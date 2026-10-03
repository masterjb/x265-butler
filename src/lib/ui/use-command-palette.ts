'use client';

import { useCallback, useEffect, useState } from 'react';

type UseCommandPaletteReturn = {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
};

const OPEN_MODAL_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]';

function isShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key === 'k';
}

function targetIsTextInput(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (
    target instanceof HTMLElement &&
    typeof target.closest === 'function' &&
    target.closest('[data-palette-ignore-shortcut]') !== null
  ) {
    return true;
  }
  return false;
}

function hasOpenModal(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector(OPEN_MODAL_SELECTOR) !== null;
}

export function useCommandPalette(): UseCommandPaletteReturn {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: KeyboardEvent) => {
      if (!isShortcut(event)) return;
      if (targetIsTextInput(event.target)) return;
      if (hasOpenModal()) return;
      event.preventDefault();
      setOpen(true);
    };
    try {
      window.addEventListener('keydown', handler, { capture: true });
    } catch (err) {
      console.warn('[command-palette] keydown listener attach failed', err);
      return;
    }
    return () => {
      window.removeEventListener('keydown', handler, { capture: true });
    };
  }, []);

  return { open, setOpen, toggle };
}
