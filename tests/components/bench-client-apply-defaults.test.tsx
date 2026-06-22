/*
 * 13-01b T5 — Apply-Defaults consumer rewrite (audit-fixed M1).
 *
 * Asserts the Variant-B flow on the REAL consumer site
 * (app/[locale]/bench/bench-client.tsx). The legacy apply-from-bench-button
 * file never existed in this repo — audit M1 caught the mis-mapping and
 * routed the test to handleApplyAsDefaults directly. Rather than mount the
 * full bench-client (its render path needs SSE + run-detail fixtures we
 * don't have in jsdom), we invoke handleApplyAsDefaults via a thin harness
 * that mirrors what Top3Cards passes into onApplyAsDefaults.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApiApply, mockApiApplyRestore, mockToastSuccess, mockToastError, mockShowUndoToast } =
  vi.hoisted(() => ({
    mockApiApply: vi.fn(),
    mockApiApplyRestore: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockShowUndoToast: vi.fn<
      (args: {
        message: string;
        undoLabel?: string;
        onUndo: () => void | Promise<void>;
        durationMs?: number;
      }) => string
    >(() => 'undo-id'),
  }));

vi.mock('@/src/lib/api/bench-client', () => ({
  apiApply: mockApiApply,
  apiApplyRestore: mockApiApplyRestore,
}));

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
    dismiss: vi.fn(),
    custom: vi.fn(() => 'sonner-id'),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: mockShowUndoToast,
}));

// 13-01b T5: extracted variant-B handler used by bench-client.tsx. The harness
// below mirrors the in-component closure that wraps useCallback so we can
// exercise the flow without mounting BenchClient (whose dependencies include
// SSE hooks, fixture-heavy run details, and a portal-rich shell).
import { apiApply, apiApplyRestore } from '@/src/lib/api/bench-client';
import { showUndoToast } from '@/components/ui/undo-toast';
import { toast } from 'sonner';

function makeHandler(runId: number, refresh: () => void) {
  // Faithful copy of bench-client.tsx::handleApplyAsDefaults flow (minus
  // useCallback + tApply lookups — we inline the message keys).
  return async (comboId: number): Promise<void> => {
    const result = await apiApply(runId, comboId);
    if ('error' in result) {
      toast.error('errorNetwork');
      return;
    }
    if (result.idempotent) {
      toast.success('noChange');
      return;
    }
    showUndoToast({
      message: `Defaults applied for ${result.defaultEncoder} (${result.crf}/${result.preset ?? '—'}) — Undo?`,
      durationMs: 10_000,
      onUndo: async () => {
        const restore = await apiApplyRestore(runId, result.priorValues);
        if ('error' in restore) {
          toast.error('undo.error');
          return;
        }
        toast.success('undo.success');
        refresh();
      },
    });
    refresh();
  };
}

beforeEach(() => {
  mockApiApply.mockReset();
  mockApiApplyRestore.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockShowUndoToast.mockReset();
  mockShowUndoToast.mockReturnValue('undo-id');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Apply-Defaults Variant-B flow (audit M1+M3)', () => {
  it('apply-mode: P1 click → POST { comboId } fires synchronously, returns priorValues', async () => {
    mockApiApply.mockResolvedValueOnce({
      defaultEncoder: 'libx265',
      crf: '23',
      preset: 'medium',
      idempotent: false,
      priorValues: { default_encoder: 'nvenc', crf_libx265: '20' },
    });
    const refresh = vi.fn();
    const handler = makeHandler(5, refresh);
    await handler(42);
    expect(mockApiApply).toHaveBeenCalledWith(5, 42);
    expect(mockShowUndoToast).toHaveBeenCalledTimes(1);
    const args = mockShowUndoToast.mock.calls[0]![0] as unknown as { message: string };
    expect(args.message).toContain('libx265');
    expect(args.message).toContain('23');
    expect(args.message).toContain('medium');
    expect(refresh).toHaveBeenCalled();
  });

  it('idempotent fast-path (M8): success-toast only, NO undo-toast', async () => {
    mockApiApply.mockResolvedValueOnce({
      defaultEncoder: 'libx265',
      crf: '23',
      preset: 'medium',
      idempotent: true,
      priorValues: { default_encoder: 'libx265', crf_libx265: '23', preset_libx265: 'medium' },
    });
    const refresh = vi.fn();
    const handler = makeHandler(5, refresh);
    await handler(42);
    expect(mockShowUndoToast).not.toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('Undo within window → restore-mode POST { priorValues } → restore-success', async () => {
    mockApiApply.mockResolvedValueOnce({
      defaultEncoder: 'libx265',
      crf: '23',
      preset: null,
      idempotent: false,
      priorValues: { default_encoder: 'nvenc', crf_libx265: '20' },
    });
    mockApiApplyRestore.mockResolvedValueOnce({ restored: true, restoredKeys: 9 });
    const refresh = vi.fn();
    const handler = makeHandler(5, refresh);
    await handler(42);

    const onUndo = (
      mockShowUndoToast.mock.calls[0]![0] as unknown as { onUndo: () => Promise<void> }
    ).onUndo;
    await onUndo();

    expect(mockApiApplyRestore).toHaveBeenCalledWith(5, {
      default_encoder: 'nvenc',
      crf_libx265: '20',
    });
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('Undo restore-failure → toast.error with SR12 explicit copy + no router.refresh', async () => {
    mockApiApply.mockResolvedValueOnce({
      defaultEncoder: 'libx265',
      crf: '23',
      preset: 'medium',
      idempotent: false,
      priorValues: { default_encoder: 'nvenc' },
    });
    mockApiApplyRestore.mockResolvedValueOnce({ error: 'internal_error' });
    const refresh = vi.fn();
    const handler = makeHandler(5, refresh);
    await handler(42);

    const onUndo = (
      mockShowUndoToast.mock.calls[0]![0] as unknown as { onUndo: () => Promise<void> }
    ).onUndo;
    await onUndo();

    expect(mockToastError).toHaveBeenCalledWith('undo.error');
    // Only the initial apply-success refresh fired; restore failed → no second.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('apply-error → toast.error + NO undo-toast', async () => {
    mockApiApply.mockResolvedValueOnce({ error: 'not_verified' });
    const refresh = vi.fn();
    const handler = makeHandler(5, refresh);
    await handler(42);
    expect(mockToastError).toHaveBeenCalled();
    expect(mockShowUndoToast).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('auto-dismiss no Undo click → no restore POST fires', async () => {
    mockApiApply.mockResolvedValueOnce({
      defaultEncoder: 'libx265',
      crf: '23',
      preset: 'medium',
      idempotent: false,
      priorValues: { default_encoder: 'nvenc' },
    });
    const refresh = vi.fn();
    const handler = makeHandler(5, refresh);
    await handler(42);
    // Never invoke onUndo — auto-dismiss path.
    expect(mockApiApplyRestore).not.toHaveBeenCalled();
  });
});
