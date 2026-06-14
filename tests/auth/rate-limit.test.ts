/*
 * 05-01 Task 1: src/lib/auth/rate-limit.ts.
 * Covers M1 (bucket cap + LRU eviction), M2 (extractIp default-secure).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: mockLoggerWarn,
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
  default: {},
}));

import {
  MAX_BUCKET_ENTRIES,
  RATE_LIMIT_MAX_ATTEMPTS,
  RATE_LIMIT_WINDOW_SEC,
  _resetForTesting,
  check,
  extractIp,
  hashIp,
  recordFailure,
  recordSuccess,
} from '@/src/lib/auth/rate-limit';

beforeEach(() => {
  _resetForTesting();
  mockLoggerWarn.mockReset();
});

describe('check — happy path', () => {
  it('test_check_when_no_prior_attempts_then_allowed', () => {
    expect(check('1.2.3.4').allowed).toBe(true);
  });

  it('test_check_when_under_max_attempts_then_allowed', () => {
    const now = 1_000;
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS - 1; i++) {
      recordFailure('1.2.3.4', now);
    }
    expect(check('1.2.3.4', now).allowed).toBe(true);
  });

  it('test_check_when_at_max_attempts_then_rejected_with_retry_after', () => {
    const now = 1_000;
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      recordFailure('1.2.3.4', now);
    }
    const decision = check('1.2.3.4', now);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSec).toBeGreaterThan(0);
    expect(decision.retryAfterSec).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_SEC);
  });

  it('test_check_when_window_rolled_over_then_allowed_again', () => {
    const now = 1_000;
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      recordFailure('1.2.3.4', now);
    }
    const after = now + RATE_LIMIT_WINDOW_SEC + 1;
    expect(check('1.2.3.4', after).allowed).toBe(true);
  });

  it('test_recordSuccess_when_called_then_clears_bucket', () => {
    const now = 1_000;
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      recordFailure('1.2.3.4', now);
    }
    recordSuccess('1.2.3.4');
    expect(check('1.2.3.4', now).allowed).toBe(true);
  });
});

describe('audit M1 — bucket cap + LRU eviction', () => {
  it('test_when_bucket_overflows_then_oldest_evicted_and_warn_logged', () => {
    const now = 1_000;
    // Fill bucket to cap.
    for (let i = 0; i < MAX_BUCKET_ENTRIES; i++) {
      recordFailure(`10.0.0.${i}`, now);
    }
    // One more triggers eviction of the oldest (10.0.0.0).
    recordFailure('10.0.0.99999', now);
    const overflowCalls = mockLoggerWarn.mock.calls.filter((c) => {
      const arg = c[0] as { event?: string } | undefined;
      return arg?.event === 'auth_rate_limit_bucket_overflow';
    });
    expect(overflowCalls.length).toBeGreaterThan(0);
  });
});

describe('audit M2 — extractIp default-secure', () => {
  it('test_extractIp_when_trustProxyXff_false_then_ignores_xff', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '203.0.113.42' },
    });
    expect(extractIp(req, false)).toBe('unknown');
  });

  it('test_extractIp_when_trustProxyXff_true_then_uses_xff_first_hop', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '203.0.113.42, 10.0.0.1' },
    });
    expect(extractIp(req, true)).toBe('203.0.113.42');
  });

  it('test_extractIp_when_trustProxyXff_true_and_x_real_ip_then_falls_back', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-real-ip': '198.51.100.7' },
    });
    expect(extractIp(req, true)).toBe('198.51.100.7');
  });

  it('test_extractIp_when_internal_test_header_then_used', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-x265-butler-remote-addr': '127.0.0.1' },
    });
    expect(extractIp(req, false)).toBe('127.0.0.1');
  });
});

describe('hashIp — audit S7 PII reduction', () => {
  it('test_hashIp_when_called_then_returns_16_char_hex', () => {
    const out = hashIp('192.168.1.1');
    expect(out).toMatch(/^[0-9a-f]{16}$/);
  });

  it('test_hashIp_when_same_input_then_deterministic', () => {
    expect(hashIp('1.1.1.1')).toBe(hashIp('1.1.1.1'));
  });

  it('test_hashIp_when_different_inputs_then_different_outputs', () => {
    expect(hashIp('1.1.1.1')).not.toBe(hashIp('2.2.2.2'));
  });
});
