import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const {
  mockSettingsGetAll,
  mockRunScan,
  mockFileRepo,
  mockListPaginated,
  mockEnqueue,
  mockListActive,
  mockCountByStatus,
  mockEmit,
  mockShareRepoListAll,
  mockLoggerChildWarn,
  mockLoggerChildInfo,
  mockLoggerChildError,
} = vi.hoisted(() => ({
  mockSettingsGetAll: vi.fn<() => Record<string, string>>(),
  mockRunScan: vi.fn(),
  mockFileRepo: { listPaginated: vi.fn() },
  mockListPaginated: vi.fn(),
  mockEnqueue: vi.fn(),
  mockListActive: vi.fn(() => []),
  mockCountByStatus: vi.fn(() => 0),
  mockEmit: vi.fn(),
  mockShareRepoListAll: vi.fn<() => unknown[]>(() => []),
  mockLoggerChildWarn: vi.fn(),
  mockLoggerChildInfo: vi.fn(),
  mockLoggerChildError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({ ...mockFileRepo, listPaginated: mockListPaginated }),
  settingRepo: () => ({ getAll: mockSettingsGetAll }),
  jobRepo: () => ({
    enqueue: mockEnqueue,
    listActive: mockListActive,
    countByStatus: mockCountByStatus,
  }),
  shareRepo: () => ({ listAll: mockShareRepoListAll }),
  default: {},
}));

vi.mock('@/src/lib/encode', () => ({
  engineEvents: { emit: mockEmit },
  isPaused: () => false,
}));

vi.mock('@/src/lib/scan/orchestrator', () => ({
  runScan: mockRunScan,
  default: { runScan: mockRunScan },
}));

// audit-fix:SR2/SR3 — spy on the scoped child logger so tests can assert that
// scan_rootpath_override_ignored, scan_empty_shares_fallback, scan_complete
// log lines fire with the requestId-bound child.
vi.mock('@/src/lib/logger', () => {
  const child = {
    warn: mockLoggerChildWarn,
    info: mockLoggerChildInfo,
    error: mockLoggerChildError,
  };
  return {
    logger: {
      child: vi.fn(() => child),
      warn: mockLoggerChildWarn,
      info: mockLoggerChildInfo,
      error: mockLoggerChildError,
    },
  };
});

