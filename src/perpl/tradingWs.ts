// Authenticated trading WebSocket client.
//
// One session per enrolled Perpl API key. The first frame after
// connect is always a signed ApiKeySignIn (mt: 29) with a fresh
// timestamp and nonce. After sign-in the server pushes wallet,
// order, and position snapshots; orders are placed with mt: 22
// frames carrying an idempotency key (`rq`, strictly increasing,
// seeded from the account's `lfr`) and a correlation id (`sn`,
// echoed as `cid` on the mt: 3 command status).
//
// Heartbeats must satisfy sn === lastSn + 1; a gap forces a
// reconnect so state is re-seeded from fresh snapshots.

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { logger } from '../lib/logger.js';
import { PERPL_CHAIN_ID, PERPL_WS_URL } from '../config.js';
import {
  Account,
  ApiKeySignInFrame,
  Fill,
  MT,
  Order,
  OrderFlags,
  OrderRequestFrame,
  OrderStatus,
  OrderStatusReason,
  Position,
  StatusResponseFrame,
  WalletSnapshot,
} from './types.js';
import type { KeyMaterial } from './rest.js';

const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
const PING_INTERVAL_MS = 30_000;
const SIGN_IN_TIMEOUT_MS = 5_000; // must sign in within 5s on mainnet
const ORDER_ACK_TIMEOUT_MS = 60_000;

export type OrderSpec = {
  marketId: number;
  type: number; // OrderType
  sizeScaled: bigint;
  priceScaled?: bigint; // 0/absent = market order (IOC)
  leverageHundredths?: number;
  positionId?: number; // lp — closes
  orderId?: number; // oid — cancel
  maxSlippageBps?: number; // ms
  builderFeePer100k?: number; // bf — builder-bound keys only
};

export type OrderAck = {
  requestId: number;
  perplOrderId?: number;
  status: number;
};

type PendingRequest = {
  requestId: number;
  sn: number;
  marketId: number;
  type: number;
  spec?: OrderSpec; // kept for an sr:32 retry with a fresh rq
  resolve: (ack: OrderAck) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  retried: boolean;
};

const DEFINITIVE_STATUSES = new Set<number>([
  OrderStatus.Open,
  OrderStatus.PartiallyFilled,
  OrderStatus.Filled,
  OrderStatus.Canceled,
  OrderStatus.Expired,
  OrderStatus.Untriggered,
  OrderStatus.Triggered,
  OrderStatus.Executed,
]);

export class TradingSession extends EventEmitter {
  readonly userId: string;
  state: 'connecting' | 'authenticating' | 'ready' | 'closed' = 'connecting';

  accountId?: number;
  balance?: string;
  lockedBalance?: string;
  forwardingAllowed = true;
  builderId?: number;
  maxBuilderFeePer100k = 0;

  private ws: WebSocket | undefined;
  private shouldRun = true;
  private retryCount = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private signInTimer: ReturnType<typeof setTimeout> | undefined;

  private lfr = 0; // last forwarded request id (seeds rq)
  private lastRq = 0; // last rq we used
  private snCounter = 0;
  private lastSn?: number;
  private headBlock = 0;

  private pendingByRq = new Map<number, PendingRequest>();
  private rqBySn = new Map<number, number>();
  private rqByOid = new Map<number, number>();

  constructor(
    private readonly key: KeyMaterial,
    opts: {
      userId: string;
      headBlockProvider?: () => number;
      orderTtlBlocks?: number;
    },
  ) {
    super();
    this.userId = opts.userId;
    this.headBlockProvider = opts.headBlockProvider ?? (() => 0);
    this.orderTtlBlocks = opts.orderTtlBlocks ?? 100;
  }

  private readonly headBlockProvider: () => number;
  private readonly orderTtlBlocks: number;

  get ready(): boolean {
    return (
      this.state === 'ready' &&
      this.ws?.readyState === WebSocket.OPEN &&
      this.accountId !== undefined
    );
  }

  connect(): void {
    this.shouldRun = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = undefined;
    }

    this.state = 'authenticating';
    const ws = new WebSocket(`${PERPL_WS_URL}/ws/v1/trading`);
    this.ws = ws;

    this.signInTimer = setTimeout(() => {
      logger.warn(`trading ws ${this.userId}: sign-in timed out`);
      ws.close(4000, 'sign-in timeout');
    }, SIGN_IN_TIMEOUT_MS);

