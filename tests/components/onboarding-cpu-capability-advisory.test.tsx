/*
 * 23-05 Plan Task 3 — CpuCapabilityAdvisory vitest render-gate matrix.
 *
 * Covers AC-2 (renders for pre-Skylake Intel + no qsv), AC-7 (render-gate +
 * kill-switch + once-per-mount audit event), AC-8 (EN/DE i18n parity).
 *
 * Mirrors onboarding-bench-recommendation-chip.test.tsx conventions:
 * vi.stubGlobal('fetch', ...) + mocked logger for single-fire assertions.
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

import { CpuCapabilityAdvisory } from '@/components/onboarding/cpu-capability-advisory';

type EncoderId = 'libx265' | 'nvenc' | 'qsv' | 'vaapi';

function wrap(ui: React.ReactNode, locale: 'en' | 'de' = 'en') {
  const messages = locale === 'en' ? en : de;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

interface CpuSubset {
  isIntel: boolean;
  graphicsGen: number | null;
  microarch: string | null;
  hevcQsv: 'none' | '8bit' | '10bit' | 'unknown';
}

const BROADWELL: CpuSubset = {
  isIntel: true,
  graphicsGen: 5,
  microarch: 'Broadwell',
  hevcQsv: 'none',
};
const SKYLAKE: CpuSubset = { isIntel: true, graphicsGen: 6, microarch: 'Skylake', hevcQsv: '8bit' };
const AMD: CpuSubset = { isIntel: false, graphicsGen: null, microarch: null, hevcQsv: 'unknown' };

function mockFetch(response: { status: number; body?: unknown } | 'abort') {
  return vi.fn(async (_url: string, _init?: { signal?: AbortSignal }) => {
    if (response === 'abort') throw new DOMException('aborted', 'AbortError');
    const body = response.body !== undefined ? JSON.stringify(response.body) : '';
    return new Response(body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('CpuCapabilityAdvisory — render-gate matrix', () => {
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

  it('renders for pre-Skylake Intel + qsv absent, emits event once (AC-2, AC-7)', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 200, body: { cpu: BROADWELL } }));
    render(wrap(<CpuCapabilityAdvisory detected={['libx265'] as EncoderId[]} />));
    const advisory = await screen.findByRole('status');
    expect(advisory).toHaveTextContent(/libx265/);
    expect(advisory).toHaveTextContent(/gen 5/);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'onboarding.encoderStep.cpuQsvUnsupportedAdvisoryShown',
        graphicsGen: 5,
      }),
    );
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it('null for Skylake gen6 (HW HEVC-QSV capable)', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 200, body: { cpu: SKYLAKE } }));
    const { container } = render(
      wrap(<CpuCapabilityAdvisory detected={['libx265'] as EncoderId[]} />),
    );
    await waitFor(() => expect(mockLoggerInfo).not.toHaveBeenCalled(), { timeout: 200 });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('null when qsv IS detected even on pre-Skylake (gate requires qsv absent)', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 200, body: { cpu: BROADWELL } }));
    const { container } = render(
      wrap(<CpuCapabilityAdvisory detected={['qsv', 'libx265'] as EncoderId[]} />),
    );
    await waitFor(() => expect(mockLoggerInfo).not.toHaveBeenCalled(), { timeout: 200 });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('null for non-Intel (AMD) CPU', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 200, body: { cpu: AMD } }));
    const { container } = render(wrap(<CpuCapabilityAdvisory detected={[] as EncoderId[]} />));
    await waitFor(() => expect(mockLoggerInfo).not.toHaveBeenCalled(), { timeout: 200 });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('null on 401/abort (silent-hide)', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 401, body: { error_code: 'auth_required' } }));
    const { container } = render(wrap(<CpuCapabilityAdvisory detected={[] as EncoderId[]} />));
    await waitFor(() => expect(mockLoggerInfo).not.toHaveBeenCalled(), { timeout: 200 });
    expect(container.querySelector('[role="status"]')).toBeNull();

    cleanup();
    vi.stubGlobal('fetch', mockFetch('abort'));
    const { container: c2 } = render(wrap(<CpuCapabilityAdvisory detected={[] as EncoderId[]} />));
    await waitFor(() => expect(mockLoggerInfo).not.toHaveBeenCalled(), { timeout: 200 });
    expect(c2.querySelector('[role="status"]')).toBeNull();
  });

  it('StrictMode double-mount → event fires exactly once', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 200, body: { cpu: BROADWELL } }));
    render(
      <StrictMode>
        {wrap(<CpuCapabilityAdvisory detected={['libx265'] as EncoderId[]} />)}
      </StrictMode>,
    );
    await screen.findByRole('status');
    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
  });

  it('renders DE locale with translated label (AC-8 parity)', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 200, body: { cpu: BROADWELL } }));
    render(wrap(<CpuCapabilityAdvisory detected={['libx265'] as EncoderId[]} />, 'de'));
    const advisory = await screen.findByRole('status');
    expect(advisory).toHaveTextContent(/libx265/);
    expect(advisory).toHaveTextContent(/iGPU/);
  });
});

describe('CpuCapabilityAdvisory — kill-switch (AC-7)', () => {
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

  it('null + zero fetch when NEXT_PUBLIC_ONBOARDING_CPU_ADVISORY_DISABLED=1', async () => {
    vi.stubEnv('NEXT_PUBLIC_ONBOARDING_CPU_ADVISORY_DISABLED', '1');
    const fetchStub = mockFetch({ status: 200, body: { cpu: BROADWELL } });
    vi.stubGlobal('fetch', fetchStub);
    const mod = await import('@/components/onboarding/cpu-capability-advisory');
    const { container } = render(
      wrap(<mod.CpuCapabilityAdvisory detected={['libx265'] as EncoderId[]} />),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });
});
