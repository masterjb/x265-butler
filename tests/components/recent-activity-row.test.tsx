// 07-01 (E-RA): Recent Activity row swap — basename primary + ID-Badge subtle
// + per-cell <Link> navigation to /{locale}/library?file={file_id}.
//
// Plan pin (audit S1): EXACTLY 3 tests in this file.
//   1. file_path present → renders basename + ID-Badge
//   2. file_path null → renders fileMissing fallback
//   3. row clicked → all per-cell Links carry locale-prefixed library href

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { RecentActivity } from '@/components/dashboard/recent-activity';
import type { RecentActivityRow } from '@/src/lib/db';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function rowFix(over: Partial<RecentActivityRow> = {}): RecentActivityRow {
  return {
    id: 42,
    file_id: 17,
    status: 'done',
    started_at: 1_700_000_000,
    finished_at: 1_700_000_100,
    encoder: 'libx265',
    crf: 23,
    queue_position: 0,
    bytes_in: 1_000_000,
    bytes_out: 500_000,
    duration_ms: 60_000,
    exit_code: 0,
    error_msg: null,
    log_tail: null,
    created_at: 1_700_000_000,
    file_path: '/mnt/user/movies/Test File.mkv',
    ...over,
  };
}

describe('RecentActivity · 07-01 row swap', () => {
  it('test_RecentActivity_when_file_path_present_then_renders_basename_and_id_badge', () => {
    render(wrap(<RecentActivity stats={{ recentActivity: [rowFix()] }} />));
    // Basename of '/mnt/user/movies/Test File.mkv' is 'Test File.mkv'.
    // Desktop renders the basename in the File <td>, mobile renders it in the
    // <li> card body — at least one occurrence is asserted via getAllByText.
    expect(screen.getAllByText(/Test File\.mkv/).length).toBeGreaterThan(0);
    // ID-Badge prefix `#42` must render (idBadge i18n key).
    expect(screen.getAllByText('#42').length).toBeGreaterThan(0);
  });

  it('test_RecentActivity_when_file_path_null_then_renders_fileMissing_fallback', () => {
    render(wrap(<RecentActivity stats={{ recentActivity: [rowFix({ file_path: null })] }} />));
    // EN fallback copy from messages/en.json `dashboard.recentActivity.fileMissing`.
    expect(screen.getAllByText('(deleted file)').length).toBeGreaterThan(0);
    // ID-Badge still renders.
    expect(screen.getAllByText('#42').length).toBeGreaterThan(0);
  });

  it('test_RecentActivity_when_row_clicked_then_link_href_is_locale_prefixed_library_with_file_param', () => {
    render(wrap(<RecentActivity stats={{ recentActivity: [rowFix()] }} />));
    // audit M2 + M3: per-cell Link pattern produces multiple anchors per row,
    // ALL sharing href `/en/library?file=17` and the same aria-label.
    const links = screen.getAllByRole('link', { name: /Test File\.mkv \(#42\)/ });
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute('href')).toBe('/en/library?file=17');
    }
  });
});
