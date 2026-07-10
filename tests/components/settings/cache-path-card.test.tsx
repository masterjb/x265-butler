// 24-03 (F2) AC-5 / AC-6 (UI half) / AC-7: CachePathCard.
//   AC-5  effective path + resolution badge + editable override; Save → PUT.
//   AC-6  amber space-advisory iff resolution === 'config-fallback'.
//   AC-7  clearing the override field → PUT cache_pool_path:'' (clear-to-unset).
// a11y: resolution badge is text (not colour-only); override input is labelled.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { ReactNode } from 'react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CachePathCard, type CachePathCardProps } from '@/components/settings/cache-path-card';
import { toast } from 'sonner';

const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

function wrap(children: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );
}

const MNT_CACHE: CachePathCardProps = {
  effectivePath: '/mnt/cache/x265-butler',
  resolution: 'mnt-cache',
  settingValue: null,
  advisory: null,
};
const CONFIG_FALLBACK: CachePathCardProps = {
  effectivePath: '/config/cache',
  resolution: 'config-fallback',
  settingValue: null,
  advisory: 'config-fallback-space',
};
const USER_OVERRIDE: CachePathCardProps = {
  effectivePath: '/mnt/disks/nvme/cache',
  resolution: 'user-override',
  settingValue: '/mnt/disks/nvme/cache',
  advisory: null,
};

beforeEach(() => {
  toastSuccess.mockReset();
  toastError.mockReset();
  global.fetch = vi.fn();
});

describe('CachePathCard (24-03)', () => {
  it('AC-5: renders effective path + resolution badge', () => {
    render(wrap(<CachePathCard {...MNT_CACHE} />));
    expect(screen.getByTestId('cache-effective-path')).toHaveTextContent('/mnt/cache/x265-butler');
    expect(screen.getByTestId('cache-resolution-badge')).toHaveTextContent(/mnt\/cache/i);
  });

  it('AC-6: config-fallback shows the amber advisory', () => {
    render(wrap(<CachePathCard {...CONFIG_FALLBACK} />));
    expect(screen.getByTestId('cache-config-fallback-advisory')).toBeInTheDocument();
  });

  it('AC-6: mnt-cache shows NO advisory', () => {
    render(wrap(<CachePathCard {...MNT_CACHE} />));
    expect(screen.queryByTestId('cache-config-fallback-advisory')).not.toBeInTheDocument();
  });

  it('Save button is disabled until the override changes', () => {
    render(wrap(<CachePathCard {...MNT_CACHE} />));
    expect(screen.getByTestId('cache-path-save')).toBeDisabled();
  });

  it('AC-5: saving an override PUTs cache_pool_path and toasts success', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    render(wrap(<CachePathCard {...MNT_CACHE} />));
    const input = screen.getByLabelText(en.settings.cachePath.overrideLabel);
    await userEvent.type(input, '/mnt/disks/nvme/cache');
    fireEvent.click(screen.getByTestId('cache-path-save'));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('/api/settings');
    expect(JSON.parse(call[1].body)).toEqual({
      settings: { cache_pool_path: '/mnt/disks/nvme/cache' },
    });
  });

  it('AC-7: clearing the override field PUTs an empty string (clear-to-unset)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    render(wrap(<CachePathCard {...USER_OVERRIDE} />));
    const input = screen.getByLabelText(en.settings.cachePath.overrideLabel);
    await userEvent.clear(input);
    fireEvent.click(screen.getByTestId('cache-path-save'));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(call[1].body)).toEqual({ settings: { cache_pool_path: '' } });
  });

  it('maps a not-writable fieldError to the specific toast', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ fieldErrors: { cache_pool_path: 'cache_pool_path_not_writable' } }),
    });
    render(wrap(<CachePathCard {...MNT_CACHE} />));
    const input = screen.getByLabelText(en.settings.cachePath.overrideLabel);
    await userEvent.type(input, '/mnt/nope');
    fireEvent.click(screen.getByTestId('cache-path-save'));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        en.settings.cachePath.errorToast.cache_pool_path_not_writable,
      ),
    );
  });
});