import { POST, runtime } from '@/app/api/scan/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function jsonReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/scan', () => {
  let tmpdir: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-test-'));
    mockSettingsGetAll.mockReset();
    mockRunScan.mockReset();
    mockListPaginated.mockReset();
    mockEnqueue.mockReset();
    mockEmit.mockReset();
    mockListActive.mockReset();
    mockCountByStatus.mockReset();
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    mockListActive.mockReturnValue([]);
    mockCountByStatus.mockReturnValue(0);
    mockShareRepoListAll.mockReset();
    // 14-04 (Plan 14-04 Task 7): /api/scan now sources scanRoot / minSizeMb /
    // extensions / maxDepth from shareRepo().listAll()[0]. Seed a default
    // share so tests that expected legacy `mockSettingsGetAll` keys keep
    // their effective-filter assertions valid.
    mockShareRepoListAll.mockReturnValue([
      {
        id: 1,
        name: 'Library',
        path: tmpdir,
        min_size_mb: 1,
        extensions_csv: 'mp4,mkv',
        max_depth: 12,
        created_at: 1700000000,
        updated_at: 1700000000,
      },
    ]);
    mockLoggerChildWarn.mockReset();
    mockLoggerChildInfo.mockReset();
    mockLoggerChildError.mockReset();
    mockSettingsGetAll.mockReturnValue({
      // 14-04: scan_root / min_size_mb / extensions / max_depth retired from
      // settings; mock now seeds only keys the route still reads
      // (auto_enqueue_after_scan + encoder).
    });
    mockRunScan.mockResolvedValue({
      rootPath: tmpdir,
      filesScanned: 3,
      filesAdded: 3,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesFailed: 0,
      durationMs: 42,
      startedAt: 1700000000,
      finishedAt: 1700000000,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_POST_when_default_body_then_returns_200_with_scan_result_requestId_effectiveFilters', async () => {
    const response = await POST(jsonReq({}));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.filesScanned).toBe(3);
    expect(body.requestId).toMatch(UUID_V4);
    expect(body.effectiveFilters).toEqual({
      resolvedRootPath: tmpdir,
      extensions: ['mp4', 'mkv'],
      minSizeMb: 1,
      maxDepth: 12,
    });
    expect(mockRunScan).toHaveBeenCalledOnce();
    const passedOpts = mockRunScan.mock.calls[0][0];
    expect(passedOpts.rootPath).toBe(tmpdir);
  });

  it('test_POST_when_body_overrides_then_orchestrator_called_with_overrides', async () => {
    const subdir = path.join(tmpdir, 'sub');
    fs.mkdirSync(subdir);
    const response = await POST(jsonReq({ rootPath: subdir, minSizeMb: 5, extensions: ['mp4'] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.effectiveFilters).toEqual({
      resolvedRootPath: subdir,
      extensions: ['mp4'],
      minSizeMb: 5,
      maxDepth: 12,
    });
  });

  // audit-added M5: 415 on wrong Content-Type, no scan started
  it('test_POST_when_content_type_text_plain_then_returns_415_no_scan_started', async () => {
    const response = await POST(
      new Request('http://localhost/api/scan', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      }),
    );
    expect(response.status).toBe(415);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.error).toBe('unsupported_media_type');
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockRunScan).not.toHaveBeenCalled();
  });

  it('test_POST_when_content_type_missing_then_returns_415', async () => {
    const response = await POST(
      new Request('http://localhost/api/scan', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(response.status).toBe(415);
  });

  it('test_POST_when_body_invalid_json_then_returns_400', async () => {
    const response = await POST(jsonReq('not valid json {'));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.error).toBe('invalid_body');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_POST_when_body_schema_violates_then_returns_400_with_details', async () => {
    const response = await POST(jsonReq({ minSizeMb: -1 }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_body');
    expect(body.details).toBeDefined();
  });

  it('test_POST_when_body_has_unknown_field_then_returns_400_strict', async () => {
    const response = await POST(jsonReq({ unknownField: 'x' }));
    expect(response.status).toBe(400);
  });

  // audit-added M3: path-traversal guard via path.resolve
  it('test_POST_when_rootPath_uses_dot_dot_to_escape_scope_then_returns_400', async () => {
    const escaping = path.join(tmpdir, '..', 'etc');
    const response = await POST(jsonReq({ rootPath: escaping }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('root_outside_scope');
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockRunScan).not.toHaveBeenCalled();
  });

  it('test_POST_when_rootPath_not_absolute_then_returns_400', async () => {
    const response = await POST(jsonReq({ rootPath: 'relative/path' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('root_outside_scope');
  });

  it('test_POST_when_rootPath_inside_scope_after_dot_dot_resolution_then_passes', async () => {
    // tmpdir/sub/../sub2 → tmpdir/sub2 (still inside scope after resolve)
    fs.mkdirSync(path.join(tmpdir, 'sub2'));
    const traversed = path.join(tmpdir, 'sub', '..', 'sub2');
    const response = await POST(jsonReq({ rootPath: traversed }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.effectiveFilters.resolvedRootPath).toBe(path.join(tmpdir, 'sub2'));
  });

  it('test_POST_when_rootPath_does_not_exist_then_returns_404', async () => {
    const missing = path.join(tmpdir, 'does-not-exist');
    const response = await POST(jsonReq({ rootPath: missing }));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.error).toBe('root_not_found');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_POST_when_rootPath_is_a_file_then_returns_422', async () => {
    const file = path.join(tmpdir, 'notadir.txt');
    fs.writeFileSync(file, 'x');
    const response = await POST(jsonReq({ rootPath: file }));
    expect(response.status).toBe(422);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.error).toBe('root_not_directory');
  });

  // audit-added M4: single-flight gate returns 409 for concurrent calls
  it('test_POST_when_called_twice_concurrently_then_second_returns_409', async () => {
    let resolveFirst: (
      value: ReturnType<typeof mockRunScan> extends Promise<infer T> ? T : never,
    ) => void = () => {};
    const slowResolve = new Promise((resolve) => {
      resolveFirst = resolve as typeof resolveFirst;
    });
    mockRunScan.mockImplementationOnce(() => slowResolve);

    const promise1 = POST(jsonReq({}));
    // Yield so the first POST progresses past the gate-set
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const response2 = await POST(jsonReq({}));
    expect(response2.status).toBe(409);
    const body2 = await response2.json();
    expect(body2.error).toBe('scan_in_progress');
    expect(body2.requestId).toMatch(UUID_V4);

    // Resolve the first scan
    resolveFirst({
      rootPath: tmpdir,
      filesScanned: 0,
      filesAdded: 0,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesFailed: 0,
      durationMs: 1,
      startedAt: 1700000000,
      finishedAt: 1700000000,
    });
    const response1 = await promise1;
    expect(response1.status).toBe(200);

    // Gate cleared — third call succeeds
    const response3 = await POST(jsonReq({}));
    expect(response3.status).toBe(200);
  });

  it('test_POST_when_orchestrator_throws_then_returns_500_with_requestId', async () => {
    mockRunScan.mockRejectedValueOnce(new Error('boom'));
    const response = await POST(jsonReq({}));
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
  });

  // S7: each call gets a fresh requestId
  it('test_POST_when_called_multiple_times_then_each_response_has_unique_requestId', async () => {
    const r1 = await (await POST(jsonReq({}))).json();
    const r2 = await (await POST(jsonReq({}))).json();
    expect(r1.requestId).not.toBe(r2.requestId);
    expect(r1.requestId).toMatch(UUID_V4);
    expect(r2.requestId).toMatch(UUID_V4);
  });

  // 02-04 follow-up: auto-enqueue setting
  it('test_POST_when_auto_enqueue_disabled_then_no_enqueue_called', async () => {
    mockSettingsGetAll.mockReturnValue({
      // 14-04: scan_root / min_size_mb / extensions / max_depth no longer
      // read from settings (sourced from shareRepo). Remaining keys preserved.
      auto_enqueue_after_scan: 'false',
    });
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(200);
    expect(mockEnqueue).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.autoEnqueued).toBe(0);
  });

  it('test_POST_when_auto_enqueue_enabled_then_enqueues_each_pending_file', async () => {
    mockSettingsGetAll.mockReturnValue({
      // 14-04: scan_root / min_size_mb / extensions / max_depth no longer
      // read from settings (sourced from shareRepo). Remaining keys preserved.
      auto_enqueue_after_scan: 'true',
    });
    mockListPaginated.mockReturnValue({
      rows: [
        { id: 1, version: 0, status: 'pending' },
        { id: 2, version: 0, status: 'pending' },
        { id: 3, version: 0, status: 'pending' },
      ],
      total: 3,
    });
    mockEnqueue.mockReturnValue({ id: 99 });

    const res = await POST(jsonReq({}));
    expect(res.status).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledTimes(3);
    // 03-01 audit M4 downstream: auto-enqueue reads settings.encoder for enqueue
    // INTENT (default 'auto' when unset). Orchestrator overwrites with the
    // RESOLVED encoder via JobRepo.setEncoder before any spawn.
    // 05-08 B4: 4th arg crf=null — orchestrator dispatch resolves crf before spawn.
    expect(mockEnqueue).toHaveBeenNthCalledWith(1, 1, 'auto', 0, null);
    expect(mockEnqueue).toHaveBeenNthCalledWith(2, 2, 'auto', 0, null);
    expect(mockEnqueue).toHaveBeenNthCalledWith(3, 3, 'auto', 0, null);
    const body = await res.json();
    expect(body.autoEnqueued).toBe(3);
  });

  it('test_POST_when_auto_enqueue_enabled_then_emits_queue_updated_after_enqueues', async () => {
    mockSettingsGetAll.mockReturnValue({
      // 14-04: scan_root / min_size_mb / extensions / max_depth no longer
      // read from settings (sourced from shareRepo). Remaining keys preserved.
      auto_enqueue_after_scan: 'true',
    });
    mockListPaginated.mockReturnValue({
      rows: [{ id: 1, version: 0, status: 'pending' }],
      total: 1,
    });
    mockEnqueue.mockReturnValue({ id: 50 });
    mockListActive.mockReturnValue([]);
    mockCountByStatus.mockReturnValue(1);

    await POST(jsonReq({}));
    expect(mockEmit).toHaveBeenCalledWith({
      type: 'queue.updated',
      activeJobs: 0,
      pendingJobs: 1,
      paused: false,
    });
  });

  it('test_POST_when_enqueue_throws_for_one_file_then_other_files_still_enqueue', async () => {
    mockSettingsGetAll.mockReturnValue({
      // 14-04: scan_root / min_size_mb / extensions / max_depth no longer
      // read from settings (sourced from shareRepo). Remaining keys preserved.
      auto_enqueue_after_scan: 'true',
    });
    mockListPaginated.mockReturnValue({
      rows: [
        { id: 1, version: 0, status: 'pending' },
        { id: 2, version: 0, status: 'pending' },
      ],
      total: 2,
    });
    mockEnqueue
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockReturnValueOnce({ id: 7 });

    const res = await POST(jsonReq({}));
    const body = await res.json();
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
    expect(body.autoEnqueued).toBe(1);
  });

  // 14-02: multi-share response + audit-trail coverage
  it('test_scan_response_when_orchestrator_returns_byShare_then_passes_through', async () => {
    mockRunScan.mockResolvedValueOnce({
      rootPath: tmpdir,
      filesScanned: 1,
      filesAdded: 1,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesFailed: 0,
      filesVanished: 0,
      byShare: [
        {
          shareId: 1,
          name: 'x',
          rootPath: '/x',
          filesScanned: 1,
          filesAdded: 1,
          filesUpdated: 0,
          filesUnchanged: 0,
          filesFailed: 0,
        },
      ],
      durationMs: 12,
      startedAt: 1700000000,
      finishedAt: 1700000000,
    });
    const res = await POST(jsonReq({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.byShare).toEqual([
      {
        shareId: 1,
        name: 'x',
        rootPath: '/x',
        filesScanned: 1,
        filesAdded: 1,
        filesUpdated: 0,
        filesUnchanged: 0,
        filesFailed: 0,
      },
    ]);
  });

  it('test_scan_response_when_orchestrator_omits_byShare_then_field_absent', async () => {
    const res = await POST(jsonReq({}));
    const body = await res.json();
    expect(body.byShare).toBeUndefined();
  });

  it('test_scan_log_payload_when_multi_share_then_byShareCount_included', async () => {
    mockRunScan.mockResolvedValueOnce({
      rootPath: tmpdir,
      filesScanned: 2,
      filesAdded: 2,
      filesUpdated: 0,
      filesUnchanged: 0,
      filesFailed: 0,
      filesVanished: 0,
      byShare: [
        {
          shareId: 1,
          name: 'a',
          rootPath: '/a',
          filesScanned: 1,
          filesAdded: 1,
          filesUpdated: 0,
          filesUnchanged: 0,
          filesFailed: 0,
        },
        {
          shareId: 2,
          name: 'b',
          rootPath: '/b',
          filesScanned: 1,
          filesAdded: 1,
          filesUpdated: 0,
          filesUnchanged: 0,
          filesFailed: 0,
        },
      ],
      durationMs: 12,
      startedAt: 1700000000,
      finishedAt: 1700000000,
    });
    await POST(jsonReq({}));
    const completeCall = mockLoggerChildInfo.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1] === 'scan complete',
    );
    expect(completeCall).toBeDefined();
    expect((completeCall![0] as { byShareCount: number }).byShareCount).toBe(2);
  });

  it('test_scan_path_traversal_guard_preserved_with_shareRepo_nonempty', async () => {
    mockShareRepoListAll.mockReturnValue([{ id: 1 }, { id: 2 }]);
    const escaping = path.join(tmpdir, '..', 'etc');
    const res = await POST(jsonReq({ rootPath: escaping }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('root_outside_scope');
    expect(mockRunScan).not.toHaveBeenCalled();
  });

  it('test_scan_when_body_rootPath_and_shares_nonempty_then_logs_ignored', async () => {
    // 14-04: route reads firstShare.path for scanRoot; needs full ShareRow.
    mockShareRepoListAll.mockReturnValue([
      {
        id: 1,
        name: 'A',
        path: tmpdir,
        min_size_mb: 1,
        extensions_csv: 'mp4,mkv',
        max_depth: 12,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 2,
        name: 'B',
        path: tmpdir + '/_unused2',
        min_size_mb: 1,
        extensions_csv: 'mp4,mkv',
        max_depth: 12,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    const subdir = path.join(tmpdir, 'movies');
    fs.mkdirSync(subdir);
    const res = await POST(jsonReq({ rootPath: subdir }));
    expect(res.status).toBe(200);
    const ignoredCall = mockLoggerChildWarn.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'scan_rootpath_override_ignored',
    );
    expect(ignoredCall).toBeDefined();
    expect((ignoredCall![0] as { body_rootPath: string }).body_rootPath).toBe(subdir);
    expect((ignoredCall![0] as { shareCount: number }).shareCount).toBe(2);
    expect((ignoredCall![0] as { mode: string }).mode).toBe('multi-share');
  });

  it('test_scan_when_empty_shares_then_orchestrator_fallback_log_observable', async () => {
    // mockRunScan invokes the passed log.info to emit scan_empty_shares_fallback,
    // exercising the SR3 correlation chain end-to-end (route → orchestrator).
    mockRunScan.mockImplementationOnce(async (_opts, _repo, log) => {
      log.info(
        { action: 'scan_empty_shares_fallback', rootPath: tmpdir },
        'shares-table empty — falling back to opts.rootPath',
      );
      return {
        rootPath: tmpdir,
        filesScanned: 0,
        filesAdded: 0,
        filesUpdated: 0,
        filesUnchanged: 0,
        filesFailed: 0,
        filesVanished: 0,
        durationMs: 1,
        startedAt: 1700000000,
        finishedAt: 1700000000,
      };
    });
    await POST(jsonReq({}));
    const fallbackCall = mockLoggerChildInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'scan_empty_shares_fallback',
    );
    expect(fallbackCall).toBeDefined();
  });
});
