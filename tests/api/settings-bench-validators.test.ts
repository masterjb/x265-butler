// 11-06 T1: validator tests für bench default-matrix keys (mode, encoders,
// presets, native_values, vmaf_buckets). Whitelist + descending + dup-reject.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGetAll, mockGet, mockSet, mockTransaction } = vi.hoisted(() => {
  const mockSet = vi.fn<(key: string, value: string) => void>();
  return {
    mockGetAll: vi.fn<() => Record<string, string>>(),
    mockGet: vi.fn<(key: string) => string | undefined>(),
    mockSet,
    mockTransaction: vi.fn(<T extends unknown[]>(fn: (...args: T) => unknown) => {
      return (...args: T) => fn(...args);
    }),
  };
});

vi.mock('@/src/lib/db', () => ({
  getDb: () => ({ transaction: mockTransaction }),
  settingRepo: () => ({ getAll: mockGetAll, get: mockGet, set: mockSet }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  return {
    logger: { child, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    default: { logger: { child } },
  };
});

import { PUT } from '@/app/api/settings/route';

function jsonReq(body: unknown): Request {
  return new Request('http://localhost/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const seedDefaults = { scan_root: '/media' };

beforeEach(() => {
  mockGetAll.mockReset();
  mockGet.mockReset();
  mockSet.mockReset();
  mockTransaction.mockReset();
  mockGetAll.mockReturnValue({ ...seedDefaults });
  mockGet.mockImplementation((k: string) => seedDefaults[k as keyof typeof seedDefaults]);
  mockTransaction.mockImplementation(<T extends unknown[]>(fn: (...args: T) => unknown) => {
    return (...args: T) => fn(...args);
  });
});

describe('PUT /api/settings — bench default-matrix validators (T1)', () => {
  // === 5 HAPPY PATH ===
  it('test_bench_default_mode_accepts_native_sweep', async () => {
    const res = await PUT(jsonReq({ settings: { bench_default_mode: 'native-sweep' } }));
    expect(res.status).toBe(200);
  });

  it('test_bench_vmaf_buckets_accepts_descending_csv', async () => {
    // 16-04: shape narrowed 4 → 3.
    const res = await PUT(jsonReq({ settings: { bench_vmaf_buckets: '95,92,88' } }));
    expect(res.status).toBe(200);
  });

  it('test_bench_default_encoders_accepts_unique_whitelist_csv', async () => {
    const res = await PUT(jsonReq({ settings: { bench_default_encoders: 'libx265,hevc_nvenc' } }));
    expect(res.status).toBe(200);
  });

  it('test_bench_default_presets_accepts_unique_whitelist_csv', async () => {
    const res = await PUT(jsonReq({ settings: { bench_default_presets: 'medium,slow' } }));
    expect(res.status).toBe(200);
  });

  it('test_bench_default_native_values_accepts_unique_ints_below_64', async () => {
    const res = await PUT(jsonReq({ settings: { bench_default_native_values: '23,28' } }));
    expect(res.status).toBe(200);
  });

  // === 5 NEGATIVE PATH (some with sub-cases) ===
  it('test_bench_default_mode_rejects_unknown_enum', async () => {
    const res = await PUT(jsonReq({ settings: { bench_default_mode: 'foo' } }));
    expect(res.status).toBe(400);
  });

  it('test_bench_vmaf_buckets_rejects_unordered_csv', async () => {
    // Pareto-Math integrity: thresholds must be strictly descending.
    // 16-04: shape narrowed 4 → 3 — 3-element non-descending still rejects.
    const res = await PUT(jsonReq({ settings: { bench_vmaf_buckets: '88,92,95' } }));
    expect(res.status).toBe(400);
  });

  it('test_bench_default_encoders_rejects_duplicates_and_unknown', async () => {
    // Sub-case 1: duplicate libx265.
    const dup = await PUT(jsonReq({ settings: { bench_default_encoders: 'libx265,libx265' } }));
    expect(dup.status).toBe(400);
    // Sub-case 2: unknown encoder name.
    const unknown = await PUT(jsonReq({ settings: { bench_default_encoders: 'unknown_enc' } }));
    expect(unknown.status).toBe(400);
  });

  it('test_bench_default_presets_rejects_case_and_unknown', async () => {
    // Sub-case 1: lowercase regex violation via mixed-case input — fails whitelist refine.
    const upper = await PUT(jsonReq({ settings: { bench_default_presets: 'UPPER,Case' } }));
    expect(upper.status).toBe(400);
    // Sub-case 2: unknown preset name.
    const unknown = await PUT(jsonReq({ settings: { bench_default_presets: 'superSlow' } }));
    expect(unknown.status).toBe(400);
  });

  it('test_bench_default_native_values_rejects_above_63', async () => {
    // Silent FFmpeg-failure prevention: x265 CRF max 51, nvenc QP max 63.
    const res = await PUT(jsonReq({ settings: { bench_default_native_values: '75,99' } }));
    expect(res.status).toBe(400);
  });

  // === 3 REGRESSION (existing bench validators still work post-edit) ===
  it('test_bench_sample_count_regression_valid_and_invalid', async () => {
    const ok = await PUT(jsonReq({ settings: { bench_sample_count: '3' } }));
    expect(ok.status).toBe(200);
    const bad = await PUT(jsonReq({ settings: { bench_sample_count: '99' } }));
    expect(bad.status).toBe(400);
  });

  it('test_bench_sample_duration_seconds_regression_valid_and_invalid', async () => {
    const ok = await PUT(jsonReq({ settings: { bench_sample_duration_seconds: '20' } }));
    expect(ok.status).toBe(200);
    const bad = await PUT(jsonReq({ settings: { bench_sample_duration_seconds: '0' } }));
    expect(bad.status).toBe(400);
  });

  it('test_bench_vmaf_model_regression_valid_and_invalid', async () => {
    const ok = await PUT(jsonReq({ settings: { bench_vmaf_model: 'vmaf_v0.6.1' } }));
    expect(ok.status).toBe(200);
    const bad = await PUT(jsonReq({ settings: { bench_vmaf_model: '' } }));
    expect(bad.status).toBe(400);
  });

  // === FIX-A: vmaf_buckets whitespace tolerance + wrong-count rejection ===
  it('test_bench_vmaf_buckets_accepts_whitespace_around_commas', async () => {
    // 16-04: shape narrowed 4 → 3 — whitespace transform preserved.
    const res = await PUT(jsonReq({ settings: { bench_vmaf_buckets: '95, 92, 88' } }));
    expect(res.status).toBe(200);
  });

  // 16-04: legacy 4-element shape now rejects (was happy-path pre-16-04).
  it('test_bench_vmaf_buckets_rejects_four_values_legacy_shape', async () => {
    const res = await PUT(jsonReq({ settings: { bench_vmaf_buckets: '95,92,88,85' } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details: Array<{ path: (string | number)[] }> };
    expect(body.details[0].path).toEqual(['settings', 'bench_vmaf_buckets']);
  });

  // 16-04 audit-SR6: direct-API count-mismatch surfaces error-message "exactly 3".
  it('test_bench_vmaf_buckets_rejects_four_values_error_message_contains_exactly_3', async () => {
    const res = await PUT(jsonReq({ settings: { bench_vmaf_buckets: '95,92,88,85' } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details: Array<{ message: string }> };
    expect(body.details[0].message).toContain('exactly 3');
  });

  it('test_bench_vmaf_buckets_rejects_five_values', async () => {
    const res = await PUT(jsonReq({ settings: { bench_vmaf_buckets: '95,92,88,85,80' } }));
    expect(res.status).toBe(400);
  });

  // 16-04 audit-SR6: count-too-short server-enforced.
  it('test_bench_vmaf_buckets_rejects_two_values_with_exactly_3_message', async () => {
    const res = await PUT(jsonReq({ settings: { bench_vmaf_buckets: '95,92' } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details: Array<{ message: string }> };
    expect(body.details[0].message).toContain('exactly 3');
  });

  // 16-04: count-one rejected (regex anchor enforces minimum-2-repeats).
  it('test_bench_vmaf_buckets_rejects_one_value', async () => {
    const res = await PUT(jsonReq({ settings: { bench_vmaf_buckets: '95' } }));
    expect(res.status).toBe(400);
  });
});
