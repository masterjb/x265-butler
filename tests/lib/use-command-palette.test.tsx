// 13-03 T1 tests — useCommandPalette hook (≥10 cases per plan + audit M3+M6+M7).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useCommandPalette } from '@/src/lib/ui/use-command-palette';

function dispatchKey(
  key: string,
  init: Partial<KeyboardEventInit> & { target?: EventTarget | null } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (init.target) {
    Object.defineProperty(event, 'target', { value: init.target, configurable: true });
  }
  window.dispatchEvent(event);
  return event;
}

describe('useCommandPalette', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('Cmd+K (metaKey) → open becomes true', () => {
    const { result } = renderHook(() => useCommandPalette());
    expect(result.current.open).toBe(false);
    act(() => {
      dispatchKey('k', { metaKey: true });
    });
    expect(result.current.open).toBe(true);
  });

  it('Ctrl+K (ctrlKey) → open becomes true', () => {
    const { result } = renderHook(() => useCommandPalette());
    act(() => {
      dispatchKey('k', { ctrlKey: true });
    });
    expect(result.current.open).toBe(true);
  });

  it('unrelated keys (Cmd+J, K alone, Ctrl+L) → open stays false', () => {
    const { result } = renderHook(() => useCommandPalette());
    act(() => {
      dispatchKey('j', { metaKey: true });
      dispatchKey('k');
      dispatchKey('l', { ctrlKey: true });
    });
    expect(result.current.open).toBe(false);
  });

  it('target is HTMLInputElement → open stays false', () => {
    const { result } = renderHook(() => useCommandPalette());
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      dispatchKey('k', { metaKey: true, target: input });
    });
    expect(result.current.open).toBe(false);
  });

  it('target is HTMLTextAreaElement → open stays false', () => {
    const { result } = renderHook(() => useCommandPalette());
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    act(() => {
      dispatchKey('k', { ctrlKey: true, target: textarea });
    });
    expect(result.current.open).toBe(false);
  });

  it('target inside [data-palette-ignore-shortcut] → open stays false', () => {
    const { result } = renderHook(() => useCommandPalette());
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-palette-ignore-shortcut', '');
    const inner = document.createElement('button');
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    act(() => {
      dispatchKey('k', { metaKey: true, target: inner });
    });
    expect(result.current.open).toBe(false);
  });

  it('preventDefault is called when shortcut matches (Browser-hijack guard)', () => {
    renderHook(() => useCommandPalette());
    let captured: KeyboardEvent | undefined;
    act(() => {
      captured = dispatchKey('k', { metaKey: true });
    });
    expect(captured?.defaultPrevented).toBe(true);
  });

  it('cleanup: after unmount keydown listener is detached', () => {
    const { result, unmount } = renderHook(() => useCommandPalette());
    unmount();
    act(() => {
      dispatchKey('k', { metaKey: true });
    });
    expect(result.current.open).toBe(false);
  });

  it('already-open modal in DOM → open stays false + preventDefault NOT called', () => {
    const { result } = renderHook(() => useCommandPalette());
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.appendChild(dialog);
    let captured: KeyboardEvent | undefined;
    act(() => {
      captured = dispatchKey('k', { metaKey: true });
    });
    expect(result.current.open).toBe(false);
    expect(captured?.defaultPrevented).toBe(false);
  });

  it('capture-phase attach: addEventListener invoked with { capture: true }', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    const { unmount } = renderHook(() => useCommandPalette());
    const keydownCalls = spy.mock.calls.filter((c) => c[0] === 'keydown');
    expect(keydownCalls.length).toBeGreaterThan(0);
    const opts = keydownCalls[0][2];
    expect(opts).toMatchObject({ capture: true });
    unmount();
    spy.mockRestore();
  });

  it('setOpen(false) returns palette to closed state', () => {
    const { result } = renderHook(() => useCommandPalette());
    act(() => {
      dispatchKey('k', { metaKey: true });
    });
    expect(result.current.open).toBe(true);
    act(() => {
      result.current.setOpen(false);
    });
    expect(result.current.open).toBe(false);
  });

  it('toggle() flips open state', () => {
    const { result } = renderHook(() => useCommandPalette());
    expect(result.current.open).toBe(false);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(true);
    act(() => {
      result.current.toggle();
    });
    expect(result.current.open).toBe(false);
  });
});
