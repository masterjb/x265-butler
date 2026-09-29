/*
 * Phase 23 Plan 23-06 — EncoderWarningsBadge tests (AC-4 / AC-7).
 *
 * The nvenc_no_runtime remediation must surface the corrected 3 NVENC
 * requirements from the single-source NVENC_REQUIREMENTS const, with per-field
 * copy buttons that write BARE values (never a joined KEY=value, AUDIT-M1) and
 * no "--gpus all" anywhere.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

import { EncoderWarningsBadge } from '@/components/settings/encoder-warnings-badge';

// Radix DropdownMenu pointer plumbing missing in jsdom.
beforeEach(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function mockNotifications() {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          notifications: [
            {
              id: 'n1',
              severity: 'warn',
              code: 'nvenc_no_runtime',
              title: 'notification.detection.nvenc_no_runtime.title',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
}

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

describe('EncoderWarningsBadge — nvenc_no_runtime remediation (23-06)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('test_encoder_warnings_badge_renders_corrected_per_field_copy_no_gpus_all', async () => {
    vi.stubGlobal('fetch', mockNotifications());
    // userEvent.setup() installs its OWN navigator.clipboard stub, so our spy
    // must be installed AFTER setup or the component would hit userEvent's stub
    // and our writeText spy would record zero calls.
    const user = userEvent.setup();
    const writeText = stubClipboard();
    render(wrap(<EncoderWarningsBadge />));

    const trigger = await screen.findByRole('button', { name: /driver warnings/i });
    await user.click(trigger);

    // 3 corrected per-field copy affordances present.
    const extraBtn = await screen.findByLabelText('Copy extra parameter --runtime=nvidia');
    const nameBtn = screen.getByLabelText('Copy variable name NVIDIA_VISIBLE_DEVICES');
    const valBtn = screen.getByLabelText('Copy variable value all');
    expect(
      screen.getByLabelText('Copy variable name NVIDIA_DRIVER_CAPABILITIES'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Copy variable value compute,video,utility')).toBeInTheDocument();

    fireEvent.click(extraBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('--runtime=nvidia'));
    fireEvent.click(nameBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('NVIDIA_VISIBLE_DEVICES'));
    fireEvent.click(valBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('all'));

    // AUDIT-M1: never a joined KEY=value paste value.
    const joined = writeText.mock.calls.some((c) => /^NVIDIA_[A-Z_]+=/.test(String(c[0])));
    expect(joined).toBe(false);
    // No --gpus all anywhere in the rendered remediation.
    expect(screen.queryByText(/--gpus all/)).toBeNull();
  });
});
