/*
 * 20-03 Plan Task 5 — QualityStep CRFExplainer integration cases.
 *
 * Covers AC-5, AC-6, AC-15 wiring (CRFExplainer rendered per CRF field +
 * scale marker tracks form.watch updates), preserves existing 03-05 contract
 * (first-field-focus + valueAsNumber).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
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
