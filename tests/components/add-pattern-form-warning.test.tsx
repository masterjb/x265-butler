/*
 * 22-03 T2 — AddPatternForm amber extensionWarning surface (AC-4).
 *
 * Drives the three branches:
 *   1. POST 200 + body.extensionWarning present → warning rendered, onAdded NOT fired.
 *   2. dismiss button click → warning unmounts, onAdded fires.
 *   3. POST 200 + body.extensionWarning ABSENT → onAdded fires immediately, no warning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { AddPatternForm } from '@/components/blocklist/add-pattern-form';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function makeFetchResponder(body: unknown, ok = true) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: ok ? 200 : 400,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AddPatternForm extensionWarning surface (22-03 AC-4)', () => {
  it('test_AC4_when_response_carries_extensionWarning_then_amber_warning_renders_AND_onAdded_NOT_called', async () => {
    const onAdded = vi.fn();
    const onCancel = vi.fn();
    const fetchSpy = makeFetchResponder({
      id: 42,
      pathPattern: '*.srt',
      extensionWarning: { resolvedExt: 'srt', scanExtensions: ['mkv', 'mp4'] },
    });
    vi.stubGlobal('fetch', fetchSpy);

    const user = userEvent.setup();
    render(wrap(<AddPatternForm onAdded={onAdded} onCancel={onCancel} />));

    await user.type(screen.getByLabelText(/Path pattern/i), '*.srt');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    // Wait for warning to render.
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeTruthy();
    });
    // Title interpolates {ext}.
    expect(screen.getByText(/no scanned share covers \.srt files/i)).toBeTruthy();
    // Body interpolates {exts} + {ext}.
    expect(screen.getByText(/Current scan-extensions: mkv, mp4/i)).toBeTruthy();
    expect(screen.getByText(/Add \.srt to a share's extensions/i)).toBeTruthy();
    // Dismiss button visible.
    expect(screen.getByRole('button', { name: /Got it/i })).toBeTruthy();
    // onAdded must NOT have fired yet — dismiss is the only path.
    expect(onAdded).not.toHaveBeenCalled();
  });

  it('test_AC4_dismiss_click_clears_warning_AND_fires_onAdded', async () => {
    const onAdded = vi.fn();
    const onCancel = vi.fn();
    const fetchSpy = makeFetchResponder({
      id: 42,
      pathPattern: '*.srt',
      extensionWarning: { resolvedExt: 'srt', scanExtensions: ['mkv', 'mp4'] },
    });
    vi.stubGlobal('fetch', fetchSpy);

    const user = userEvent.setup();
    render(wrap(<AddPatternForm onAdded={onAdded} onCancel={onCancel} />));

    await user.type(screen.getByLabelText(/Path pattern/i), '*.srt');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => screen.getByRole('button', { name: /Got it/i }));
    await user.click(screen.getByRole('button', { name: /Got it/i }));

    expect(onAdded).toHaveBeenCalledTimes(1);
    // Warning unmounted.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('test_AC4_when_response_has_no_extensionWarning_then_onAdded_fires_immediately', async () => {
    const onAdded = vi.fn();
    const onCancel = vi.fn();
    const fetchSpy = makeFetchResponder({
      id: 42,
      pathPattern: '*.mkv',
      // no extensionWarning field
    });
    vi.stubGlobal('fetch', fetchSpy);

    const user = userEvent.setup();
    render(wrap(<AddPatternForm onAdded={onAdded} onCancel={onCancel} />));

    await user.type(screen.getByLabelText(/Path pattern/i), '*.mkv');
    await user.click(screen.getByRole('button', { name: /^Add$/i }));

    await waitFor(() => {
      expect(onAdded).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
