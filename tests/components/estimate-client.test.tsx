// Phase 13 Plan 13-04 Task 4 — EstimateClient component tests.
// Mocks fetch to /api/scan/estimate; verifies form behavior, loading state,
// result rendering, error toasts, naive-pill, and AC-17 truncated banner.
// 13 cases — audit-uplifted from 12 for AC-17.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { EstimateClient } from '@/app/[locale]/scan/estimate/estimate-client';

const { mockToastError } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const DEFAULT_PROPS = {
  initialPath: '/media/movies',
  scanRoot: '/media',
  scanRootExists: true,
  defaultExtensions: 'mp4,mkv',
  defaultMinSizeMb: 50,
  defaultMaxDepth: 12,
};

function fakeOk(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      filesScanned: 5,
      filesEligible: 3,
      skipBuckets: { sidecar: 1, blocklist: 1, eligible: 3, scanned: 5 },
      savings: {
        ratio: 0.45,
        projectedBytes: 1_000_000_000,
        totalBytes: 2_000_000_000,
        source: 'naive',
        runId: null,
        encoder: 'libx265',
      },
      encodeTime: {
        seconds: 1800,
        source: 'naive',
        runId: null,
        encoder: 'libx265',
        scaleFactor: 1,
        eligibleCount: 3,
        withDurationCount: 3,
      },
      effectiveFilters: {
        resolvedRootPath: '/media/movies',
        extensions: ['mp4', 'mkv'],
        minSizeMb: 50,
        maxDepth: 12,
        encoder: 'libx265',
      },
      durationMs: 234,
      truncated: false,
      requestId: '00000000-0000-4000-8000-000000000000',
      ...over,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fakeErr(status: number, body: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: 'x', ...body }), { status });
}

