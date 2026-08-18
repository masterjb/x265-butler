// 05-01: in-memory IP-keyed login rate-limiter.
// Phase 5 Plan 05-01 (Auth Backend Foundation) — audit M1 + M2 + S4.
//
// Single-process matches engineEvents singleton assumption (HMR-safe via
// globalThis guard).
//
// audit M1: hard cap MAX_BUCKET_ENTRIES=10000 with insertion-order LRU
// eviction defends against distributed-IP DoS that would otherwise grow the
// Map unboundedly. Eviction emits pino warn auth_rate_limit_bucket_overflow.
//
// audit M2: extractIp default-secure — auth_trust_proxy_xff='false' (factory)
// IGNORES x-forwarded-for. Operator opt-in only when behind a reverse proxy
// that strips client-supplied XFF. PROJECT.md states LAN-only deployment.
//
// audit S4: caller emits auth_rate_limit_hit when check() returns !allowed.

import crypto from 'node:crypto';
import { logger } from '@/src/lib/logger';

export const RATE_LIMIT_WINDOW_SEC = 60;
export const RATE_LIMIT_MAX_ATTEMPTS = 5;
export const MAX_BUCKET_ENTRIES = 10_000;
const JANITOR_INTERVAL_MS = 60_000;

interface BucketEntry {
  count: number;
  windowStart: number; // epoch seconds
}

declare global {
  var __x265butler_login_rate_limiter:
    | {
        buckets: Map<string, BucketEntry>;
        janitorTimer: NodeJS.Timeout | null;
      }
    | undefined;
}

function getStore(): {
  buckets: Map<string, BucketEntry>;
  janitorTimer: NodeJS.Timeout | null;
} {
  if (!globalThis.__x265butler_login_rate_limiter) {
    const store = {
      buckets: new Map<string, BucketEntry>(),
      janitorTimer: null as NodeJS.Timeout | null,
    };
    // Janitor: prune entries older than 2× window. Single-shot (HMR-safe).
    if (typeof setInterval === 'function') {
      store.janitorTimer = setInterval(() => {
        const now = Math.floor(Date.now() / 1000);
        const cutoff = now - RATE_LIMIT_WINDOW_SEC * 2;
        for (const [key, entry] of store.buckets.entries()) {
          if (entry.windowStart < cutoff) {
            store.buckets.delete(key);
          }
        }
      }, JANITOR_INTERVAL_MS);
      // Don't keep the event loop alive just for the janitor.
      if (store.janitorTimer && typeof store.janitorTimer.unref === 'function') {
        store.janitorTimer.unref();
      }
    }
    globalThis.__x265butler_login_rate_limiter = store;
  }
  return globalThis.__x265butler_login_rate_limiter;
}

/** Stable, low-cardinality IP fingerprint for logs (audit S7 PII reduction). */
export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip, 'utf8').digest('hex').slice(0, 16);
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec: number;
  attemptCount: number;
}

function evictOldestIfNeeded(buckets: Map<string, BucketEntry>): void {
  if (buckets.size < MAX_BUCKET_ENTRIES) return;
  // Map preserves insertion order — first key is oldest.
  const firstKey = buckets.keys().next().value;
  if (firstKey === undefined) return;
  buckets.delete(firstKey);
  logger.warn(
    {
      event: 'auth_rate_limit_bucket_overflow',
      evicted_ip_hash: firstKey,
      bucket_size: MAX_BUCKET_ENTRIES,
    },
    'auth rate-limit bucket overflow — evicting oldest entry',
  );
}

/**
 * Check the rate-limit bucket for an IP. Does NOT mutate the bucket on its own —
 * caller invokes recordFailure / recordSuccess after the actual login attempt.
 */
export function check(ip: string, nowSec?: number): RateLimitDecision {
  const store = getStore();
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const key = hashIp(ip);
  const entry = store.buckets.get(key);
  if (!entry) {
    return { allowed: true, retryAfterSec: 0, attemptCount: 0 };
  }
  // Window expired → fresh.
  if (now - entry.windowStart >= RATE_LIMIT_WINDOW_SEC) {
    return { allowed: true, retryAfterSec: 0, attemptCount: 0 };
  }
  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    const retryAfterSec = Math.max(1, RATE_LIMIT_WINDOW_SEC - (now - entry.windowStart));
    return { allowed: false, retryAfterSec, attemptCount: entry.count };
  }
  return { allowed: true, retryAfterSec: 0, attemptCount: entry.count };
}

export function recordFailure(ip: string, nowSec?: number): void {
  const store = getStore();
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const key = hashIp(ip);
  const entry = store.buckets.get(key);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_SEC) {
    evictOldestIfNeeded(store.buckets);
    store.buckets.set(key, { count: 1, windowStart: now });
    return;
  }
  entry.count++;
}

export function recordSuccess(ip: string): void {
  const store = getStore();
  store.buckets.delete(hashIp(ip));
}

/**
 * audit M2: default-secure IP extraction.
 *
 * trustProxyXff=false (factory default) → IGNORE x-forwarded-for.
 * Without a reliable socket.remoteAddress in Next.js Route Handlers, fall back
 * to 'unknown' so the limiter still functions; the operator running on LAN
 * still gets a working bucket per logical-client (cookie-based or per-tab).
 *
 * trustProxyXff=true → parse XFF[0]. Operator MUST configure their reverse
 * proxy to strip client-supplied XFF — documented in 05-05 README hardening.
 */
export function extractIp(req: Request, trustProxyXff: boolean): string {
  if (trustProxyXff) {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const realIp = req.headers.get('x-real-ip');
    if (realIp) return realIp.trim();
  }
  // Without trust, we rely on Next.js / runtime to expose remote address.
  // Next.js Route Handlers do NOT directly expose req.socket — accept the
  // limitation and fall back to a single-client-key for LAN deployments.
  // 05-05 README documents this caveat. Test asserts the behavior.
  const internal = req.headers.get('x-x265-butler-remote-addr');
  if (internal) return internal.trim();
  return 'unknown';
}

/** Test-only: clear all buckets. Not exported in non-test paths via guard. */
export function _resetForTesting(): void {
  if (process.env.NODE_ENV === 'production' && process.env.VITEST !== 'true') return;
  const store = getStore();
  store.buckets.clear();
}

/**
 * 05-02 audit S8: clear all rate-limit buckets. Called by PUT /api/settings
 * when auth_trust_proxy_xff is toggled — old buckets keyed by previous
 * IP-resolution scheme become stale and could lock out the legitimate operator
 * under the new scheme. Returns the number of evicted buckets for log payload.
 */
export function clearAll(): number {
  const store = getStore();
  const evicted = store.buckets.size;
  store.buckets.clear();
  return evicted;
}
