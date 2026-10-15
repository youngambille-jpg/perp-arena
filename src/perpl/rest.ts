// Signed Perpl REST client.
//
// Every authenticated call signs a canonical string with the
// account's Ed25519 key and sends four X-API-* headers. The
// canonical string is six fields joined by "\n":
//   <chain_id>, <method>, <request-target>, <timestamp_ms>,
//   <nonce>, <sha256(body) hex>
//
// The request-target must match byte-for-byte what the server
// receives, so the query string is built once and reused for
// both the signature and the request.

import { createHash, randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { logger } from '../lib/logger.js';
import { PERPL_API_URL, PERPL_CHAIN_ID } from '../config.js';
import type {
  AccountEvent,
  Context,
  Fill,
  Order,
  Page,
  Position,
} from './types.js';

export interface KeyMaterial {
  /** Opaque X-API-Key token returned at enrollment. */
  token: string;
  /** 32-byte Ed25519 private key. */
  privateKey: Buffer;
}

export function privateKeyFromHex(value: string): Buffer {
  const hex = value.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Perpl private key must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export class PerplApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PerplApiError';
  }
}

const EMPTY_BODY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export class PerplRestClient {
  readonly token: string;

  constructor(private readonly key: KeyMaterial) {
    this.token = key.token;
  }

  /**
   * Performs a signed request. `target` must be the exact
   * path + query string (built once, signed once, fetched once).
   */
  async request(
    method: 'GET' | 'POST',
    target: string,
    body = '',
    retry = true,
  ): Promise<Response> {
    const timestamp = Date.now().toString();
    const nonce = randomBytes(16).toString('base64url');
    const bodyHash = body
      ? createHash('sha256').update(body).digest('hex')
      : EMPTY_BODY_SHA256;

    const canonical = [
      PERPL_CHAIN_ID,
      method,
      target,
      timestamp,
      nonce,
      bodyHash,
    ].join('\n');

    const signature = await ed.signAsync(
      Buffer.from(canonical),
      this.key.privateKey,
    );

    const res = await fetch(`${PERPL_API_URL}${target}`, {
      method,
      headers: {
        'X-API-Key': this.key.token,
        'X-API-Timestamp': timestamp,
        'X-API-Nonce': nonce,
        'X-API-Signature': Buffer.from(signature).toString('base64url'),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    });

    // Perpl rate limits: ~60 signed requests/min. Back off on 429.
    if (res.status === 429 && retry) {
      logger.warn('perpl rate limited (429), backing off 2s');
      await new Promise((r) => setTimeout(r, 2000));
      return this.request(method, target, body, false);
    }
    return res;
  }

  async json<T>(
    method: 'GET' | 'POST',
    target: string,
    body?: string,
  ): Promise<T> {
    const res = await this.request(method, target, body ?? '');
    if (!res.ok) {
      throw new PerplApiError(
        res.status,
        `Perpl ${method} ${target} -> HTTP ${res.status}`,
      );
    }
    return (await res.json()) as T;
  }

  // ---- Trading state (snapshots) -------------------------------------

  async wallet(): Promise<import('./types.js').WalletSnapshot> {
    return this.json('GET', '/v1/trading/wallet');
  }

  async orders(): Promise<{ mt: number; d: Order[] }> {
    return this.json('GET', '/v1/trading/orders');
  }

  async positions(): Promise<{ mt: number; d: Position[] }> {
    return this.json('GET', '/v1/trading/positions');
  }

  // ---- History (cursor-paginated, newest first) ---------------------

  async fills(count = 100, page?: string): Promise<Page<Fill>> {
    const params = new URLSearchParams({ count: String(count) });
    if (page) params.set('page', page);
    return this.json('GET', `/v1/trading/fills?${params.toString()}`);
  }

  async allFills(limit = 1000): Promise<Fill[]> {
    const out: Fill[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.fills(100, cursor);
      out.push(...page.d);
      cursor = page.np;
    } while (cursor && out.length < limit);
    return out;
  }

  async orderHistory(count = 100, page?: string): Promise<Page<Order>> {
    const params = new URLSearchParams({ count: String(count) });
    if (page) params.set('page', page);
    return this.json(
      'GET',
      `/v1/trading/order-history?${params.toString()}`,
    );
  }

  async positionHistory(
    count = 100,
    page?: string,
  ): Promise<Page<Position>> {
    const params = new URLSearchParams({ count: String(count) });
    if (page) params.set('page', page);
    return this.json(
      'GET',
      `/v1/trading/position-history?${params.toString()}`,
    );
  }

  async accountHistory(
    count = 100,
    page?: string,
  ): Promise<Page<AccountEvent>> {
    const params = new URLSearchParams({ count: String(count) });
    if (page) params.set('page', page);
    return this.json(
      'GET',
      `/v1/trading/account-history?${params.toString()}`,
    );
  }

  // ---- Profile ------------------------------------------------------

  async refCode(): Promise<{ code: string }> {
    return this.json('GET', '/v1/profile/ref-code');
  }
}

// ---- Public (unauthenticated) endpoints ------------------------------

export async function fetchContext(): Promise<Context> {
  const res = await fetch(`${PERPL_API_URL}/v1/pub/context`);
  if (!res.ok) throw new Error(`context fetch failed: HTTP ${res.status}`);
  return (await res.json()) as Context;
}

export interface Candle {
  t: number;
  o: number;
  c: number;
  h: number;
  l: number;
  v: string;
  n: number;
}

export async function fetchCandles(
  marketId: number,
  resolution: number,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const res = await fetch(
    `${PERPL_API_URL}/v1/market-data/${marketId}/candles/${resolution}/${fromMs}-${toMs}`,
  );
  if (!res.ok) {
    throw new Error(`candles fetch failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { d?: Candle[] };
  return data.d ?? [];
}

export interface TickerResponse {
  mt: number;
  sn?: number;
  d: Record<number, import('./types.js').MarketState | undefined>;
}

export async function fetchTickers(): Promise<TickerResponse> {
  const res = await fetch(`${PERPL_API_URL}/v1/market-data/ticker`);
  if (!res.ok) throw new Error(`ticker fetch failed: HTTP ${res.status}`);
  return (await res.json()) as TickerResponse;
}
