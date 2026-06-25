// 13-01a T3 tests: 16 cases — P1/P2/P3 happy + edge paths + 4 audit regressions
// (M3 ESC-isolation / M5 re-render / SR3 cooldown-suppress / SR4 touch-target≥44px).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

import { ConfirmButton } from '@/components/ui/confirm-button';

const { mockShowUndoToast, mockToastDismiss } = vi.hoisted(() => ({
  mockShowUndoToast: vi.fn(),
  mockToastDismiss: vi.fn(),
}));

vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: mockShowUndoToast,
  UNDO_TOAST_DEFAULT_MS: 10000,
}));

vi.mock('sonner', () => {
  const toast = (() => undefined) as unknown as Record<string, unknown>;
  toast.dismiss = mockToastDismiss;
  toast.custom = vi.fn();
  return { toast, default: { toast } };
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  mockShowUndoToast.mockReset();
  mockToastDismiss.mockReset();
  mockShowUndoToast.mockReturnValue('tid-mock');
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

describe('ConfirmButton — P1', () => {
  it('P1 render + click → onConfirm called once', () => {
    const onConfirm = vi.fn();
    render(
      <Wrapper>
        <ConfirmButton variant="P1" onConfirm={onConfirm} label="Apply" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('P1 disabled prop → click no-op', () => {
    const onConfirm = vi.fn();
    render(
      <Wrapper>
        <ConfirmButton variant="P1" onConfirm={onConfirm} label="Apply" disabled />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('ConfirmButton — P2', () => {
  it('P2 click → useDeferredAction.schedule + showUndoToast called', () => {
    const onConfirm = vi.fn();
    render(
      <Wrapper>
        <ConfirmButton
          variant="P2"
          onConfirm={onConfirm}
          label="Skip"
          successToastMessage="Skipped video.mkv"
        />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(mockShowUndoToast).toHaveBeenCalledTimes(1);
    const args = mockShowUndoToast.mock.calls[0][0];
    expect(args.message).toBe('Skipped video.mkv');
    expect(typeof args.onUndo).toBe('function');
  });

  it('P2 click + advance(10000) → onConfirm called', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(
      <Wrapper>
        <ConfirmButton variant="P2" onConfirm={onConfirm} label="Skip" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('P2 click + Undo → onConfirm NOT called, onUndo called', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    const onUndo = vi.fn();
    render(
      <Wrapper>
        <ConfirmButton variant="P2" onConfirm={onConfirm} onUndo={onUndo} label="Skip" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    const undoFn = mockShowUndoToast.mock.calls[0][0].onUndo as () => void;
    act(() => {
      undoFn();
    });
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  // 13-01b T4 / AC-11: per-instance undoDelayMs prop overrides the 10s default.
  it('P2 undoDelayMs=5000 → onConfirm fires at 5s (not 10s); showUndoToast.durationMs=5000', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(
      <Wrapper>
        <ConfirmButton variant="P2" onConfirm={onConfirm} label="Bench Cancel" undoDelayMs={5000} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: /bench cancel/i }));
    expect(mockShowUndoToast).toHaveBeenCalledTimes(1);
    const args = mockShowUndoToast.mock.calls[0][0];
    expect(args.durationMs).toBe(5000);
    // After 4999ms the deferred fn has NOT fired yet.
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(onConfirm).not.toHaveBeenCalled();
    // Crossing 5000ms triggers the fire.
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('ConfirmButton — P3', () => {
  it('P3 click (idle) → state=cooldown + aria-busy + cooldown-affordance visible', () => {
    vi.useFakeTimers();
    render(
      <Wrapper>
        <ConfirmButton variant="P3" onConfirm={vi.fn()} label="Disable+Delete" />
      </Wrapper>,
    );
    const primary = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(primary);
    });
    expect(primary).toHaveAttribute('aria-busy', 'true');
    expect(primary).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('confirm-button-cooldown-progress')).toBeInTheDocument();
  });

  it('P3 cooldown + 3s elapse → armed + aria-pressed=true', () => {
    vi.useFakeTimers();
    render(
      <Wrapper>
        <ConfirmButton variant="P3" onConfirm={vi.fn()} label="Disable+Delete" />
      </Wrapper>,
    );
    const primary = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(primary);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(primary).toHaveAttribute('aria-pressed', 'true');
  });

  it('P3 armed + 2nd click → onConfirm called + state=fired + reset after grace', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(
      <Wrapper>
        <ConfirmButton variant="P3" onConfirm={onConfirm} label="Disable+Delete" />
      </Wrapper>,
    );
    const primary = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(primary);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      fireEvent.click(primary);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // After reset grace → back to idle
    expect(primary).toHaveAttribute('aria-pressed', 'false');
  });

  it('P3 cooldown + Cancel-Button click → state=aborted + reset', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(
      <Wrapper>
        <ConfirmButton variant="P3" onConfirm={onConfirm} label="Disable+Delete" />
      </Wrapper>,
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
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId('confirm-button-cancel')).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('P3 armed + ESC keydown → state=aborted + onConfirm NOT called', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(
      <Wrapper>
        <ConfirmButton variant="P3" onConfirm={onConfirm} label="Disable+Delete" />
      </Wrapper>,
    );
    const primary = screen.getByTestId('confirm-button-primary') as HTMLButtonElement;
    act(() => {
      fireEvent.click(primary);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    primary.focus();
    expect(document.activeElement).toBe(primary);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(primary).toHaveAttribute('aria-pressed', 'false');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('P3 armed + 8s elapse no-click → autoDisarmed + onConfirm NOT called', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(
      <Wrapper>
        <ConfirmButton variant="P3" onConfirm={onConfirm} label="Disable+Delete" />
      </Wrapper>,
    );
    const primary = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(primary);
    });
    act(() => {
      vi.advanceTimersByTime(3000); // armed
    });
    act(() => {
      vi.advanceTimersByTime(8000); // auto-disarm
    });
    act(() => {
      vi.advanceTimersByTime(200); // grace
    });
    expect(primary).toHaveAttribute('aria-pressed', 'false');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('P3 reduced-motion → no progress-bar element, text-fallback present', () => {
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
    vi.useFakeTimers();
    render(
      <Wrapper>
        <ConfirmButton variant="P3" onConfirm={vi.fn()} label="Disable+Delete" />
      </Wrapper>,
    );
    const primary = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(primary);
    });
    expect(screen.queryByTestId('confirm-button-cooldown-progress')).not.toBeInTheDocument();
    expect(screen.getByTestId('confirm-button-cooldown-text')).toBeInTheDocument();
  });
});

describe('ConfirmButton — P3 audit regressions', () => {
  it('M3: two-instance ESC-isolation — ESC on A → A aborted, B remains armed', () => {
    vi.useFakeTimers();
    render(
      <Wrapper>
        <div>
          <div data-testid="wrap-a">
            <ConfirmButton variant="P3" onConfirm={vi.fn()} label="A" />
          </div>
          <div data-testid="wrap-b">
            <ConfirmButton variant="P3" onConfirm={vi.fn()} label="B" />
          </div>
        </div>
      </Wrapper>,
    );
    const wrapA = screen.getByTestId('wrap-a');
    const wrapB = screen.getByTestId('wrap-b');
    const primaryA = within(wrapA).getByTestId('confirm-button-primary') as HTMLButtonElement;
    const primaryB = within(wrapB).getByTestId('confirm-button-primary') as HTMLButtonElement;

    act(() => {
      fireEvent.click(primaryA);
      fireEvent.click(primaryB);
    });
    act(() => {
      vi.advanceTimersByTime(3000); // both armed
    });
    expect(primaryA).toHaveAttribute('aria-pressed', 'true');
    expect(primaryB).toHaveAttribute('aria-pressed', 'true');

    primaryA.focus();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(primaryA).toHaveAttribute('aria-pressed', 'false');
    expect(primaryB).toHaveAttribute('aria-pressed', 'true');
  });

  it('M5: re-render during cooldown → fn fires exactly ONCE', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    function Wrap({ extra }: { extra: number }) {
      return (
        <Wrapper>
          <ConfirmButton variant="P3" onConfirm={onConfirm} label={`btn-${extra}`} />
        </Wrapper>
      );
    }
    const { rerender } = render(<Wrap extra={1} />);
    const primary = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(primary); // → cooldown
    });
    // Force parent re-render mid-cooldown via unrelated prop
    rerender(<Wrap extra={2} />);
    rerender(<Wrap extra={3} />);
    act(() => {
      vi.advanceTimersByTime(3000); // armed
    });
    const primaryAfter = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(primaryAfter); // confirm
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('SR3: cooldown-state primary click suppressed (disabled HTML attr)', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(
      <Wrapper>
        <ConfirmButton variant="P3" onConfirm={onConfirm} label="Btn" />
      </Wrapper>,
    );
    const primary = screen.getByTestId('confirm-button-primary') as HTMLButtonElement;
    act(() => {
      fireEvent.click(primary); // → cooldown
    });
    expect(primary).toBeDisabled();
    // Attempt a click during cooldown — must NOT advance to armed/fired.
    act(() => {
      fireEvent.click(primary);
    });
    expect(primary).toHaveAttribute('aria-pressed', 'false');
    expect(primary).toHaveAttribute('aria-busy', 'true');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('SR4: touch-target — default size md applies h-11 / min-h-11 class (44px)', () => {
    render(
      <Wrapper>
        <ConfirmButton variant="P1" onConfirm={vi.fn()} label="Apply" />
      </Wrapper>,
    );
    const btn = screen.getByRole('button', { name: /apply/i });
    expect(btn.className).toMatch(/\bmin-h-11\b/);
  });
});
