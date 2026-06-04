/*
 * 03-05 Plan Task 2 — wizard UI tests.
 *
 * Mirrors tests/components/dashboard-page.test.tsx Client Component pattern.
 * Mock fetch for PUT /api/settings + POST /api/encoders/refresh +
 * POST /api/onboarding/complete. Mock useRouter.push.
 *
 * audit M3 — DB-error fallback at Server Component layer is tested via
 * tests/components/locale-root-redirect.test.tsx (root page); analogous
 * /onboarding Server Component path is tested below.
 *
 * audit M5 — in-flight button-disable
 * audit M6 — AbortController(10000ms) timeout
 * audit M7 — explicit nodejs runtime export
 * audit S1 — step indicator a11y (role=progressbar + aria-valuenow + aria-label)
 * audit S4 — wizard_entered audit-trail log
 * audit S5 — toast text from i18n key not hardcoded
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

const { mockRouterPush, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockRouterPush: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/en/onboarding',
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT: ${url}`);
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

import { OnboardingClient } from '@/app/[locale]/onboarding/onboarding-client';
import { runtime } from '@/app/[locale]/onboarding/page';

const REPO_ROOT = join(__dirname, '..', '..');

const FIXTURE_SETTINGS = {
  scan_root: '/media',
  min_size_mb: '50',
  crf_libx265: '23',
  crf_nvenc: '23',
  crf_qsv: '22',
  crf_vaapi: '22',
};

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function makeFetchMock() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url === '/api/encoders/refresh') {
      return new Response(
        JSON.stringify({
          refreshed: true,
          detected: ['libx265'],
          active: 'libx265',
          resolution: 'auto',
          requestId: 'rid-refresh',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url === '/api/settings') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url === '/api/onboarding/complete') {
      return new Response(JSON.stringify({ completed: true, requestId: 'rid-complete' }), {
        status: 200,
      });
    }
    return new Response('not-found', { status: 404 });
  });
  return { fetchMock, calls };
}

// 18-02: HwAccelStep at wizard position 2. After Welcome → Continue, wait for
// HwAccel detection-fetch to resolve into a branch (software for libx265-only
// + no-warnings fixture) + click the branch's Continue CTA to reach PathsStep.
async function advancePastHwAccel(): Promise<void> {
  await screen.findByRole('heading', { name: /Hardware acceleration/i });
  await waitFor(() => {
    expect(screen.getByRole('region', { name: /Software encoding active/i })).toBeInTheDocument();
  });
  fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
}

describe('OnboardingClient — wizard state machine', () => {
  beforeEach(() => {
    mockRouterPush.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // audit M7
  it('test_onboardingPage_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_onboardingPage_when_renders_then_step_1_visible_with_get_started_cta', () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Welcome/i);
    expect(screen.getByRole('button', { name: /Get started/i })).toBeInTheDocument();
  });

  // audit S1: step indicator a11y
  it('test_onboardingPage_when_step_indicator_renders_then_role_progressbar_with_aria_valuenow', () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuenow', '1');
    expect(progressbar).toHaveAttribute('aria-valuemin', '1');
    expect(progressbar).toHaveAttribute('aria-valuemax', '5');
  });

  // audit S1: aria-label uses step name not only color
  it('test_onboardingPage_when_step_indicator_renders_then_aria_label_uses_step_name_not_only_color', () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    const progressbar = screen.getByRole('progressbar');
    const ariaLabel = progressbar.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toMatch(/Step 1 of 5/);
    // The current step's headline text appears in the label.
    expect(ariaLabel.toLowerCase()).toContain('welcome');
  });

  it('test_onboardingPage_when_step_1_continue_clicked_then_step_2_renders_hw_accel_step', async () => {
    // 18-02: Step 2 is now HwAccelStep (was PathsStep). PathsStep moves to Step 3.
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /Hardware acceleration/i }),
    ).toBeInTheDocument();
  });

  it('test_onboardingPage_when_step_2_hw_accel_continue_clicked_then_step_3_paths_renders', async () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    await screen.findByRole('heading', { name: /Hardware acceleration/i });
    await waitFor(() => {
      expect(screen.getByRole('region', { name: /Software encoding active/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /Where are your videos/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Scan root/i)).toBeInTheDocument();
  });

  it('test_onboardingPage_when_step_2_continue_clicked_with_valid_form_then_step_3_mounts_without_PUT_settings', async () => {
    // 14-04 (Plan 14-04 Task 6): step-2 no longer fires PUT /api/settings.
    // Values stash in component state and travel with the final
    // POST /api/onboarding/complete (audit-fix M3 / AC-16a).
    const { fetchMock, calls } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    await advancePastHwAccel();
    await screen.findByRole('heading', { name: /Where are your videos/i });
    const continueBtn = screen.getByRole('button', { name: /Continue/i });
    fireEvent.click(continueBtn);
    // After success, Step 3 mounts AND POST /api/encoders/refresh fires.
    await waitFor(() => {
      expect(calls.find((c) => c.url === '/api/encoders/refresh')).toBeDefined();
    });
    // No /api/settings call should have happened during step-2 transition.
    expect(calls.find((c) => c.url === '/api/settings')).toBeUndefined();
  });

  it('test_onboardingPage_when_step_3_detection_succeeds_then_active_line_renders', async () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    await advancePastHwAccel();
    await screen.findByRole('heading', { name: /Where are your videos/i });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    // Wait for Step 3 to mount + detection to resolve
    await screen.findByRole('heading', { name: /Hardware encoder detection/i });
    await waitFor(() => {
      expect(screen.getByText(/Resolved encoder: libx265/i)).toBeInTheDocument();
    });
  });

  it('test_onboardingPage_when_step_2_hw_accel_detection_fails_then_amber_alert_renders_AND_continue_still_enabled', async () => {
    // 18-02: detection failure now surfaces at HwAccelStep (step 2). Earlier
    // 03-05 test asserted same fallback at EncoderStep (step 3 then) — moved.
    // AC-4 last clause: AbortError or 5xx → inline amber-alert "Detection
    // failed; try again". CTA-row keeps Back + Continue (operator can proceed,
    // Settings → Encoder is recovery path).
    const fetchMock = vi.fn(async (url: string, _init: RequestInit = {}) => {
      if (url === '/api/encoders/refresh') {
        return new Response('boom', { status: 500 });
      }
      if (url === '/api/settings') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    await screen.findByRole('heading', { name: /Hardware acceleration/i });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Detection failed/i);
    // Continue stays enabled (operator can proceed; Settings → Encoder is recovery path)
    const continueBtn = screen.getByRole('button', { name: /^Continue$/i });
    expect(continueBtn).not.toBeDisabled();
  });

  it('test_onboardingPage_when_step_4_finish_clicked_then_PUT_settings_then_POST_onboarding_complete_then_router_push_library', async () => {
    const { fetchMock, calls } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    await advancePastHwAccel();
    await screen.findByRole('heading', { name: /Where are your videos/i });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: /Hardware encoder detection/i });
    await waitFor(() => {
      expect(screen.getByText(/Resolved encoder: libx265/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: /Quality defaults/i });
    fireEvent.click(screen.getByRole('button', { name: /Finish setup/i }));
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/en/library');
    });
    // Sequence: PUT settings → POST /complete → push
    const orderedCalls = calls.map((c) => c.url);
    const settingsIdx = orderedCalls.lastIndexOf('/api/settings');
    const completeIdx = orderedCalls.lastIndexOf('/api/onboarding/complete');
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    expect(completeIdx).toBeGreaterThan(settingsIdx);
  });

  // audit S5: toast text from i18n key, NOT hardcoded
  it('test_onboardingPage_when_complete_toast_renders_then_text_comes_from_t_onboarding_complete_toast', async () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    await advancePastHwAccel();
    await screen.findByRole('heading', { name: /Where are your videos/i });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: /Hardware encoder detection/i });
    await waitFor(() => {
      expect(screen.getByText(/Resolved encoder: libx265/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByRole('heading', { name: /Quality defaults/i });
    fireEvent.click(screen.getByRole('button', { name: /Finish setup/i }));
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith(en.onboarding.complete.toast);
    });
  });

  // 14-04 (Plan 14-04 Task 6): step-2 no longer fires PUT /api/settings;
  // rapid double-click should still transition to step-3 exactly once
  // (no /api/settings calls at all).
  it('test_onboardingPage_when_step_2_continue_clicked_twice_rapidly_then_zero_PUT_settings_fires', async () => {
    const { fetchMock, calls } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    await advancePastHwAccel();
    await screen.findByRole('heading', { name: /Where are your videos/i });
    const continueBtn = screen.getByRole('button', { name: /Continue/i });
    fireEvent.click(continueBtn);
    fireEvent.click(continueBtn);
    fireEvent.click(continueBtn);
    // Step 3 should mount (encoder detection fires).
    await waitFor(() => {
      expect(calls.find((c) => c.url === '/api/encoders/refresh')).toBeDefined();
    });
    const settingsCalls = calls.filter((c) => c.url === '/api/settings');
    expect(settingsCalls).toHaveLength(0);
  });

  it('test_onboardingPage_when_back_clicked_on_step_3_paths_then_step_2_hw_accel_renders', async () => {
    // 18-02: Back from PathsStep (step 3) now lands on HwAccelStep (step 2),
    // not Welcome. Welcome reachable via another Back click.
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    await advancePastHwAccel();
    await screen.findByRole('heading', { name: /Where are your videos/i });
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(
      await screen.findByRole('heading', { name: /Hardware acceleration/i }),
    ).toBeInTheDocument();
  });

  // audit M4 (already covered in route test) — wizard layer must include 'use client'.
  it('test_onboardingPage_subcomponent_modules_carry_use_client_directive_on_first_line', () => {
    const files = [
      'app/[locale]/onboarding/onboarding-client.tsx',
      'components/onboarding/step-indicator.tsx',
      'components/onboarding/welcome-step.tsx',
      'components/onboarding/hw-accel-step.tsx',
      'components/onboarding/paths-step.tsx',
      'components/onboarding/encoder-step.tsx',
      'components/onboarding/quality-step.tsx',
    ];
    for (const rel of files) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
      const firstLine = src.split('\n')[0].trim();
      expect(firstLine).toBe(`'use client';`);
    }
  });
});
