import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { ReactNode } from 'react';

vi.mock('swr', () => {
  const useSwr = vi.fn();
  const mutate = vi.fn();
  return { __esModule: true, default: useSwr, mutate };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { AutoScanToggle } from '@/components/settings/auto-scan-toggle';
import useSWR from 'swr';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const useSwrMock = useSWR as unknown as ReturnType<typeof vi.fn<any>>;
const toastErrorMock = vi.mocked(toast.error);
const mutateMock = vi.mocked((await import('swr')).mutate);

function wrap(children: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  useSwrMock.mockReset();
  mutateMock.mockReset();
  toastErrorMock.mockReset();
  global.fetch = vi.fn();
});

function setSettings(settings: Record<string, string> = {}): void {
  useSwrMock.mockReturnValue({
    data: { settings },
    error: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof useSwrMock>);
}

describe('AutoScanToggle', () => {
  it('default ON when autoScan.enabled key absent (AC-9)', () => {
    setSettings({});
    render(wrap(<AutoScanToggle />));
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('reflects persisted autoScan.enabled=false', () => {
    setSettings({ 'autoScan.enabled': 'false' });
    render(wrap(<AutoScanToggle />));
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('flip ON→OFF → PUT /api/settings with autoScan.enabled=false', async () => {
    setSettings({ 'autoScan.enabled': 'true' });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    render(wrap(<AutoScanToggle />));
    await userEvent.click(screen.getByRole('switch'));
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const putCall = calls.find((c) => c[1]?.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = JSON.parse(putCall![1].body as string);
    expect(body).toEqual({ settings: { 'autoScan.enabled': 'false' } });
  });

  it('failed PUT → reverts optimistic state + toast error', async () => {
    setSettings({ 'autoScan.enabled': 'true' });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 500 });
    render(wrap(<AutoScanToggle />));
    await userEvent.click(screen.getByRole('switch'));
    expect(toastErrorMock).toHaveBeenCalled();
  });

  it('keyboard a11y: switch is reachable via Tab + togglable via Space', async () => {
    setSettings({ 'autoScan.enabled': 'true' });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    render(wrap(<AutoScanToggle />));
    const sw = screen.getByRole('switch');
    sw.focus();
    expect(document.activeElement).toBe(sw);
    await userEvent.keyboard(' ');
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.find((c) => c[1]?.method === 'PUT')).toBeDefined();
  });
});
