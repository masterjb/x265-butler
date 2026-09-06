/*
 * 50-05 T3: ContainerLogPanel filters. F6 — before this file the panel had no
 * test at all; the route did. Deliberately NOT retrofitting coverage for the
 * pre-existing controls (format, lines, auto-refresh, download) beyond what the
 * new ACs touch: this plan tests what it builds.
 *
 * Covers:
 *   AC-5  — substring, case-insensitive, and `[` does NOT throw (no regex).
 *   AC-6  — the two-branch cpu_attribution case: level 25 goes, level 40 STAYS.
 *           This is the test that defends E2 against an action denylist.
 *   AC-7  — text filter AND telemetry switch combine.
 *   AC-8  — the filter empty-state names the ACTUALLY loaded line count, not the
 *           `lines` selector value.
 *   AC-8b — the "raise the line count" hint appears only when the ring holds
 *           more than the tail shows.
 *   AC-9  — no filter → every line, unchanged order; ring-empty keeps its own text.
 *   AC-10 — the filter survives an auto-refresh.
 *   AC-11 — the filter survives a format / lines change.
 *   AC-12 — the download href is untouched by an active filter.
 *   AC-13 — labels, aria-labels, keyboard reachability.
 *   AC-13c— the filter empty-state sits in an aria-live="polite" region.
 *   AC-18 — a response WITHOUT meta does not reuse the old meta; it fails OPEN.
 *   AC-19 — level: null is never hidden by the telemetry switch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

const { mockAuthFetch } = vi.hoisted(() => ({ mockAuthFetch: vi.fn() }));

vi.mock('@/components/auth/auth-fetcher', () => ({
  authFetch: mockAuthFetch,
  AuthRedirectError: class extends Error {},
}));

// The clear button is a P3 ConfirmButton with its own network path — out of
// scope here, stubbed so this file tests the filters and nothing else.
vi.mock('@/components/logs/clear-logs-button', () => ({
  ClearLogsButton: () => <button type="button">clear-stub</button>,
}));

import { ContainerLogPanel } from '@/components/logs/container-log-panel';

type Meta = { level: number | null; action: string | null } | null;

function respond(lines: string[], meta: Meta[] | undefined, totalLines?: number): void {
  mockAuthFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      lines,
      ...(meta === undefined ? {} : { meta }),
      totalLines: totalLines ?? lines.length,
      totalBytes: 0,
      format: 'raw',
    }),
  });
}

function renderPanel(props?: { lines?: number; format?: 'raw' | 'json' }) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ContainerLogPanel
        format={props?.format ?? 'raw'}
        lines={props?.lines ?? 100}
        onFormatChange={() => {}}
        onLinesChange={() => {}}
      />
    </NextIntlClientProvider>,
  );
}

const TELE_LINE = '2026-08-20T10:00:00.000Z TELE cpu_attribution {"lagP99":3}';
const WARN_LINE = '2026-08-20T10:00:01.000Z WARN cpu_attribution {"lagP99":410}';
const INFO_LINE = '2026-08-20T10:00:02.000Z INFO encoder_detection_complete';

const TELE_META: Meta = { level: 25, action: 'cpu_attribution' };
const WARN_META: Meta = { level: 40, action: 'cpu_attribution' };
const INFO_META: Meta = { level: 30, action: 'encoder_detection_complete' };

function visibleLogLines(): string[] {
  const pre = document.querySelector('pre');
  return Array.from(pre?.querySelectorAll('span') ?? []).map((s) => s.textContent ?? '');
}

beforeEach(() => {
  mockAuthFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ContainerLogPanel — filters (50-05)', () => {
  // AC-9
  it('AC-9: with no filter every loaded line is shown, in order', async () => {
    respond([TELE_LINE, WARN_LINE, INFO_LINE], [TELE_META, WARN_META, INFO_META]);
    renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(3));
    expect(visibleLogLines()).toEqual([TELE_LINE, WARN_LINE, INFO_LINE]);
    expect(screen.queryByText(en.logs.container.empty)).toBeNull();
  });

  // AC-9, second half: the pre-existing ring-empty state is untouched.
  it('AC-9: an empty ring still shows the original "no log lines" text', async () => {
    respond([], []);
    renderPanel();
    await waitFor(() => expect(screen.getByText(en.logs.container.empty)).toBeTruthy());
  });

  // AC-5
  it('AC-5: the text filter is a case-insensitive substring match', async () => {
    respond([TELE_LINE, WARN_LINE, INFO_LINE], [TELE_META, WARN_META, INFO_META]);
    renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(3));

    const input = screen.getByLabelText(en.logs.container.filter.aria);
    fireEvent.change(input, { target: { value: 'DETECTION' } });

    expect(visibleLogLines()).toEqual([INFO_LINE]);
  });

  // AC-5, the reason it is not a regex.
  it('AC-5: typing "[" does not throw — the filter is not a regex', async () => {
    respond([INFO_LINE], [INFO_META]);
    renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(1));

    const input = screen.getByLabelText(en.logs.container.filter.aria);
    expect(() => fireEvent.change(input, { target: { value: '[' } })).not.toThrow();
    expect(visibleLogLines()).toEqual([]);
  });

  // AC-6 — the load-bearing test for decision E2.
  it('AC-6: hiding telemetry drops level 25 and KEEPS the warn branch of the same action', async () => {
    respond([TELE_LINE, WARN_LINE], [TELE_META, WARN_META]);
    renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(2));

    fireEvent.click(screen.getByRole('switch', { name: en.logs.container.filter.hideTelemetry }));

    expect(visibleLogLines()).toEqual([WARN_LINE]);
  });

  // AC-6, third clause + AC-3 fail-open.
  it('AC-6: a line with meta null stays visible while telemetry is hidden', async () => {
    respond([TELE_LINE, 'unparsable raw line'], [TELE_META, null]);
    renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(2));

    fireEvent.click(screen.getByRole('switch', { name: en.logs.container.filter.hideTelemetry }));

    expect(visibleLogLines()).toEqual(['unparsable raw line']);
  });

  // AC-19
  it('AC-19: a level of null is never hidden — only an exact 25 is', async () => {
    respond([TELE_LINE, 'no level at all'], [TELE_META, { level: null, action: 'something' }]);
    renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(2));

    fireEvent.click(screen.getByRole('switch', { name: en.logs.container.filter.hideTelemetry }));

    expect(visibleLogLines()).toEqual(['no level at all']);
  });

  // AC-7
  it('AC-7: text filter and telemetry switch combine with AND', async () => {
    respond([TELE_LINE, WARN_LINE, INFO_LINE], [TELE_META, WARN_META, INFO_META]);
    renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(3));

    fireEvent.change(screen.getByLabelText(en.logs.container.filter.aria), {
      target: { value: 'cpu' },
    });
    fireEvent.click(screen.getByRole('switch', { name: en.logs.container.filter.hideTelemetry }));

    // "cpu" matches both cpu_attribution lines; the switch removes the level-25 one.
    expect(visibleLogLines()).toEqual([WARN_LINE]);
  });

  // AC-8 — the MH-2 case: the message must name what is loaded, not the selector.
  it('AC-8: the filter empty-state names the loaded line count (40), not the selector (1000)', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    respond(
      lines,
      lines.map(() => INFO_META),
      40,
    );
    renderPanel({ lines: 1000 });
    await waitFor(() => expect(visibleLogLines()).toHaveLength(40));

    fireEvent.change(screen.getByLabelText(en.logs.container.filter.aria), {
      target: { value: 'zzz-no-such-line' },
    });

    const msg = screen.getByText(/No match/);
    expect(msg.textContent).toContain('40');
    expect(msg.textContent).not.toContain('1000');
    // And it is NOT the ring-empty text, which would be false here.
    expect(screen.queryByText(en.logs.container.empty)).toBeNull();
  });

  // AC-8b, both directions.
  it('AC-8b: the "raise the line count" hint appears only when the ring holds more', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i}`);
    respond(
      lines,
      lines.map(() => INFO_META),
      900,
    );
    const { unmount } = renderPanel({ lines: 100 });
    await waitFor(() => expect(visibleLogLines()).toHaveLength(5));

    fireEvent.change(screen.getByLabelText(en.logs.container.filter.aria), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText(/line selector/i)).toBeTruthy();
    unmount();

    // Whole ring loaded → the hint would be useless, so it must be absent.
    respond(
      lines,
      lines.map(() => INFO_META),
      5,
    );
    renderPanel({ lines: 100 });
    await waitFor(() => expect(visibleLogLines()).toHaveLength(5));

    fireEvent.change(screen.getByLabelText(en.logs.container.filter.aria), {
      target: { value: 'zzz' },
    });
    expect(screen.queryByText(/line selector/i)).toBeNull();
    expect(screen.getByText(/entire buffer/i)).toBeTruthy();
  });

  // AC-13c
  it('AC-13c: the filter empty-state lives in an aria-live="polite" region', async () => {
    respond([INFO_LINE], [INFO_META]);
    const { container } = renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(1));

    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();

    fireEvent.change(screen.getByLabelText(en.logs.container.filter.aria), {
      target: { value: 'zzz' },
    });
    expect(live?.textContent ?? '').toMatch(/No match/);
  });

  // AC-10
  it('AC-10: the filter survives an auto-refresh and applies to the new lines', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    respond([INFO_LINE], [INFO_META]);
    renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(1));

    fireEvent.change(screen.getByLabelText(en.logs.container.filter.aria), {
      target: { value: 'detection' },
    });
    fireEvent.click(screen.getByRole('switch', { name: en.logs.container.action.autoRefresh }));

    respond([INFO_LINE, TELE_LINE], [INFO_META, TELE_META]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });

    // The new telemetry line does not contain "detection" and is filtered out;
    // the filter input itself kept its value.
    await waitFor(() => expect(visibleLogLines()).toEqual([INFO_LINE]));
    expect((screen.getByLabelText(en.logs.container.filter.aria) as HTMLInputElement).value).toBe(
      'detection',
    );
  });

  // AC-11
  it('AC-11: the filter survives a format change and applies to the refetched result', async () => {
    respond([INFO_LINE, TELE_LINE], [INFO_META, TELE_META]);
    const { rerender } = renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(2));

    fireEvent.change(screen.getByLabelText(en.logs.container.filter.aria), {
      target: { value: 'detection' },
    });
    expect(visibleLogLines()).toEqual([INFO_LINE]);

    respond(
      ['{"msg":"encoder_detection_complete"}', '{"msg":"cpu_attribution"}'],
      [INFO_META, TELE_META],
    );
    rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ContainerLogPanel
          format="json"
          lines={100}
          onFormatChange={() => {}}
          onLinesChange={() => {}}
        />
      </NextIntlClientProvider>,
    );

    await waitFor(() =>
      expect(visibleLogLines()).toEqual(['{"msg":"encoder_detection_complete"}']),
    );
    expect((screen.getByLabelText(en.logs.container.filter.aria) as HTMLInputElement).value).toBe(
      'detection',
    );
  });

  // AC-18 — the silent failure class this plan has to rule out.
  it('AC-18: a response without meta does not reuse the old meta and fails OPEN', async () => {
    respond([TELE_LINE], [TELE_META]);
    renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(1));

    fireEvent.click(screen.getByRole('switch', { name: en.logs.container.filter.hideTelemetry }));
    expect(visibleLogLines()).toEqual([]);

    // Same line, but the response carries NO meta this time.
    respond([TELE_LINE], undefined);
    fireEvent.click(screen.getByLabelText(en.logs.container.action.refreshAria));

    // Stale meta would keep hiding it. Fail-open means it comes back.
    await waitFor(() => expect(visibleLogLines()).toEqual([TELE_LINE]));
  });

  // AC-12
  it('AC-12: the download href is unaffected by an active filter', async () => {
    respond([INFO_LINE], [INFO_META]);
    const { container } = renderPanel({ lines: 500, format: 'json' });
    await waitFor(() => expect(visibleLogLines()).toHaveLength(1));

    const href = container.querySelector('a')?.getAttribute('href');
    fireEvent.change(screen.getByLabelText(en.logs.container.filter.aria), {
      target: { value: 'zzz' },
    });

    expect(container.querySelector('a')?.getAttribute('href')).toBe(href);
    expect(href).toBe('/api/logs/container?lines=500&format=json');
    // And the footer says so, rather than letting a shared log lie by omission.
    expect(screen.getByText(en.logs.container.note.downloadUnfiltered)).toBeTruthy();
  });

  // AC-13
  it('AC-13: the new controls are labelled and keyboard-reachable', async () => {
    respond([INFO_LINE], [INFO_META]);
    renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(1));

    const input = screen.getByLabelText(en.logs.container.filter.aria) as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('type')).toBe('search');

    // The switch is bound through <label htmlFor>, the pattern of the
    // auto-refresh switch in the same header.
    const sw = screen.getByRole('switch', { name: en.logs.container.filter.hideTelemetry });
    // <label htmlFor> binds to the control the Switch exposes for it, and the
    // switch itself is in the tab order — the same wiring as the auto-refresh
    // switch next to it.
    expect(document.querySelector('label[for="container-hide-telemetry"]')).toBeTruthy();
    expect(document.getElementById('container-hide-telemetry')).toBeTruthy();
    expect(sw.getAttribute('tabindex')).toBe('0');
    expect(sw.getAttribute('aria-describedby')).toBe('container-hide-telemetry-hint');
    expect(document.getElementById('container-hide-telemetry-hint')?.textContent).toBe(
      en.logs.container.filter.hideTelemetryHint,
    );

    // The clear affordance only exists once there is something to clear, and it
    // carries a name — it is icon-only.
    expect(screen.queryByLabelText(en.logs.container.filter.clear)).toBeNull();
    fireEvent.change(input, { target: { value: 'x' } });
    const clear = screen.getByLabelText(en.logs.container.filter.clear);
    fireEvent.click(clear);
    expect((screen.getByLabelText(en.logs.container.filter.aria) as HTMLInputElement).value).toBe(
      '',
    );
  });

  // AC-13, last clause — review R-2. The AC says the new controls take the
  // height of their neighbours; no test froze it, and audit MH-1 exists because
  // a wrong height number already slipped through an AC once (it claimed h-9
  // while the header is h-7/h-8). The freeze is the ABSENCE of an override: the
  // input must carry no h-* class of its own, so it renders at the Input
  // default. Raising this header is a separate job (CLAUDE.md Z.103 note) — if
  // someone bumps it here alone, this goes red.
  it('AC-13: the filter input takes the Input default height, no h-* override', async () => {
    respond([INFO_LINE], [INFO_META]);
    renderPanel();
    await waitFor(() => expect(visibleLogLines()).toHaveLength(1));

    const input = screen.getByLabelText(en.logs.container.filter.aria);
    // `cn()` is tailwind-merge: an h-* passed through className REPLACES the
    // default, so exactly one h-* survives and its value is the freeze.
    expect(Array.from(input.classList).filter((c) => /^h-\d/.test(c))).toEqual(['h-8']);

    // "Switch wie der Auto-Refresh-Schalter" — same claim, checked by identity
    // rather than by a number, so it stays true if the shared default moves.
    const telemetry = screen.getByRole('switch', {
      name: en.logs.container.filter.hideTelemetry,
    });
    const autoRefresh = screen.getByRole('switch', {
      name: en.logs.container.action.autoRefresh,
    });
    expect(telemetry.className).toBe(autoRefresh.className);
  });
});
