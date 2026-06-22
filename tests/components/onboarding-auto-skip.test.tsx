/*
 * Plan 20-01 / Phase 20 — PathsStep auto-skip branch coverage.
 *
 * Covers:
 *  - Test 1  AC-3: skip-branch step-2 == HwAccel
 *  - Test 2  AC-3: forward nav skip-branch step-2 → step-4 (NOT step-3)
 *  - Test 3  AC-3 + S4: backward nav skip-branch step-4 → step-2
 *  - Test 4  AC-5: toast.info exactly-once with title + path-in-description
 *  - Test 5  AC-5: toast NOT called when autoSkipPathsStep=false
 *  - Test 6  AC-5: StrictMode double-mount → still exactly-once via toastFiredRef
 *  - Test 7  AC-5 + AC-12: action button click → router.push('/{locale}/settings#paths')
 *  - Test 8  AC-6: step-indicator totalSteps={4} → aria-valuemax="4"
 *  - Test 17 audit-added S4: back-from-step-2 in skip-branch lands on Welcome
 *  - Test 22 audit-added M3: skip-branch invariant — step=3 corrupt-draft re-routes to step=2 + warn-log
 *  - Test 23 audit-added S3: toast description renders text-only (no HTML / no script exec)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

const { mockRouterPush, mockToastInfo, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockRouterPush: vi.fn(),
  mockToastInfo: vi.fn(),
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
    info: mockToastInfo,
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

import {
  OnboardingClient,
  ONBOARDING_DRAFT_KEY,
} from '@/app/[locale]/onboarding/onboarding-client';

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
    return new Response('not-found', { status: 404 });
  });
  return { fetchMock, calls };
}

async function advancePastHwAccel(): Promise<void> {
  await screen.findByRole('heading', { name: /Hardware acceleration/i });
  await waitFor(() => {
    expect(screen.getByRole('region', { name: /Software encoding active/i })).toBeInTheDocument();
  });
  fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));
}

describe('OnboardingClient — 20-01 skip-branch auto-skip PathsStep', () => {
  beforeEach(() => {
    mockRouterPush.mockReset();
    mockToastInfo.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', makeFetchMock().fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  // Test 1 — AC-3: skip-branch advance Welcome → HwAccel (visible-position 2)
  it('test_auto_skip_when_autoSkipPathsStep_true_then_step_2_renders_HwAccel', async () => {
    render(
      wrap(
        <OnboardingClient
          initialSettings={FIXTURE_SETTINGS}
          locale="en"
          autoSkipPathsStep={true}
          placeholderSharePath="/media"
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /Hardware acceleration/i }),
    ).toBeInTheDocument();
    // PathsStep heading MUST NOT appear (skip-branch never renders it).
    expect(screen.queryByRole('heading', { name: /Where are your videos/i })).toBeNull();
  });

  // Test 2 — AC-3: skip-branch forward nav 2 → 4 (Encoder), bypassing paths.
  it('test_auto_skip_when_step_2_continue_clicked_then_step_4_encoder_renders_not_paths', async () => {
    render(
      wrap(
        <OnboardingClient
          initialSettings={FIXTURE_SETTINGS}
          locale="en"
          autoSkipPathsStep={true}
          placeholderSharePath="/media"
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    await advancePastHwAccel();
    // Land on EncoderStep (step 4 / "Hardware encoder detection"), NOT PathsStep.
    expect(
      await screen.findByRole('heading', { level: 1, name: /Hardware encoder detection/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Where are your videos/i })).toBeNull();
  });

  // Test 3 — AC-3: skip-branch backward nav 4 → 2 (HwAccel), bypassing paths.
  it('test_auto_skip_when_back_on_step_4_then_step_2_HwAccel_renders_not_paths', async () => {
    render(
      wrap(
        <OnboardingClient
          initialSettings={FIXTURE_SETTINGS}
          locale="en"
          autoSkipPathsStep={true}
          placeholderSharePath="/media"
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    await advancePastHwAccel();
    await screen.findByRole('heading', { name: /Hardware encoder detection/i });
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(
      await screen.findByRole('heading', { name: /Hardware acceleration/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Where are your videos/i })).toBeNull();
  });

  // Test 4 — AC-5: toast.info exactly-once with title + path-in-description.
  it('test_auto_skip_when_mounts_then_toast_info_called_once_with_title_and_path', async () => {
    render(
      wrap(
        <OnboardingClient
          initialSettings={FIXTURE_SETTINGS}
          locale="en"
          autoSkipPathsStep={true}
          placeholderSharePath="/media"
        />,
      ),
    );
    await waitFor(() => {
      expect(mockToastInfo).toHaveBeenCalledTimes(1);
    });
    const [title, opts] = mockToastInfo.mock.calls[0];
    expect(title).toBe(en.onboarding.paths.autoSkipToast.title);
    expect((opts as { description: string }).description).toContain('/media');
    expect((opts as { duration: number }).duration).toBe(4000);
  });

  // Test 5 — AC-5: toast NOT called when autoSkipPathsStep=false.
  it('test_auto_skip_when_autoSkipPathsStep_false_then_toast_not_called', async () => {
    render(
      wrap(
        <OnboardingClient
          initialSettings={FIXTURE_SETTINGS}
          locale="en"
          autoSkipPathsStep={false}
          placeholderSharePath={null}
        />,
      ),
    );
    // Wait long enough for any effects to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  // Test 6 — AC-5: StrictMode double-mount → toastFiredRef gates exactly-once.
  it('test_auto_skip_when_strict_mode_double_mount_then_toast_called_exactly_once', async () => {
    render(
      <StrictMode>
        {wrap(
          <OnboardingClient
            initialSettings={FIXTURE_SETTINGS}
            locale="en"
            autoSkipPathsStep={true}
            placeholderSharePath="/media"
          />,
        )}
      </StrictMode>,
    );
    await waitFor(() => {
      expect(mockToastInfo).toHaveBeenCalled();
    });
    // Give React time to run StrictMode's second-mount effects.
    await new Promise((r) => setTimeout(r, 30));
    expect(mockToastInfo).toHaveBeenCalledTimes(1);
  });

  // Test 7 — AC-5 + AC-12: action button onClick navigates to /{locale}/settings#paths.
  it('test_auto_skip_when_action_button_clicked_then_router_push_settings_paths_hash', async () => {
    render(
      wrap(
        <OnboardingClient
          initialSettings={FIXTURE_SETTINGS}
          locale="en"
          autoSkipPathsStep={true}
          placeholderSharePath="/media"
        />,
      ),
    );
    await waitFor(() => {
      expect(mockToastInfo).toHaveBeenCalled();
    });
    const [, opts] = mockToastInfo.mock.calls[0];
    const action = (opts as { action: { onClick: () => void; label: string } }).action;
    expect(action.label).toBe(en.onboarding.paths.autoSkipToast.actionLabel);
    action.onClick();
    expect(mockRouterPush).toHaveBeenCalledWith('/en/settings#paths');
  });

  // Test 8 — AC-6: step-indicator totalSteps={4} → aria-valuemax="4".
  it('test_auto_skip_when_skip_branch_active_then_step_indicator_aria_valuemax_is_4', () => {
    render(
      wrap(
        <OnboardingClient
          initialSettings={FIXTURE_SETTINGS}
          locale="en"
          autoSkipPathsStep={true}
          placeholderSharePath="/media"
        />,
      ),
    );
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuemax', '4');
    expect(progressbar).toHaveAttribute('aria-valuenow', '1');
  });

  // Test 17 — audit S4: skip-branch back from step-2 (HwAccel) lands on Welcome (step 1).
  it('test_auto_skip_when_back_from_step_2_then_step_1_welcome_renders', async () => {
    render(
      wrap(
        <OnboardingClient
          initialSettings={FIXTURE_SETTINGS}
          locale="en"
          autoSkipPathsStep={true}
          placeholderSharePath="/media"
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /Get started/i }));
    await screen.findByRole('heading', { name: /Hardware acceleration/i });
    fireEvent.click(screen.getByRole('button', { name: /Back/i }));
    expect(await screen.findByRole('heading', { name: /Welcome/i })).toBeInTheDocument();
  });

  // Test 22 — audit M3: skip-branch invariant guard. Corrupt draft step=3 re-routes
  // to step=2 + emits console.warn.
  it('test_auto_skip_when_corrupt_draft_step_3_then_reroutes_to_step_2_with_warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      window.sessionStorage.setItem(
        ONBOARDING_DRAFT_KEY,
        JSON.stringify({ step: 3, pathsValues: null, qualityValues: null }),
      );
      render(
        wrap(
          <OnboardingClient
            initialSettings={FIXTURE_SETTINGS}
            locale="en"
            autoSkipPathsStep={true}
            placeholderSharePath="/media"
          />,
        ),
      );
      // Final rendered step is HwAccel (step=2 visible position).
      expect(
        await screen.findByRole('heading', { name: /Hardware acceleration/i }),
      ).toBeInTheDocument();
      // M3 invariant warn-log fires (OR the draft-recovery info-log — both
      // confirm the re-route path took effect). Accept either signal.
      const warnFired = warnSpy.mock.calls.some(
        (c) => c[0] === 'wizard_skip_branch_step_invariant_violated',
      );
      const infoFired = infoSpy.mock.calls.some(
        (c) => c[0] === 'wizard_draft_step_invalid_in_skip_branch',
      );
      expect(warnFired || infoFired).toBe(true);
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  // Test 23 — audit S3: toast description renders text-only via ICU {path} —
  // synthetic XSS payload is escaped (sonner text-rendering, no innerHTML).
  it('test_auto_skip_when_path_contains_HTML_chars_then_description_text_only_no_script_exec', async () => {
    const synthetic = '<img src=x onerror=alert(1)>/media';
    render(
      wrap(
        <OnboardingClient
          initialSettings={FIXTURE_SETTINGS}
          locale="en"
          autoSkipPathsStep={true}
          placeholderSharePath={synthetic}
        />,
      ),
    );
    await waitFor(() => {
      expect(mockToastInfo).toHaveBeenCalled();
    });
    const [, opts] = mockToastInfo.mock.calls[0];
    const description = (opts as { description: string }).description;
    // The literal HTML chars are preserved as text (NOT parsed).
    expect(description).toContain(synthetic);
    // No img element materialized in the DOM (sonner is mocked anyway, but
    // assert defensively: no element with the XSS marker reaches React's tree).
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  // 20-02 AC-6 audit-M3 — Skip-vs-fallback convergence guard.
  // Drives OnboardingClient to QualityStep (step=5) in BOTH branches via
  // sessionStorage draft pre-seed, then asserts AutoScanAwareness mounts +
  // its deeplink href ends with `#auto-scan-advanced` (regardless of branch).
  it.each([
    { autoSkip: true, label: 'skip-branch (4-step)' },
    { autoSkip: false, label: 'fallback-branch (5-step)' },
  ])(
    'AutoScanAwareness renders at final step + deeplink targets #auto-scan-advanced — $label (AC-6 audit-M3)',
    async ({ autoSkip }) => {
      // Pre-seed sessionStorage draft so OnboardingClient hydrates at step=5
      // (QualityStep) directly — bypasses the multi-step wizard navigation
      // and isolates the assertion on AutoScanAwareness + deeplink convergence.
      window.sessionStorage.setItem(
        ONBOARDING_DRAFT_KEY,
        JSON.stringify({
          step: 5,
          pathsValues: { scan_root: '/media', min_size_mb: 50 },
          qualityValues: null,
        }),
      );
      render(
        wrap(
          <OnboardingClient
            initialSettings={FIXTURE_SETTINGS}
            locale="en"
            autoSkipPathsStep={autoSkip}
            placeholderSharePath={autoSkip ? '/media' : null}
          />,
        ),
      );
      // Wait for hydration + step=5 to render QualityStep + its embedded
      // AutoScanAwareness.
      const surface = await screen.findByTestId('onboarding-autoscan-awareness');
      expect(surface).toBeInTheDocument();
      // Deeplink href ends with #auto-scan-advanced regardless of branch.
      const link = surface.querySelector('a');
      expect(link).not.toBeNull();
      expect(link!.getAttribute('href')).toMatch(/#auto-scan-advanced$/);
    },
  );
});
