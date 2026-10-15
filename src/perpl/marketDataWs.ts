// Public market-data WebSocket client.
//
// Connects to `${PERPL_WS_URL}/ws/v1/market-data`, subscribes
// to batched `mt: 5` streams, and maintains:
//   - the latest price cache (mt: 9 MarketStateUpdate)
//   - the head block + heartbeat sequence (mt: 100)
//   - L2 books and recent trades (mt: 15/16, 17/18)
//
// Reconnects with exponential backoff; re-subscribes on every
// reconnect. Market-data connections need no authentication and
// no application-level pings.

import { EventEmitter } from 'node:events';
import { logger } from '../lib/logger.js';
import { PERPL_WS_URL } from '../config.js';
import { pool } from '../lib/db.js';
import type {
  HeartbeatFrame,
  MarketState,
  MarketStateUpdateFrame,
  SubscriptionResponseFrame,
} from './types.js';

export const MT = {
  SUBSCRIPTION_REQUEST: 5,
  SUBSCRIPTION_RESPONSE: 6,
  MARKET_STATE_UPDATE: 9,
  L2_BOOK_SNAPSHOT: 15,
  L2_BOOK_UPDATE: 16,
  TRADES_SNAPSHOT: 17,
  TRADES_UPDATE: 18,
  HEARTBEAT: 100,
} as const;

const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

export type L2Level = { p: number; s: number; o: number };

export class MarketDataClient extends EventEmitter {
  private ws: WebSocket | undefined;
  private retryCount = 0;
  private shouldRun = true;
  private subscriptions = new Set<string>();
  private _lastMessageAt = 0;
  private _headBlock = 0;
  private lastSn?: number;
  private books = new Map<number, BookState>();

  constructor() {
    super();
  }

  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get lastMessageAt(): number {
    return this._lastMessageAt;
  }

  get headBlock(): number {
    return this._headBlock;
  }

  book(marketId: number): BookState | undefined {
    return this.books.get(marketId);
  }

