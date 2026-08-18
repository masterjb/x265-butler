import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BlocklistRow, FileRow } from '@/src/lib/db/schema';

const {
  mockBlocklistAdd,
  mockBlocklistRemove,
  mockBlocklistFindById,
  mockBlocklistFindByPattern,
  mockBlocklistCount,
  mockFileGetById,
  mockFileSetStatus,
  mockFileListEligibleForBlocklistFlip,
  mockFileBulkSetStatusByIds,
  mockGetDb,
  mockEnsureServerInit,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
  mockLoggerDebug,
  mockComposeExtensionWarning,
} = vi.hoisted(() => ({
  mockBlocklistAdd: vi.fn(),
  mockBlocklistRemove: vi.fn(),
  mockBlocklistFindById: vi.fn(),
  mockBlocklistFindByPattern: vi.fn(),
  mockBlocklistCount: vi.fn(),
  mockFileGetById: vi.fn(),
  mockFileSetStatus: vi.fn(),
  mockFileListEligibleForBlocklistFlip: vi.fn(),
  mockFileBulkSetStatusByIds: vi.fn(),
  // 13-06: getDb returns an object whose .transaction(fn) returns a callable
  // wrapper that invokes `fn` synchronously — mirrors better-sqlite3 behavior
  // for unit tests (no real isolation; route logic is what we exercise here).
  mockGetDb: vi.fn(() => ({
    transaction: <T>(fn: () => T): (() => T) => fn,
  })),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerDebug: vi.fn(),
  // 22-03 T1: route-level mock for the extension-warning helper. Unit tests
  // for the helper itself live in tests/lib/blocklist/pattern-extension.test.ts;
  // here we drive route branches via explicit return values.
  mockComposeExtensionWarning: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  blocklistRepo: () => ({
    add: mockBlocklistAdd,
    remove: mockBlocklistRemove,
    findById: mockBlocklistFindById,
    findByPattern: mockBlocklistFindByPattern,
    count: mockBlocklistCount,
  }),
  fileRepo: () => ({
    getById: mockFileGetById,
    setStatus: mockFileSetStatus,
    listEligibleForBlocklistFlip: mockFileListEligibleForBlocklistFlip,
    bulkSetStatusByIds: mockFileBulkSetStatusByIds,
  }),
  getDb: mockGetDb,
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
      debug: mockLoggerDebug,
    }),
  },
  default: {},
}));

// 22-03 T1: stub composeExtensionWarning at the module boundary. Default = null
// (no warning) so all pre-22-03 tests remain unaffected. Per-test overrides
// drive the 6 new audit-S1/S2/M3 cases.
vi.mock('@/src/lib/blocklist/pattern-extension', () => ({
  composeExtensionWarning: mockComposeExtensionWarning,
  derivePatternExtension: vi.fn(),
  getCurrentScanExtensions: vi.fn(),
}));

import { POST, DELETE, runtime } from '@/app/api/library/[id]/blocklist/route';

const ROUTE_URL = 'http://test/api/library/1/blocklist';

