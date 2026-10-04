// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '@/src/lib/ui/copy-text';

// jsdom ships neither navigator.clipboard nor document.execCommand, which is
// exactly the http://<LAN-IP> situation for navigator.clipboard. Each test sets
// what it needs and afterEach removes it again.
function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

function setExecCommand(impl: (cmd: string) => boolean) {
  const spy = vi.fn(impl);
  (document as { execCommand?: unknown }).execCommand = spy;
  return spy;
}

let button: HTMLButtonElement;

beforeEach(() => {
  button = document.createElement('button');
  button.textContent = 'copy';
  document.body.appendChild(button);
  button.focus();
});

afterEach(() => {
  delete (navigator as { clipboard?: unknown }).clipboard;
  delete (document as { execCommand?: unknown }).execCommand;
  document.body.innerHTML = '';
});

describe('copyText', () => {
  it('test_copyText_when_clipboard_api_resolves_then_uses_it_and_skips_execCommand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const exec = setExecCommand(() => true);

    await expect(copyText('abc')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('abc');
    expect(exec).not.toHaveBeenCalled();
  });

  it('test_copyText_when_clipboard_api_missing_then_execCommand_copies_textarea_value', async () => {
    let valueDuringCopy: string | undefined;
    const exec = setExecCommand(() => {
      valueDuringCopy = document.querySelector('textarea')?.value;
      return true;
    });

    await expect(copyText('abc')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(valueDuringCopy).toBe('abc');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('test_copyText_when_clipboard_api_rejects_then_falls_back_to_execCommand', async () => {
    setClipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')));
    const exec = setExecCommand(() => true);

    await expect(copyText('abc')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('test_copyText_when_execCommand_missing_then_resolves_false', async () => {
    await expect(copyText('abc')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('test_copyText_when_execCommand_returns_false_then_resolves_false_and_cleans_up', async () => {
    setExecCommand(() => false);
    await expect(copyText('abc')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('test_copyText_when_execCommand_throws_then_resolves_false_and_cleans_up', async () => {
    setExecCommand(() => {
      throw new Error('SecurityError');
    });
    await expect(copyText('abc')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('test_copyText_when_clipboard_api_missing_then_execCommand_runs_synchronously', () => {
    const exec = setExecCommand(() => true);
    void copyText('abc');
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('test_copyText_when_inside_focus_trapped_dialog_then_textarea_keeps_focus_and_selection', async () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inner = document.createElement('button');
    dialog.appendChild(inner);
    document.body.appendChild(dialog);
    inner.focus();

    // Mirrors Radix FocusScope: focus landing outside the container is pulled back.
    const trap = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (target && !dialog.contains(target)) inner.focus();
    };
    document.addEventListener('focusin', trap);

    let observed: {
      activeIsTextarea: boolean;
      insideDialog: boolean;
      start: number | null;
      end: number | null;
    } | null = null;
    setExecCommand(() => {
      const textarea = document.querySelector('textarea');
      observed = {
        activeIsTextarea: document.activeElement === textarea,
        insideDialog: textarea ? dialog.contains(textarea) : false,
        start: textarea?.selectionStart ?? null,
        end: textarea?.selectionEnd ?? null,
      };
      return true;
    });

    try {
      await expect(copyText('abc')).resolves.toBe(true);
    } finally {
      document.removeEventListener('focusin', trap);
    }

    expect(observed).toEqual({ activeIsTextarea: true, insideDialog: true, start: 0, end: 3 });
    expect(document.activeElement).toBe(inner);
    expect(document.querySelector('textarea')).toBeNull();
  });
});
