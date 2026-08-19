/*
 * 47-02 T2 — BenchBulkActions tests.
 *
 * Covers all five AC-6 envelope branches (all-success / mixed / all-failed / { error }
 * return / rejected promise — the last two as SEPARATE tests per audit M5), the bulk
 * half of AC-8 (P3 cooldown: idle → cooldown(3000ms) → armed → fired, fake timers),
 * AC-3b (hung request) and AC-12 (kill-switch).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

const { mockToast, mockToastSuccess, mockToastError, mockBulkDelete, mockRefresh } = vi.hoisted(
  () => ({
    mockToast: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockBulkDelete: vi.fn(),
    mockRefresh: vi.fn(),
  }),
);

vi.mock('sonner', () => ({
  toast: Object.assign(mockToast, {
    success: mockToastSuccess,
    error: mockToastError,
    dismiss: vi.fn(),
    custom: vi.fn(() => 'sonner-id'),
  }),
}));

vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: vi.fn(() => 'undo-id'),
  UNDO_TOAST_DEFAULT_MS: 10_000,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/src/lib/api/bench-client', () => ({
  bulkDeleteBenchRuns: mockBulkDelete,
}));

import { BenchBulkActions } from '@/components/bench/bench-bulk-actions';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

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

function armAndConfirm(): void {
  act(() => {
    fireEvent.click(primary()); // → cooldown
  });
  act(() => {
    vi.advanceTimersByTime(3000); // → armed
  });
  act(() => {
    fireEvent.click(primary()); // → fired
  });
}

/** Renders the description ReactNode that sonner was handed, so per-id copy is assertable. */
function renderedDescription(call: unknown[]): string {
  const opts = call[1] as { description?: React.ReactNode } | undefined;
  const { container } = render(wrap(<>{opts?.description}</>));
  return container.textContent ?? '';
}