  connect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
    }

    const ws = new WebSocket(`${PERPL_WS_URL}/ws/v1/market-data`);
    this.ws = ws;

    ws.onopen = () => {
      this.retryCount = 0;
      // A connection with no subscriptions is closed by the
      // server after ~10s (1008), so (re)subscribe the full set
      // on every connect — not just the delta.
      this.resubscribeAll();
      logger.info('market-data ws connected');
    };

    ws.onmessage = (event) => {
      this._lastMessageAt = Date.now();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        logger.warn('market-data ws: unparseable frame');
        return;
      }
      this.handle(msg);
    };

    ws.onerror = () => {
      logger.warn('market-data ws error');
    };

    ws.onclose = (event) => {
      this.ws = undefined;
      if (!this.shouldRun) return;
      const delay =
        RETRY_DELAYS[Math.min(this.retryCount++, RETRY_DELAYS.length - 1)];
      logger.warn(
        `market-data ws closed (code ${event.code}), reconnecting in ${delay}ms`,
      );
      setTimeout(() => this.connect(), delay);
    };
  }

  /** Subscribe to streams; batched into one mt:5 frame (max 16 per connection). */
  subscribe(streams: string[]): void {
    const fresh = streams.filter((s) => !this.subscriptions.has(s));
    for (const s of fresh) this.subscriptions.add(s);
    if (fresh.length === 0 || !this.ready) return;
    this.send({
      mt: MT.SUBSCRIPTION_REQUEST,
      subs: fresh.map((stream) => ({ stream, subscribe: true })),
    });
  }

  /** (Re)sends the full subscription set — used on every (re)connect. */
  private resubscribeAll(): void {
    if (this.subscriptions.size === 0 || !this.ready) return;
    this.send({
      mt: MT.SUBSCRIPTION_REQUEST,
      subs: [...this.subscriptions].map((stream) => ({
        stream,
        subscribe: true,
      })),
    });
  }

  unsubscribe(streams: string[]): void {
    if (!this.ready) return;
    this.send({
      mt: MT.SUBSCRIPTION_REQUEST,
      subs: streams.map((stream) => ({ stream, subscribe: false })),
    });
    for (const s of streams) this.subscriptions.delete(s);
  }

  private send(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private handle(msg: Record<string, unknown>): void {
    const mt = msg.mt as number;
    switch (mt) {
      case MT.SUBSCRIPTION_RESPONSE: {
        const frame = msg as unknown as SubscriptionResponseFrame;
        for (const sub of frame.subs) {
          if (sub.status && sub.status.code !== 0) {
            logger.warn(
              `subscription failed: ${sub.stream}`,
              sub.status.error ?? '',
            );
            this.subscriptions.delete(sub.stream);
          }
        }
        break;
      }

      case MT.MARKET_STATE_UPDATE: {
        const frame = msg as unknown as MarketStateUpdateFrame;
        this.trackState(frame.d);
        void this.persistPrices(frame.d);
        this.emit('marketState', frame.d);
        break;
      }

      case MT.L2_BOOK_SNAPSHOT:
      case MT.L2_BOOK_UPDATE: {
        const book = msg as unknown as L2BookFrame;
        this.applyBook(book, mt === MT.L2_BOOK_SNAPSHOT);
        break;
      }

      case MT.TRADES_SNAPSHOT:
      case MT.TRADES_UPDATE: {
        this.emit('trades', msg);
        break;
      }

      case MT.HEARTBEAT: {
        const hb = msg as unknown as HeartbeatFrame;
        // The heartbeat stream carries a continuous sequence; a gap
        // means missed frames — resubscribe to recover.
        if (this.lastSn !== undefined && hb.sn !== this.lastSn + 1) {
          logger.warn(
            `market-data sequence gap (${this.lastSn} -> ${hb.sn}), resubscribing`,
          );
          const subs = [...this.subscriptions];
          this.subscriptions.clear();
          this.subscribe(subs);
        }
        this.lastSn = hb.sn;
        this._headBlock = hb.h;
        break;
      }
    }
  }

  private applyBook(book: L2BookFrame, isSnapshot: boolean): void {
    const marketId = Number(book.mkt ?? book.market_id);
    if (!Number.isInteger(marketId)) return;
    let existing = this.books.get(marketId);
    if (!existing || isSnapshot) {
      existing = { bids: new Map<number, L2Level>(), asks: new Map<number, L2Level>() };
      this.books.set(marketId, existing);
    }
    const levelsBySide = { bid: book.bid, ask: book.ask } as const;
    for (const side of ['bid', 'ask'] as const) {
      const levels = levelsBySide[side];
      if (!Array.isArray(levels)) continue;
      const target = side === 'bid' ? existing.bids : existing.asks;
      for (const level of levels) {
        if (level.o === 0) target.delete(level.p);
        else target.set(level.p, level);
      }
    }
    this.emit('book', marketId, existing);
  }

  /** Persist the latest state into price_cache for the API tier. */
  private async persistPrices(d: MarketStateUpdateFrame['d']): Promise<void> {
    try {
      for (const [marketId, state] of Object.entries(d)) {
        if (!state) continue;
        await pool.query(
          `insert into price_cache
             (market_id, oracle_price, mark_price, last_price, mid_price,
              bid, ask, price_24h_ago, daily_volume, open_interest, at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           on conflict (market_id) do update set
             oracle_price = excluded.oracle_price,
             mark_price = excluded.mark_price,
             last_price = excluded.last_price,
             mid_price = excluded.mid_price,
             bid = excluded.bid,
             ask = excluded.ask,
             price_24h_ago = excluded.price_24h_ago,
             daily_volume = excluded.daily_volume,
             open_interest = excluded.open_interest,
             at = now()`,
          [
            Number(marketId),
            state.orl ?? null,
            state.mrk ?? null,
            state.lst ?? null,
            state.mid ?? null,
            state.bid ?? null,
            state.ask ?? null,
            state.prv ?? null,
            state.dva ?? null,
            state.oi ?? null,
          ],
        );
      }
    } catch (error) {
      logger.error('price_cache write failed', error);
    }
  }

  /** Latest market state for one market, from the in-memory view. */
  stateFor(marketId: number): MarketState | undefined {
    return this.latestState.get(marketId);
  }

  private latestState = new Map<number, MarketState>();

  /** Tracks the latest state frame per market (in addition to the DB write). */
  private trackState(d: MarketStateUpdateFrame['d']): void {
    for (const [marketId, state] of Object.entries(d)) {
      if (state) this.latestState.set(Number(marketId), state);
    }
  }

  disconnect(): void {
    this.shouldRun = false;
    this.ws?.close();
    this.ws = undefined;
  }
}

export interface L2BookFrame {
  mt?: number;
  sid?: number;
  mkt?: number;
  market_id?: number;
  at?: { t: number };
  bid?: L2Level[];
  ask?: L2Level[];
  [key: string]: unknown;
}

export interface BookState {
  bids: Map<number, L2Level>;
  asks: Map<number, L2Level>;
}
