/*
 * 47-02 T1c — BenchRunDeleteAction tests.
 *
 * ConfirmButton P3 machine (src/lib/ui/confirm-button-state-machine.ts):
 *   idle --ARM--> cooldown(3000ms) --ELAPSE--> armed(8000ms auto-disarm) --CONFIRM--> fired
 * There is NO direct idle→armed edge, so every arm-then-confirm test uses fake timers
 * and advances 3000ms inside act() between the two clicks. Two back-to-back clicks would
 * hit a pointer-events-none disabled primary and assert nothing (plan AC-8 / audit M1).
 * Pattern copied from tests/components/clear-logs-button.test.tsx:94-130.
 *
 * Covers AC-2, AC-3, AC-3b, AC-8, AC-11 (idle accessible name) and the row half of AC-12.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { BenchRunRow, BenchRunStatus } from '@/src/lib/db/schema';

const { mockToastSuccess, mockToastError, mockPurge, mockRefresh } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockPurge: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: mockToastSuccess,
    error: mockToastError,
    dismiss: vi.fn(),
    custom: vi.fn(() => 'sonner-id'),
  }),
}));

// P3 pulls the undo-toast module in through the shared ConfirmButton barrel (P2 path).
vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: vi.fn(() => 'undo-id'),
  UNDO_TOAST_DEFAULT_MS: 10_000,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/src/lib/api/bench-client', () => ({
  purgeBenchRun: mockPurge,
}));

import { BenchRunDeleteAction } from '@/components/bench/bench-run-delete-action';

function makeRun(id: number, status: BenchRunStatus = 'complete'): BenchRunRow {
  return {
    id,
    mode: 'native-sweep',
    status,
    fileIds: [1],
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [23] },
    sample_count: 3,
    sample_duration_seconds: 20,
    vmaf_buckets_json: null,
    vmaf_model: 'vmaf_v0.6.1',
    actor_id: null,
    error_reason: null,
    created_at: 1_700_000_000 + id,
    started_at: null,
    completed_at: null,
    version: 1,
  };
}

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

// Flush the async onConfirm chain under fake timers.
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function primary(): HTMLElement {
  return screen.getByTestId('confirm-button-primary');
}

function stateKind(): string | null {
  return primary().closest('[data-state]')?.getAttribute('data-state') ?? null;
}

/** idle → cooldown → armed (the only legal route to a confirmable control). */
function armControl(): void {
  act(() => {
    fireEvent.click(primary());
  });
  act(() => {
    vi.advanceTimersByTime(3000);
  });
}