beforeEach(() => {
  mockToast.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockBulkDelete.mockReset();
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

describe('BenchBulkActions — P3 safety margin (AC-8)', () => {
  it('a single click issues NO request', () => {
    vi.useFakeTimers();
    mockBulkDelete.mockResolvedValue({ successCount: 3, failed: [] });
    render(wrap(<BenchBulkActions ids={[1, 2, 3]} onDeleted={vi.fn()} onAfter={vi.fn()} />));

    act(() => {
      fireEvent.click(primary());
    });

    expect(primary()).toHaveAttribute('aria-disabled', 'true');
    expect(mockBulkDelete).not.toHaveBeenCalled();
  });

  it('is disabled with an empty selection', () => {
    render(wrap(<BenchBulkActions ids={[]} onDeleted={vi.fn()} onAfter={vi.fn()} />));
    expect(primary()).toBeDisabled();
  });
});

describe('BenchBulkActions — envelope handling (AC-6)', () => {
  it('all-success: success toast, deleted ids reported, selection cleared', async () => {
    vi.useFakeTimers();
    mockBulkDelete.mockResolvedValue({ successCount: 3, failed: [] });
    const onDeleted = vi.fn();
    const onAfter = vi.fn();
    render(wrap(<BenchBulkActions ids={[1, 2, 3]} onDeleted={onDeleted} onAfter={onAfter} />));

    armAndConfirm();
    await flush();

    expect(mockBulkDelete).toHaveBeenCalledTimes(1);
    expect(mockBulkDelete).toHaveBeenCalledWith([1, 2, 3]);
    expect(mockToastSuccess).toHaveBeenCalledWith('3 runs deleted');
    expect(onDeleted).toHaveBeenCalledWith([1, 2, 3]);
    expect(onAfter).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('mixed: only the successful id is removed, the WHOLE selection is cleared (SR5)', async () => {
    vi.useFakeTimers();
    mockBulkDelete.mockResolvedValue({
      successCount: 1,
      failed: [
        { id: 2, reason: 'active_run' },
        { id: 3, reason: 'not_found' },
      ],
    });
    const onDeleted = vi.fn();
    const onAfter = vi.fn();
    render(wrap(<BenchBulkActions ids={[1, 2, 3]} onDeleted={onDeleted} onAfter={onAfter} />));

    armAndConfirm();
    await flush();

    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0][0]).toBe('1 deleted, 2 failed');
    const detail = renderedDescription(mockToast.mock.calls[0]);
    expect(detail).toContain('#2: Run still active — cancel it first');
    expect(detail).toContain('#3: Not found');
    expect(onDeleted).toHaveBeenCalledWith([1]);
    expect(onAfter).toHaveBeenCalledTimes(1);
  });

  it('all four route reasons resolve to real copy, not an echoed key path', async () => {
    vi.useFakeTimers();
    mockBulkDelete.mockResolvedValue({
      successCount: 1,
      failed: [
        { id: 2, reason: 'not_found' },
        { id: 3, reason: 'active_run' },
        { id: 4, reason: 'active_pass2' },
        { id: 5, reason: 'internal_error' },
      ],
    });
    render(wrap(<BenchBulkActions ids={[1, 2, 3, 4, 5]} onDeleted={vi.fn()} onAfter={vi.fn()} />));

    armAndConfirm();
    await flush();

    const detail = renderedDescription(mockToast.mock.calls[0]);
    expect(detail).toContain('#2: Not found');
    expect(detail).toContain('#3: Run still active — cancel it first');
    expect(detail).toContain('#4: Full-file verify still running');
    // Only 3 detail lines render; the 4th collapses into the "+N more" tail.
    expect(detail).toContain('+1 more');
    expect(detail).not.toContain('bulk.failed');
  });

  it('all-failed: error toast, nothing removed, selection PRESERVED', async () => {
    vi.useFakeTimers();
    mockBulkDelete.mockResolvedValue({
      successCount: 0,
      failed: [
        { id: 1, reason: 'active_run' },
        { id: 2, reason: 'active_pass2' },
      ],
    });
    const onDeleted = vi.fn();
    const onAfter = vi.fn();
    render(wrap(<BenchBulkActions ids={[1, 2]} onDeleted={onDeleted} onAfter={onAfter} />));

    armAndConfirm();
    await flush();

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError.mock.calls[0][0]).toBe('2 runs could not be deleted');
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onAfter).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('envelope-level { error } return: network toast, selection PRESERVED', async () => {
    vi.useFakeTimers();
    mockBulkDelete.mockResolvedValue({ error: 'invalid_body' });
    const onDeleted = vi.fn();
    const onAfter = vi.fn();
    render(wrap(<BenchBulkActions ids={[1, 2]} onDeleted={onDeleted} onAfter={onAfter} />));

    armAndConfirm();
    await flush();

    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringMatching(/Could not delete the selected runs/i),
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onAfter).not.toHaveBeenCalled();
  });

  it('a REJECTED wrapper: network toast, selection PRESERVED, no unhandled rejection', async () => {
    vi.useFakeTimers();
    // bulkDeleteBenchRuns has no internal try/catch (bench-client.ts:110-127) — this is
    // a different code path from the { error } return above (audit M5).
    mockBulkDelete.mockRejectedValue(new Error('network down'));
    const onDeleted = vi.fn();
    const onAfter = vi.fn();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      render(wrap(<BenchBulkActions ids={[1, 2]} onDeleted={onDeleted} onAfter={onAfter} />));

      armAndConfirm();
      await flush();

      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringMatching(/Could not delete the selected runs/i),
      );
      expect(onDeleted).not.toHaveBeenCalled();
      expect(onAfter).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('BenchBulkActions — hung purge (AC-3b)', () => {
  it('a wrapper that never settles fails loudly after PURGE_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    mockBulkDelete.mockReturnValue(new Promise(() => undefined));
    const onDeleted = vi.fn();
    const onAfter = vi.fn();
    render(wrap(<BenchBulkActions ids={[1, 2]} onDeleted={onDeleted} onAfter={onAfter} />));

    armAndConfirm();
    await flush();
    expect(mockToastError).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringMatching(/Could not delete the selected runs/i),
    );
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onAfter).not.toHaveBeenCalled();
  });
});

describe('BenchBulkActions — kill-switch (AC-12)', () => {
  it('NEXT_PUBLIC_BENCH_DELETE_DISABLED=1 renders nothing', async () => {
    vi.stubEnv('NEXT_PUBLIC_BENCH_DELETE_DISABLED', '1');
    vi.resetModules();
    const mod = await import('@/components/bench/bench-bulk-actions');
    const { container } = render(
      wrap(<mod.BenchBulkActions ids={[1, 2]} onDeleted={vi.fn()} onAfter={vi.fn()} />),
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('confirm-button-primary')).toBeNull();
  });
});
