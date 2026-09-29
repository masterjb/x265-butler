import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { Top3Cards } from '@/components/bench/top3-cards';
import type { AggregatedComboView } from '@/src/lib/db/schema';

const MESSAGES = {
  bench: {
    top3: {
      size: { title: 'Smallest size' },
      balanced: { title: 'Balanced' },
      quality: { title: 'Highest quality' },
      useThis: 'Verify on full file',
      applyAsDefaults: 'Apply as defaults',
      verifyTooltipReady: 'Run a bench to enable',
      noCandidate: 'No candidate',
      sizeLabel: 'Size',
      timeLabel: 'Time',
      // 11-02-FIX-V2 UAT-003 keys
      savesPct: 'saves {pct}%',
      worseByPct: '+{pct}% worse',
      savesBytes: '≈{bytes} on full file',
      noSavings: 'no savings',
      compressionUnavailable: 'Compression: legacy data',
      projectionAssumption: 'Projection assumes uniform compressibility across files',
      sameComboAs: 'Same combo as {roleTitle}',
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

function makeCombo(
  role: AggregatedComboView['top3_role'],
  encoder = 'libx265',
  overrides: Partial<AggregatedComboView> = {},
): AggregatedComboView {
  return {
    encoder,
    preset: 'medium',
    native_quality_param: 'crf',
    native_quality_value: 23,
    vmaf_target: null,
    vmaf: 92.5,
    sizeBytes: 500_000_000,
    encodeSec: 45,
    sourceSampleBytes: 2_000_000_000,
    sampleIds: [1],
    is_pareto: true,
    top3_role: role,
    ...overrides,
  };
}

describe('Top3Cards', () => {
  it('test_top3Cards_renders_3_cards_in_size_balanced_quality_dom_order', () => {
    // 3 distinct pareto combos along the front — small, mid, large size with rising VMAF
    const summary = [
      makeCombo('size', 'libx265', { sizeBytes: 100_000_000, vmaf: 88.0, encodeSec: 30 }),
      makeCombo('balanced', 'hevc_nvenc', {
        sizeBytes: 300_000_000,
        vmaf: 92.0,
        encodeSec: 45,
      }),
      makeCombo('quality', 'hevc_qsv', { sizeBytes: 600_000_000, vmaf: 96.0, encodeSec: 60 }),
    ];
    render(wrap(<Top3Cards summary={summary} mode="native-sweep" />));
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(3);
    // DOM order: size → balanced → quality (left-to-right Pareto X-axis)
    expect(cards[0]).toHaveAttribute('data-testid', 'top3-card-size');
    expect(cards[1]).toHaveAttribute('data-testid', 'top3-card-balanced');
    expect(cards[2]).toHaveAttribute('data-testid', 'top3-card-quality');
  });

  it('test_top3Cards_each_card_has_icon_prefix_not_color_only', () => {
    const summary = [makeCombo('quality'), makeCombo('balanced'), makeCombo('size')];
    render(wrap(<Top3Cards summary={summary} mode="native-sweep" />));
    expect(screen.getByTestId('top3-icon-size')).toBeInTheDocument();
    expect(screen.getByTestId('top3-icon-balanced')).toBeInTheDocument();
    expect(screen.getByTestId('top3-icon-quality')).toBeInTheDocument();
  });

  it('test_top3Cards_use_this_button_has_aria_disabled_and_describedby', () => {
    const summary = [makeCombo('quality')];
    render(wrap(<Top3Cards summary={summary} mode="native-sweep" />));
    const buttons = screen.getAllByRole('button');
    const disabledBtn = buttons.find((b) => b.getAttribute('aria-disabled') === 'true');
    expect(disabledBtn).toBeTruthy();
    expect(disabledBtn).toHaveAttribute('aria-describedby');
  });

  it('test_top3Cards_pareto_length_1_renders_same_combo_in_all_3_cards', () => {
    // Single pareto combo → all 3 roles point to it (size = balanced = quality)
    const summary = [makeCombo('quality')];
    render(wrap(<Top3Cards summary={summary} mode="native-sweep" />));
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(3);
    // No card should be empty — all show the single pareto combo
    expect(cards[0]).not.toHaveAttribute('aria-disabled');
    expect(cards[1]).not.toHaveAttribute('aria-disabled');
    expect(cards[2]).not.toHaveAttribute('aria-disabled');
  });

  it('test_top3Cards_pareto_length_2_renders_size_and_balanced_same_quality_distinct', () => {
    // 2 pareto combos: smaller (size+balanced) and bigger (quality)
    const summary = [
      makeCombo('size', 'libx265', { sizeBytes: 100_000_000, vmaf: 88.0 }),
      makeCombo('quality', 'hevc_nvenc', { sizeBytes: 600_000_000, vmaf: 96.0 }),
    ];
    render(wrap(<Top3Cards summary={summary} mode="native-sweep" />));
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(3);
    // All 3 cards populated — pickTop3 picks front[0] for size+balanced, front[1] for quality
    expect(cards[0]).not.toHaveAttribute('aria-disabled');
    expect(cards[1]).not.toHaveAttribute('aria-disabled');
    expect(cards[2]).not.toHaveAttribute('aria-disabled');
  });

  it('test_top3Cards_no_pareto_combos_renders_all_3_cards_empty', () => {
    // Empty summary → no pareto front → all cards empty
    render(wrap(<Top3Cards summary={[]} mode="native-sweep" />));
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveAttribute('aria-disabled', 'true');
    expect(cards[1]).toHaveAttribute('aria-disabled', 'true');
    expect(cards[2]).toHaveAttribute('aria-disabled', 'true');
  });

  // 11-02-FIX-V2 UAT-003: emphasis-row tests
  describe('emphasis-row (UAT-003)', () => {
    function makeSummaryWithSavings(
      sourceSampleBytes: number | null,
      sizeBytes: number,
    ): AggregatedComboView[] {
      return [
        // 3 distinct points so all 3 Top3 roles are filled
        makeCombo('size', 'libx265', { sizeBytes, sourceSampleBytes, vmaf: 88 }),
        makeCombo('balanced', 'libx265', {
          sizeBytes: sizeBytes * 2,
          sourceSampleBytes,
          vmaf: 92,
        }),
        makeCombo('quality', 'libx265', {
          sizeBytes: sizeBytes * 3,
          sourceSampleBytes,
          vmaf: 96,
        }),
      ];
    }

    it('test_renders_savesPct_with_TrendingDown_when_positive_savings', () => {
      const summary = makeSummaryWithSavings(1_000_000_000, 200_000_000); // 80% savings
      render(
        wrap(
          <Top3Cards
            summary={summary}
            mode="native-sweep"
            fileIds={[10]}
            fileSizeMap={{ 10: 5_000_000_000 }}
          />,
        ),
      );
      // Smallest-size card (1× size) shows the highest savings %
      const sizeCard = screen.getByTestId('top3-card-size');
      expect(sizeCard.textContent).toMatch(/saves 80%/);
    });

    it('test_renders_compressionUnavailable_when_sourceSampleBytes_null_audit_SR5_legacy', () => {
      const summary = makeSummaryWithSavings(null, 200_000_000);
      render(
        wrap(
          <Top3Cards
            summary={summary}
            mode="native-sweep"
            fileIds={[10]}
            fileSizeMap={{ 10: 5_000_000_000 }}
          />,
        ),
      );
      const sizeCard = screen.getByTestId('top3-card-size');
      expect(sizeCard.textContent).toMatch(/Compression: legacy data/);
    });

    it('test_renders_worseByPct_when_encoded_exceeds_source_audit_M4_negative_branch', () => {
      // sourceSampleBytes 100, encoded 150 → -50% savings (50% worse)
      const summary = makeSummaryWithSavings(100, 150);
      render(
        wrap(
          <Top3Cards
            summary={summary}
            mode="native-sweep"
            fileIds={[10]}
            fileSizeMap={{ 10: 5_000_000_000 }}
          />,
        ),
      );
      const sizeCard = screen.getByTestId('top3-card-size');
      expect(sizeCard.textContent).toMatch(/\+50% worse/);
    });

    it('test_renders_compressionUnavailable_when_fileSizeMap_empty', () => {
      const summary = makeSummaryWithSavings(1_000, 500);
      render(
        wrap(<Top3Cards summary={summary} mode="native-sweep" fileIds={[]} fileSizeMap={{}} />),
      );
      const sizeCard = screen.getByTestId('top3-card-size');
      expect(sizeCard.textContent).toMatch(/Compression: legacy data/);
    });
  });

  // 11-04 Option C: always-visible bytes + savings% sub-line (no toggle)
  describe('always-visible savings sub-line (11-04)', () => {
    function makeSavingsSummary(): AggregatedComboView[] {
      return [
        makeCombo('size', 'libx265', {
          sizeBytes: 200_000_000,
          sourceSampleBytes: 1_000_000_000,
          vmaf: 88,
        }),
        makeCombo('balanced', 'libx265', {
          sizeBytes: 400_000_000,
          sourceSampleBytes: 1_000_000_000,
          vmaf: 92,
        }),
        makeCombo('quality', 'libx265', {
          sizeBytes: 600_000_000,
          sourceSampleBytes: 1_000_000_000,
          vmaf: 96,
        }),
      ];
    }

    it('test_size_dd_always_shows_bytes_and_savings_pct_sub_line', () => {
      render(
        wrap(
          <Top3Cards
            summary={makeSavingsSummary()}
            mode="native-sweep"
            fileIds={[10]}
            fileSizeMap={{ 10: 5_000_000_000 }}
          />,
        ),
      );
      const sizeDd = screen.getByTestId('size-dd-size');
      expect(sizeDd.textContent).toMatch(/[A-Z]iB/);
      expect(sizeDd.textContent).toMatch(/%/);
    });

    it('test_size_dd_shows_bytes_only_when_savings_unavailable', () => {
      render(
        wrap(
          <Top3Cards
            summary={[makeCombo('size', 'libx265', { sourceSampleBytes: null, sizeBytes: 100 })]}
            mode="native-sweep"
            fileIds={[]}
            fileSizeMap={{}}
          />,
        ),
      );
      const sizeDd = screen.getByTestId('size-dd-size');
      expect(sizeDd.textContent).not.toMatch(/%/);
    });
  });

  // 11-03 AC-7: Pass-2 / Apply enable-path
  describe('11-03 AC-7 enable-path', () => {
    function makeBasicSummary(): AggregatedComboView[] {
      return [
        makeCombo('size', 'libx265', { sizeBytes: 100, vmaf: 88, sampleIds: [11] }),
        makeCombo('balanced', 'hevc_nvenc', { sizeBytes: 300, vmaf: 92, sampleIds: [12] }),
        makeCombo('quality', 'hevc_qsv', { sizeBytes: 600, vmaf: 96, sampleIds: [13] }),
      ];
    }

    it('test_runVerifiable_false_renders_disabled_useThis_button_with_tooltip', () => {
      render(wrap(<Top3Cards summary={makeBasicSummary()} mode="native-sweep" />));
      // All three cards: useThis label rendered but as aria-disabled
      const buttons = screen.getAllByRole('button');
      const disabledButtons = buttons.filter((b) => b.getAttribute('aria-disabled') === 'true');
      expect(disabledButtons.length).toBeGreaterThanOrEqual(3);
    });

    it('test_runVerifiable_true_renders_active_useThis_button_that_calls_onUseThis_with_comboId', () => {
      const onUseThis = vi.fn();
      render(
        wrap(
          <Top3Cards
            summary={makeBasicSummary()}
            mode="native-sweep"
            runVerifiable={true}
            onUseThis={onUseThis}
          />,
        ),
      );
      const allButtons = screen.getAllByRole('button');
      const useThisButton = allButtons.find(
        (b) =>
          b.textContent === 'Verify on full file' && b.getAttribute('aria-disabled') !== 'true',
      );
      expect(useThisButton).toBeTruthy();
      useThisButton!.click();
      expect(onUseThis).toHaveBeenCalledTimes(1);
      // The sampleIds[0] of one of the cards
      expect([11, 12, 13]).toContain(onUseThis.mock.calls[0][0]);
    });

    it('test_pass2Verified_renders_applyAsDefaults_button_and_calls_handler', () => {
      const onApply = vi.fn();
      render(
        wrap(
          <Top3Cards
            summary={makeBasicSummary()}
            mode="native-sweep"
            runVerifiable={true}
            isPass2Verified={(cid) => cid === 12}
            onApplyAsDefaults={onApply}
          />,
        ),
      );
      const applyBtn = screen.getByText('Apply as defaults');
      applyBtn.click();
      expect(onApply).toHaveBeenCalledWith(12);
    });

    it('test_pass2Running_disables_useThis_button_for_that_combo', () => {
      render(
        wrap(
          <Top3Cards
            summary={makeBasicSummary()}
            mode="native-sweep"
            runVerifiable={true}
            isPass2Running={(cid) => cid === 11}
          />,
        ),
      );
      const allButtons = screen.getAllByRole('button');
      const useThisButtons = allButtons.filter((b) => b.textContent === 'Verify on full file');
      const disabledOnes = useThisButtons.filter(
        (b) => b.getAttribute('aria-disabled') === 'true' || (b as HTMLButtonElement).disabled,
      );
      expect(disabledOnes.length).toBeGreaterThanOrEqual(1);
    });
  });
});
