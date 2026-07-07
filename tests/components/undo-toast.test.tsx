// 13-01a T4 tests: 4 cases — showUndoToast invocation + countdown decrement
// + undo-click + reduced-motion fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

import { showUndoToast } from '@/components/ui/undo-toast';

const { mockToastCustom, mockToastDismiss } = vi.hoisted(() => ({
  mockToastCustom: vi.fn(),
  mockToastDismiss: vi.fn(),
}));

vi.mock('sonner', () => {
  const toast = (() => undefined) as unknown as Record<string, unknown>;
  toast.custom = mockToastCustom;
  toast.dismiss = mockToastDismiss;
  return { toast, default: { toast } };
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );
}

describe('UndoToast', () => {
  beforeEach(() => {
    mockToastCustom.mockReset();
    mockToastDismiss.mockReset();
    mockToastCustom.mockReturnValue('toast-id-mock');
    // Reset reduced-motion to false by default
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
    vi.useRealTimers();
  });

  it('showUndoToast invokes sonner.toast.custom with duration', () => {
    const onUndo = vi.fn();
    const id = showUndoToast({
      message: 'Skipped video.mkv',
      onUndo,
      durationMs: 10000,
    });
    expect(mockToastCustom).toHaveBeenCalledTimes(1);
    const [, options] = mockToastCustom.mock.calls[0];
    expect(options).toEqual({ duration: 10000 });
    expect(id).toBe('toast-id-mock');
  });

  it('countdown decrements: 10s → 9s → 7s', () => {
    vi.useFakeTimers();
    const onUndo = vi.fn();
    showUndoToast({ message: 'Skipped', onUndo, durationMs: 10000 });
    const renderFn = mockToastCustom.mock.calls[0][0] as (id: string) => React.ReactElement;
    render(<Wrapper>{renderFn('tid')}</Wrapper>);
    expect(screen.getByTestId('undo-toast-progress-bar')).toBeInTheDocument();
    // Initial: 10s
    expect(screen.getByText(/Undo in 10s/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/Undo in 9s/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText(/Undo in 7s/)).toBeInTheDocument();
  });

  it('undo-button click → onUndo + sonner.dismiss(toastId)', () => {
    const onUndo = vi.fn();
    showUndoToast({ message: 'Skipped', onUndo });
    const renderFn = mockToastCustom.mock.calls[0][0] as (id: string) => React.ReactElement;
    render(<Wrapper>{renderFn('tid-99')}</Wrapper>);
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(mockToastDismiss).toHaveBeenCalledWith('tid-99');
  });

  it('reduced-motion → no progress-bar, text-fallback present', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((q: string) => ({
        matches: q.includes('reduce'),
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })),
    });
    const onUndo = vi.fn();
    showUndoToast({ message: 'Skipped', onUndo, durationMs: 10000 });
    const renderFn = mockToastCustom.mock.calls[0][0] as (id: string) => React.ReactElement;
    render(<Wrapper>{renderFn('tid-x')}</Wrapper>);
    expect(screen.queryByTestId('undo-toast-progress-bar')).not.toBeInTheDocument();
    expect(screen.getByTestId('undo-toast-countdown-text')).toBeInTheDocument();
  });
});
