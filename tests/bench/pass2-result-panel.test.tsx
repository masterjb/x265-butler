// 11-03 AC-8: Pass2ResultPanel — verified-vs-projected emphasis-row.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Pass2ResultPanel } from '@/components/bench/pass2-result-panel';
import type { BenchComboRow } from '@/src/lib/db/schema';

const MESSAGES = {
  bench: {
    pass2: {
      heading: 'Pass-2 verified result',
      vmafLabel: 'VMAF',
      sizeLabel: 'Size',
      timeLabel: 'Time',
      deltaVsSample: 'Δ {delta} vs sample',
      savingsVsFull: '{pct}% saved vs full source',
      verifiedSourceFile: 'Source: {path}',
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

describe('Pass2ResultPanel (11-03 AC-8)', () => {
  it('renders heading + verified VMAF/Size/Time in 3-col layout', () => {
    render(wrap(<Pass2ResultPanel combo={makeCombo()} sourceFullFileBytes={5_000_000_000} />));
    expect(screen.getByText('Pass-2 verified result')).toBeInTheDocument();
    expect(screen.getByText('92.34')).toBeInTheDocument();
  });

  it('renders Δ vs sample for VMAF when both present', () => {
    render(
      wrap(
        <Pass2ResultPanel
          combo={makeCombo({ vmaf: 91, pass2_vmaf: 93.5 })}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByText(/Δ \+2\.50 vs sample/)).toBeInTheDocument();
  });

  it('emphasis-row shows positive savings when verified < source', () => {
    // 2.5GB verified vs 5GB source = 50% saved
    render(wrap(<Pass2ResultPanel combo={makeCombo()} sourceFullFileBytes={5_000_000_000} />));
    expect(screen.getByText(/50% saved vs full source/)).toBeInTheDocument();
  });

  it('emphasis-row shows negative savings when verified > source', () => {
    // 6GB verified vs 5GB source = -20% saved (worse)
    render(
      wrap(
        <Pass2ResultPanel
          combo={makeCombo({ pass2_size_bytes: 6_000_000_000 })}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByText(/-20% saved vs full source/)).toBeInTheDocument();
  });

  it('returns null when pass2 metrics not yet present', () => {
    const { container } = render(
      wrap(
        <Pass2ResultPanel
          combo={makeCombo({ pass2_vmaf: null, pass2_size_bytes: null })}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(container.firstChild).toBeNull();
  });

  it('omits savings emphasis-row when sourceFullFileBytes is 0', () => {
    render(wrap(<Pass2ResultPanel combo={makeCombo()} sourceFullFileBytes={0} />));
    expect(screen.queryByText(/saved vs full source/)).toBeNull();
  });

  // 11-03 UAT request: provenance line — Top-3 role title + combo-config
  it('test_provenance_line_renders_role_title_balanced_when_combo_top3_role_is_balanced', () => {
    render(
      wrap(
        <Pass2ResultPanel
          combo={makeCombo({ top3_role: 'balanced' })}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByText('Balanced')).toBeInTheDocument();
  });

  it('test_provenance_line_renders_role_title_size_when_combo_top3_role_is_size', () => {
    render(
      wrap(
        <Pass2ResultPanel
          combo={makeCombo({ top3_role: 'size' })}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByText('Smallest size')).toBeInTheDocument();
  });

  it('test_provenance_line_renders_role_title_quality_when_combo_top3_role_is_quality', () => {
    render(
      wrap(
        <Pass2ResultPanel
          combo={makeCombo({ top3_role: 'quality' })}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByText('Highest quality')).toBeInTheDocument();
  });

  it('test_shows_savings_pct_sub_row_always_visible', () => {
    // 2.5GB verified vs 5GB source = 50% saved → tTop3('savesPct', { pct: 50 })
    render(wrap(<Pass2ResultPanel combo={makeCombo()} sourceFullFileBytes={5_000_000_000} />));
    const sizeLabel = screen.getByText('Size');
    const sizeDd = sizeLabel.nextElementSibling as HTMLElement;
    // dd always shows bytes
    expect(sizeDd.textContent).toMatch(/[A-Z]iB/);
    // savings% sub-row visible without any toggle
    expect(screen.getByText(/saves 50%/)).toBeInTheDocument();
  });

  it('test_shows_no_savings_sub_row_when_source_is_zero', () => {
    render(wrap(<Pass2ResultPanel combo={makeCombo()} sourceFullFileBytes={0} />));
    const sizeLabel = screen.getByText('Size');
    const sizeDd = sizeLabel.nextElementSibling as HTMLElement;
    // dd shows bytes even when source is 0
    expect(sizeDd.textContent).toMatch(/[A-Z]iB/);
    // no savings% sub-row when source size unknown
    expect(screen.queryByText(/saves \d+%/)).toBeNull();
  });

  it('test_provenance_line_renders_combo_config_string_with_encoder_preset_param_value', () => {
    render(
      wrap(
        <Pass2ResultPanel
          combo={makeCombo({
            encoder: 'libx265',
            preset: 'medium',
            native_quality_param: '-crf',
            native_quality_value: 23,
          })}
          sourceFullFileBytes={5_000_000_000}
        />,
      ),
    );
    expect(screen.getByText('libx265 medium -crf=23')).toBeInTheDocument();
  });
});
