// 07-06 Plan Task 2 — LibraryClient auto-open behavior tests.
// Plan pin: EXACTLY 5 tests in this file (AC-4).
//   1. auto-open fires when query.file matches a row
//   2. no auto-open when query.file matches no row (empty rows)
//   3. no auto-open when query.file is absent (undefined)
//   4. auto-open uses matching row's data (file prop passed to panel)
//   5. re-triggers on new query.file (A→B navigation scenario)
//
// Mandatory approach (audit-fix:M2): vi.mock FileDetailPanel — Radix portals
// are unreliable in jsdom; mock-call assertions are the deterministic gate.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { LibraryClient } from '@/app/[locale]/library/library-client';
import type { FileRow } from '@/src/lib/db/schema';
import type { CountByStatus } from '@/src/lib/db/repos/file';
import type { LibraryQuery } from '@/src/lib/api/library-query';

const { mockFileDetailPanel } = vi.hoisted(() => ({
  mockFileDetailPanel: vi.fn(() => null),
}));

vi.mock('@/components/library/file-detail-panel', () => ({
  FileDetailPanel: mockFileDetailPanel,
}));

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const EMPTY_COUNTS: CountByStatus = {
  all: 0,
  pending: 0,
  queued: 0,
  encoding: 0,
  'done-smaller': 0,
  'done-larger': 0,
  'skipped-codec': 0,
  'skipped-bitrate': 0,
  'skipped-suffix': 0,
  'skipped-tag': 0,
  'skipped-sidecar': 0,
  'skipped-blocklist': 0,
  failed: 0,
  blocklisted: 0,
  interrupted: 0,
  vanished: 0,
  'done-not-worth': 0,
  'done-already-evaluated': 0,
};

const FIXTURE_FILE: FileRow = {
  id: 42,
  path: '/media/foo/bar.mp4',
  status: 'done-smaller',
  size_bytes: 1_000_000,
  mtime: 1_700_000_000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 5_000_000,
  duration_seconds: 60,
  width: 1920,
  height: 1080,
  container: 'mp4',
  last_scanned_at: 1_700_000_000,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  version: 0,
  container_override: null,
  share_id: null,
};

const FIXTURE_FILE_99: FileRow = { ...FIXTURE_FILE, id: 99, path: '/media/foo/other.mp4' };

const DEFAULT_PAGINATION = { page: 1, size: 25, total: 1, pageCount: 1 };

const BASE_QUERY: LibraryQuery = {
  page: 1,
  size: 25,
  sort: 'size',
  dir: 'desc',
  includeVanished: false,
};

function makeProps(
  overrides: {
    rows?: FileRow[];
    query?: Partial<LibraryQuery>;
    pagination?: typeof DEFAULT_PAGINATION;
  } = {},
) {
  return {
    rows: overrides.rows ?? [FIXTURE_FILE],
    pagination: overrides.pagination ?? DEFAULT_PAGINATION,
    counts: EMPTY_COUNTS,
    query: { ...BASE_QUERY, ...overrides.query },
    scanRootExists: true,
    scanRoot: '/media',
    shares: [],
    orphanCount: 0,
  };
}

type MockCall = [{ open: boolean; file: FileRow | null }];
const panelCalls = () => mockFileDetailPanel.mock.calls as unknown as MockCall[];

describe('LibraryClient auto-open panel', () => {
  beforeEach(() => {
    mockFileDetailPanel.mockClear();
  });

  it('test_auto_open_when_query_file_matches_row', () => {
    render(wrap(<LibraryClient {...makeProps({ query: { file: 42 } })} />));
    const wasCalled = panelCalls().some(([props]) => props.open === true);
    expect(wasCalled).toBe(true);
  });

  it('test_no_auto_open_when_query_file_no_match', () => {
    render(
      wrap(
        <LibraryClient
          {...makeProps({
            rows: [],
            query: { file: 99999 },
            pagination: { page: 1, size: 25, total: 0, pageCount: 0 },
          })}
        />,
      ),
    );
    const wasCalled = panelCalls().some(([props]) => props.open === true);
    expect(wasCalled).toBe(false);
  });

  it('test_no_auto_open_when_query_file_absent', () => {
    render(wrap(<LibraryClient {...makeProps()} />));
    const wasCalled = panelCalls().some(([props]) => props.open === true);
    expect(wasCalled).toBe(false);
  });

  it('test_auto_open_uses_first_matching_row', () => {
    render(wrap(<LibraryClient {...makeProps({ query: { file: 42 } })} />));
    const openCall = panelCalls().find(([props]) => props.open === true);
    expect(openCall).toBeDefined();
    expect(openCall![0].file).toMatchObject({ id: 42 });
  });

  it('test_re_triggers_on_new_query_file', () => {
    const { rerender } = render(wrap(<LibraryClient {...makeProps({ query: { file: 42 } })} />));
    const openCallA = panelCalls().find(([props]) => props.open === true);
    expect(openCallA).toBeDefined();
    expect(openCallA![0].file).toMatchObject({ id: 42 });

    mockFileDetailPanel.mockClear();

    rerender(
      wrap(
        <LibraryClient
          {...makeProps({
            rows: [FIXTURE_FILE_99],
            query: { file: 99 },
          })}
        />,
      ),
    );
    const openCallsB = panelCalls().filter(([props]) => props.open === true);
    expect(openCallsB.length).toBeGreaterThan(0);
    const lastOpenCallB = openCallsB[openCallsB.length - 1];
    expect(lastOpenCallB[0].file).toMatchObject({ id: 99 });
  });
});
