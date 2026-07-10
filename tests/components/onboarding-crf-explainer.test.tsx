/*
 * 20-03 Plan Task 5 — CRFExplainer vitest cases.
 *
 * Covers AC-5, AC-6, AC-15 (boundary-clamp), AC-16 (kill-switch),
 * StrictMode firstOpenRef idempotency, i18n parity.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import React, { StrictMode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

const { mockLoggerInfo } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Base UI Tooltip uses a Portal that waits on trigger anchor measurements.
// In jsdom the anchor reports 0x0 so the portal never mounts its content,
// which makes the marker (rendered inside TooltipContent) unfindable.
// Stub the primitives to render inline — preserves behavior we care about
// (trigger button click → logger fires; marker style.left tracks currentValue)
// without depending on portal positioning.
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

import { CRFExplainer } from '@/components/onboarding/crf-explainer';

function wrap(ui: React.ReactNode, locale: 'en' | 'de' = 'en') {
  const messages = locale === 'en' ? en : de;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe('CRFExplainer — trigger + tooltip', () => {
  beforeEach(() => {
    mockLoggerInfo.mockClear();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('test_crf_explainer_trigger_renders_with_aria_label_and_min_touch_target', () => {
    render(wrap(<CRFExplainer encoder="libx265" currentValue={23} />));
    const trigger = screen.getByRole('button', { name: /CRF explainer/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger.className).toMatch(/min-h-\[44px\]/);
    expect(trigger.className).toMatch(/min-w-\[44px\]/);
  });

  it('test_crf_explainer_marker_at_left_0_when_value_0 (AC-15_boundary_low)', async () => {
    render(wrap(<CRFExplainer encoder="libx265" currentValue={0} />));
    // Force tooltip open via click so marker mounts (portal flush is async on CI).
    fireEvent.click(screen.getByRole('button', { name: /CRF explainer/i }));
    const marker = (await screen.findByTestId('crf-explainer-marker')) as HTMLElement;
    expect(marker.style.left).toBe('0%');
  });

  it('test_crf_explainer_marker_at_left_100_when_value_51 (AC-15_boundary_high)', async () => {
    render(wrap(<CRFExplainer encoder="libx265" currentValue={51} />));
    fireEvent.click(screen.getByRole('button', { name: /CRF explainer/i }));
    const marker = (await screen.findByTestId('crf-explainer-marker')) as HTMLElement;
    expect(marker.style.left).toBe('100%');
  });

  it('test_crf_explainer_marker_clamped_when_value_exceeds_scale_max (AC-15_out_of_range)', async () => {
    render(wrap(<CRFExplainer encoder="libx265" currentValue={75} />));
    fireEvent.click(screen.getByRole('button', { name: /CRF explainer/i }));
    const marker = (await screen.findByTestId('crf-explainer-marker')) as HTMLElement;
    expect(marker.style.left).toBe('100%');
  });

  it('test_crf_explainer_marker_defensive_when_value_is_NaN', async () => {
    render(wrap(<CRFExplainer encoder="libx265" currentValue={NaN} />));
    fireEvent.click(screen.getByRole('button', { name: /CRF explainer/i }));
    const marker = (await screen.findByTestId('crf-explainer-marker')) as HTMLElement;
    expect(marker.style.left).toBe('0%');
  });

  it('test_crf_explainer_logger_fires_once_on_first_open_per_mount (AC-5)', async () => {
    render(wrap(<CRFExplainer encoder="qsv" currentValue={22} />));
    const trigger = screen.getByRole('button', { name: /CRF explainer/i });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'onboarding.qualityStep.crfExplainerOpened',
        encoder: 'qsv',
        crfValue: 22,
      }),
    );
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it('test_crf_explainer_strictmode_double_mount_logger_fires_once (StrictMode_idempotent)', async () => {
    render(<StrictMode>{wrap(<CRFExplainer encoder="vaapi" currentValue={22} />)}</StrictMode>);
    const triggers = screen.getAllByRole('button', { name: /CRF explainer/i });
    // StrictMode may yield two instances; click the first only.
    fireEvent.click(triggers[0]);
    fireEvent.click(triggers[0]);
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it('test_crf_explainer_de_locale_trigger_aria_label_translated', () => {
    render(wrap(<CRFExplainer encoder="libx265" currentValue={23} />, 'de'));
    expect(screen.getByRole('button', { name: /CRF-Erklärung/i })).toBeInTheDocument();
  });
});

describe('CRFExplainer — kill-switch (AC-16)', () => {
  beforeEach(() => {
    mockLoggerInfo.mockClear();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('test_crf_explainer_null_when_kill_switch_env_var_set', async () => {
    vi.stubEnv('NEXT_PUBLIC_ONBOARDING_CRF_EXPLAINER_DISABLED', '1');
    const mod = await import('@/components/onboarding/crf-explainer');
    const { container } = render(wrap(<mod.CRFExplainer encoder="libx265" currentValue={23} />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('button[aria-label*="CRF"]')).toBeNull();
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});
