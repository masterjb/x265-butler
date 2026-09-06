// @vitest-environment node
// 22-01 T4 audit-M1: rate-limit + origin gate tests.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkOrigin,
  checkRateLimit,
  ipFor,
  _resetBuckets,
  RATE_LIMIT_PER_MIN,
} from '@/src/lib/diagnostics/log-event-rate-limit';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://test/api/diagnostics/log-event', { headers });
}

describe('22-01 T4 audit-M1: rate-limit + origin gates', () => {
  beforeEach(() => {
    _resetBuckets();
    delete process.env.ALLOWED_ORIGINS;
  });

  describe('ipFor', () => {
    it('reads x-forwarded-for first hop', () => {
      expect(ipFor(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4');
    });
    it('falls back to x-real-ip', () => {
      expect(ipFor(req({ 'x-real-ip': '10.0.0.1' }))).toBe('10.0.0.1');
    });
    it('returns "unknown" when no headers present', () => {
      expect(ipFor(req())).toBe('unknown');
    });
  });

  describe('checkRateLimit', () => {
    it('allows first request', () => {
      expect(checkRateLimit(req({ 'x-forwarded-for': '1.1.1.1' }))).toEqual({ ok: true });
    });
    it('429 after RATE_LIMIT_PER_MIN+1 requests', () => {
      const r = req({ 'x-forwarded-for': '2.2.2.2' });
      for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) {
        expect(checkRateLimit(r).ok).toBe(true);
      }
      const result = checkRateLimit(r);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.retryAfterSec).toBeGreaterThan(0);
      expect(result.ok === false && result.retryAfterSec).toBeLessThanOrEqual(60);
    });
    it('separate IPs have independent buckets', () => {
      const a = req({ 'x-forwarded-for': '3.3.3.3' });
      const b = req({ 'x-forwarded-for': '4.4.4.4' });
      for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) checkRateLimit(a);
      // a is now at-limit; b should still be ok
      expect(checkRateLimit(b).ok).toBe(true);
    });
  });

  describe('checkOrigin', () => {
    it('missing-Origin → permitted (legacy + same-origin fetches)', () => {
      expect(checkOrigin(req())).toEqual({ ok: true });
    });
    it('same-origin matches host header', () => {
      expect(checkOrigin(req({ origin: 'http://example.com', host: 'example.com' }))).toEqual({
        ok: true,
      });
      expect(checkOrigin(req({ origin: 'https://example.com', host: 'example.com' }))).toEqual({
        ok: true,
      });
    });
    it('cross-origin rejected without ALLOWED_ORIGINS entry', () => {
      expect(checkOrigin(req({ origin: 'https://evil.com', host: 'good.com' }))).toEqual({
        ok: false,
      });
    });
    it('ALLOWED_ORIGINS env-allowlist passes cross-origin', () => {
      process.env.ALLOWED_ORIGINS = 'https://ok.com, https://other.com';
      expect(checkOrigin(req({ origin: 'https://ok.com', host: 'good.com' }))).toEqual({
        ok: true,
      });
    });
  });
});
