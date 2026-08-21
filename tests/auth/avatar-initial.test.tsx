// 05-02 T1: Avatar circle a11y tests.
// Phase 5 Plan 05-02 — audit M7 (non-button) + AC-9 (Unicode-safe initial).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { AvatarInitial } from '@/components/auth/avatar-initial';

function wrap(ui: React.ReactElement): React.ReactElement {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe('AvatarInitial — audit M7 (non-button) + Unicode safety', () => {
  it('renders with role="img" and aria-label including username', () => {
    render(wrap(<AvatarInitial username="admin" />));
    const img = screen.getByRole('img', { name: /admin/i });
    expect(img).toBeTruthy();
  });

  it('does NOT render a button (audit M7 — buttons that do nothing fail a11y)', () => {
    render(wrap(<AvatarInitial username="admin" />));
    const buttons = screen.queryAllByRole('button');
    expect(buttons).toHaveLength(0);
  });

  it('uppercases ASCII first character', () => {
    render(wrap(<AvatarInitial username="admin" />));
    const initial = screen.getByText('A', { exact: true });
    expect(initial).toBeTruthy();
  });

  it('handles non-ASCII Unicode safely (Über → Ü)', () => {
    render(wrap(<AvatarInitial username="Über" />));
    const initial = screen.getByText('Ü', { exact: true });
    expect(initial).toBeTruthy();
  });

  it('renders ? fallback when username is null', () => {
    render(wrap(<AvatarInitial username={null} />));
    const initial = screen.getByText('?', { exact: true });
    expect(initial).toBeTruthy();
  });

  it('keyboard-reachable via tabIndex=0 on the role=img wrapper', () => {
    render(wrap(<AvatarInitial username="admin" />));
    const img = screen.getByRole('img', { name: /admin/i });
    expect(img.getAttribute('tabindex')).toBe('0');
  });

  it('44x44 tap target via size-11 wrapper class', () => {
    render(wrap(<AvatarInitial username="admin" />));
    const img = screen.getByRole('img', { name: /admin/i });
    expect(img.className).toMatch(/size-11/);
  });
});
