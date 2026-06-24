// 05-02 T2: AuthTab visibility-state machine tests.
// Phase 5 Plan 05-02 — AC-5 (5 states A/B/C/D/E).

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { AuthTab, type AuthSettings } from '@/components/settings/auth-tab';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

const settings: AuthSettings = {
  auth_enabled: 'false',
  session_ttl_seconds: '604800',
  auth_trust_proxy_xff: 'false',
  bcrypt_cost: '12',
};

function wrap(ui: React.ReactElement): React.ReactElement {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe('AuthTab — visibility states A/B/C/D/E (audit AC-5)', () => {
  it('state A: toggle only (no setup, no advanced, no danger)', () => {
    render(wrap(<AuthTab state="A" initialSettings={settings} userExists={false} />));
    expect(screen.getByLabelText(en.settings.auth.toggle.label)).toBeTruthy();
    expect(screen.queryByText(en.settings.setup.heading)).toBeNull();
    expect(screen.queryByText(en.settings.advanced.heading)).toBeNull();
    expect(screen.queryByText(en.settings.danger.disableAndDelete.label)).toBeNull();
  });

  it('state B: toggle + advanced + danger (auth disabled but user exists)', () => {
    render(wrap(<AuthTab state="B" initialSettings={settings} userExists={true} />));
    expect(screen.getByLabelText(en.settings.auth.toggle.label)).toBeTruthy();
    expect(screen.queryByText(en.settings.setup.heading)).toBeNull();
    expect(screen.getByText(en.settings.advanced.heading)).toBeTruthy();
    expect(screen.getByText(en.settings.danger.disableAndDelete.label)).toBeTruthy();
  });

  it('state C: toggle + setup + advanced (no danger — userCount=0)', () => {
    const enabledSettings = { ...settings, auth_enabled: 'true' as const };
    render(wrap(<AuthTab state="C" initialSettings={enabledSettings} userExists={false} />));
    expect(screen.getByLabelText(en.settings.auth.toggle.label)).toBeTruthy();
    expect(screen.getByText(en.settings.setup.heading)).toBeTruthy();
    expect(screen.getByText(en.settings.advanced.heading)).toBeTruthy();
    expect(screen.queryByText(en.settings.danger.disableAndDelete.label)).toBeNull();
  });

  it('state D: toggle + advanced + danger (no setup — already done)', () => {
    const enabledSettings = { ...settings, auth_enabled: 'true' as const };
    render(wrap(<AuthTab state="D" initialSettings={enabledSettings} userExists={true} />));
    expect(screen.queryByText(en.settings.setup.heading)).toBeNull();
    expect(screen.getByText(en.settings.advanced.heading)).toBeTruthy();
    expect(screen.getByText(en.settings.danger.disableAndDelete.label)).toBeTruthy();
  });

  it('state E (race): identical to D — userCount > 0 wins (defense)', () => {
    const enabledSettings = { ...settings, auth_enabled: 'true' as const };
    render(wrap(<AuthTab state="E" initialSettings={enabledSettings} userExists={true} />));
    expect(screen.queryByText(en.settings.setup.heading)).toBeNull();
    expect(screen.getByText(en.settings.advanced.heading)).toBeTruthy();
    expect(screen.getByText(en.settings.danger.disableAndDelete.label)).toBeTruthy();
  });

  it('toggle dialog text matches accurate phrasing (audit M5 — NOT "sessions revoked")', () => {
    // Verify the i18n source text — the dialog shows on disable-when-userExists,
    // tested separately. Here just assert the source string content.
    expect(en.settings.auth.toggle.disableConfirm.body).toContain('without authentication');
    expect(en.settings.auth.toggle.disableConfirm.body).not.toMatch(/sessions.*revoked/i);
  });
});
