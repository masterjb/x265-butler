// 05-04 T2.E: Export-CSV button tests.
// Phase 5 Plan 05-04 — AC-5 + audit S2/S3/S4.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExportCsvAction, parseFilenameFromCD } from '@/components/library/export-csv-action';
import { wrap } from '../test-utils';

const mockAuthFetch = vi.fn();

vi.mock('@/components/auth/auth-fetcher', async () => {
  const actual = await vi.importActual<typeof import('@/components/auth/auth-fetcher')>(
    '@/components/auth/auth-fetcher',
  );
  return {
    ...actual,
    authFetch: (...args: unknown[]) => mockAuthFetch(...args),
  };
});

// The button's accessible name is the aria-label (overrides visible text).
const ENGLISH_BUTTON_LABEL = /library view as a csv/i;

const baseHeaders = {
  'Content-Disposition':
    'attachment; filename="x265-butler-library-20260428-134509.csv"; filename*=UTF-8\'\'x265-butler-library-20260428-134509.csv',
};

function makeMockResponse(opts: {
  ok?: boolean;
  status?: number;
  blob?: () => Promise<Blob>;
  headers?: Record<string, string>;
}): Response {
  const headers = new Headers(opts.headers ?? baseHeaders);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers,
    blob:
      opts.blob ?? (() => Promise.resolve(new Blob(['id,path\n1,/a.mp4\n'], { type: 'text/csv' }))),
  } as unknown as Response;
}

beforeEach(() => {
  mockAuthFetch.mockReset();
  // jsdom does not implement URL.createObjectURL / revokeObjectURL — define
  // them as plain mocks so the component's Blob+anchor flow works.
  const createMock = vi.fn(() => 'blob:mock-url');
  const revokeMock = vi.fn(() => undefined);
  Object.defineProperty(URL, 'createObjectURL', {
    value: createMock,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeMock,
    writable: true,
    configurable: true,
  });
  (
    globalThis as unknown as {
      __exportSpies: { create: typeof createMock; revoke: typeof revokeMock };
    }
  ).__exportSpies = { create: createMock, revoke: revokeMock };
});

describe('ExportCsvAction — visibility + disabled state', () => {
  it('renders the button with the idle label', () => {
    render(wrap(<ExportCsvAction currentQueryString="" />));
    expect(screen.getByRole('button', { name: ENGLISH_BUTTON_LABEL })).toBeInTheDocument();
  });

  it('disabled prop disables the button', () => {
    render(wrap(<ExportCsvAction currentQueryString="" disabled />));
    expect(screen.getByRole('button', { name: ENGLISH_BUTTON_LABEL })).toBeDisabled();
  });
});

