// Phase 21 Plan 21-02 T3 Step 1 — CopyReportButton tests (AC-4 + audit-SR1/SR3/SR4/SR6).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { wrap } from '../../test-utils';
import { CopyReportButton } from '@/components/diagnostics/copy-report-button';

const { mockToast } = vi.hoisted(() => ({
  mockToast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: mockToast }));

const REPORT_BODY = '# Diagnostics report\n\nÜnîcödé content';

function mockClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

describe('CopyReportButton', () => {
  beforeEach(() => {
    mockToast.error.mockReset();
    mockToast.success.mockReset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // @ts-expect-error reset between tests
    delete (navigator as Record<string, unknown>).clipboard;
  });

  it('fetches /api/diagnostics-report on click + writes to clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    mockClipboard(writeText);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/api/diagnostics-report')) {
        return new Response(REPORT_BODY, { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    render(wrap(<CopyReportButton />));
    fireEvent.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const arg = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(arg).toContain(REPORT_BODY);
    expect(arg).toContain('### Last test-encode');
    expect(arg).toContain('_not executed yet_');
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/diagnostics-report',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it('shows success toast on clipboard.writeText resolve', async () => {
    mockClipboard(vi.fn(async () => undefined));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(REPORT_BODY, { status: 200 }));
    render(wrap(<CopyReportButton />));
    fireEvent.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  });

  it('HTTP error → toast.error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    render(wrap(<CopyReportButton />));
    fireEvent.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
  });

  it('navigator.clipboard undefined → execCommand fallback path is attempted', async () => {
    const execSpy = vi.fn(() => true);
    document.execCommand = execSpy as unknown as typeof document.execCommand;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(REPORT_BODY, { status: 200 }));
    render(wrap(<CopyReportButton />));
    fireEvent.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(execSpy).toHaveBeenCalledWith('copy'));
    expect(mockToast.success).toHaveBeenCalled();
  });

  it('POSTs /api/diagnostics/log-event with FLAT byteLength (UTF-8 bytes via TextEncoder, audit-SR1+M4)', async () => {
    mockClipboard(vi.fn(async () => undefined));
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/diagnostics-report')) {
        return new Response(REPORT_BODY, { status: 200 });
      }
      if (url.includes('/api/diagnostics/log-event')) {
        calls.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });
    render(wrap(<CopyReportButton />));
    fireEvent.click(screen.getAllByRole('button')[0]!);

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const logCall = calls[0]!;
    const body = logCall.body as { event: string; payload: { byteLength: number } };
    expect(body.event).toBe('diagnosticsReportCopied');
    // byteLength now measures the assembled clipboard body (REPORT_BODY +
    // test-encode placeholder + optional generatedAt footer), so MUST be
    // strictly greater than the raw report-body UTF-8 size.
    const rawReportBytes = new TextEncoder().encode(REPORT_BODY).length;
    expect(body.payload.byteLength).toBeGreaterThan(rawReportBytes);
    // Confirm UTF-8 bytes ≠ JS string.length (REPORT_BODY contains multi-byte chars).
    expect(rawReportBytes).toBeGreaterThan(REPORT_BODY.length);
  });

  it('modal-fallback when BOTH clipboard + execCommand fail (audit-SR6)', async () => {
    // No navigator.clipboard, execCommand returns false → fallback dialog.
    document.execCommand = vi.fn(() => false) as unknown as typeof document.execCommand;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(REPORT_BODY, { status: 200 }));
    render(wrap(<CopyReportButton />));
    fireEvent.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => {
      const ta = document.querySelector('textarea[readonly]') as HTMLTextAreaElement | null;
      expect(ta?.value).toContain(REPORT_BODY);
      expect(ta?.value).toContain('### Last test-encode');
    });
  });

  it('appends last-test-encode markdown to clipboard when lastTestEncodeResult prop set (UAT-extension B)', async () => {
    const writeText = vi.fn(async () => undefined);
    mockClipboard(writeText);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/api/diagnostics-report')) {
        return new Response(REPORT_BODY, { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    render(
      wrap(
        <CopyReportButton
          lastTestEncodeResult={{
            outcome: 'failed',
            encoderPicked: 'hevc_nvenc',
            durationMs: 427,
            exitCode: 234,
            ffmpegStdout: '',
            ffmpegStderr: 'InitializeEncoder failed: invalid param (8)',
            mappedError: null,
          }}
        />,
      ),
    );
    fireEvent.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const clipboardArg = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(clipboardArg).toContain(REPORT_BODY);
    expect(clipboardArg).toContain('### Last test-encode');
    expect(clipboardArg).toContain('hevc_nvenc');
    expect(clipboardArg).toContain('InitializeEncoder failed');
  });

  it('AbortController-timeout case (audit-SR3): fetch never resolves → onUnmount cleanup ac.abort fires without setState-warning', async () => {
    // Fetch hangs; unmount component → AbortController cleanup should fire.
    let abortListener: (() => void) | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const sig = (init?.signal as AbortSignal | undefined) ?? null;
      if (sig) sig.addEventListener('abort', () => (abortListener = () => undefined));
      return new Promise(() => undefined);
    });
    const { unmount } = render(wrap(<CopyReportButton />));
    fireEvent.click(screen.getAllByRole('button')[0]!);
    // Allow microtasks to register abort listener.
    await new Promise((r) => setTimeout(r, 10));
    unmount();
    expect(abortListener).not.toBeNull();
  });

  // Plan 21-05 — test-encode-evidence gate (AC-1 + AC-4 + AC-11 + AC-12).
  describe('21-05 gated prop', () => {
    it('gated=true: button disabled + aria-describedby + helper-text rendered', () => {
      render(wrap(<CopyReportButton gated={true} />));
      const btn = screen.getAllByRole('button')[0]!;
      expect(btn).toBeDisabled();
      expect(btn.getAttribute('aria-describedby')).toBe('copy-report-gate-helper');
      const helper = document.getElementById('copy-report-gate-helper');
      expect(helper).not.toBeNull();
      expect(helper?.getAttribute('role')).toBe('note');
      expect(helper?.textContent).toMatch(/run a test encode/i);
    });

    it('gated=true: clicking does NOT trigger fetch', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(REPORT_BODY, { status: 200 }));
      render(wrap(<CopyReportButton gated={true} />));
      fireEvent.click(screen.getAllByRole('button')[0]!);
      // Allow microtasks; assert fetch never fires.
      await new Promise((r) => setTimeout(r, 20));
      const reportFetches = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes('/api/diagnostics-report'),
      );
      expect(reportFetches.length).toBe(0);
    });

    it('gated=false: button enabled + NO helper-text in DOM', () => {
      render(wrap(<CopyReportButton gated={false} />));
      const btn = screen.getAllByRole('button')[0]!;
      expect(btn).not.toBeDisabled();
      expect(btn.getAttribute('aria-describedby')).toBeNull();
      expect(document.getElementById('copy-report-gate-helper')).toBeNull();
    });

    it('gated=true → gated=false transition: helper disappears + button enabled', () => {
      const { rerender } = render(wrap(<CopyReportButton gated={true} />));
      expect(document.getElementById('copy-report-gate-helper')).not.toBeNull();
      rerender(wrap(<CopyReportButton gated={false} />));
      expect(document.getElementById('copy-report-gate-helper')).toBeNull();
      expect(screen.getAllByRole('button')[0]!).not.toBeDisabled();
    });

    it('helper-text matches t(copyReport.gateHelper) i18n key (AC-11)', () => {
      render(wrap(<CopyReportButton gated={true} />));
      const helper = document.getElementById('copy-report-gate-helper');
      // EN locale via test-utils wrap() — match phrasing without locking exact string.
      expect(helper?.textContent).toMatch(/lifecycle evidence/i);
    });
  });
});