beforeEach(() => {
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockPurge.mockReset();
  mockRefresh.mockReset();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((q: string) => ({
      matches: false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('BenchRunDeleteAction — status gate (AC-2)', () => {
  it.each<BenchRunStatus>(['pending', 'running'])(
    'renders NO control at all for status %s',
    (status) => {
      const { container } = render(
        wrap(<BenchRunDeleteAction run={makeRun(1, status)} onDeleted={vi.fn()} />),
      );
      expect(screen.queryByTestId('confirm-button-primary')).toBeNull();
      expect(container).toBeEmptyDOMElement();
    },
  );

  it.each<BenchRunStatus>(['complete', 'failed', 'cancelled'])(
    'renders a control for status %s',
    (status) => {
      render(wrap(<BenchRunDeleteAction run={makeRun(1, status)} onDeleted={vi.fn()} />));
      expect(screen.getByTestId('confirm-button-primary')).toBeInTheDocument();
    },
  );
});

describe('BenchRunDeleteAction — P3 safety margin (AC-8)', () => {
  it('a single click issues NO request and leaves the control in cooldown', () => {
    vi.useFakeTimers();
    mockPurge.mockResolvedValue({ deleted: true, combosDeleted: 4 });
    render(wrap(<BenchRunDeleteAction run={makeRun(7)} onDeleted={vi.fn()} />));

    act(() => {
      fireEvent.click(primary());
    });

    expect(stateKind()).toBe('cooldown');
    expect(primary()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('confirm-button-cancel')).toBeInTheDocument();
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('a second click DURING cooldown still issues no request', () => {
    vi.useFakeTimers();
    mockPurge.mockResolvedValue({ deleted: true, combosDeleted: 0 });
    render(wrap(<BenchRunDeleteAction run={makeRun(7)} onDeleted={vi.fn()} />));

    act(() => {
      fireEvent.click(primary());
    });
    act(() => {
      vi.advanceTimersByTime(1000);
      fireEvent.click(primary());
    });

    expect(stateKind()).toBe('cooldown');
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('arm + confirm issues EXACTLY ONE purge and removes the row (AC-1)', async () => {
    vi.useFakeTimers();
    mockPurge.mockResolvedValue({ deleted: true, combosDeleted: 4 });
    const onDeleted = vi.fn();
    render(wrap(<BenchRunDeleteAction run={makeRun(7)} onDeleted={onDeleted} />));

    armControl();
    expect(stateKind()).toBe('armed');
    expect(mockPurge).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(primary());
    });
    await flush();

    expect(mockPurge).toHaveBeenCalledTimes(1);
    expect(mockPurge).toHaveBeenCalledWith(7);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith([7]);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringContaining('Run #7 deleted'));
  });

  it('Escape from the ARMED+focused state disarms; a further single click issues nothing', () => {
    vi.useFakeTimers();
    mockPurge.mockResolvedValue({ deleted: true, combosDeleted: 1 });
    render(wrap(<BenchRunDeleteAction run={makeRun(7)} onDeleted={vi.fn()} />));

    armControl();
    expect(stateKind()).toBe('armed');

    // The ESC handler is instance-scoped via contains(document.activeElement)
    // (confirm-button.tsx:207-221) and fireEvent.click does NOT focus in jsdom.
    act(() => {
      (primary() as HTMLButtonElement).focus();
    });
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    act(() => {
      vi.advanceTimersByTime(200); // RESET_GRACE_MS: aborted → idle
    });

    expect(stateKind()).toBe('idle');

    act(() => {
      fireEvent.click(primary()); // re-arms only — must not fire
    });
    expect(mockPurge).not.toHaveBeenCalled();
  });
});

describe('BenchRunDeleteAction — rejection mapping (AC-3)', () => {
  const CASES: Array<[string, RegExp]> = [
    ['delete_rejected_active_run', /still active/i],
    ['delete_rejected_active_pass2', /full-file verify/i],
    ['run_not_found', /already gone/i],
    ['some_unknown_code', /Could not delete this run/i],
  ];

  it.each(CASES)('error %s yields its own toast and keeps the row', async (code, copy) => {
    vi.useFakeTimers();
    mockPurge.mockResolvedValue({ error: code });
    const onDeleted = vi.fn();
    render(wrap(<BenchRunDeleteAction run={makeRun(7)} onDeleted={onDeleted} />));

    armControl();
    act(() => {
      fireEvent.click(primary());
    });
    await flush();

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(copy));
    expect(onDeleted).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('a REJECTED wrapper yields the generic toast and no unhandled rejection', async () => {
    vi.useFakeTimers();
    // purgeBenchRun carries no internal try/catch (bench-client.ts:94-105): a network
    // failure or a non-JSON body REJECTS. Drive the throw path via a rejected promise,
    // NOT via an { error } return — they are different branches (audit M5).
    mockPurge.mockRejectedValue(new Error('network down'));
    const onDeleted = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      render(wrap(<BenchRunDeleteAction run={makeRun(7)} onDeleted={onDeleted} />));

      armControl();
      act(() => {
        fireEvent.click(primary());
      });
      await flush();

      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringMatching(/Could not delete this run/i),
      );
      expect(onDeleted).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('BenchRunDeleteAction — hung purge (AC-3b)', () => {
  it('a wrapper that never settles fails loudly after PURGE_TIMEOUT_MS and keeps the row', async () => {
    vi.useFakeTimers();
    mockPurge.mockReturnValue(new Promise(() => undefined));
    const onDeleted = vi.fn();
    render(wrap(<BenchRunDeleteAction run={makeRun(7)} onDeleted={onDeleted} />));

    armControl();
    act(() => {
      fireEvent.click(primary());
    });
    await flush();
    expect(mockToastError).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringMatching(/Could not delete this run/i),
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('BenchRunDeleteAction — accessible name (AC-11)', () => {
  it('the IDLE control names the run it deletes, via ConfirmButton label', () => {
    render(wrap(<BenchRunDeleteAction run={makeRun(42)} onDeleted={vi.fn()} />));
    expect(screen.getByRole('button', { name: 'Delete #42' })).toBeInTheDocument();
  });
});

describe('BenchRunDeleteAction — kill-switch (AC-12)', () => {
  it('NEXT_PUBLIC_BENCH_DELETE_DISABLED=1 renders nothing', async () => {
    vi.stubEnv('NEXT_PUBLIC_BENCH_DELETE_DISABLED', '1');
    vi.resetModules();
    // The constant is read at MODULE LOAD, so the module must be re-imported after
    // the env is stubbed — a re-render of the already-loaded module would not see it.
    const mod = await import('@/components/bench/bench-run-delete-action');
    const { container } = render(
      wrap(<mod.BenchRunDeleteAction run={makeRun(7)} onDeleted={vi.fn()} />),
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('confirm-button-primary')).toBeNull();
  });
});
