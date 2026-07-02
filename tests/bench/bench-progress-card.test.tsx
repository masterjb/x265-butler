// 11-02-FIX (UAT-001): BenchProgressCard V3 layout — phasePct binding, key-snap, a11y.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { BenchProgressCard } from '@/components/bench/bench-progress-card';
import EN from '@/messages/en.json';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={EN} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe('BenchProgressCard — V3 layout (11-02-FIX)', () => {
  it('test_bar_aria_valuenow_reflects_phasePct_not_overallPct', () => {
    // Audit M2: bar source MUST be phasePct (currentComboPct), NOT overallPct.
    const { container } = render(
      wrap(
        <BenchProgressCard
          completedCombos={2}
          totalCombos={9}
          currentPhase="encode"
          fileCount={1}
          currentComboPct={73}
          currentComboOverallPct={54}
        />,
      ),
    );
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('73');
    // Big % top-right also reflects phasePct.
    expect(screen.getByText('73%')).toBeInTheDocument();
  });

  it('test_bar_fill_element_key_attribute_changes_with_phase_for_snap_reset', () => {
    // Audit M3: key={currentPhase} forces unmount+remount on phase change so the
    // 100→0 reset doesn't animate backwards. We verify by re-rendering with a
    // different phase and confirming the bar fill element is a new instance.
    const { container, rerender } = render(
      wrap(
        <BenchProgressCard
          completedCombos={0}
          totalCombos={9}
          currentPhase="encode"
          currentComboPct={100}
        />,
      ),
    );
    const firstFill = container.querySelector('[role="progressbar"] > div');
    expect(firstFill).toBeTruthy();

    rerender(
      wrap(
        <BenchProgressCard
          completedCombos={0}
          totalCombos={9}
          currentPhase="vmaf"
          currentComboPct={5}
        />,
      ),
    );
    const secondFill = container.querySelector('[role="progressbar"] > div');
    expect(secondFill).toBeTruthy();
    // React replaces the element when key changes — they are NOT the same DOM node.
    expect(secondFill).not.toBe(firstFill);
  });

  it('test_motion_reduce_class_present_on_bar_fill', () => {
    const { container } = render(
      wrap(
        <BenchProgressCard
          completedCombos={1}
          totalCombos={4}
          currentPhase="encode"
          currentComboPct={50}
        />,
      ),
    );
    const fill = container.querySelector('[role="progressbar"] > div');
    expect(fill?.className).toContain('motion-reduce:transition-none');
    expect(fill?.className).toContain('motion-safe:transition-all');
  });

  it('test_renders_encoder_line_when_currentComboEncoder_and_crf_provided', () => {
    render(
      wrap(
        <BenchProgressCard
          completedCombos={0}
          totalCombos={9}
          currentPhase="encode"
          currentComboPct={20}
          currentComboEncoder="libx265"
          currentComboCrf={22}
        />,
      ),
    );
    expect(screen.getByText('libx265 @ CRF 22')).toBeInTheDocument();
  });
});
