import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FileRow, JobRow, FileStatus } from '@/src/lib/db/schema';

const {
  mockGetById,
  mockEnqueue,
  mockListActive,
  mockListRecent,
  mockCountByStatus,
  mockEngineEventsEmit,
  mockEnsureServerInit,
  mockBlocklistMatchByFileIdOrPath,
} = vi.hoisted(() => ({
  mockGetById: vi.fn<(id: number) => FileRow | undefined>(),
  mockEnqueue:
    vi.fn<
      (
        file_id: number,
        encoder: string,
        expectedFileVersion: number,
        crf: number | null,
      ) => JobRow | null
    >(),
  mockListActive: vi.fn<() => JobRow[]>(),
  mockListRecent: vi.fn<(limit: number) => JobRow[]>(),
  mockCountByStatus: vi.fn<(status: string) => number>(),
  mockEngineEventsEmit: vi.fn(),
  mockEnsureServerInit: vi.fn(),
  mockBlocklistMatchByFileIdOrPath: vi.fn<(fileId: number | null, filePath: string) => boolean>(),
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({ getById: mockGetById }),
  jobRepo: () => ({
    enqueue: mockEnqueue,
    listActive: mockListActive,
    listRecent: mockListRecent,
    countByStatus: mockCountByStatus,
  }),
  blocklistRepo: () => ({
    matchByFileIdOrPath: mockBlocklistMatchByFileIdOrPath,
  }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/encode/events', () => ({
  engineEvents: { emit: mockEngineEventsEmit, subscribe: vi.fn() },
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

import { POST, GET, runtime } from '@/app/api/queue/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function jsonReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/queue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function fileFixture(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: 42,
    path: '/media/foo.mp4',
    size_bytes: 1000,
    mtime: 1700000000,
    content_hash: 'abc123',
    codec: 'h264',
    bitrate: 5000000,
    duration_seconds: 600,
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
    ...overrides,
  };
}

function jobFixture(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 1,
    file_id: 42,
    status: 'queued',
    started_at: null,
    finished_at: null,
    encoder: 'libx265',
    crf: null,
    queue_position: 0,
    bytes_in: null,
    bytes_out: null,
    duration_ms: null,
    exit_code: null,
    error_msg: null,
    log_tail: null,
    created_at: 1700000000,
    ...overrides,
  };
}

describe('POST /api/queue', () => {
  beforeEach(() => {
    mockGetById.mockReset();
    mockEnqueue.mockReset();
    mockListActive.mockReset();
    mockListRecent.mockReset();
    mockCountByStatus.mockReset();
    mockEngineEventsEmit.mockReset();
    mockEnsureServerInit.mockReset();
    mockBlocklistMatchByFileIdOrPath.mockReset().mockReturnValue(false);
    mockListActive.mockReturnValue([]);
    mockListRecent.mockReturnValue([]);
    mockCountByStatus.mockReturnValue(0);
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_POST_when_valid_fileId_then_201_with_full_JobRow_and_emits_queue_updated', async () => {
    const file = fileFixture();
    const job = jobFixture();
    mockGetById.mockReturnValue(file);
    mockEnqueue.mockReturnValue(job);
    mockListActive.mockReturnValue([job]);
    mockCountByStatus.mockReturnValue(1);

    const response = await POST(jsonReq({ fileId: 42 }));

    expect(mockEnsureServerInit).toHaveBeenCalledOnce();
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    const body = await response.json();
    expect(body.requestId).toMatch(UUID_V4);
    // audit-added S7: full JobRow returned, not thin {jobId,fileId,status}
    expect(body.job).toEqual(job);
    // 05-08 B4: enqueue receives crf=null (orchestrator dispatch resolves it).
    expect(mockEnqueue).toHaveBeenCalledWith(42, 'libx265', 0, null);
    // audit-added M3: queue.updated emit BEFORE response
    expect(mockEngineEventsEmit).toHaveBeenCalledWith({
      type: 'queue.updated',
      activeJobs: 1,
      pendingJobs: 1,
      paused: false,
    });
  });

  it('test_POST_when_no_body_then_400_invalid_body', async () => {
    const response = await POST(jsonReq({}));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_body');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_POST_when_text_plain_then_415', async () => {
    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'fileId=42',
    });
    const response = await POST(req);
    expect(response.status).toBe(415);
    const body = await response.json();
    expect(body.error).toBe('unsupported_media_type');
  });

  it('test_POST_when_malformed_json_then_400_invalid_body', async () => {
    const req = new Request('http://localhost/api/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.details).toBe('malformed JSON');
  });

  it('test_POST_when_extra_keys_then_400_invalid_body_zod_strict', async () => {
    const response = await POST(jsonReq({ fileId: 42, foo: 'bar' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_body');
  });

  it('test_POST_when_file_not_found_then_404', async () => {
    mockGetById.mockReturnValue(undefined);
    const response = await POST(jsonReq({ fileId: 999 }));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('file_not_found');
    expect(body.fileId).toBe(999);
  });

  it.each([
    'encoding',
    'queued',
    'done-smaller',
    'skipped-codec',
    'blocklisted',
  ] satisfies FileStatus[])(
    'test_POST_when_file_status_%s_then_409_not_eligible_for_encode',
    async (status) => {
      mockGetById.mockReturnValue(fileFixture({ status }));
      const response = await POST(jsonReq({ fileId: 42 }));
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe('not_eligible_for_encode');
      expect(body.currentStatus).toBe(status);
      expect(mockEnqueue).not.toHaveBeenCalled();
    },
  );

  it('test_POST_when_eligible_states_pending_failed_interrupted_done_larger_then_proceeds', async () => {
    const eligibleStates: FileStatus[] = ['pending', 'failed', 'interrupted', 'done-larger'];
    for (const status of eligibleStates) {
      mockEnqueue.mockReset();
      mockEngineEventsEmit.mockReset();
      mockGetById.mockReturnValue(fileFixture({ status }));
      mockEnqueue.mockReturnValue(jobFixture());
      const response = await POST(jsonReq({ fileId: 42 }));
      expect(response.status).toBe(201);
    }
  });

  it('test_POST_when_enqueue_returns_null_and_version_unchanged_then_409_already_queued', async () => {
    const file = fileFixture({ version: 0 });
    mockGetById
      .mockReturnValueOnce(file) // initial eligibility check
      .mockReturnValueOnce(file); // re-read for null disambiguation
    mockEnqueue.mockReturnValue(null);
    const response = await POST(jsonReq({ fileId: 42 }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('already_queued');
  });

  it('test_POST_when_enqueue_returns_null_and_version_changed_then_409_file_version_conflict', async () => {
    const file = fileFixture({ version: 0 });
    const fresh = fileFixture({ version: 5 });
    mockGetById.mockReturnValueOnce(file).mockReturnValueOnce(fresh);
    mockEnqueue.mockReturnValue(null);
    const response = await POST(jsonReq({ fileId: 42, expectedFileVersion: 0 }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('file_version_conflict');
    expect(body.expectedVersion).toBe(0);
    expect(body.currentVersion).toBe(5);
  });

  it('test_POST_when_enqueue_throws_unexpected_then_500_internal_error_with_requestId', async () => {
    mockGetById.mockReturnValue(fileFixture());
    mockEnqueue.mockImplementation(() => {
      throw new Error('boom');
    });
    const response = await POST(jsonReq({ fileId: 42 }));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_POST_when_engineEvents_emit_throws_then_still_returns_201', async () => {
    mockGetById.mockReturnValue(fileFixture());
    mockEnqueue.mockReturnValue(jobFixture());
    mockEngineEventsEmit.mockImplementation(() => {
      throw new Error('listener crashed');
    });
    const response = await POST(jsonReq({ fileId: 42 }));
    expect(response.status).toBe(201); // emit failure does NOT fail the enqueue
  });

  // 13-06 T4-A — Layer-2 encode-path guard for /api/queue.

  it('test_POST_AC1_pattern_blocked_file_returns_409_blocklisted', async () => {
    mockGetById.mockReturnValue(
      fileFixture({ status: 'pending', path: '/movies/Samples/clip.mkv' }),
    );
    mockBlocklistMatchByFileIdOrPath.mockReturnValue(true);
    const response = await POST(jsonReq({ fileId: 42 }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('blocklisted');
    expect(body.currentStatus).toBe('pending');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('test_POST_AC4_file_pinned_blocked_returns_409_blocklisted', async () => {
    // matchByFileIdOrPath returns true for both file-pinned + pattern.
    mockGetById.mockReturnValue(fileFixture({ status: 'pending', path: '/movies/A.mkv' }));
    mockBlocklistMatchByFileIdOrPath.mockReturnValue(true);
    const response = await POST(jsonReq({ fileId: 42 }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('blocklisted');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('test_POST_clean_file_not_blocked_still_enqueues_201_regression', async () => {
    mockGetById.mockReturnValue(fileFixture({ status: 'pending' }));
    mockEnqueue.mockReturnValue(jobFixture());
    mockBlocklistMatchByFileIdOrPath.mockReturnValue(false);
    const response = await POST(jsonReq({ fileId: 42 }));
    expect(response.status).toBe(201);
    expect(mockEnqueue).toHaveBeenCalled();
  });

  it('test_POST_blocklist_non_matching_still_enqueues_201_regression', async () => {
    mockGetById.mockReturnValue(fileFixture({ status: 'pending', path: '/movies/main.mkv' }));
    mockBlocklistMatchByFileIdOrPath.mockReturnValue(false);
    mockEnqueue.mockReturnValue(jobFixture());
    const response = await POST(jsonReq({ fileId: 42 }));
    expect(response.status).toBe(201);
  });
});

describe('GET /api/queue', () => {
  beforeEach(() => {
    mockGetById.mockReset();
    mockListActive.mockReset();
    mockListRecent.mockReset();
    mockCountByStatus.mockReset();
    mockEnsureServerInit.mockReset();
    mockListActive.mockReturnValue([]);
    mockListRecent.mockReturnValue([]);
  });

  function getReq(query = ''): Request {
    return new Request(`http://localhost/api/queue${query}`, { method: 'GET' });
  }

  it('test_GET_when_no_query_then_200_with_active_recent_paused', async () => {
    const j1 = jobFixture({ id: 1, status: 'encoding' });
    const j2 = jobFixture({ id: 2, status: 'queued' });
    mockListActive.mockReturnValue([j1, j2]);
    mockListRecent.mockReturnValue([j1, j2]);

    const response = await GET(getReq());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.active).toEqual([j1, j2]);
    expect(body.recent).toEqual([j1, j2]);
    expect(body.paused).toBe(false);
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockListRecent).toHaveBeenCalledWith(50);
  });

  it('test_GET_when_recentLimit_99999_then_400_or_clamped', async () => {
    const response = await GET(getReq('?recentLimit=99999'));
    // zod max(500) → 400 invalid_query (preferred to silent clamp)
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_query');
  });

  // 05-09 Decision §2/§3: paused permanently false on the GET response.
  it('test_GET_when_called_then_paused_field_is_always_literal_false', async () => {
    const response = await GET(getReq());
    const body = await response.json();
    expect(body.paused).toBe(false);
  });
});
