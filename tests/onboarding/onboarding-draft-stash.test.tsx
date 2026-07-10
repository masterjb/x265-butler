// 16-03 deep-link state-loss fix — sessionStorage stash + hydrate.
//
// Covers: operator clicks "Open advanced options" mid-wizard → values
// stashed → navigation away → wizard re-entry hydrates step + values.
// Also covers: successful POST /api/onboarding/complete clears stash.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

const { mockRouterPush, mockToastSuccess, mockToastError, mockToastInfo } = vi.hoisted(() => ({
  mockRouterPush: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
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
    info: mockToastInfo,
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
    if (url === '/api/settings') {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url === '/api/onboarding/complete') {
      return new Response(JSON.stringify({ completed: true, requestId: 'rid' }), {
        status: 200,
      });
    }
    return new Response('not-found', { status: 404 });
  });
  return { fetchMock, calls };
}

describe('OnboardingClient — sessionStorage draft stash (16-03)', () => {
  beforeEach(() => {
    mockRouterPush.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  it('hydrates wizard to step=4 + stashes new values on Awareness deep-link click', async () => {
    // Pre-populate sessionStorage as if operator had previously clicked the
    // Awareness deep-link from Step 4 with non-default CRF values.
    window.sessionStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({
        step: 5,
        pathsValues: { scan_root: '/data/movies', min_size_mb: 100 },
        qualityValues: {
          crf_libx265: 20,
          crf_nvenc: 19,
          crf_qsv: 18,
          crf_vaapi: 21,
        },
      }),
    );

    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));

    // Wait for hydration effect → QualityStep mounts (heading "Quality defaults").
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 1, name: /Quality defaults/i }),
      ).toBeInTheDocument(),
    );

    // CRF inputs prefilled from stash (NOT from initialSettings server defaults).
    const libx265Input = screen.getByLabelText('libx265') as HTMLInputElement;
    expect(libx265Input.value).toBe('20');
    const nvencInput = screen.getByLabelText('NVENC') as HTMLInputElement;
    expect(nvencInput.value).toBe('19');

    // Operator clicks Awareness deep-link → sessionStorage re-stashed with
    // current state (post-hydrate values + step=4 + retained paths).
    const link = screen.getByRole('link', { name: /Open advanced options/i });
    fireEvent.click(link);

    const stashed = JSON.parse(window.sessionStorage.getItem(ONBOARDING_DRAFT_KEY) ?? '{}');
    // 18-02: wizard grew 4→5 steps; quality is now step 5.
    expect(stashed.step).toBe(5);
    expect(stashed.pathsValues).toEqual({ scan_root: '/data/movies', min_size_mb: 100 });
    expect(stashed.qualityValues.crf_libx265).toBe(20);
    expect(stashed.qualityValues.crf_nvenc).toBe(19);
  });

  // 20-01 Test 13 / AC-7: ONBOARDING_DRAFT_KEY value stays at .v2 (NO v3 bump).
  it('test_draft_key_stays_at_v2_no_v3_bump', () => {
    expect(ONBOARDING_DRAFT_KEY).toBe('x265butler.onboarding.draft.v2');
  });

  // 20-01 Test 11 / AC-7: skip-branch + v2 draft.step=3 (paths) → re-route to
  // step=2 (HwAccel), preserve qualityValues, clear stale pathsValues, emit
  // wizard_draft_step_invalid_in_skip_branch console.info.
  it('test_when_skip_branch_active_and_draft_step_3_then_reroute_to_step_2_with_info_log', async () => {
    const consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      window.sessionStorage.setItem(
        ONBOARDING_DRAFT_KEY,
        JSON.stringify({
          step: 3,
          pathsValues: { scan_root: '/old', min_size_mb: 999 },
          qualityValues: { crf_libx265: 19, crf_nvenc: 18, crf_qsv: 17, crf_vaapi: 20 },
        }),
      );
      const { fetchMock } = makeFetchMock();
      vi.stubGlobal('fetch', fetchMock);
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
      // Land on HwAccel (step=2 in v2 internal numbering).
      await waitFor(() =>
        expect(
          screen.getByRole('heading', { level: 1, name: /Hardware acceleration/i }),
        ).toBeInTheDocument(),
      );
      const infoFired = consoleInfoSpy.mock.calls.some(
        (c) => c[0] === 'wizard_draft_step_invalid_in_skip_branch',
      );
      expect(infoFired).toBe(true);
    } finally {
      consoleInfoSpy.mockRestore();
    }
  });

  // 20-01 Test 12 / AC-7: v2 draft.step=4 (encoder, valid in skip-branch) → preserved.
  it('test_when_skip_branch_active_and_draft_step_4_then_step_preserved_no_reroute', async () => {
    window.sessionStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({
        step: 4,
        pathsValues: null,
        qualityValues: null,
      }),
    );
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
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
    expect(
      await screen.findByRole('heading', { level: 1, name: /Hardware encoder detection/i }),
    ).toBeInTheDocument();
  });

  it('clears sessionStorage stash on successful onboarding completion', async () => {
    // Stash exists at start (operator returned via deep-link earlier).
    // 18-02: step=5 is Quality (was step=4 in v1 schema).
    window.sessionStorage.setItem(
      ONBOARDING_DRAFT_KEY,
      JSON.stringify({
        step: 5,
        pathsValues: { scan_root: '/data/movies', min_size_mb: 100 },
        qualityValues: { crf_libx265: 23, crf_nvenc: 23, crf_qsv: 22, crf_vaapi: 22 },
      }),
    );
    expect(window.sessionStorage.getItem(ONBOARDING_DRAFT_KEY)).not.toBeNull();

    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    render(wrap(<OnboardingClient initialSettings={FIXTURE_SETTINGS} locale="en" />));

    // Hydration brings wizard to step=4.
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 1, name: /Quality defaults/i }),
      ).toBeInTheDocument(),
    );

    // Click "Finish setup" — fires PUT /api/settings + POST /complete.
    const finishBtn = await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Finish setup/i });
      expect(btn).not.toBeDisabled();
      return btn;
    });
    await act(async () => {
      fireEvent.click(finishBtn);
    });

    // After success, sessionStorage stash cleared + router pushed to library.
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/en/library');
    });
    expect(window.sessionStorage.getItem(ONBOARDING_DRAFT_KEY)).toBeNull();
  });
});
