// Queue page toolbar: shows the active processing order, saves a new one
// through the settings API, shows how many jobs are sorted by hand and clears
// that manual order. Failures roll the selection back and show a toast.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';
import { QueueOrderBar } from '@/components/queue/queue-order-bar';

const { mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock('sonner', () => {
  const toast = (() => undefined) as unknown as Record<string, unknown>;
  toast.success = mockToastSuccess;
  toast.error = mockToastError;
  return { toast, default: { toast } };
});

let fetchMock: ReturnType<typeof vi.fn>;

function renderBar(
  props: Partial<React.ComponentProps<typeof QueueOrderBar>> = {},
  messages: typeof en = en,
  locale = 'en',
) {
  const onChanged = vi.fn();
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <QueueOrderBar order="oldest" pinnedCount={0} onChanged={onChanged} {...props} />
    </NextIntlClientProvider>,
  );
  return { onChanged };
}

beforeEach(() => {
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  // Select pointer plumbing missing in jsdom.
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe('QueueOrderBar', () => {
  it('shows the active order under a visible label', () => {
    renderBar({ order: 'largest' });
    const trigger = screen.getByLabelText(en.queue.order.label);
    expect(trigger).toHaveTextContent(en.queue.order.options.largest);
  });

  it('offers the four orders', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByLabelText(en.queue.order.label));
    for (const label of Object.values(en.queue.order.options)) {
      expect(await screen.findByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('saves a new order through the settings API and reloads', async () => {
    const user = userEvent.setup();
    const { onChanged } = renderBar();
    await user.click(screen.getByLabelText(en.queue.order.label));
    await user.click(await screen.findByRole('option', { name: en.queue.order.options.smallest }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ settings: { queue_order: 'smallest' } });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockToastSuccess).toHaveBeenCalledWith(en.queue.order.toast.saved);
  });

  it('rolls the selection back and shows a toast when saving fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const user = userEvent.setup();
    const { onChanged } = renderBar({ order: 'oldest' });
    await user.click(screen.getByLabelText(en.queue.order.label));
    await user.click(await screen.findByRole('option', { name: en.queue.order.options.newest }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(en.queue.order.toast.saveError),
    );
    expect(screen.getByLabelText(en.queue.order.label)).toHaveTextContent(
      en.queue.order.options.oldest,
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('hides the hint and the clear button when nothing is pinned', () => {
    renderBar({ pinnedCount: 0 });
    expect(screen.queryByRole('button', { name: en.queue.order.clear })).toBeNull();
    expect(screen.queryByText(/sorted by hand/)).toBeNull();
  });

  it('shows the pinned count and clears the manual order', async () => {
    const user = userEvent.setup();
    const { onChanged } = renderBar({ pinnedCount: 3 });
    expect(screen.getByText('3 jobs sorted by hand, they go first')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: en.queue.order.clear }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/queue/reorder');
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockToastSuccess).toHaveBeenCalledWith(en.queue.order.toast.cleared);
  });

  it('shows a toast and keeps the list when clearing fails', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const user = userEvent.setup();
    const { onChanged } = renderBar({ pinnedCount: 1 });
    expect(screen.getByText('1 job sorted by hand, it goes first')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: en.queue.order.clear }));
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(en.queue.order.toast.clearError),
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('meets the 44 px touch target on the select and the button', () => {
    renderBar({ pinnedCount: 2 });
    expect(screen.getByLabelText(en.queue.order.label).className).toMatch(/\bh-11\b/);
    expect(screen.getByRole('button', { name: en.queue.order.clear }).className).toMatch(
      /\bh-11\b/,
    );
  });

  it('renders in German', () => {
    renderBar({ order: 'largest', pinnedCount: 2 }, de as unknown as typeof en, 'de');
    expect(screen.getByLabelText('Reihenfolge')).toHaveTextContent('Größte Datei zuerst');
    expect(screen.getByText('2 Jobs von Hand sortiert, sie kommen zuerst')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Handsortierung aufheben' })).toBeInTheDocument();
  });

  it('uses no dashes in its texts', () => {
    for (const messages of [en, de]) {
      const text = JSON.stringify(messages.queue.order);
      expect(text).not.toMatch(/[—]| – /);
    }
  });
});
