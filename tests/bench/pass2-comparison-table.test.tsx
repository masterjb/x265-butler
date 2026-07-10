// 11-05: Pass2ComparisonTable — 3-column comparison view of Top-3 combos' Pass-2 results.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Pass2ComparisonTable } from '@/components/bench/pass2-comparison-table';
import type { BenchComboRow, Top3Role } from '@/src/lib/db/schema';

const MESSAGES = {
  bench: {
    compareTable: {
      heading: 'Pass-2 comparison',
      notVerified: 'Not verified',
      awaitingVerify: 'Awaiting verify',
      vmafLabel: 'VMAF',
      sizeLabel: 'Size',
      timeLabel: 'Time',
      sameComboAs: 'Same combo as {roleTitle}',
    },
    top3: {
      size: { title: 'Smallest size' },
      balanced: { title: 'Balanced' },
      quality: { title: 'Highest quality' },
      savesPct: 'saves {pct}%',
      worseByPct: '+{pct}% worse',
      noSavings: 'no savings',
    },
  },
};

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={MESSAGES} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function makeCombo(overrides: Partial<BenchComboRow> = {}): BenchComboRow {
  return {
    id: 42,
    run_id: 1,
    file_id: 10,
    encoder: 'libx265',
    preset: 'medium',
    native_quality_param: '-crf',
    native_quality_value: 23,
    vmaf_target: null,
    sample_idx: 0,
    vmaf: 90,
    size_bytes: 100,
    encode_seconds: 5,
    source_sample_bytes: 200,
    pass2_vmaf: 92.34,
    pass2_size_bytes: 2_500_000_000,
    pass2_encode_seconds: 581.4,
    pass2_completed_at: 1700000000,
    status: 'complete',
    error_reason: null,
    is_pareto: 1,
    top3_role: 'balanced',
    created_at: 1,
    completed_at: 2,
    ...overrides,
  };
}

function makeByRole(combos: BenchComboRow[]): Record<Top3Role, BenchComboRow | undefined> {
  const map: Record<Top3Role, BenchComboRow | undefined> = {
    size: undefined,
    balanced: undefined,
    quality: undefined,
  };
  for (const c of combos) {
    if (c.top3_role) map[c.top3_role] = c;
  }
  return map;
}

const ALL_THREE_VERIFIED = [
  makeCombo({ id: 1, top3_role: 'size', pass2_vmaf: 88.0, pass2_size_bytes: 1_000_000_000 }),
  makeCombo({ id: 2, top3_role: 'balanced', pass2_vmaf: 92.34, pass2_size_bytes: 2_500_000_000 }),
  makeCombo({ id: 3, top3_role: 'quality', pass2_vmaf: 96.0, pass2_size_bytes: 4_000_000_000 }),
];

