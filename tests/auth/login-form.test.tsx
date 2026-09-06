// 05-02 T1: Login form tests.
// Phase 5 Plan 05-02 — AC-2 + AC-3 + AC-4.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { LoginForm } from '@/app/[locale]/login/login-form';

const mocks = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  toastDefaultMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mocks.replaceMock,
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(mocks.toastDefaultMock, {
    error: mocks.toastErrorMock,
    success: mocks.toastSuccessMock,
  }),
}));

const { replaceMock, toastErrorMock, toastSuccessMock, toastDefaultMock } = mocks;

function wrap(ui: React.ReactElement): React.ReactElement {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe('LoginForm — AC-2/AC-3/AC-4', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
    replaceMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    toastDefaultMock.mockReset();
    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost/login', pathname: '/login', search: '' },
      writable: true,
    });
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renders username + password fields with autocomplete', () => {
    render(wrap(<LoginForm next="/library" expired={false} />));
    expect(screen.getByLabelText(en.login.field.username.label)).toHaveAttribute(
      'autocomplete',
      'username',
    );
    expect(screen.getByLabelText(en.login.field.password.label)).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
  });

  it('shows password show/hide toggle with aria-label switching', () => {
    render(wrap(<LoginForm next="/library" expired={false} />));
    const toggle = screen.getByLabelText(en.login.field.password.show);
    fireEvent.click(toggle);
    expect(screen.getByLabelText(en.login.field.password.hide)).toBeTruthy();
  });

  it('happy path → router.replace(next) on 200', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ username: 'admin' }), { status: 200 }),
    );
    render(wrap(<LoginForm next="/en/library" expired={false} />));
    fireEvent.change(screen.getByLabelText(en.login.field.username.label), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText(en.login.field.password.label), {
      target: { value: 'p@ssw0rd-12c' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.login.action.submit }));
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/en/library');
    });
  });

  it('401 → destructive toast + reset password only', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error_code: 'invalid_credentials' }), { status: 401 }),
    );
    render(wrap(<LoginForm next="/library" expired={false} />));
    fireEvent.change(screen.getByLabelText(en.login.field.username.label), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText(en.login.field.password.label), {
      target: { value: 'wrong-pass-12' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.login.action.submit }));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(en.login.error.invalidCredentials);
    });
    expect((screen.getByLabelText(en.login.field.username.label) as HTMLInputElement).value).toBe(
      'admin',
    );
    expect((screen.getByLabelText(en.login.field.password.label) as HTMLInputElement).value).toBe(
      '',
    );
  });

  it('429 → countdown disables submit + Retry-After respected', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error_code: 'rate_limit_exceeded' }), {
        status: 429,
        headers: { 'Retry-After': '45' },
      }),
    );
    render(wrap(<LoginForm next="/library" expired={false} />));
    fireEvent.change(screen.getByLabelText(en.login.field.username.label), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText(en.login.field.password.label), {
      target: { value: 'wrong-12c' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.login.action.submit }));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    // Submit button now disabled
    await waitFor(() => {
      const submitBtn = screen.getByRole('button', { name: /try again in/i });
      expect((submitBtn as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('network error → destructive toast', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('network'));
    render(wrap(<LoginForm next="/library" expired={false} />));
    fireEvent.change(screen.getByLabelText(en.login.field.username.label), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText(en.login.field.password.label), {
      target: { value: 'p@ss-12c' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.login.action.submit }));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(en.login.error.networkError);
    });
  });

  it('?expired=1 fires toast on mount and calls router.replace to clean URL', async () => {
    Object.defineProperty(window, 'location', {
      value: { href: 'http://localhost/login?expired=1', pathname: '/login', search: '?expired=1' },
      writable: true,
    });
    render(wrap(<LoginForm next="/library" expired={true} />));
    await waitFor(() => {
      expect(toastDefaultMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalled();
    });
  });

  it('submitLockRef rejects rapid double-clicks (only ONE fetch fires)', async () => {
    let resolved = false;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve(new Response(JSON.stringify({}), { status: 200 }));
          }, 200);
        }),
    );
    render(wrap(<LoginForm next="/library" expired={false} />));
    fireEvent.change(screen.getByLabelText(en.login.field.username.label), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText(en.login.field.password.label), {
      target: { value: 'p@ss-12c' },
    });
    const btn = screen.getByRole('button', { name: en.login.action.submit });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => {
      expect(resolved).toBe(true);
    });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