    ws.onopen = () => {
      void this.signIn(ws).catch((error: unknown) => {
        logger.error(`trading ws ${this.userId}: sign-in failed`, error);
        ws.close(4001, 'sign-in failed');
      });
    };

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        logger.warn(`trading ws ${this.userId}: unparseable frame`);
        return;
      }
      try {
        this.handle(msg);
      } catch (error) {
        logger.error(`trading ws ${this.userId}: handler error`, error);
      }
    };

    ws.onerror = () => {
      logger.warn(`trading ws ${this.userId}: error`);
    };

    ws.onclose = (event) => {
      this.clearTimers();
      this.ws = undefined;
      this.state = 'connecting';
      this.emit('closed', event.code);
      if (!this.shouldRun) return;
      if (event.code === 3401) {
        logger.warn(
          `trading ws ${this.userId}: auth failed (3401), re-signing`,
        );
      }
      const delay =
        RETRY_DELAYS[
          Math.min(this.retryCount++, RETRY_DELAYS.length - 1)
        ];
      logger.warn(
        `trading ws ${this.userId}: closed (code ${event.code}), reconnecting in ${delay}ms`,
      );
      setTimeout(() => {
        if (this.shouldRun) this.connect();
      }, delay);
    };
  }

  /** Signs and sends the mt:29 frame — must be the first message. */
  private async signIn(ws: WebSocket): Promise<void> {
    const timestamp = Date.now().toString();
    const nonce = randomBytes(16).toString('base64url');
    const canonical = [
      PERPL_CHAIN_ID,
      'trading-ws-signin',
      timestamp,
      nonce,
    ].join('\n');
    const signature = await ed.signAsync(
      Buffer.from(canonical),
      this.key.privateKey,
    );

    const frame: ApiKeySignInFrame = {
      mt: MT.API_KEY_SIGN_IN,
      chain_id: PERPL_CHAIN_ID,
      api_key: this.key.token,
      timestamp,
      nonce,
      signature: Buffer.from(signature).toString('base64url'),
    };
    ws.send(JSON.stringify(frame));
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.signInTimer) clearTimeout(this.signInTimer);
    this.pingTimer = undefined;
    this.signInTimer = undefined;
  }

  private handle(msg: Record<string, unknown>): void {
    const mt = msg.mt as number;
    switch (mt) {
      case MT.STATUS_RESPONSE:
        this.handleStatus(msg as unknown as StatusResponseFrame);
        break;

      case MT.WALLET_SNAPSHOT: {
        const snap = msg as unknown as WalletSnapshot;
        const account = snap.as?.[0];
        if (account) this.applyAccount(account);
        if (snap.sn !== undefined) this.lastSn = snap.sn;
        this.becomeReady();
        this.emit('wallet', snap);
        break;
      }

      case MT.WALLET_UPDATE: {
        // Balance/locked updates; shape mirrors wallet fields.
        const b = msg.b as string | undefined;
        const lb = msg.lb as string | undefined;
        if (b !== undefined) this.balance = b;
        if (lb !== undefined) this.lockedBalance = lb;
        this.emit('walletUpdate', msg);
        break;
      }

      case MT.ACCOUNT_UPDATE: {
        const account = msg as unknown as Account;
        this.applyAccount(account);
        this.emit('account', account);
        break;
      }

      case MT.ORDERS_SNAPSHOT:
        this.emit('orders', (msg as { d?: Order[] }).d ?? []);
        break;

      case MT.ORDERS_UPDATE: {
        const orders = (msg as { d?: Order[] }).d ?? [];
        for (const order of orders) this.applyOrderUpdate(order);
        this.emit('orderUpdate', orders);
        break;
      }

      case MT.FILLS_UPDATE: {
        const fills = (msg as { d?: Fill[] }).d ?? [];
        for (const fill of fills) {
          const requestId = fill.oid !== undefined
            ? this.rqByOid.get(fill.oid)
            : (fill.rq !== undefined ? fill.rq : undefined);
          this.emit('fill', fill, requestId);
        }
        this.emit('fills', fills);
        break;
      }

      case MT.POSITIONS_SNAPSHOT:
        this.emit('positions', (msg as { d?: Position[] }).d ?? []);
        break;

      case MT.POSITIONS_UPDATE: {
        const positions = (msg as { d?: Position[] }).d ?? [];
        this.emit('positionUpdate', positions);
        break;
      }

      case MT.HEARTBEAT: {
        const sn = msg.sn as number;
        const h = msg.h as number;
        if (this.lastSn !== undefined && sn !== this.lastSn + 1) {
          logger.warn(
            `trading ws ${this.userId}: sequence gap (${this.lastSn} -> ${sn}), reconnecting`,
          );
          this.ws?.close(4000, 'sequence gap');
          return;
        }
        this.lastSn = sn;
        this.headBlock = h;
        break;
      }

      case MT.ACCOUNT_STATS_UPDATE:
        this.emit('stats', msg);
        break;

      default:
        // Pong (mt: 2) and other frames need no handling.
        break;
    }
  }

  private applyAccount(account: Account): void {
    this.accountId = account.id;
    this.balance = account.b;
    this.lockedBalance = account.lb;
    this.forwardingAllowed = account.fw;
    // Re-seed the rq counter from the server's last forwarded id.
    if (account.lfr > this.lfr) {
      this.lfr = account.lfr;
      this.lastRq = Math.max(this.lastRq, account.lfr);
    }
    this.emit('account', account);
  }

  private becomeReady(): void {
    if (this.state !== 'ready' && this.accountId !== undefined) {
      this.state = 'ready';
      this.retryCount = 0;
      this.clearTimers();
      this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
      logger.info(`trading ws ${this.userId}: ready (account ${this.accountId})`);
      this.emit('ready');
    }
  }

  private ping(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ mt: MT.PING, t: Date.now() }));
    }
  }

  private handleStatus(frame: StatusResponseFrame): void {
    // The command-status stream (sid 100) reports gateway admission.
    if (frame.sid !== 100) return;
    const cid = frame.cid;
    if (cid === undefined) return;
    const requestId = this.rqBySn.get(cid);
    if (requestId === undefined) return;
    const pending = this.pendingByRq.get(requestId);
    if (!pending) return;

    this.rqBySn.delete(cid);
    clearTimeout(pending.timer);

    if (frame.status.code === 0) {
      // Accepted for forwarding. The order's real outcome arrives
      // later on the mt: 24 order-updates stream; the pending
      // promise resolves on the first non-failure update. The
      // 'admitted' event lets the audit trail record the open state.
      logger.debug(
        `order ${requestId} admitted (mkt ${pending.marketId})`,
      );
      this.emit('admitted', requestId);
    } else {
      const error = new Error(
        `order rejected: ${frame.status.error ?? frame.status.code}`,
      );
      this.settlePending(requestId, undefined, frame.status.code, error);
    }
  }

  private applyOrderUpdate(order: Order): void {
    if (order.rq !== undefined && order.id !== undefined) {
      this.rqByOid.set(order.id, order.rq);
    }
    const requestId =
      order.rq !== undefined
        ? order.rq
        : order.id !== undefined
          ? this.rqByOid.get(order.id)
          : undefined;
    if (requestId === undefined) return;

    const pending = this.pendingByRq.get(requestId);
    if (!pending) return;

    const status = order.st ?? OrderStatus.Pending;

    // The first non-failure status is definitive (st in
    // 2, 3, 4, 5, 8, 9, 10); later updates are ignored.
    if (DEFINITIVE_STATUSES.has(status)) {
      this.settlePending(requestId, order.id, status);
      return;
    }

    if (status === OrderStatus.Failed) {
      if (
        order.sr === OrderStatusReason.OrderDescIdTooLow &&
        !pending.retried
      ) {
        // Our rq counter is behind the server's. Retry once
        // with a fresh rq — placeOrder re-seeds from lfr.
        clearTimeout(pending.timer);
        this.pendingByRq.delete(requestId);
        this.rqBySn.delete(pending.sn);
        pending.retried = true;
        this.retryWithFreshRq(pending);
        return;
      }
      this.settlePending(
        requestId,
        undefined,
        status,
        new Error(
          `order failed (sr ${order.sr ?? 'unknown'}: ${
            OrderStatusReasonName[order.sr ?? 0] ?? 'unknown'
          })`,
        ),
      );
    }
  }

  /** Re-sends a failed order under a fresh rq. */
  private retryWithFreshRq(pending: PendingRequest): void {
    const spec = pending.spec;
    if (!spec) return;
    this.placeOrder(spec)
      .then((ack) => pending.resolve(ack))
      .catch((error: Error) => pending.reject(error));
  }

  private settlePending(
    requestId: number,
    perplOrderId: number | undefined,
    status: number,
    error?: Error,
  ): void {
    const pending = this.pendingByRq.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingByRq.delete(requestId);
    if (error) pending.reject(error);
    else {
      pending.resolve({ requestId, perplOrderId, status });
    }
  }

  /**
   * Places an order. Resolves once the gateway admits the frame
   * (mt: 3 code 0) or the order reaches a non-failure status on
   * mt: 24; rejects on gateway rejection or failure. Retries once
   * with a fresh rq on OrderDescIdTooLow.
   */
  async placeOrder(spec: OrderSpec): Promise<OrderAck> {
    if (!this.ready) {
      throw new Error('trading session is not ready');
    }
    if (this.accountId === undefined) {
      throw new Error('account id unknown');
    }
    if (!this.forwardingAllowed) {
      throw new Error('account forwarding is disabled');
    }

    const requestId = Math.max(this.lastRq, this.lfr) + 1;
    this.lastRq = requestId;
    const sn = ++this.snCounter;
    this.rqBySn.set(sn, requestId);

    const head = this.headBlockProvider() || this.headBlock;
    const lb = head > 0 ? head + this.orderTtlBlocks : 0;

    const frame: OrderRequestFrame = {
      mt: MT.ORDER_REQUEST,
      sn,
      rq: requestId,
      mkt: spec.marketId,
      acc: this.accountId,
      t: spec.type,
      p: Number(spec.priceScaled ?? 0n),
      s: Number(spec.sizeScaled),
      ...(spec.maxSlippageBps !== undefined
        ? { ms: spec.maxSlippageBps }
        : {}),
      fl: spec.priceScaled && spec.priceScaled > 0n
        ? OrderFlags.GTC
        : OrderFlags.ImmediateOrCancel,
      ...(spec.positionId !== undefined ? { lp: spec.positionId } : {}),
      ...(spec.orderId !== undefined ? { oid: spec.orderId } : {}),
      lv: spec.leverageHundredths ?? 0,
      lb,
      ...(spec.builderFeePer100k
        ? { bf: spec.builderFeePer100k }
        : {}),
    };

    return new Promise<OrderAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Admission never arrived. The order may still execute
        // at-most-once; the reconciler finalizes the row via REST.
        const pending = this.pendingByRq.get(requestId);
        if (pending) {
          this.pendingByRq.delete(requestId);
          this.rqBySn.delete(sn);
          reject(new Error('order acknowledgment timed out'));
        }
      }, ORDER_ACK_TIMEOUT_MS);

      this.pendingByRq.set(requestId, {
        requestId,
        sn,
        marketId: spec.marketId,
        type: spec.type,
        spec,
        resolve,
        reject,
        timer,
        retried: false,
      });

      this.ws?.send(JSON.stringify(frame));
      logger.debug(
        `order sent: rq=${requestId} mkt=${spec.marketId} t=${spec.type} s=${frame.s}`,
      );
    });
  }

  /** Closes every open position with market orders (kill switch). */
  async closeAllPositions(
    positions: Array<{ id: number; mkt: number; t?: number; s?: number }>,
    maxSlippageBps?: number,
  ): Promise<void> {
    for (const position of positions) {
      const size = BigInt(position.s ?? 0);
      if (size <= 0n) continue;
      const isLong = (position.t ?? 0) === 1;
      try {
        await this.placeOrder({
          marketId: position.mkt,
          type: isLong ? 3 : 4, // CloseLong / CloseShort
          sizeScaled: size,
          positionId: position.id,
          maxSlippageBps,
        });
      } catch (error) {
        logger.error(
          `kill-switch close failed for position ${position.id}`,
          error,
        );
      }
    }
  }

  /** Drops the session; the registry may open a new one later. */
  disconnect(): void {
    this.shouldRun = false;
    this.clearTimers();
    for (const pending of this.pendingByRq.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('session closed'));
    }
    this.pendingByRq.clear();
    this.rqBySn.clear();
    this.rqByOid.clear();
    this.state = 'closed';
    this.ws?.close();
    this.ws = undefined;
  }
}

const OrderStatusReasonName: Record<number, string> = {
  1: 'AmountExceedsAvailableBalance',
  13: 'CrossesBook',
  14: 'ExceedsLastExecutionBlock',
  15: 'ForwardingReverted',
  32: 'OrderDescIdTooLow',
  38: 'OrderSizeExceedsAvailableSize',
  53: 'PerpetualInsolvent',
};
