// 15-01 T4: /api/library?pathPrefix= — AC-7 zod-validated extension.
// Covers: echo in effectiveFilters, per-field .catch on >500 chars,
// AND-composition with share/status, library_query_executed info-log,
// library_pathprefix_rejected warn-log on control-char input, CSV-export
// boundary snapshot (SR5 deferred-to-15-02 signal).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { FileRow, ShareRow } from '@/src/lib/db/schema';
import type { CountByStatus, ListOptions, ListResult } from '@/src/lib/db/repos/file';

const mocks = vi.hoisted(() => ({
  mockListPaginated: vi.fn<(opts: ListOptions) => ListResult>(),
  mockCountByStatus: vi.fn<() => CountByStatus>(),
  mockCountOrphaned: vi.fn<() => number>(),
  mockShareListAll: vi.fn<() => ShareRow[]>(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({
    listPaginated: mocks.mockListPaginated,
    countByStatus: mocks.mockCountByStatus,
    countOrphaned: mocks.mockCountOrphaned,
  }),
  shareRepo: () => ({ listAll: mocks.mockShareListAll }),
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mocks.mockLogInfo,
      warn: mocks.mockLogWarn,
      error: mocks.mockLogError,
    }),
  },
}));

import { GET } from '@/app/api/library/route';

const emptyCounts: CountByStatus = {
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

const sampleRow: FileRow = {
  id: 1,
  path: '/media/x.mp4',
  size_bytes: 1024,
  mtime: 0,
  content_hash: '0'.repeat(64),
  codec: 'h264',
  bitrate: null,
  duration_seconds: null,
  width: null,
  height: null,
  container: null,
  status: 'pending',
  last_scanned_at: 0,
  created_at: 0,
  updated_at: 0,
  version: 0,
  container_override: null,
  share_id: null,
};

function getReq(query: string): Request {
  return new Request(`http://localhost/api/library${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mockListPaginated.mockReturnValue({ rows: [sampleRow], total: 1 });
  mocks.mockCountByStatus.mockReturnValue(emptyCounts);
  mocks.mockCountOrphaned.mockReturnValue(0);
  mocks.mockShareListAll.mockReturnValue([]);
});

describe('GET /api/library?pathPrefix', () => {
  it('effectiveFilters.pathPrefix echoes parsed input', async () => {
    const res = await GET(getReq('?pathPrefix=/mnt/movies/A'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effectiveFilters.pathPrefix).toBe('/mnt/movies/A');
    const opts = mocks.mockListPaginated.mock.calls[0][0];
    expect(opts.pathPrefix).toBe('/mnt/movies/A');
  });

  it('pathPrefix > 500 chars → per-field .catch(undefined); 200 OK without filter', async () => {
    const long = 'a'.repeat(600);
    const res = await GET(getReq(`?pathPrefix=${long}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effectiveFilters.pathPrefix).toBeUndefined();
  });

  it('AND-composition: pathPrefix + share + status passed through to repo opts', async () => {
    await GET(getReq('?pathPrefix=/mnt/a&share=2&status=done-smaller'));
    const opts = mocks.mockListPaginated.mock.calls[0][0];
    expect(opts.pathPrefix).toBe('/mnt/a');
    expect(opts.shareId).toBe(2);
    expect(opts.status).toBe('done-smaller');
  });

  it('M1: library_query_executed info-log emitted with hasPathPrefix flag', async () => {
    await GET(getReq('?pathPrefix=/mnt'));
    const events = mocks.mockLogInfo.mock.calls.map((c) => c[1]);
    expect(events).toContain('library_query_executed');
    const payload = mocks.mockLogInfo.mock.calls.find(
      (c) => c[1] === 'library_query_executed',
    )?.[0] as { hasPathPrefix: boolean } | undefined;
    expect(payload?.hasPathPrefix).toBe(true);
  });

  it('M4: control-char NULL-byte payload → library_pathprefix_rejected warn-log; 200 ohne filter', async () => {
    // URL-encoded U+0000 → %00 (zod regex pre-binding-reject).
    const res = await GET(getReq('?pathPrefix=foo%00bar'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effectiveFilters.pathPrefix).toBeUndefined();
    const warnEvents = mocks.mockLogWarn.mock.calls.map((c) => c[1]);
    expect(warnEvents).toContain('library_pathprefix_rejected');
  });

  it('M4: BEL control-char payload (U+0007) → rejected same code-path', async () => {
    const res = await GET(getReq('?pathPrefix=foo%07bar'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effectiveFilters.pathPrefix).toBeUndefined();
  });
});

describe('SR5: CSV-export pathPrefix-inheritance boundary snapshot', () => {
  it('export.csv route source does NOT yet consume pathPrefix (deferred to 15-02)', () => {
    // 15-01 documents the boundary: /api/library/export.csv currently iterates
    // the ListOptions emitted by the page handler, but the export route itself
    // doesn't surface pathPrefix as a query-param. When 15-02 wires that up,
    // this snapshot test flips and the deferred ticket can be closed.
    const exportPath = path.resolve(process.cwd(), 'app/api/library/export.csv/route.ts');
    if (!fs.existsSync(exportPath)) {
      // Defensive: if the file path changed under us, the test should fail
      // loudly rather than silently pass.
      throw new Error(`SR5 snapshot anchor missing: ${exportPath}`);
    }
    const source = fs.readFileSync(exportPath, 'utf8');
    expect(source.includes('pathPrefix')).toBe(false);
  });
});
