// 32-01 T1 tests — POST /api/library/bulk-encode.
// Mirrors tests/api/library-bulk-retry structure but for the ENQUEUE path.
// SR-2: per-id atomic enqueue (no SAVEPOINT) — assert good jobs persist after a bad id.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FileRow, JobRow } from '@/src/lib/db/schema';

const mocks = vi.hoisted(() => ({
  mockFileGetById: vi.fn(),
  mockJobEnqueue: vi.fn(),
  mockJobListActive: vi.fn(),
  mockJobCountByStatus: vi.fn(),
  mockBlocklistMatch: vi.fn(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockEngineEmit: vi.fn(),
  mockGateAuth: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({ getById: mocks.mockFileGetById }),
  jobRepo: () => ({
    enqueue: mocks.mockJobEnqueue,
    listActive: mocks.mockJobListActive,
    countByStatus: mocks.mockJobCountByStatus,
  }),
  blocklistRepo: () => ({ matchByFileIdOrPath: mocks.mockBlocklistMatch }),
  default: {},
}));

vi.mock('@/src/lib/encode/events', () => ({
  engineEvents: { emit: mocks.mockEngineEmit },
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mocks.mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mocks.mockLoggerInfo,
      warn: mocks.mockLoggerWarn,
      error: mocks.mockLoggerError,
    }),
  },
  default: {},
}));

vi.mock('@/src/lib/api/auth-gate', () => ({
  gateAuth: mocks.mockGateAuth,
}));

// requireNotBlocklisted is NOT mocked — exercise the real guard against the
// mocked blocklistRepo.matchByFileIdOrPath (SR-1 fidelity).

import { POST, runtime } from '@/app/api/library/bulk-encode/route';

const ROUTE_URL = 'http://test/api/library/bulk-encode';

function makeRequest(body?: unknown, headers?: Record<string, string>): Request {
  return new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

function makeJob(id: number, file_id: number): JobRow {
  return {
    id,
    file_id,
    status: 'queued',
    encoder: 'libx265',
    retry_count: 0,
    crf: null,
    preset_used: null,
    force_container: null,
    created_at: 1700000000,
    updated_at: 1700000000,
    claimed_at: null,
    completed_at: null,
    failure_reason: null,
    stderr_excerpt: null,
    input_path: null,
    output_path: null,
    output_size_bytes: null,
    input_size_bytes: null,
    ffmpeg_version: null,
    encode_duration_ms: null,
    worker_id: null,
    queue_position: 1,
  } as unknown as JobRow;
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  // Default: auth allowed (authenticated actor).
  mocks.mockGateAuth.mockResolvedValue({
    denied: undefined,
    auth: { ok: true, mode: 'authenticated', username: 'tester' },
  });
  // Default: not blocklisted, enqueue succeeds, counts available.
  mocks.mockBlocklistMatch.mockReturnValue(undefined);
  mocks.mockJobEnqueue.mockImplementation((fileId: number) => makeJob(100 + fileId, fileId));
  mocks.mockJobListActive.mockReturnValue([]);
  mocks.mockJobCountByStatus.mockReturnValue(0);
});

