// Copy text to the clipboard from a click handler. Resolves true only when the
// copy really happened; never throws.
//
// unRAID installs are reached over plain http://<LAN-IP>, which is not a secure
// context: navigator.clipboard is undefined there. The execCommand path is the
// only way to copy without one.
//
// Constraints the fallback has to respect:
// - Browsers allow execCommand('copy') only within a short user activation, so
//   when the Clipboard API is missing the fallback runs synchronously, before
//   any await.
// - Inside a modal (Radix Dialog/Sheet/Drawer), FocusScope pulls focus back as
//   soon as an element outside its container gains it, which drops the
//   selection. The textarea is therefore mounted inside the active dialog.
// - Radix refocuses its container when a node is removed while body has focus,
//   so focus is restored before the textarea is removed.
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or document not focused: try the legacy path.
    }
  }
  return copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const container =
    previousFocus?.closest<HTMLElement>('[role="dialog"],[role="alertdialog"]') ?? document.body;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.tabIndex = -1;
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  // Below 16px, iOS Safari zooms the page when the field takes focus.
  textarea.style.fontSize = '12pt';
  container.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    // iOS Safari ignores select() on readonly fields.
    textarea.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    previousFocus?.focus();
    if (selection && previousRange) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    textarea.remove();
  }
}
