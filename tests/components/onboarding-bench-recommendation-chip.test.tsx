/*
 * 20-03 Plan Task 5 — BenchRecommendationChip vitest cases.
 *
 * Covers AC-1, AC-2, AC-3, AC-12, AC-16 + StrictMode idempotency.
 *
 * Mocks @/src/lib/logger so we can assert single-fire event semantics.
 * Uses vi.stubGlobal('fetch', ...) per onboarding-page.test.tsx convention.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { StrictMode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

const { mockLoggerInfo } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { BenchRecommendationChip } from '@/components/onboarding/bench-recommendation-chip';

function wrap(ui: React.ReactNode, locale: 'en' | 'de' = 'en') {
  const messages = locale === 'en' ? en : de;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function mockFetch(
  response: { status: number; body?: unknown } | 'abort' | 'timeout' = {
    status: 200,
    body: { recommendations: { hevc_nvenc: { crf: 23, preset: 'medium' } } },
  },
) {
  return vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
    if (response === 'abort') {
      throw new DOMException('aborted', 'AbortError');
    }
    if (response === 'timeout') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }
    const body = response.body !== undefined ? JSON.stringify(response.body) : '';
    return new Response(body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('BenchRecommendationChip — render + logger paths', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mockLoggerInfo.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('test_chip_renders_when_200_and_recommendation_exists_for_active_encoder (AC-1)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        status: 200,
        body: { recommendations: { nvenc: { crf: 23, preset: 'medium' } } },
      }),
    );
    render(wrap(<BenchRecommendationChip activeEncoder="nvenc" />));
    expect(await screen.findByRole('status')).toHaveTextContent(/Recommended.*nvenc.*CRF 23/);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'onboarding.encoderStep.benchRecommendationServed',
        encoder: 'nvenc',
        crf: 23,
      }),
    );
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it('test_chip_null_when_200_but_active_encoder_recommendation_undefined (AC-3)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        status: 200,
        body: { recommendations: { nvenc: { crf: 23, preset: 'medium' } } },
      }),
    );
    const { container } = render(wrap(<BenchRecommendationChip activeEncoder="vaapi" />));
    await waitFor(() => expect(mockLoggerInfo).not.toHaveBeenCalled(), { timeout: 200 });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('test_chip_null_on_404_no_completed_bench_run (AC-2)', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 404, body: { error: 'no_completed_bench_run' } }));
    const { container } = render(wrap(<BenchRecommendationChip activeEncoder="nvenc" />));
    await waitFor(() => expect(mockLoggerInfo).not.toHaveBeenCalled(), { timeout: 200 });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('test_chip_null_on_500_internal_error (silent_hide_no_toast)', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 500, body: { error: 'internal_error' } }));
    const { container } = render(wrap(<BenchRecommendationChip activeEncoder="nvenc" />));
    await waitFor(() => expect(mockLoggerInfo).not.toHaveBeenCalled(), { timeout: 200 });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('test_chip_null_on_401_auth_required (AC-12)', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 401, body: { error_code: 'auth_required' } }));
    const { container } = render(wrap(<BenchRecommendationChip activeEncoder="nvenc" />));
    await waitFor(() => expect(mockLoggerInfo).not.toHaveBeenCalled(), { timeout: 200 });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('test_chip_null_on_403_forbidden (AC-12)', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 403, body: { error: 'forbidden' } }));
    const { container } = render(wrap(<BenchRecommendationChip activeEncoder="nvenc" />));
    await waitFor(() => expect(mockLoggerInfo).not.toHaveBeenCalled(), { timeout: 200 });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('test_chip_null_on_abort_error (AbortController_timeout)', async () => {
    vi.stubGlobal('fetch', mockFetch('abort'));
    const { container } = render(wrap(<BenchRecommendationChip activeEncoder="nvenc" />));
    await waitFor(() => expect(mockLoggerInfo).not.toHaveBeenCalled(), { timeout: 200 });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('test_chip_strictmode_double_mount_logger_fires_exactly_once (StrictMode_idempotent)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        status: 200,
        body: { recommendations: { nvenc: { crf: 23, preset: 'medium' } } },
      }),
    );
    render(<StrictMode>{wrap(<BenchRecommendationChip activeEncoder="nvenc" />)}</StrictMode>);
    await screen.findByRole('status');
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it('test_chip_renders_in_de_locale_with_translated_label (AC-8_i18n_parity)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        status: 200,
        body: { recommendations: { libx265: { crf: 23, preset: 'medium' } } },
      }),
    );
    render(wrap(<BenchRecommendationChip activeEncoder="libx265" />, 'de'));
    expect(await screen.findByRole('status')).toHaveTextContent(/Empfohlen.*libx265.*CRF 23/);
  });
});

describe('BenchRecommendationChip — kill-switch (AC-16)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mockLoggerInfo.mockClear();
    vi.resetModules();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('test_chip_null_when_kill_switch_env_var_set_no_fetch_no_logger', async () => {
    vi.stubEnv('NEXT_PUBLIC_ONBOARDING_BENCH_CHIP_DISABLED', '1');
    const fetchStub = mockFetch();
    vi.stubGlobal('fetch', fetchStub);
    // Re-import after env-stub so module-load const reads stubbed value.
    const mod = await import('@/components/onboarding/bench-recommendation-chip');
    const { container } = render(wrap(<mod.BenchRecommendationChip activeEncoder="nvenc" />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});
