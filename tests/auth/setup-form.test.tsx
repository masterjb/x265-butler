// 05-02 T2: SetupForm tests.
// Phase 5 Plan 05-02 — AC-6 + audit S4 (validatePasswordComplexity reuse).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { SetupForm } from '@/components/settings/setup-form';

const mocks = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refreshMock, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: mocks.toastErrorMock,
    success: mocks.toastSuccessMock,
  }),
}));

function wrap(ui: React.ReactElement): React.ReactElement {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe('SetupForm — AC-6', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
    mocks.refreshMock.mockReset();
    mocks.toastErrorMock.mockReset();
    mocks.toastSuccessMock.mockReset();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders 3 fields (username + password + confirm) with correct autocomplete', () => {
    render(wrap(<SetupForm />));
    expect(screen.getByLabelText(en.settings.setup.field.username.label)).toHaveAttribute(
      'autocomplete',
      'username',
    );
    expect(screen.getByLabelText(en.settings.setup.field.password.label)).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
    expect(screen.getByLabelText(en.settings.setup.field.confirmPassword.label)).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });

  it('rejects username < 3 chars locally (no fetch)', async () => {
    render(wrap(<SetupForm />));
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.username.label), {
      target: { value: 'ab' },
    });
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.password.label), {
      target: { value: 'complex-pass-12c!' },
    });
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.confirmPassword.label), {
      target: { value: 'complex-pass-12c!' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.settings.setup.action.submit }));
    await waitFor(() => {
      expect(screen.getByText(en.settings.setup.error.usernameTooShort)).toBeTruthy();
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects username with invalid chars locally', async () => {
    render(wrap(<SetupForm />));
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.username.label), {
      target: { value: 'admin@host' },
    });
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.password.label), {
      target: { value: 'complex-pass-12c!' },
    });
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.confirmPassword.label), {
      target: { value: 'complex-pass-12c!' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.settings.setup.action.submit }));
    await waitFor(() => {
      expect(screen.getByText(en.settings.setup.error.usernameInvalid)).toBeTruthy();
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects weak password via validatePasswordComplexity (audit S4 reuse)', async () => {
    render(wrap(<SetupForm />));
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.username.label), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.password.label), {
      target: { value: '111111111111' },
    });
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.confirmPassword.label), {
      target: { value: '111111111111' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.settings.setup.action.submit }));
    await waitFor(() => {
      expect(screen.getByText(en.settings.setup.error.passwordTooWeak)).toBeTruthy();
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('confirm-mismatch error fires only after blur on confirm field', async () => {
    render(wrap(<SetupForm />));
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.password.label), {
      target: { value: 'aaaaaa12345!' },
    });
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.confirmPassword.label), {
      target: { value: 'different-12!' },
    });
    // No error YET (no blur)
    expect(screen.queryByText(en.settings.setup.error.passwordsDontMatch)).toBeNull();
    fireEvent.blur(screen.getByLabelText(en.settings.setup.field.confirmPassword.label));
    await waitFor(() => {
      expect(screen.getByText(en.settings.setup.error.passwordsDontMatch)).toBeTruthy();
    });
  });

  it('happy path → toast success + router.refresh on 201', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ userId: 1, username: 'admin' }), { status: 201 }),
    );
    render(wrap(<SetupForm />));
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.username.label), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.password.label), {
      target: { value: 'aaaaaa12345!' },
    });
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.confirmPassword.label), {
      target: { value: 'aaaaaa12345!' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.settings.setup.action.submit }));
    await waitFor(() => {
      expect(mocks.toastSuccessMock).toHaveBeenCalledWith(en.settings.setup.success);
    });
    expect(mocks.refreshMock).toHaveBeenCalled();
  });

  it('409 setup_already_completed → toast success + refresh (race tolerance)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error_code: 'setup_already_completed' }), { status: 409 }),
    );
    render(wrap(<SetupForm />));
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.username.label), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.password.label), {
      target: { value: 'aaaaaa12345!' },
    });
    fireEvent.change(screen.getByLabelText(en.settings.setup.field.confirmPassword.label), {
      target: { value: 'aaaaaa12345!' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.settings.setup.action.submit }));
    await waitFor(() => {
      expect(mocks.refreshMock).toHaveBeenCalled();
    });
  });
});
