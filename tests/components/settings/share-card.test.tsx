/*
 * 14-04 Task 4 — ShareCard tests.
 *
 * Covers AC-11 anatomy (collapsed summary) + AC-13 P3 delete behavior +
 * AC-11 expand-to-edit toggle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { ShareCard } from '@/components/settings/share-card';
import type { ShareRow } from '@/src/lib/db/schema';

vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: vi.fn(),
  UNDO_TOAST_DEFAULT_MS: 10000,
}));

vi.mock('sonner', () => {
  const toastFn = (() => undefined) as unknown as Record<string, unknown>;
  toastFn.dismiss = vi.fn();
  toastFn.custom = vi.fn();
  toastFn.success = vi.fn();
  toastFn.error = vi.fn();
  toastFn.message = vi.fn();
  return { toast: toastFn, default: { toast: toastFn } };
});

function wrap(children: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );
}

function sample(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 1,
    name: 'Movies',
    path: '/media/movies',
    min_size_mb: 50,
    extensions_csv: 'mkv,mp4,avi',
    max_depth: 8,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

beforeEach(() => {
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

describe('ShareCard — collapsed summary (AC-11)', () => {
  it('test_collapsed_when_max_depth_8_then_summary_reads_full_anatomy', () => {
    render(
      wrap(
        <ShareCard
          share={sample()}
          isEditing={false}
          onEditStart={vi.fn()}
          onEditCancel={vi.fn()}
          onSave={vi.fn()}
          onDelete={vi.fn()}
        />,
      ),
    );
    const summary = screen.getByTestId('share-summary');
    expect(summary.textContent).toContain('Movies');
    expect(summary.textContent).toContain('/media/movies');
    expect(summary.textContent).toContain('min 50');
    expect(summary.textContent).toContain('3 ext');
    expect(summary.textContent).toContain('depth 8');
  });

  it('test_collapsed_when_max_depth_null_then_summary_shows_infinity_glyph', () => {
    render(
      wrap(
        <ShareCard
          share={sample({ max_depth: null })}
          isEditing={false}
          onEditStart={vi.fn()}
          onEditCancel={vi.fn()}
          onSave={vi.fn()}
          onDelete={vi.fn()}
        />,
      ),
    );
    expect(screen.getByTestId('share-summary').textContent).toContain('depth ∞');
  });

  it('test_collapsed_when_clicked_edit_then_calls_onEditStart', async () => {
    const onEditStart = vi.fn();
    render(
      wrap(
        <ShareCard
          share={sample()}
          isEditing={false}
          onEditStart={onEditStart}
          onEditCancel={vi.fn()}
          onSave={vi.fn()}
          onDelete={vi.fn()}
        />,
      ),
    );
    const editBtn = screen.getByTestId('share-edit-btn-1');
    await userEvent.click(editBtn);
    expect(onEditStart).toHaveBeenCalledTimes(1);
  });

  it('test_buttons_when_md_size_then_min_height_44px_class_present', () => {
    render(
      wrap(
        <ShareCard
          share={sample()}
          isEditing={false}
          onEditStart={vi.fn()}
          onEditCancel={vi.fn()}
          onSave={vi.fn()}
          onDelete={vi.fn()}
        />,
      ),
    );
    const editBtn = screen.getByTestId('share-edit-btn-1');
    expect(editBtn.className).toContain('min-h-11');
  });
});

describe('ShareCard — expanded edit (AC-11)', () => {
  it('test_expanded_when_isEditing_true_then_renders_ShareEditForm', () => {
    render(
      wrap(
        <ShareCard
          share={sample()}
          isEditing={true}
          onEditStart={vi.fn()}
          onEditCancel={vi.fn()}
          onSave={vi.fn()}
          onDelete={vi.fn()}
        />,
      ),
    );
    expect(screen.getByTestId('share-edit-form')).toBeInTheDocument();
    expect(screen.queryByTestId('share-summary')).toBeNull();
  });
});

describe('ShareCard — P3 delete (AC-13)', () => {
  it('test_delete_when_p3_cooldown_then_armed_then_confirmed_calls_onDelete_once', () => {
    vi.useFakeTimers();
    const onDelete = vi.fn();
    render(
      wrap(
        <ShareCard
          share={sample()}
          isEditing={false}
          onEditStart={vi.fn()}
          onEditCancel={vi.fn()}
          onSave={vi.fn()}
          onDelete={onDelete}
        />,
      ),
    );
    const primary = screen.getByTestId('confirm-button-primary');
    // Click 1 → cooldown
    act(() => {
      fireEvent.click(primary);
    });
    // Wait 3s for armed transition
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // Click 2 → fires onConfirm
    act(() => {
      fireEvent.click(primary);
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('test_delete_when_cancel_clicked_during_cooldown_then_aborts_and_no_onDelete', () => {
    vi.useFakeTimers();
    const onDelete = vi.fn();
    render(
      wrap(
        <ShareCard
          share={sample()}
          isEditing={false}
          onEditStart={vi.fn()}
          onEditCancel={vi.fn()}
          onSave={vi.fn()}
          onDelete={onDelete}
        />,
      ),
    );
    const primary = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(primary);
    });
    const cancel = screen.getByTestId('confirm-button-cancel');
    act(() => {
      fireEvent.click(cancel);
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDelete).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
