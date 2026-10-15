// In-memory per-user token-bucket rate limiter (v1: single API process).
// Swap for Upstash Redis if the API ever scales past one instance.

import { logger } from './logger.js';

type Bucket = { tokens: number; refilledAt: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxTokens: number,
    private readonly refillPerMs: number,
  ) {}

  /** Returns true when the request is allowed. */
  allow(key: string, cost = 1): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.maxTokens, refilledAt: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = now - bucket.refilledAt;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillPerMs);
    bucket.refilledAt = now;
    if (bucket.tokens < cost) {
      logger.debug('rate limit exceeded', key);
      return false;
    }
    bucket.tokens -= cost;
    return true;
  }

  /** Drops keys not seen within `ttlMs` so memory stays bounded. */
  prune(ttlMs: number): void {
    const cutoff = Date.now() - ttlMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.refilledAt < cutoff) this.buckets.delete(key);
    }
  }
}

// 60 requests/minute per user, matching Perpl's authenticated REST budget.
export const perUserRateLimiter = new RateLimiter(60, 60 / 60_000);