describe('POST /api/library/bulk-encode', () => {
  it('runtime is nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('AC-1 happy path — 5 eligible IDs all enqueue → 200 successCount=5, one emit', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => ({ ...baseFile, id }));
    const res = await POST(makeRequest({ ids: [1, 2, 3, 4, 5] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.successCount).toBe(5);
    expect(json.failed).toEqual([]);
    expect(mocks.mockJobEnqueue).toHaveBeenCalledTimes(5);
    // crf=null, encoder='libx265', expectedFileVersion=file.version
    expect(mocks.mockJobEnqueue).toHaveBeenCalledWith(1, 'libx265', 0, null);
    // Exactly one queue.updated emit AFTER the loop.
    expect(mocks.mockEngineEmit).toHaveBeenCalledTimes(1);
    expect(mocks.mockEngineEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'queue.updated', paused: false }),
    );
    expect(mocks.mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ audit: 'bulk_library_encode', successCount: 5 }),
      'bulk_library_encode',
    );
  });

  it('AC-2 partial — not_found + not_eligible + blocklisted + already_queued + success', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => {
      if (id === 1) return undefined; // not_found
      if (id === 2) return { ...baseFile, id: 2, status: 'done-smaller' }; // not_eligible
      if (id === 3) return { ...baseFile, id: 3, status: 'pending', path: '/movies/Samples/c.mkv' }; // blocklisted
      if (id === 4) return { ...baseFile, id: 4, status: 'pending' }; // already_queued (enqueue null, version same)
      if (id === 5) return { ...baseFile, id: 5, status: 'pending' }; // success
      return undefined;
    });
    mocks.mockBlocklistMatch.mockImplementation((fileId: number) => fileId === 3);
    mocks.mockJobEnqueue.mockImplementation((fileId: number) =>
      fileId === 4 ? null : makeJob(100 + fileId, fileId),
    );
    const res = await POST(makeRequest({ ids: [1, 2, 3, 4, 5] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.successCount).toBe(1);
    const reasonsById = new Map((json.failed as FailedEntryShape[]).map((f) => [f.id, f.reason]));
    expect(reasonsById.get(1)).toBe('not_found');
    expect(reasonsById.get(2)).toBe('not_eligible');
    expect(reasonsById.get(3)).toBe('blocklisted');
    expect(reasonsById.get(4)).toBe('already_queued');
    // Only id=5 enqueued successfully.
    expect(mocks.mockJobEnqueue).toHaveBeenCalledWith(5, 'libx265', 0, null);
  });

  it('AC-2 version_conflict — enqueue null + version changed since read', async () => {
    let call = 0;
    mocks.mockFileGetById.mockImplementation((id: number) => {
      if (id !== 9) return { ...baseFile, id, status: 'pending' };
      // First read version 0, re-read version 1 (changed since selection).
      call += 1;
      return { ...baseFile, id: 9, status: 'pending', version: call === 1 ? 0 : 1 };
    });
    mocks.mockJobEnqueue.mockReturnValue(null);
    const res = await POST(makeRequest({ ids: [9] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.successCount).toBe(0);
    expect(json.failed).toEqual([{ id: 9, reason: 'version_conflict' }]);
  });

  it('AC-1 no emit when zero succeed (all failed)', async () => {
    mocks.mockFileGetById.mockReturnValue(undefined);
    const res = await POST(makeRequest({ ids: [1, 2] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.successCount).toBe(0);
    expect(mocks.mockEngineEmit).not.toHaveBeenCalled();
  });

  it('AC-3 415 on wrong Content-Type', async () => {
    const req = new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ids: [1] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(415);
  });

  it('AC-3 400 on empty ids', async () => {
    const res = await POST(makeRequest({ ids: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
  });

  it('AC-3 400 on > 500 ids', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    const res = await POST(makeRequest({ ids }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
  });

  it('AC-3 400 on duplicate ids', async () => {
    const res = await POST(makeRequest({ ids: [1, 1, 2] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_body');
  });

  it('AC-3 401-deny when gateAuth denies', async () => {
    mocks.mockGateAuth.mockResolvedValue({
      denied: new Response('unauthorized', { status: 401 }),
      auth: { ok: false },
    });
    const res = await POST(makeRequest({ ids: [1] }));
    expect(res.status).toBe(401);
    expect(mocks.mockJobEnqueue).not.toHaveBeenCalled();
  });

  it('AC-3 build-time skip', async () => {
    const prev = process.env.NEXT_PHASE;
    process.env.NEXT_PHASE = 'phase-production-build';
    try {
      const res = await POST(makeRequest({ ids: [1] }));
      expect(res.status).toBe(200);
      expect((await res.json()).reason).toBe('build-time-skip');
    } finally {
      process.env.NEXT_PHASE = prev;
    }
  });

  it('SR-2 per-id isolation — internal_error on one id does NOT drop already-enqueued good ids', async () => {
    mocks.mockFileGetById.mockImplementation((id: number) => ({
      ...baseFile,
      id,
      status: 'pending',
    }));
    mocks.mockJobEnqueue.mockImplementation((fileId: number) => {
      if (fileId === 2) throw new Error('boom'); // unexpected per-id throw
      return makeJob(100 + fileId, fileId);
    });
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.successCount).toBe(2); // ids 1 and 3 persist
    expect(json.failed).toEqual([{ id: 2, reason: 'internal_error' }]);
    // Good ids were enqueued and survive the bad id (no SAVEPOINT rollback).
    expect(mocks.mockJobEnqueue).toHaveBeenCalledWith(1, 'libx265', 0, null);
    expect(mocks.mockJobEnqueue).toHaveBeenCalledWith(3, 'libx265', 0, null);
    expect(mocks.mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'bulk-encode per-id internal_error',
    );
  });
});

type FailedEntryShape = { id: number; reason: string };
