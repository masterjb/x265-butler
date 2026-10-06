import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ThemeProvider } from '@/components/app-shell/theme-provider';
import en from '@/messages/en.json';
import type { TrashEntryRow } from '@/src/lib/db/schema';

const mockFetch = vi.fn();
(globalThis as { fetch?: unknown }).fetch = mockFetch;

import TrashPage from '@/app/[locale]/trash/page';

function wrapIntl(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        {ui}
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}

async function renderPage() {
  const ui = await TrashPage({ searchParams: Promise.resolve({}) });
  return render(wrapIntl(ui));
}

const NOW = Math.floor(Date.now() / 1000);

const sampleRow: TrashEntryRow = {
  id: 1,
  file_id: 1,
  original_path: '/media/show/episode.mkv',
  trash_path: '/cache/x265-butler/trash/1-2026/episode.mkv',
  size_bytes: 1_500_000_000,
  trashed_at: NOW - 86_400,
  expires_at: NOW + 30 * 86_400,
  restored_at: null,
};

function mockListAndSummary(
  rows: TrashEntryRow[],
  total: number,
  summary: { bytesReclaimed: number; count: number },
) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/trash/summary')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(summary) });
    }
    if (url.includes('/api/trash')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows, total }) });
    }
    return Promise.resolve({ ok: false });
  });
}

describe('TrashPage (Server + Client integration)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('test_TrashPage_when_rendered_then_shows_trash_title', async () => {
    mockListAndSummary([], 0, { bytesReclaimed: 0, count: 0 });
    await renderPage();
    expect(screen.getByRole('heading', { name: en.trash.title })).toBeInTheDocument();
  });

  it('test_TrashPage_when_no_rows_then_shows_empty_state_headline', async () => {
    mockListAndSummary([], 0, { bytesReclaimed: 0, count: 0 });
    await renderPage();
    expect(screen.getAllByText(en.trash.empty.headline).length).toBeGreaterThan(0);
  });

  it('test_TrashPage_when_summary_zero_then_savings_pill_renders_zero_count', async () => {
    mockListAndSummary([], 0, { bytesReclaimed: 0, count: 0 });
    await renderPage();
    expect(screen.getByText(/0 files/)).toBeInTheDocument();
  });

  it('test_TrashPage_when_summary_has_data_then_savings_pill_renders_count', async () => {
    mockListAndSummary([], 0, { bytesReclaimed: 247 * 1_000_000_000, count: 1432 });
    await renderPage();
    expect(screen.getByText(/1[,.]?432 files/)).toBeInTheDocument();
  });

  it('test_TrashPage_when_rows_present_then_renders_path', async () => {
    mockListAndSummary([sampleRow], 1, { bytesReclaimed: 1_500_000_000, count: 1 });
    await renderPage();
    expect(screen.getAllByText('/media/show/episode.mkv').length).toBeGreaterThan(0);
  });

  it('test_TrashPage_when_fetch_fails_then_falls_back_to_empty_initial_state', async () => {
    mockFetch.mockResolvedValue({ ok: false });
    await renderPage();
    expect(screen.getAllByText(en.trash.empty.headline).length).toBeGreaterThan(0);
  });
});