describe('Pass2ComparisonTable (11-05 AC-1..AC-6)', () => {
  // Test 1: heading renders
  it('renders heading', () => {
    render(
      wrap(
        <Pass2ComparisonTable
          combosByRole={makeByRole(ALL_THREE_VERIFIED)}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByText('Pass-2 comparison')).toBeInTheDocument();
  });

  // Test 2: 3 columns, one per role
  it('renders 3 columns via data-testid', () => {
    render(
      wrap(
        <Pass2ComparisonTable
          combosByRole={makeByRole(ALL_THREE_VERIFIED)}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByTestId('compare-col-size')).toBeInTheDocument();
    expect(screen.getByTestId('compare-col-balanced')).toBeInTheDocument();
    expect(screen.getByTestId('compare-col-quality')).toBeInTheDocument();
  });

  // Test 3: verified combo shows VMAF value
  it('verified combo shows VMAF value', () => {
    render(
      wrap(
        <Pass2ComparisonTable
          combosByRole={makeByRole(ALL_THREE_VERIFIED)}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByText('92.34')).toBeInTheDocument();
    expect(screen.getByText('88.00')).toBeInTheDocument();
    expect(screen.getByText('96.00')).toBeInTheDocument();
  });

  // Test 4: verified combo shows formatted size
  it('verified combo shows formatted size (contains GiB or MiB)', () => {
    render(
      wrap(
        <Pass2ComparisonTable
          combosByRole={makeByRole(ALL_THREE_VERIFIED)}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    const sizeLabels = screen.getAllByText('Size');
    expect(sizeLabels.length).toBe(3);
    // At least one GiB value rendered (1_000_000_000 bytes ≈ 0.93 GiB)
    const sizeText = screen.getAllByText(/GiB|MiB/);
    expect(sizeText.length).toBeGreaterThan(0);
  });

  // Test 5: verified combo shows savings% sub-line
  it('savings% sub-line renders when sourceFullFileBytes > 0 and size < source', () => {
    // 1GB verified vs 5GB source = 80% savings
    const combo = makeCombo({ id: 1, top3_role: 'balanced', pass2_size_bytes: 1_000_000_000 });
    render(
      wrap(
        <Pass2ComparisonTable
          combosByRole={makeByRole([combo])}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByText(/saves 80%/)).toBeInTheDocument();
  });

  // Test 6: all 3 unverified combos show "—" placeholder in all 3 metric cells each
  it('unverified combo shows muted placeholder in all metric cells', () => {
    const unverified = [
      makeCombo({
        id: 1,
        top3_role: 'size',
        pass2_completed_at: null,
        pass2_vmaf: null,
        pass2_size_bytes: null,
        pass2_encode_seconds: null,
      }),
      makeCombo({
        id: 2,
        top3_role: 'balanced',
        pass2_completed_at: null,
        pass2_vmaf: null,
        pass2_size_bytes: null,
        pass2_encode_seconds: null,
      }),
      makeCombo({
        id: 3,
        top3_role: 'quality',
        pass2_completed_at: null,
        pass2_vmaf: null,
        pass2_size_bytes: null,
        pass2_encode_seconds: null,
      }),
    ];
    render(
      wrap(
        <Pass2ComparisonTable
          combosByRole={makeByRole(unverified)}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    const dashes = screen.getAllByText('—');
    // 3 metric cells × 3 unverified columns = 9 dashes
    expect(dashes.length).toBe(9);
  });

  // Test 7: role icons render for each role
  it('role icons render for size, balanced, quality', () => {
    render(
      wrap(
        <Pass2ComparisonTable
          combosByRole={makeByRole(ALL_THREE_VERIFIED)}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByTestId('compare-icon-size')).toBeInTheDocument();
    expect(screen.getByTestId('compare-icon-balanced')).toBeInTheDocument();
    expect(screen.getByTestId('compare-icon-quality')).toBeInTheDocument();
  });

  // Test 8: combo config line renders (encoder + preset + param=value)
  it('combo config line renders with encoder preset param=value', () => {
    render(
      wrap(
        <Pass2ComparisonTable
          combosByRole={makeByRole(ALL_THREE_VERIFIED)}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    const configLines = screen.getAllByText('libx265 medium -crf=23');
    expect(configLines.length).toBe(3);
  });

  // Test 9: missing combo (no row for a role) renders column without config/metrics
  it('missing combo renders column without combo config line', () => {
    // Only size combo present — balanced and quality columns have no combo
    const onlySize = makeCombo({ id: 1, top3_role: 'size' });
    render(
      wrap(
        <Pass2ComparisonTable
          combosByRole={makeByRole([onlySize])}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    // All 3 columns still render
    expect(screen.getByTestId('compare-col-size')).toBeInTheDocument();
    expect(screen.getByTestId('compare-col-balanced')).toBeInTheDocument();
    expect(screen.getByTestId('compare-col-quality')).toBeInTheDocument();
    // balanced + quality: no config line, all 3 metric cells show "—" each = 6 dashes total
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBe(6);
  });

  // Test 11: duplicate combos show "Same combo as" hint
  it('test_sameComboAs_hint_renders_when_two_roles_share_identical_settings', () => {
    // size and balanced share identical settings → balanced shows hint
    const sizeCombo = makeCombo({
      id: 1,
      top3_role: 'size',
      encoder: 'libx265',
      preset: 'medium',
      native_quality_value: 23,
      vmaf_target: null,
    });
    const balancedCombo = makeCombo({
      id: 2,
      top3_role: 'balanced',
      encoder: 'libx265',
      preset: 'medium',
      native_quality_value: 23,
      vmaf_target: null,
    });
    const qualityCombo = makeCombo({
      id: 3,
      top3_role: 'quality',
      encoder: 'libx265',
      preset: 'slow',
      native_quality_value: 20,
      vmaf_target: null,
    });
    render(
      wrap(
        <Pass2ComparisonTable
          combosByRole={makeByRole([sizeCombo, balancedCombo, qualityCombo])}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByTestId('compare-same-as-balanced')).toBeInTheDocument();
    expect(screen.getByText(/Same combo as Smallest size/)).toBeInTheDocument();
    // quality and size are NOT duplicates → no hint on quality or size
    expect(screen.queryByTestId('compare-same-as-size')).toBeNull();
    expect(screen.queryByTestId('compare-same-as-quality')).toBeNull();
  });

  // Test 10: sourceFullFileBytes=0 — no savings sub-line, no crash
  it('savingsUnavailable: no savings sub-line when sourceFullFileBytes=0', () => {
    render(
      wrap(
        <Pass2ComparisonTable
          combosByRole={makeByRole(ALL_THREE_VERIFIED)}
          sourceFullFileBytes={0}
        />,
      ),
    );
    expect(screen.queryByText(/saves \d+%/)).toBeNull();
    expect(screen.queryByText(/\+\d+% worse/)).toBeNull();
    // Component still renders without crashing
    expect(screen.getByText('Pass-2 comparison')).toBeInTheDocument();
  });
});
