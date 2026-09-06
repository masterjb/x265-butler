// Phase 21 Plan 21-02 T3 Step 2 — TestEncodeRunner tests (AC-5).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { wrap } from '../../test-utils';
import { TestEncodeRunner } from '@/components/diagnostics/test-encode-runner';

const { mockToast } = vi.hoisted(() => ({
  mockToast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: mockToast }));

const SUCCESS_BODY = {
  success: true,
  encoderPicked: 'libx265',
  durationMs: 5234,
  ffmpegStdout: 'out',
  ffmpegStderr: '',
  exitCode: 0,
};

const FAILED_BODY = { ...SUCCESS_BODY, success: false, exitCode: 1, ffmpegStderr: 'oops' };
const KILLED_BODY = { ...SUCCESS_BODY, success: false, exitCode: null };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('TestEncodeRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToast.error.mockReset();
  });

  it('initial state shows trigger button', () => {
    render(wrap(<TestEncodeRunner />));
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('click → POST /api/diagnostics/test-encode + spinner', async () => {
    let resolveFetch: (v: Response) => void = () => undefined;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>((r) => (resolveFetch = r)));
    render(wrap(<TestEncodeRunner />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('button')).toBeDisabled());
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/diagnostics/test-encode',
      expect.objectContaining({ method: 'POST' }),
    );
    resolveFetch(jsonResponse(SUCCESS_BODY));
  });

  it('success outcome renders result-card with encoder + duration + exit-code', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SUCCESS_BODY));
    render(wrap(<TestEncodeRunner />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/libx265/)).toBeInTheDocument());
    expect(screen.getByText(/5234 ms/)).toBeInTheDocument();
  });

  it('failed outcome renders error-card', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(FAILED_BODY));
    render(wrap(<TestEncodeRunner />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(screen.getAllByText(/failed|fehlgeschlagen/i).length).toBeGreaterThan(0),
    );
  });

  it('killed_timeout outcome renders warning-card', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(KILLED_BODY));
    render(wrap(<TestEncodeRunner />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getAllByText(/killed|timeout/i).length).toBeGreaterThan(0));
  });

  it('HTTP 503 mutex-held renders retry message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ error_code: 'test_encode_in_flight', retryAfterSeconds: 5 }, 503),
    );
    render(wrap(<TestEncodeRunner />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(screen.getByText(/progress|in progress|läuft/i)).toBeInTheDocument(),
    );
  });

  it('stdout-collapsible renders trigger with stdout/stderr toggle label', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ...SUCCESS_BODY, ffmpegStdout: 'stdout-text', ffmpegStderr: 'stderr-text' }),
    );
    render(wrap(<TestEncodeRunner />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/stdout/i)).toBeInTheDocument());
  });

  it('submitLockRef prevents double-click double-POST', async () => {
    let resolveFetch: (v: Response) => void = () => undefined;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>((r) => (resolveFetch = r)));
    render(wrap(<TestEncodeRunner />));
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse(SUCCESS_BODY));
  });

  it('HTTP 500 → http_error card displayed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error_code: 'x' }, 500));
    render(wrap(<TestEncodeRunner />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeInTheDocument());
  });

  // 23-01: diagnosis callout
  it('failed + mappedError renders the "Likely cause" callout with the hint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        ...FAILED_BODY,
        encoderPicked: 'hevc_qsv',
        ffmpegStderr: 'Error creating a MFX session: -9',
        mappedError: { code: 'qsvMfxSessionUnsupported', severity: 'warning' },
      }),
    );
    render(wrap(<TestEncodeRunner />));
    fireEvent.click(screen.getByRole('button'));
    const callout = await screen.findByText(/Likely cause/i);
    expect(callout).toBeInTheDocument();
    // hint text rendered (EN)
    expect(screen.getByText(/render group|oneVPL runtime/i)).toBeInTheDocument();
    // role=status region present
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('failed WITHOUT mappedError renders NO callout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(FAILED_BODY));
    render(wrap(<TestEncodeRunner />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(screen.getAllByText(/failed|fehlgeschlagen/i).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/Likely cause/i)).not.toBeInTheDocument();
  });

  it('success renders NO callout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SUCCESS_BODY));
    render(wrap(<TestEncodeRunner />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/libx265/)).toBeInTheDocument());
    expect(screen.queryByText(/Likely cause/i)).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 50-06 — the panel says WHAT the test encode ran with, and never hides a