describe('ExportCsvAction — click flow', () => {
  it('triggers authFetch with current URL state', async () => {
    mockAuthFetch.mockResolvedValue(makeMockResponse({}));
    const user = userEvent.setup();
    render(wrap(<ExportCsvAction currentQueryString="q=foo&status=failed&sort=size&dir=desc" />));
    await user.click(screen.getByRole('button', { name: ENGLISH_BUTTON_LABEL }));
    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/library/export.csv?q=foo&status=failed&sort=size&dir=desc',
        { method: 'GET' },
      );
    });
  });

  it('calls URL.createObjectURL + revokeObjectURL exactly once each on success', async () => {
    mockAuthFetch.mockResolvedValue(makeMockResponse({}));
    const user = userEvent.setup();
    render(wrap(<ExportCsvAction currentQueryString="sort=size&dir=desc" />));
    await user.click(screen.getByRole('button', { name: ENGLISH_BUTTON_LABEL }));
    const spies = (
      globalThis as unknown as {
        __exportSpies: { create: ReturnType<typeof vi.spyOn>; revoke: ReturnType<typeof vi.spyOn> };
      }
    ).__exportSpies;
    await waitFor(() => {
      expect(spies.create).toHaveBeenCalledTimes(1);
      expect(spies.revoke).toHaveBeenCalledTimes(1);
    });
  });

  it('on 500 mock response: error toast + Retry button', async () => {
    mockAuthFetch.mockResolvedValue(makeMockResponse({ ok: false, status: 500 }));
    const user = userEvent.setup();
    render(wrap(<ExportCsvAction currentQueryString="sort=size&dir=desc" />));
    await user.click(screen.getByRole('button', { name: ENGLISH_BUTTON_LABEL }));
    expect(await screen.findByText(/couldn't export library/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('Retry click re-invokes authFetch', async () => {
    mockAuthFetch
      .mockResolvedValueOnce(makeMockResponse({ ok: false, status: 500 }))
      .mockResolvedValueOnce(makeMockResponse({}));
    const user = userEvent.setup();
    render(wrap(<ExportCsvAction currentQueryString="sort=size&dir=desc" />));
    await user.click(screen.getByRole('button', { name: ENGLISH_BUTTON_LABEL }));
    await screen.findByRole('button', { name: /retry/i });
    await user.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledTimes(2);
    });
  });

  it('audit S4: blob() rejection → message_partial (NOT generic message)', async () => {
    mockAuthFetch.mockResolvedValue(
      makeMockResponse({
        blob: () => Promise.reject(new Error('truncated')),
      }),
    );
    const user = userEvent.setup();
    render(wrap(<ExportCsvAction currentQueryString="sort=size&dir=desc" />));
    await user.click(screen.getByRole('button', { name: ENGLISH_BUTTON_LABEL }));
    expect(await screen.findByText(/interrupted mid-download/i)).toBeInTheDocument();
  });

  it('audit S2: URL.revokeObjectURL fires even when anchor flow throws', async () => {
    mockAuthFetch.mockResolvedValue(makeMockResponse({}));
    // Force a.click() to throw — the try/finally wrapping must still revoke.
    const origCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'click', {
          value: () => {
            throw new Error('synthetic anchor click failure');
          },
        });
      }
      return el;
    });
    const user = userEvent.setup();
    render(wrap(<ExportCsvAction currentQueryString="sort=size&dir=desc" />));
    await user.click(screen.getByRole('button', { name: ENGLISH_BUTTON_LABEL }));
    const spies = (
      globalThis as unknown as { __exportSpies: { revoke: ReturnType<typeof vi.spyOn> } }
    ).__exportSpies;
    await waitFor(() => {
      expect(spies.revoke).toHaveBeenCalled();
    });
    createSpy.mockRestore();
  });

  it('audit S3: disabled-state tooltip surfaces when disabled && !inFlight', () => {
    render(wrap(<ExportCsvAction currentQueryString="" disabled />));
    // Tooltip portal renders into the DOM only after focus/hover; assert the
    // trigger is wrapped in a TooltipTrigger by checking the data-slot attribute.
    const button = screen.getByRole('button', { name: ENGLISH_BUTTON_LABEL });
    // base-ui adds data-slot="tooltip-trigger" on the trigger element.
    expect(
      button.getAttribute('data-slot') === 'tooltip-trigger' ||
        button.closest('[data-slot="tooltip-trigger"]'),
    ).toBeTruthy();
  });

  it('submitLockRef: rapid 5x click in <50ms → exactly 1 authFetch call', async () => {
    // Hold authFetch pending across all clicks so submitLockRef stays locked.
    // Prior impl resolved after 100ms which races slow CI: click N could fully
    // finish (finally→lock=false) before click N+1 dispatches → spurious 2nd call.
    let resolveFn: ((v: Response) => void) | null = null;
    mockAuthFetch.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolveFn = r;
        }),
    );
    const user = userEvent.setup({ delay: null });
    render(wrap(<ExportCsvAction currentQueryString="sort=size&dir=desc" />));
    const btn = screen.getByRole('button', { name: ENGLISH_BUTTON_LABEL });
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    await user.click(btn);
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
    resolveFn!(makeMockResponse({}));
  });

  it('AuthRedirectError swallowed silently — no error UI', async () => {
    const { AuthRedirectError } = await import('@/components/auth/auth-fetcher');
    mockAuthFetch.mockRejectedValue(new AuthRedirectError());
    const user = userEvent.setup();
    render(wrap(<ExportCsvAction currentQueryString="sort=size&dir=desc" />));
    await user.click(screen.getByRole('button', { name: ENGLISH_BUTTON_LABEL }));
    // Wait a tick for the catch block.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/couldn't export library/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe('parseFilenameFromCD', () => {
  it('prefers RFC 5987 filename* over legacy filename=', () => {
    const cd =
      'attachment; filename="fallback.csv"; filename*=UTF-8\'\'x265-butler-library-20260428-134509.csv';
    expect(parseFilenameFromCD(cd)).toBe('x265-butler-library-20260428-134509.csv');
  });

  it('decodes percent-escaped UTF-8 in filename*', () => {
    const cd = "attachment; filename*=UTF-8''%D1%82%D0%B5%D1%81%D1%82.csv";
    expect(parseFilenameFromCD(cd)).toBe('тест.csv');
  });

  it('falls back to legacy filename= when filename* missing', () => {
    const cd = 'attachment; filename="legacy.csv"';
    expect(parseFilenameFromCD(cd)).toBe('legacy.csv');
  });

  it('returns null when both forms are absent', () => {
    expect(parseFilenameFromCD('attachment')).toBeNull();
    expect(parseFilenameFromCD('')).toBeNull();
  });
});
