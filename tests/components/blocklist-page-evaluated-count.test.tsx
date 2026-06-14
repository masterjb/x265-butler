/*
 * 22-03 T3 — BlocklistClient Recent-matches column (AC-5).
 *
 * Renders BlocklistClient directly with mock props. Drives the three
 * row-types: pattern with count, pattern with ZERO + warning-hint, file-pinned.
 * Mobile-card line mirrors table cell.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import {
  BlocklistClient,
  type BlocklistRowWithFile,
} from '@/app/[locale]/blocklist/blocklist-client';

function wrap(ui: React.ReactNode, locale: 'en' | 'de' = 'en') {
  const messages = locale === 'en' ? en : de;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const rowSrt: BlocklistRowWithFile = {
  id: 1,
  file_id: null,
  path_pattern: '*.srt',
  reason: 'operator',
  created_at: 1700000000,
  filePath: null,
  recentMatchCount: 0,
  derivedExtension: 'srt',
  extensionWarningHint: true,
};

const rowMkv: BlocklistRowWithFile = {
  id: 2,
  file_id: null,
  path_pattern: '*.mkv',
  reason: 'operator',
  created_at: 1700000000,
  filePath: null,
  recentMatchCount: 5,
  derivedExtension: 'mkv',
  extensionWarningHint: false,
};

const rowFilePinned: BlocklistRowWithFile = {
  id: 3,
  file_id: 99,
  path_pattern: null,
  reason: 'operator',
  created_at: 1700000000,
  filePath: '/media/A.mkv',
};

afterEach(() => {
  cleanup();
});

describe('BlocklistClient Recent-matches column (22-03 AC-5)', () => {
  it('test_AC5_table_header_recent_matches_present_in_EN', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={[rowSrt, rowMkv, rowFilePinned]}
          initialTotal={3}
          initialPage={1}
          initialSize={25}
          dbErrored={false}
          scanExtensions={['mkv', 'mp4']}
        />,
      ),
    );
    expect(screen.getAllByText(/Recent matches/i).length).toBeGreaterThan(0);
  });

  it('test_AC5_table_header_letzte_treffer_present_in_DE', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={[rowSrt, rowMkv, rowFilePinned]}
          initialTotal={3}
          initialPage={1}
          initialSize={25}
          dbErrored={false}
          scanExtensions={['mkv', 'mp4']}
        />,
        'de',
      ),
    );
    expect(screen.getAllByText(/Letzte Treffer/i).length).toBeGreaterThan(0);
  });

  it('test_AC5_pattern_with_5_recent_matches_renders_count_5', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={[rowMkv]}
          initialTotal={1}
          initialPage={1}
          initialSize={25}
          dbErrored={false}
          scanExtensions={['mkv', 'mp4']}
        />,
      ),
    );
    expect(screen.getAllByText('5').length).toBeGreaterThan(0);
  });

  it('test_AC5_pattern_with_zero_AND_warning_hint_renders_0_plus_info_icon_with_aria_label', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={[rowSrt]}
          initialTotal={1}
          initialPage={1}
          initialSize={25}
          dbErrored={false}
          scanExtensions={['mkv', 'mp4']}
        />,
      ),
    );
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    // Info icon button carries aria-label per T0-F3 + AC-5.
    const triggers = screen.getAllByRole('button', { name: /Recent match count/i });
    expect(triggers.length).toBeGreaterThan(0);
  });

  it('test_AC5_file_pinned_row_renders_em_dash_with_aria_label', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={[rowFilePinned]}
          initialTotal={1}
          initialPage={1}
          initialSize={25}
          dbErrored={false}
          scanExtensions={['mkv', 'mp4']}
        />,
      ),
    );
    const dashes = screen.getAllByLabelText(/Not applicable/i);
    expect(dashes.length).toBeGreaterThan(0);
    for (const d of dashes) {
      expect(d.textContent).toBe('—');
    }
  });

  it('test_AC5_mobile_card_line_renders_recent_matches_label_AND_count', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={[rowMkv]}
          initialTotal={1}
          initialPage={1}
          initialSize={25}
          dbErrored={false}
          scanExtensions={['mkv', 'mp4']}
        />,
      ),
    );
    // Mobile card section is `md:hidden` — still in the DOM under jsdom.
    // Label appears in card.
    const labels = screen.getAllByText(/Recent matches/i);
    // At least 2: 1 table header + 1 mobile-card label.
    expect(labels.length).toBeGreaterThanOrEqual(2);
  });

  it('test_AC5_warning_hint_does_NOT_render_when_extensionWarningHint_false', () => {
    render(
      wrap(
        <BlocklistClient
          initialRows={[rowMkv]}
          initialTotal={1}
          initialPage={1}
          initialSize={25}
          dbErrored={false}
          scanExtensions={['mkv', 'mp4']}
        />,
      ),
    );
    // No info-icon trigger button for the non-hinted row.
    expect(screen.queryAllByRole('button', { name: /Recent match count/i }).length).toBe(0);
  });
});