function makeRequest(
  method: 'POST' | 'DELETE',
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  return new Request(ROUTE_URL, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

const baseFile: FileRow = {
  id: 1,
  path: '/movies/A.mkv',
  size_bytes: 1024,
  mtime: 1700000000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 1000000,
  duration_seconds: 60,
  width: 1920,
  height: 1080,
  container: 'mp4',
  status: 'pending',
  last_scanned_at: 1700000000,
  created_at: 1700000000,
  updated_at: 1700000000,
  version: 0,
  container_override: null,
  share_id: null,
};

const baseBlocklistRow: BlocklistRow = {
  id: 42,
  file_id: 1,
  path_pattern: null,
  reason: 'operator',
  created_at: 1700000000,
};

beforeEach(() => {
  mockBlocklistAdd.mockReset();
  mockBlocklistRemove.mockReset();
  mockBlocklistFindById.mockReset();
  mockBlocklistFindByPattern.mockReset();
  mockBlocklistCount.mockReset().mockReturnValue(0);
  mockFileGetById.mockReset();
  mockFileSetStatus.mockReset().mockReturnValue(true);
  mockFileListEligibleForBlocklistFlip.mockReset().mockReturnValue([]);
  mockFileBulkSetStatusByIds.mockReset().mockReturnValue(0);
  mockGetDb.mockClear();
  mockEnsureServerInit.mockReset();
  mockLoggerInfo.mockReset();
  mockLoggerWarn.mockReset();
  mockLoggerError.mockReset();
  mockLoggerDebug.mockReset();
  mockComposeExtensionWarning.mockReset().mockReturnValue(null);
  delete process.env.NEXT_PHASE;
});

describe('POST /api/library/[id]/blocklist', () => {
  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_POST_when_mode_file_then_creates_entry_AND_setStatus_blocklisted', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockBlocklistAdd.mockReturnValue(baseBlocklistRow);

    const res = await POST(makeRequest('POST', { mode: 'file' }), ctx('1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(42);
    expect(body.fileId).toBe(1);
    expect(mockBlocklistAdd).toHaveBeenCalledWith({ file_id: 1, reason: 'operator' });
    expect(mockFileSetStatus).toHaveBeenCalledWith(1, 'blocklisted', 0);
  });

  it('test_POST_when_mode_pattern_valid_then_creates_entry_NO_setStatus', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '/movies/Samples/*',
    });

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '/movies/Samples/*' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    expect(mockFileSetStatus).not.toHaveBeenCalled();
    expect(mockBlocklistAdd).toHaveBeenCalledWith({
      path_pattern: '/movies/Samples/*',
      reason: 'operator',
    });
  });

  it('test_POST_when_mode_pattern_invalid_min_length_then_400_invalid_body', async () => {
    const res = await POST(makeRequest('POST', { mode: 'pattern', pathPattern: 'a' }), ctx('0'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
  });

  it('test_POST_when_mode_pattern_3_stars_then_400_pattern_too_complex', async () => {
    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '/a/*/b/*/c/*' }),
      ctx('0'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('pattern_too_complex');
  });

  it('test_POST_when_file_id_not_found_then_404_file_not_found', async () => {
    mockFileGetById.mockReturnValue(undefined);
    const res = await POST(makeRequest('POST', { mode: 'file' }), ctx('999'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('file_not_found');
  });

  it('test_POST_when_mode_pattern_idempotency_returns_existing', async () => {
    mockBlocklistFindByPattern.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '/movies/Samples/*',
    });
    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '/movies/Samples/*' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idempotent).toBe(true);
    expect(mockBlocklistAdd).not.toHaveBeenCalled();
  });

  // audit S1: body size cap
  it('test_POST_when_content_length_too_large_then_413_body_too_large', async () => {
    const req = new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(20 * 1024) },
      body: JSON.stringify({ mode: 'file' }),
    });
    const res = await POST(req, ctx('1'));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe('body_too_large');
  });

  // audit S2: entry-count cap
  it('test_POST_when_entry_cap_reached_then_409_blocklist_full', async () => {
    mockBlocklistCount.mockReturnValue(10000);
    const res = await POST(makeRequest('POST', { mode: 'file' }), ctx('1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('blocklist_full');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'blocklist_count_cap_reached' }),
      expect.any(String),
    );
  });

  it('test_POST_when_NEXT_PHASE_phase_production_build_then_short_circuits', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    const res = await POST(makeRequest('POST', { mode: 'file' }), ctx('1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(mockBlocklistAdd).not.toHaveBeenCalled();
  });

  it('test_POST_when_called_then_cache_control_no_store', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockBlocklistAdd.mockReturnValue(baseBlocklistRow);
    const res = await POST(makeRequest('POST', { mode: 'file' }), ctx('1'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('test_POST_when_called_then_pino_info_action_blocklist_added', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockBlocklistAdd.mockReturnValue(baseBlocklistRow);
    await POST(makeRequest('POST', { mode: 'file' }), ctx('1'));
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'blocklist_added' }),
      expect.any(String),
    );
  });

  // 13-06 T3 — Layer-1 retroactive flip on pattern POST.

  it('test_POST_pattern_AC5_4_eligible_flipped_to_blocklisted', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*/Samples/*',
    });
    mockFileListEligibleForBlocklistFlip.mockReturnValue([
      { id: 11, path: '/movies/Samples/B.mkv', status: 'failed' },
      { id: 12, path: '/movies/Samples/C.mkv', status: 'interrupted' },
      { id: 13, path: '/movies/Samples/D.mkv', status: 'done-larger' },
      { id: 14, path: '/movies/Samples/E.mkv', status: 'done-not-worth' },
      { id: 10, path: '/movies/A.mkv', status: 'pending' }, // outside pattern
    ]);
    mockFileBulkSetStatusByIds.mockReturnValue(4);

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '*/Samples/*' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flippedCount).toBe(4);
    expect(body.flippedIds.sort((a: number, b: number) => a - b)).toEqual([11, 12, 13, 14]);
    expect(mockFileBulkSetStatusByIds).toHaveBeenCalledTimes(1);
    const callArgs = mockFileBulkSetStatusByIds.mock.calls[0];
    expect(callArgs[1]).toBe('blocklisted');
  });

  it('test_POST_pattern_AC5_SR2_per_file_pino_with_previousStatus', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*/Samples/*',
    });
    mockFileListEligibleForBlocklistFlip.mockReturnValue([
      { id: 11, path: '/movies/Samples/B.mkv', status: 'failed' },
      { id: 12, path: '/movies/Samples/C.mkv', status: 'interrupted' },
      { id: 13, path: '/movies/Samples/D.mkv', status: 'done-larger' },
      { id: 14, path: '/movies/Samples/E.mkv', status: 'done-not-worth' },
    ]);
    mockFileBulkSetStatusByIds.mockReturnValue(4);

    await POST(makeRequest('POST', { mode: 'pattern', pathPattern: '*/Samples/*' }), ctx('0'));
    const perFileCalls = mockLoggerInfo.mock.calls.filter(
      (c) => c[0].action === 'file_status_changed_by_blocklist_pattern',
    );
    expect(perFileCalls).toHaveLength(4);
    const byId = new Map<number, string>();
    for (const c of perFileCalls) {
      byId.set(c[0].fileId, c[0].previousStatus);
    }
    expect(byId.get(11)).toBe('failed');
    expect(byId.get(12)).toBe('interrupted');
    expect(byId.get(13)).toBe('done-larger');
    expect(byId.get(14)).toBe('done-not-worth');
  });

  it('test_POST_pattern_AC6_idempotent_re_post_emits_noop_event_no_re_flip', async () => {
    mockBlocklistFindByPattern.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*/Samples/*',
    });
    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '*/Samples/*' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idempotent).toBe(true);
    expect(body.flippedCount).toBeUndefined();
    expect(body.flippedIds).toBeUndefined();
    expect(mockBlocklistAdd).not.toHaveBeenCalled();
    expect(mockFileListEligibleForBlocklistFlip).not.toHaveBeenCalled();
    expect(mockFileBulkSetStatusByIds).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'blocklist_added_idempotent_noop' }),
      expect.any(String),
    );
  });

  it('test_POST_pattern_AC8_mid_path_2_star_consumes_13_05_matchPath', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*/Extras/*',
    });
    mockFileListEligibleForBlocklistFlip.mockReturnValue([
      { id: 20, path: '/tv/Show/Season01/Extras/clip1.mkv', status: 'pending' },
      { id: 21, path: '/tv/Show/Season02/Extras/clip2.mkv', status: 'failed' },
      { id: 22, path: '/tv/Show/Season01/Normal/clip3.mkv', status: 'pending' },
    ]);
    mockFileBulkSetStatusByIds.mockReturnValue(2);

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '*/Extras/*' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flippedCount).toBe(2);
    expect(body.flippedIds.sort((a: number, b: number) => a - b)).toEqual([20, 21]);
    // bulkSetStatusByIds should receive only ids 20+21, NOT 22.
    const callArgs = mockFileBulkSetStatusByIds.mock.calls[0];
    expect((callArgs[0] as number[]).sort((a, b) => a - b)).toEqual([20, 21]);
  });

  it('test_POST_pattern_zero_eligible_matches_no_flip_log', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*/NeverMatches/*',
    });
    // listEligible returns nothing matching — helper returns 0 flipped.
    mockFileListEligibleForBlocklistFlip.mockReturnValue([
      { id: 1, path: '/movies/main.mkv', status: 'pending' },
    ]);

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '*/NeverMatches/*' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flippedCount).toBe(0);
    expect(body.flippedIds).toEqual([]);
    expect(mockFileBulkSetStatusByIds).not.toHaveBeenCalled();
    // No pattern_retroactive_flip event emitted on 0-match.
    const flipLogs = mockLoggerInfo.mock.calls.filter(
      (c) => c[0].action === 'pattern_retroactive_flip',
    );
    expect(flipLogs).toHaveLength(0);
    const flipWarn = mockLoggerWarn.mock.calls.filter(
      (c) => c[0].action === 'pattern_retroactive_flip',
    );
    expect(flipWarn).toHaveLength(0);
  });

  it('test_POST_pattern_SR5_99_files_emits_info_level', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*/X/*',
    });
    const candidates = Array.from({ length: 99 }, (_, i) => ({
      id: i + 1,
      path: `/X/f${i}.mkv`,
      status: 'pending' as const,
    }));
    mockFileListEligibleForBlocklistFlip.mockReturnValue(candidates);
    mockFileBulkSetStatusByIds.mockReturnValue(99);

    await POST(makeRequest('POST', { mode: 'pattern', pathPattern: '*/X/*' }), ctx('0'));
    const infoFlip = mockLoggerInfo.mock.calls.filter(
      (c) => c[0].action === 'pattern_retroactive_flip',
    );
    const warnFlip = mockLoggerWarn.mock.calls.filter(
      (c) => c[0].action === 'pattern_retroactive_flip',
    );
    expect(infoFlip).toHaveLength(1);
    expect(warnFlip).toHaveLength(0);
  });

  it('test_POST_pattern_SR5_100_files_emits_warn_level', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*/X/*',
    });
    const candidates = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      path: `/X/f${i}.mkv`,
      status: 'pending' as const,
    }));
    mockFileListEligibleForBlocklistFlip.mockReturnValue(candidates);
    mockFileBulkSetStatusByIds.mockReturnValue(100);

    await POST(makeRequest('POST', { mode: 'pattern', pathPattern: '*/X/*' }), ctx('0'));
    const infoFlip = mockLoggerInfo.mock.calls.filter(
      (c) => c[0].action === 'pattern_retroactive_flip',
    );
    const warnFlip = mockLoggerWarn.mock.calls.filter(
      (c) => c[0].action === 'pattern_retroactive_flip',
    );
    expect(infoFlip).toHaveLength(0);
    expect(warnFlip).toHaveLength(1);
  });

  it('test_POST_pattern_AC11_scope_cap_throws_409_blocklist_scope_too_large', async () => {
    const { EncodeGuardScopeCapError } = await import('@/src/lib/blocklist/encode-guard');
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*',
    });
    mockFileListEligibleForBlocklistFlip.mockImplementation(() => {
      throw new EncodeGuardScopeCapError(100_001, 100_000);
    });

    const res = await POST(makeRequest('POST', { mode: 'pattern', pathPattern: '**' }), ctx('0'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('blocklist_scope_too_large');
    expect(body.scopeCount).toBe(100_001);
    expect(body.cap).toBe(100_000);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'blocklist_scope_cap_exceeded' }),
      expect.any(String),
    );
  });

  it('test_POST_pattern_AC12_SR4_truncates_response_at_1000_full_list_in_pino', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*/Samples/*',
    });
    const candidates = Array.from({ length: 1500 }, (_, i) => ({
      id: i + 1,
      path: `/movies/Samples/${i}.mkv`,
      status: 'pending' as const,
    }));
    mockFileListEligibleForBlocklistFlip.mockReturnValue(candidates);
    mockFileBulkSetStatusByIds.mockReturnValue(1500);

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '*/Samples/*' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flippedCount).toBe(1500);
    expect(body.flippedIds).toHaveLength(1000);
    expect(body.flippedIdsTruncated).toBe(true);
    expect(body.flippedIdsTotalCount).toBe(1500);
    // Pino log preserves full list.
    const flipLog = mockLoggerWarn.mock.calls.find(
      (c) => c[0].action === 'pattern_retroactive_flip',
    );
    expect(flipLog).toBeDefined();
    expect(flipLog![0].flippedIds).toHaveLength(1500);
  });

  it('test_POST_file_mode_does_NOT_call_listEligibleForBlocklistFlip_M2_boundary', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockBlocklistAdd.mockReturnValue(baseBlocklistRow);
    await POST(makeRequest('POST', { mode: 'file' }), ctx('1'));
    expect(mockFileListEligibleForBlocklistFlip).not.toHaveBeenCalled();
    expect(mockFileBulkSetStatusByIds).not.toHaveBeenCalled();
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  it('test_POST_pattern_M2_atomic_TX_invoked_exactly_once', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*/Samples/*',
    });
    mockFileListEligibleForBlocklistFlip.mockReturnValue([]);
    await POST(makeRequest('POST', { mode: 'pattern', pathPattern: '*/Samples/*' }), ctx('0'));
    // getDb invoked once → its transaction wraps idempotency check + add + flip atomically.
    expect(mockGetDb).toHaveBeenCalledTimes(1);
  });

  it('test_POST_pattern_AC13_SR7_listEligible_called_with_5_states_excludes_queued_encoding', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*/Samples/*',
    });
    mockFileListEligibleForBlocklistFlip.mockReturnValue([]);

    await POST(makeRequest('POST', { mode: 'pattern', pathPattern: '*/Samples/*' }), ctx('0'));
    expect(mockFileListEligibleForBlocklistFlip).toHaveBeenCalledTimes(1);
    const states = mockFileListEligibleForBlocklistFlip.mock.calls[0][0] as string[];
    expect(states.sort()).toEqual(
      ['done-larger', 'done-not-worth', 'failed', 'interrupted', 'pending'].sort(),
    );
    expect(states).not.toContain('queued');
    expect(states).not.toContain('encoding');
  });

  // 22-03 T1 — extension-warning surface on pattern POST.

  it('test_POST_pattern_22_03_AC3_warning_attached_AND_pino_debug_emitted', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*.srt',
    });
    mockFileListEligibleForBlocklistFlip.mockReturnValue([]);
    mockComposeExtensionWarning.mockReturnValue({
      resolvedExt: 'srt',
      scanExtensions: ['mkv', 'mp4'],
    });

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '*.srt' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extensionWarning).toEqual({
      resolvedExt: 'srt',
      scanExtensions: ['mkv', 'mp4'],
    });
    // pino debug emit captured exactly once.
    const warnEmits = mockLoggerDebug.mock.calls.filter(
      (c) => c[0].action === 'blocklist_pattern_warn_no_scan_ext',
    );
    expect(warnEmits).toHaveLength(1);
    expect(warnEmits[0][0]).toMatchObject({
      entryId: 42,
      pattern: '*.srt',
      resolvedExt: 'srt',
      scanExtensions: ['mkv', 'mp4'],
    });
  });

  it('test_POST_pattern_22_03_AC3_no_warning_when_ext_covered_AND_zero_emit', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*.mkv',
    });
    mockFileListEligibleForBlocklistFlip.mockReturnValue([]);
    mockComposeExtensionWarning.mockReturnValue(null);

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '*.mkv' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extensionWarning).toBeUndefined();
    const warnEmits = mockLoggerDebug.mock.calls.filter(
      (c) => c[0].action === 'blocklist_pattern_warn_no_scan_ext',
    );
    expect(warnEmits).toHaveLength(0);
  });

  it('test_POST_pattern_22_03_AC3_no_warning_when_mid_path_pattern', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*/Extras/*',
    });
    mockFileListEligibleForBlocklistFlip.mockReturnValue([]);
    mockComposeExtensionWarning.mockReturnValue(null);

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '*/Extras/*' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extensionWarning).toBeUndefined();
    expect(mockComposeExtensionWarning).toHaveBeenCalledWith('*/Extras/*');
    const warnEmits = mockLoggerDebug.mock.calls.filter(
      (c) => c[0].action === 'blocklist_pattern_warn_no_scan_ext',
    );
    expect(warnEmits).toHaveLength(0);
  });

  it('test_POST_pattern_22_03_AC3_audit_S1_S3_shareRepo_throws_suppresses_warning', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*.srt',
    });
    mockFileListEligibleForBlocklistFlip.mockReturnValue([]);
    // Helper-internal suppression: composeExtensionWarning swallows the throw,
    // returns null. The unit test for getCurrentScanExtensions covers the WARN
    // emit. Here we verify route-level behavior: NO extensionWarning attached
    // when helper returns null even though a `*.srt`-shape pattern was POSTed.
    mockComposeExtensionWarning.mockReturnValue(null);

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '*.srt' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extensionWarning).toBeUndefined();
    const warnEmits = mockLoggerDebug.mock.calls.filter(
      (c) => c[0].action === 'blocklist_pattern_warn_no_scan_ext',
    );
    expect(warnEmits).toHaveLength(0);
  });

  it('test_POST_pattern_22_03_AC3_audit_S2_idempotent_branch_zero_warning_emit', async () => {
    // Second POST: findByPattern returns existing row → idempotent branch.
    mockBlocklistFindByPattern.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*.srt',
    });
    mockComposeExtensionWarning.mockReturnValue({
      resolvedExt: 'srt',
      scanExtensions: ['mkv', 'mp4'],
    });

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '*.srt' }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idempotent).toBe(true);
    expect(body.extensionWarning).toBeUndefined();
    // Idempotent branch returns BEFORE the warning-compose block runs.
    expect(mockComposeExtensionWarning).not.toHaveBeenCalled();
    const warnEmits = mockLoggerDebug.mock.calls.filter(
      (c) => c[0].action === 'blocklist_pattern_warn_no_scan_ext',
    );
    expect(warnEmits).toHaveLength(0);
  });

  it('test_POST_pattern_22_03_AC3_audit_M3_helper_throws_returns_200_with_helper_error_emit', async () => {
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '*.srt',
    });
    mockFileListEligibleForBlocklistFlip.mockReturnValue([]);
    mockComposeExtensionWarning.mockImplementation(() => {
      throw new Error('unexpected helper failure');
    });

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: '*.srt' }),
      ctx('0'),
    );
    // POST MUST still succeed.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(42);
    expect(body.extensionWarning).toBeUndefined();
    // helper-error emit captured exactly once at WARN level.
    const errEmits = mockLoggerWarn.mock.calls.filter(
      (c) => c[0].action === 'blocklist_pattern_warn_helper_error',
    );
    expect(errEmits).toHaveLength(1);
    expect(errEmits[0][0]).toMatchObject({
      action: 'blocklist_pattern_warn_helper_error',
      error: 'unexpected helper failure',
      pattern: '*.srt',
      entryId: 42,
    });
  });

  it('test_POST_pattern_22_03_AC3_audit_M2_log_pattern_truncated_at_256_chars', async () => {
    const longPattern = '*' + 'a'.repeat(4000) + '.srt';
    mockBlocklistFindByPattern.mockReturnValue(undefined);
    mockBlocklistAdd.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: longPattern,
    });
    mockFileListEligibleForBlocklistFlip.mockReturnValue([]);
    mockComposeExtensionWarning.mockReturnValue({
      resolvedExt: 'srt',
      scanExtensions: ['mkv', 'mp4'],
    });

    const res = await POST(
      makeRequest('POST', { mode: 'pattern', pathPattern: longPattern }),
      ctx('0'),
    );
    expect(res.status).toBe(200);
    const debugEmit = mockLoggerDebug.mock.calls.find(
      (c) => c[0].action === 'blocklist_pattern_warn_no_scan_ext',
    );
    expect(debugEmit).toBeDefined();
    // 256-char cap + ellipsis suffix.
    expect((debugEmit![0].pattern as string).length).toBeLessThanOrEqual(257);
    expect((debugEmit![0].pattern as string).endsWith('…')).toBe(true);
    // resolvedExt + scanExtensions are NOT clamped.
    expect(debugEmit![0].resolvedExt).toBe('srt');
    expect(debugEmit![0].scanExtensions).toEqual(['mkv', 'mp4']);
  });
});

describe('DELETE /api/library/[id]/blocklist', () => {
  it('test_DELETE_when_id_exists_AND_file_pinned_AND_blocklisted_then_setStatus_pending_AND_returns_200', async () => {
    mockBlocklistFindById.mockReturnValue(baseBlocklistRow);
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'blocklisted' });
    mockBlocklistRemove.mockReturnValue(true);

    const res = await DELETE(makeRequest('DELETE'), ctx('42'));
    expect(res.status).toBe(200);
    expect(mockFileSetStatus).toHaveBeenCalledWith(1, 'pending', 0);
    expect(mockBlocklistRemove).toHaveBeenCalledWith(42);
  });

  // audit M3: status preservation
  it('test_DELETE_when_file_status_NOT_blocklisted_then_NO_setStatus_AND_pino_info_status_preserve_on_unblocklist', async () => {
    mockBlocklistFindById.mockReturnValue(baseBlocklistRow);
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'failed' });
    mockBlocklistRemove.mockReturnValue(true);

    const res = await DELETE(makeRequest('DELETE'), ctx('42'));
    expect(res.status).toBe(200);
    expect(mockFileSetStatus).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'status_preserve_on_unblocklist',
        currentStatus: 'failed',
      }),
      expect.any(String),
    );
  });

  it('test_DELETE_when_id_pattern_then_NO_setStatus', async () => {
    mockBlocklistFindById.mockReturnValue({
      ...baseBlocklistRow,
      file_id: null,
      path_pattern: '/movies/Samples/*',
    });
    mockBlocklistRemove.mockReturnValue(true);
    const res = await DELETE(makeRequest('DELETE'), ctx('42'));
    expect(res.status).toBe(200);
    expect(mockFileSetStatus).not.toHaveBeenCalled();
  });

  // audit S4: idempotent flag
  it('test_DELETE_when_id_missing_then_404_with_idempotent_true_flag', async () => {
    mockBlocklistFindById.mockReturnValue(undefined);
    const res = await DELETE(makeRequest('DELETE'), ctx('99'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
    expect(body.idempotent).toBe(true);
  });

  it('test_DELETE_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });
});