// fallback behind a green card.
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG_BODY = {
  ...SUCCESS_BODY,
  encoderPicked: 'hevc_qsv',
  encoderRequested: 'qsv',
  encoderFallback: false,
  crf: 26,
  preset: 'slow',
  force10bit: true,
  keyframeIntervalSec: 5,
  commandLine: ['/usr/local/bin/ffmpeg', '-hide_banner'],
  settingsSource: 'settings',
};

describe('50-06 TestEncodeRunner — resolved configuration', () => {
  beforeEach(() => vi.clearAllMocks());

  async function renderWith(body: unknown) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body));
    render(wrap(<TestEncodeRunner />));
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('hevc_qsv')).toBeInTheDocument());
  }

  it('AC-19: the definition list carries requested encoder, CRF, preset, 10-bit and keyframe interval', async () => {
    await renderWith(CONFIG_BODY);
    expect(screen.getByText('qsv')).toBeInTheDocument();
    expect(screen.getByText('26')).toBeInTheDocument();
    expect(screen.getByText('slow')).toBeInTheDocument();
    // 10-bit ON and the keyframe interval both render as words/values, never as
    // a bare boolean or a raw number without a unit.
    expect(screen.getByText('on')).toBeInTheDocument();
    expect(screen.getByText('5s')).toBeInTheDocument();
    // the pre-existing rows survive unchanged (AC-19 second clause)
    expect(screen.getByText('5234 ms')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('AC-26: an unresolved CRF renders as a word, never blank', async () => {
    await renderWith({ ...CONFIG_BODY, crf: 'unresolved' });
    expect(screen.getByText('unresolved')).toBeInTheDocument();
  });

  it('AC-9: a zero keyframe interval renders as "off", not as "0 s"', async () => {
    await renderWith({ ...CONFIG_BODY, keyframeIntervalSec: 0 });
    expect(screen.queryByText('0s')).not.toBeInTheDocument();
    expect(screen.getAllByText('off').length).toBeGreaterThanOrEqual(1);
  });

  it('AC-28: a fallback run is MARKED — not left to the operator to spot', async () => {
    await renderWith({
      ...CONFIG_BODY,
      encoderPicked: 'hevc_qsv',
      encoderRequested: 'nvenc',
      encoderFallback: true,
    });
    const notice = screen.getByText('A different encoder than requested');
    expect(notice).toBeInTheDocument();
    // colour is never the only signal — the notice carries a text label AND the
    // requested/used pair in its body.
    expect(screen.getByText(/Your settings pin nvenc/)).toBeInTheDocument();
    expect(screen.getByText(/the test ran with hevc_qsv/)).toBeInTheDocument();
  });

  it('AC-28: a normal run shows NO fallback notice', async () => {
    await renderWith(CONFIG_BODY);
    expect(screen.queryByText('A different encoder than requested')).not.toBeInTheDocument();
  });

  it('AC-25: an unavailable settings read is called out as factory defaults', async () => {
    await renderWith({ ...CONFIG_BODY, settingsSource: 'unavailable' });
    expect(screen.getByText('Settings could not be read')).toBeInTheDocument();
    expect(screen.getByText(/NOT your configuration/)).toBeInTheDocument();
  });

  it('AC-25: a healthy read shows NO settings notice', async () => {
    await renderWith(CONFIG_BODY);
    expect(screen.queryByText('Settings could not be read')).not.toBeInTheDocument();
  });

  it('both notices are announced to assistive tech (role=status), colour is never the only cue', async () => {
    await renderWith({ ...CONFIG_BODY, encoderFallback: true, settingsSource: 'unavailable' });
    const statuses = screen.getAllByRole('status');
    expect(statuses.length).toBeGreaterThanOrEqual(2);
  });

  it('a server without the 50-06 fields does not blank the panel', async () => {
    // Defensive defaults: an older/cached response must degrade, not break.
    await renderWith({ ...SUCCESS_BODY, encoderPicked: 'hevc_qsv' });
    expect(screen.getByText('5234 ms')).toBeInTheDocument();
  });
});