describe('EstimateClient (13-04 T4)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockToastError.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('case 1: renders form with initialPath pre-filled', () => {
    render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    const pathInput = screen.getByLabelText(/path/i) as HTMLInputElement;
    expect(pathInput.value).toBe('/media/movies');
  });

  it('case 2: submit fires POST /api/scan/estimate with form params', async () => {
    fetchMock.mockResolvedValue(fakeOk());
    render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    fireEvent.submit(screen.getByRole('button', { name: /estimate$/i }).closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/scan/estimate');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.rootPath).toBe('/media/movies');
    expect(body.extensions).toEqual(['mp4', 'mkv']);
    expect(body.minSizeMb).toBe(50);
  });

  it('case 3: loading state disables submit button + shows submitting label', async () => {
    let resolveFetch!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolveFetch = r)));
    render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    const submit = screen.getByRole('button', { name: /estimate$/i });
    fireEvent.submit(submit.closest('form')!);
    await waitFor(() => expect(submit).toBeDisabled());
    // Both visible button label + sr-only aria-live region read "Estimating…".
    expect(screen.getAllByText(/estimating/i).length).toBeGreaterThanOrEqual(1);
    resolveFetch(fakeOk());
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it('case 4: 200 result renders 3 cards (savings + encodeTime + skipBuckets)', async () => {
    fetchMock.mockResolvedValue(fakeOk());
    render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    fireEvent.submit(screen.getByRole('button', { name: /estimate$/i }).closest('form')!);
    await screen.findByText(/estimated savings/i);
    await screen.findByText(/estimated encode time/i);
    await screen.findByText(/skip breakdown/i);
  });

  it('case 5: 200 bench-augmented → source-pill renders runId', async () => {
    fetchMock.mockResolvedValue(
      fakeOk({
        savings: {
          ratio: 0.5,
          projectedBytes: 1_000_000_000,
          totalBytes: 2_000_000_000,
          source: 'bench-augmented',
          runId: 42,
          encoder: 'libx265',
        },
        encodeTime: {
          seconds: 1800,
          source: 'bench-augmented',
          runId: 42,
          encoder: 'libx265',
          scaleFactor: 1,
          eligibleCount: 3,
          withDurationCount: 3,
        },
      }),
    );
    render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    fireEvent.submit(screen.getByRole('button', { name: /estimate$/i }).closest('form')!);
    const pills = await screen.findAllByText(/bench run #42/i);
    expect(pills.length).toBeGreaterThanOrEqual(1);
  });

  it('case 6: 200 naive → amber pill rendered', async () => {
    fetchMock.mockResolvedValue(fakeOk());
    render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    fireEvent.submit(screen.getByRole('button', { name: /estimate$/i }).closest('form')!);
    const pills = await screen.findAllByText(/naive estimate \(no bench data\)/i);
    expect(pills.length).toBeGreaterThanOrEqual(1);
  });

  it('case 7: 200 filesScanned=0 → empty-state card', async () => {
    fetchMock.mockResolvedValue(
      fakeOk({
        filesScanned: 0,
        filesEligible: 0,
        skipBuckets: { sidecar: 0, blocklist: 0, eligible: 0, scanned: 0 },
        savings: {
          ratio: 0.45,
          projectedBytes: 0,
          totalBytes: 0,
          source: 'naive',
          runId: null,
          encoder: 'libx265',
        },
      }),
    );
    render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    fireEvent.submit(screen.getByRole('button', { name: /estimate$/i }).closest('form')!);
    await screen.findByText(/no matching files/i);
    expect(screen.queryByText(/estimated savings/i)).not.toBeInTheDocument();
  });

  it('case 8: 409 → toast.error scanInProgress + form re-enabled', async () => {
    fetchMock.mockResolvedValue(fakeErr(409, { error: 'scan_in_progress' }));
    render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    fireEvent.submit(screen.getByRole('button', { name: /estimate$/i }).closest('form')!);
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    const msg = mockToastError.mock.calls[0]![0] as string;
    expect(msg).toMatch(/scan is currently running/i);
    expect(screen.getByRole('button', { name: /estimate$/i })).not.toBeDisabled();
  });

  it('case 9: 400 invalid_body → toast.error', async () => {
    fetchMock.mockResolvedValue(fakeErr(400, { error: 'invalid_body' }));
    render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    fireEvent.submit(screen.getByRole('button', { name: /estimate$/i }).closest('form')!);
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
  });

  it('case 10: 404 root_not_found → form-error below path-input via aria-describedby', async () => {
    fetchMock.mockResolvedValue(fakeErr(404, { error: 'root_not_found' }));
    render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    fireEvent.submit(screen.getByRole('button', { name: /estimate$/i }).closest('form')!);
    const errorMsg = await screen.findByRole('alert');
    expect(errorMsg.textContent).toMatch(/path not found/i);
    const pathInput = screen.getByLabelText(/path/i);
    expect(pathInput.getAttribute('aria-describedby')).toBe('estimate-path-error');
    expect(pathInput.getAttribute('aria-invalid')).toBe('true');
  });

  it('case 11: prefers-reduced-motion respected via motion-safe class on skeleton', async () => {
    let resolveFetch!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolveFetch = r)));
    const { container } = render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    fireEvent.submit(screen.getByRole('button', { name: /estimate$/i }).closest('form')!);
    await waitFor(() => {
      // Skeleton elements appear during load; class includes motion-safe gate.
      const animated = container.querySelectorAll('.motion-safe\\:animate-pulse');
      expect(animated.length).toBeGreaterThan(0);
    });
    resolveFetch(fakeOk());
  });

  it('case 12: submit-button disabled when scanRootExists=false', () => {
    render(wrap(<EstimateClient {...DEFAULT_PROPS} scanRootExists={false} />));
    expect(screen.getByRole('button', { name: /estimate$/i })).toBeDisabled();
  });

  // AC-17 — audit-added.
  it('case 13: 200 truncated=true → amber truncated banner above grid', async () => {
    fetchMock.mockResolvedValue(fakeOk({ truncated: true }));
    render(wrap(<EstimateClient {...DEFAULT_PROPS} />));
    fireEvent.submit(screen.getByRole('button', { name: /estimate$/i }).closest('form')!);
    const banner = await screen.findByRole('alert');
    // Number format is locale-aware (toLocaleString); accept either thousands separator.
    expect(banner.textContent).toMatch(/result truncated at 100[.,]000 files/i);
  });
});
