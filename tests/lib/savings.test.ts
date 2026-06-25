// 11-02-FIX-V2 UAT-003: computeSavings + sumFileSizes pure-function tests.

import { describe, it, expect } from 'vitest';
import { computeSavings, sumFileSizes } from '@/src/lib/format/savings';

describe('computeSavings (11-02-FIX-V2)', () => {
  it('test_50pct_savings_yields_pct_50_and_proportional_full_file_bytes', () => {
    // sample 100 → 50 = 50% savings; full file 1_000_000_000 → projected 500_000_000 saved
    const result = computeSavings(100, 50, 1_000_000_000);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(50);
    expect(result!.projectedFullFileBytes).toBe(500_000_000);
  });

  it('test_negative_savings_surfaces_as_negative_pct_unclamped_audit_SR4', () => {
    // sample 100 → 250 = encoded 2.5× larger = -150% savings
    const result = computeSavings(100, 250, 1_000);
    expect(result).not.toBeNull();
    expect(result!.pct).toBe(-150);
    // Don't clamp — operator must see catastrophic mis-config honestly.
  });

  it('test_null_sourceSampleBytes_returns_null_legacy_row', () => {
    expect(computeSavings(null, 50, 1_000)).toBeNull();
  });

  it('test_zero_or_negative_source_returns_null_input_invariant', () => {
    expect(computeSavings(0, 50, 1_000)).toBeNull();
    expect(computeSavings(-1, 50, 1_000)).toBeNull();
  });

  it('test_zero_encoded_returns_null_audit_SR3_broken_encode_guard', () => {
    // Zero-byte output yields ratio=1 (100% savings) which would mislead operator.
    expect(computeSavings(100, 0, 1_000)).toBeNull();
    expect(computeSavings(100, -5, 1_000)).toBeNull();
  });
});

describe('sumFileSizes (11-02-FIX-V2)', () => {
  it('test_sums_all_present_ids_ignoring_missing', () => {
    const map = { 1: 100, 2: 200, 3: 300 };
    expect(sumFileSizes([1, 2, 3], map)).toBe(600);
    expect(sumFileSizes([1, 99], map)).toBe(100); // missing 99 → ignored
    expect(sumFileSizes([], map)).toBe(0);
  });

  it('test_silently_skips_invalid_entries', () => {
    const map: Record<number, number> = { 1: -50, 2: 200 };
    expect(sumFileSizes([1, 2], map)).toBe(200); // negative skipped
  });
});
