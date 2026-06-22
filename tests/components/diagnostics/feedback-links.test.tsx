// Phase 21 Plan 21-02 T3 Step 4 — FeedbackLinks tests (AC-7 + audit-M6/SR2).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { wrap } from '../../test-utils';
import { FeedbackLinks } from '@/components/diagnostics/feedback-links';
import type { AppVersionBlock } from '@/src/lib/diagnostics/types';

const { mockToast } = vi.hoisted(() => ({
  mockToast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: mockToast }));

function appBlock(overrides: Partial<AppVersionBlock> = {}): AppVersionBlock {
  return {
    version: '2.17.3',
    gitHash: 'abc1234',
    committedAt: 1700000000,
    committedAtCET: null,
    ...overrides,
  };
}

const REPORT_BODY = '# diagnostics report';

describe('FeedbackLinks', () => {
  let openSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mockToast.success.mockReset();
    mockToast.error.mockReset();
    vi.clearAllMocks();
    openSpy = vi.fn();
    Object.defineProperty(window, 'open', { configurable: true, value: openSpy });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  afterEach(() => {
    // @ts-expect-error reset
    delete (navigator as Record<string, unknown>).clipboard;
  });

  it('bug click fetches report + writes clipboard + opens forum tab + POSTs log-event type=bug', async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/diagnostics-report')) {
        return new Response(REPORT_BODY, { status: 200 });
      }
      if (url.includes('/api/diagnostics/log-event')) {
        captured.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });
    render(wrap(<FeedbackLinks app={appBlock()} />));
    fireEvent.click(screen.getByRole('button', { name: /bug/i }));
    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    expect(openSpy.mock.calls[0]).toEqual([
      expect.stringMatching(/forums\.unraid\.net/),
      '_blank',
      'noopener,noreferrer',
    ]);
    await waitFor(() => expect(captured.length).toBeGreaterThan(0));
    const last = captured[captured.length - 1]!.body as {
      event: string;
      payload: { type: string };
    };
    expect(last.event).toBe('feedbackLinkOpened');
    expect(last.payload.type).toBe('bug');
  });

  it('feature click writes template-stub + opens forum + POSTs log-event type=feature', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const captured: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/api/diagnostics/log-event')) {
        captured.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });
    render(wrap(<FeedbackLinks app={appBlock()} />));
    fireEvent.click(screen.getByRole('button', { name: /feature/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const tplArg = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(tplArg).toContain('x265-butler v2.17.3 · abc1234');
    expect(openSpy).toHaveBeenCalled();
    const last = captured[captured.length - 1]!.body as { payload: { type: string } };
    expect(last.payload.type).toBe('feature');
  });

  it('feature-template uses "unknown" defensive defaults when app fields nullish (audit-M6)', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    render(
      wrap(
        <FeedbackLinks
          app={
            {
              version: undefined,
              gitHash: undefined,
              committedAt: null,
              committedAtCET: null,
            } as unknown as AppVersionBlock
          }
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /feature/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const tplArg = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(tplArg).toContain('vunknown · unknown');
    expect(tplArg).not.toContain('undefined');
  });

  it('window.open uses noopener,noreferrer', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    render(wrap(<FeedbackLinks app={appBlock()} />));
    fireEvent.click(screen.getByRole('button', { name: /feature/i }));
    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    expect(openSpy.mock.calls[0]![2]).toBe('noopener,noreferrer');
  });

  it('submitLockRef prevents bug+feature double-fire on rapid clicks', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    let resolveFetch: (v: Response) => void = () => undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input).includes('/api/diagnostics-report')) {
        return new Promise<Response>((r) => (resolveFetch = r));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    render(wrap(<FeedbackLinks app={appBlock()} />));
    const bug = screen.getByRole('button', { name: /bug/i });
    fireEvent.click(bug);
    fireEvent.click(bug);
    fireEvent.click(bug);
    await waitFor(() => expect(bug).toBeDisabled());
    const reportFetches = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/api/diagnostics-report'),
    );
    expect(reportFetches.length).toBe(1);
    resolveFetch(new Response(REPORT_BODY, { status: 200 }));
  });

  // Plan 21-05 — test-encode-evidence gate (AC-2 + AC-3 + AC-11).
  describe('21-05 gated prop', () => {
    it('gated=true: Bug button disabled + aria-describedby + helper-text rendered', () => {
      render(wrap(<FeedbackLinks app={appBlock()} gated={true} />));
      const bug = screen.getByRole('button', { name: /bug|fehler/i });
      expect(bug).toBeDisabled();
      expect(bug.getAttribute('aria-describedby')).toBe('bug-report-gate-helper');
      const helper = document.getElementById('bug-report-gate-helper');
      expect(helper).not.toBeNull();
      expect(helper?.getAttribute('role')).toBe('note');
    });

    it('gated=true: Bug click does NOT trigger fetch', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(REPORT_BODY, { status: 200 }));
      render(wrap(<FeedbackLinks app={appBlock()} gated={true} />));
      fireEvent.click(screen.getByRole('button', { name: /bug|fehler/i }));
      await new Promise((r) => setTimeout(r, 20));
      const reportFetches = fetchSpy.mock.calls.filter((c) =>
        String(c[0]).includes('/api/diagnostics-report'),
      );
      expect(reportFetches.length).toBe(0);
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('gated=true: Feature button stays ENABLED and works (AC-3)', async () => {
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
      render(wrap(<FeedbackLinks app={appBlock()} gated={true} />));
      const feature = screen.getByRole('button', { name: /feature|funktion/i });
      expect(feature).not.toBeDisabled();
      expect(feature.getAttribute('aria-describedby')).toBeNull();
      fireEvent.click(feature);
      await waitFor(() => expect(writeText).toHaveBeenCalled());
      expect(openSpy).toHaveBeenCalled();
    });

    it('gated=false: Bug button enabled + NO helper-text in DOM', () => {
      render(wrap(<FeedbackLinks app={appBlock()} gated={false} />));
      const bug = screen.getByRole('button', { name: /bug|fehler/i });
      expect(bug).not.toBeDisabled();
      expect(bug.getAttribute('aria-describedby')).toBeNull();
      expect(document.getElementById('bug-report-gate-helper')).toBeNull();
    });

    it('helper-text matches t(feedback.bugGateHelper) i18n key (AC-11)', () => {
      render(wrap(<FeedbackLinks app={appBlock()} gated={true} />));
      const helper = document.getElementById('bug-report-gate-helper');
      expect(helper?.textContent).toMatch(/lifecycle evidence/i);
    });
  });
});
