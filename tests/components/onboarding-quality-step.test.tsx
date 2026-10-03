/*
 * 20-03 Plan Task 5 — QualityStep CRFExplainer integration cases.
 *
 * Covers AC-5, AC-6, AC-15 wiring (CRFExplainer rendered per CRF field +
 * scale marker tracks form.watch updates), preserves existing 03-05 contract
 * (first-field-focus + valueAsNumber).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

vi.mock('@/src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Base UI Tooltip Portal never mounts in jsdom (trigger reports 0x0 bounds).
// Stub primitives to render inline — see crf-explainer test file for rationale.
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button data-slot="tooltip-trigger" {...props}>
      {children}
    </button>
  ),
  TooltipContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-slot="tooltip-content" className={className}>
      {children}
    </div>
  ),
}));

import { QualityStep } from '@/components/onboarding/quality-step';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const INITIAL_VALUES = {
  crf_libx265: '23',
  crf_nvenc: '23',
  crf_qsv: '22',
  crf_vaapi: '22',
};

describe('QualityStep — CRFExplainer integration', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('test_quality_step_renders_crf_explainer_per_field_4_triggers', () => {
    render(
      wrap(
        <QualityStep
          initialValues={INITIAL_VALUES}
          onComplete={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    const triggers = screen.getAllByRole('button', { name: /CRF explainer/i });
    expect(triggers).toHaveLength(4);
  });

  it('test_quality_step_first_field_auto_focused_preserves_03_05_contract', () => {
    render(
      wrap(
        <QualityStep
          initialValues={INITIAL_VALUES}
          onComplete={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    const libx265Input = screen.getByLabelText('libx265') as HTMLInputElement;
    expect(libx265Input).toBe(document.activeElement);
  });

  it('test_quality_step_scale_marker_tracks_form_watch_updates_on_input_change', async () => {
    render(
      wrap(
        <QualityStep
          initialValues={INITIAL_VALUES}
          onComplete={vi.fn()}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    // Open the libx265 CRFExplainer (first trigger) at initial value 23.
    const triggers = screen.getAllByRole('button', { name: /CRF explainer/i });
    fireEvent.click(triggers[0]);
    // Mock renders TooltipContent inline for all 4 fields → 4 markers; pick [0]
    // (libx265 field) since that's the one we're driving.
    let markers = await screen.findAllByTestId('crf-explainer-marker');
    const startLeft = (markers[0] as HTMLElement).style.left;

    // Change libx265 input to 51 (boundary). Tooltip stays open across the
    // form re-render so marker remains mounted; assert it now reflects 100%.
    const libx265Input = screen.getByLabelText('libx265') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(libx265Input, { target: { value: '51' } });
    });
    markers = await screen.findAllByTestId('crf-explainer-marker');
    expect((markers[0] as HTMLElement).style.left).toBe('100%');
    expect((markers[0] as HTMLElement).style.left).not.toBe(startLeft);
  });
});

// 52-04 AC-7: "Automatisch encodieren" switch in the last wizard step.
describe('QualityStep — auto-encode switch (52-04)', () => {
  afterEach(() => {
    cleanup();
  });

  // The finish button stays disabled until react-hook-form has resolved
  // isValid asynchronously after mount.
  async function submitWhenValid(): Promise<void> {
    const finish = screen.getByRole('button', { name: en.onboarding.step5.cta.finish });
    await waitFor(() => expect(finish.hasAttribute('disabled')).toBe(false));
    await act(async () => {
      fireEvent.click(finish);
    });
  }

  function renderStep(onComplete = vi.fn(), autoEncode?: boolean) {
    render(
      wrap(
        <QualityStep
          initialValues={{ ...INITIAL_VALUES, autoEncode }}
          onComplete={onComplete}
          onBack={vi.fn()}
          isSubmitting={false}
        />,
      ),
    );
    return onComplete;
  }

  it('test_quality_step_when_rendered_then_auto_encode_switch_off_by_default', () => {
    renderStep();
    const sw = screen.getByRole('switch', { name: en.onboarding.autoEncode.label });
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('test_quality_step_when_rendered_then_benchmark_hint_visible', () => {
    renderStep();
    expect(screen.getByText(en.onboarding.autoEncode.benchmarkHint)).toBeTruthy();
  });

  it('test_quality_step_when_finished_untouched_then_payload_auto_encode_false', async () => {
    const onComplete = renderStep();
    await submitWhenValid();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete.mock.calls[0][0].autoEncode).toBe(false);
  });

  it('test_quality_step_when_switch_toggled_then_payload_auto_encode_true', async () => {
    const onComplete = renderStep();
    fireEvent.click(screen.getByRole('switch', { name: en.onboarding.autoEncode.label }));
    await submitWhenValid();
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete.mock.calls[0][0].autoEncode).toBe(true);
  });

  it('test_quality_step_when_stashed_true_then_switch_starts_on', () => {
    renderStep(vi.fn(), true);
    const sw = screen.getByRole('switch', { name: en.onboarding.autoEncode.label });
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });
});
