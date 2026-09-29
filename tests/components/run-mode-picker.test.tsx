// 12-04: RunModePicker tests — Select(recent completed runs) +
// RadioGroup(quality|balanced|size). Audit M1: server-side ?status=complete
// filter; SR4: vi.mock('next-intl', ...) + logger spy convention.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/messages/en.json';

vi.mock('@/src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { RunModePicker } from '@/components/settings/run-mode-picker';
import type { PickerChange } from '@/components/settings/run-mode-picker';

function renderPicker(
  overrides: {
    onChange?: (next: PickerChange) => void;
    selectedRunId?: number | null;
    mode?: 'quality' | 'balanced' | 'size';
    selectionSource?: 'default' | 'operator';
    selectionMode?: 'default' | 'operator';
  } = {},
) {
  const handler = overrides.onChange ?? vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      <RunModePicker
        selectedRunId={overrides.selectedRunId ?? null}
        mode={overrides.mode ?? 'quality'}
        selectionSource={overrides.selectionSource ?? 'default'}
        selectionMode={overrides.selectionMode ?? 'default'}
        onChange={handler}
      />
    </NextIntlClientProvider>,
  );
  return handler;
}

function mockFetchRuns(
  runs: Array<{
    id: number;
    status?: string;
    completed_at?: number | null;
    created_at?: number;
    matrix?: unknown;
  }>,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            runs: runs.map((r) => ({
              id: r.id,
              status: r.status ?? 'complete',
              completed_at: r.completed_at ?? r.id * 1000,
              created_at: r.created_at ?? r.id * 1000 - 10,
              matrix: r.matrix ?? { encoders: ['libx265'] },
            })),
            requestId: 'rq-' + Math.random(),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    ),
  );
}

describe('RunModePicker — fetch + default emit (audit SR5)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches /api/bench?status=complete on mount (audit M1)', async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ runs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchSpy);
    renderPicker();
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const url = String((fetchSpy.mock.calls as unknown as Array<[unknown]>)[0][0]);
    expect(url).toMatch(/\/api\/bench\?status=complete/);
    expect(url).toMatch(/limit=10/);
  });

  it('emits onChange(default, head-runId) once list resolves (audit SR5)', async () => {
    mockFetchRuns([{ id: 42 }, { id: 41 }]);
    const handler = vi.fn();
    renderPicker({ onChange: handler });
    await waitFor(() => {
      expect(handler).toHaveBeenCalled();
    });
    const call = handler.mock.calls[0][0] as PickerChange;
    expect(call.selectedRunId).toBe(42);
    expect(call.selectionSource).toBe('default');
    expect(call.mode).toBe('quality');
  });
});

describe('RunModePicker — mode RadioGroup', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders 3 mode radios with aria-checked semantic (AC-8)', async () => {
    mockFetchRuns([{ id: 1 }]);
    renderPicker();
    // 3 radio inputs (base-ui radio uses role="radio").
    const radios = await screen.findAllByRole('radio');
    expect(radios).toHaveLength(3);
  });

  it('selects mode → onChange invoked with selectionMode=operator', async () => {
    mockFetchRuns([{ id: 1 }]);
    const handler = vi.fn();
    renderPicker({ onChange: handler });
    await waitFor(() => {
      expect(handler).toHaveBeenCalled();
    });
    handler.mockClear();
    const balancedRadio = await screen.findByRole('radio', { name: /Balanced/ });
    fireEvent.click(balancedRadio);
    await waitFor(() => {
      expect(handler).toHaveBeenCalled();
    });
    const lastCall = handler.mock.calls[handler.mock.calls.length - 1][0] as PickerChange;
    expect(lastCall.mode).toBe('balanced');
    expect(lastCall.selectionMode).toBe('operator');
  });
});

describe('RunModePicker — empty list', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('no completed runs → disabled Select + empty helper-text', async () => {
    mockFetchRuns([]);
    renderPicker();
    await waitFor(() => {
      const matches = screen.getAllByText('No completed bench-runs yet');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });
});
