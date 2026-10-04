// 10-03 E-D5: POST /api/library/[id]/retry — forceContainer path.
// Mirrors library-retry.test.ts mock structure; extends with mockJobEnqueue.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FileRow, JobRow } from '@/src/lib/db/schema';

const {
  mockFileGetById,
  mockFileSetStatus,
  mockJobFindByFileId,
  mockJobMarkCancelled,
  mockJobEnqueue,
  mockEnsureServerInit,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
  mockBlocklistMatchByFileIdOrPath,
} = vi.hoisted(() => ({
  mockFileGetById: vi.fn(),
  mockFileSetStatus: vi.fn(),
  mockJobFindByFileId: vi.fn(),
  mockJobMarkCancelled: vi.fn(),
  mockJobEnqueue: vi.fn(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockBlocklistMatchByFileIdOrPath: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({
    getById: mockFileGetById,
    setStatus: mockFileSetStatus,
  }),
  jobRepo: () => ({
    findByFileId: mockJobFindByFileId,
    markCancelled: mockJobMarkCancelled,
    enqueue: mockJobEnqueue,
  }),
  blocklistRepo: () => ({
    matchByFileIdOrPath: mockBlocklistMatchByFileIdOrPath,
  }),
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
    }),
  },
  default: {},
}));

import { POST } from '@/app/api/library/[id]/retry/route';

const ROUTE_URL = 'http://test/api/library/1/retry';

function makeRequest(body?: string, headers?: Record<string, string>): Request {
  return new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

const baseFile: FileRow = {
  id: 1,
  path: '/movies/A.mkv',
  size_bytes: 1024,
  mtime: 1_700_000_000,
  content_hash: 'a'.repeat(64),
  codec: 'hevc',
  bitrate: 1_000_000,
  duration_seconds: 60,
  width: 1920,
  height: 1080,
  container: 'matroska',
  status: 'done-larger',
  last_scanned_at: 1_700_000_000,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  version: 3,
  container_override: null,
  share_id: null,
};

const enqueuedJob: JobRow = {
  id: 42,
  file_id: 1,
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
  created_at: 1_700_000_100,
  force_container: 'mp4',
};

beforeEach(() => {
  mockFileGetById.mockReset();
  mockFileSetStatus.mockReset().mockReturnValue(true);
  mockJobFindByFileId.mockReset().mockReturnValue(undefined);
  mockJobMarkCancelled.mockReset();
  mockJobEnqueue.mockReset().mockReturnValue(enqueuedJob);
  mockEnsureServerInit.mockReset();
  mockLoggerInfo.mockReset();
  mockLoggerWarn.mockReset();
  mockLoggerError.mockReset();
  mockBlocklistMatchByFileIdOrPath.mockReset().mockReturnValue(false);
  delete process.env.NEXT_PHASE;
});

describe('POST /api/library/[id]/retry — 10-03 E-D5 forceContainer path', () => {
  it('test_POST_when_forceContainer_mp4_then_200_enqueue_called_with_mp4_and_response_has_forceContainer', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    const res = await POST(makeRequest(JSON.stringify({ forceContainer: 'mp4' })), ctx('1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.forceContainer).toBe('mp4');
    expect(body.newStatus).toBe('queued');
    expect(body.jobId).toBe(42);
    expect(body.previousStatus).toBe('done-larger');
    expect(mockJobEnqueue).toHaveBeenCalledWith(1, 'libx265', 3, null, 'mp4');
    expect(mockFileSetStatus).not.toHaveBeenCalled();
  });

  it('test_POST_when_forceContainer_mkv_then_200_enqueue_called_with_mkv', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockJobEnqueue.mockReturnValue({ ...enqueuedJob, force_container: 'mkv' });
    const res = await POST(makeRequest(JSON.stringify({ forceContainer: 'mkv' })), ctx('1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.forceContainer).toBe('mkv');
    expect(mockJobEnqueue).toHaveBeenCalledWith(1, 'libx265', 3, null, 'mkv');
  });

  it('test_POST_when_no_body_then_standard_retry_setStatus_pending_no_enqueue', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.newStatus).toBe('pending');
    expect(body.forceContainer).toBeUndefined();
    expect(mockJobEnqueue).not.toHaveBeenCalled();
    expect(mockFileSetStatus).toHaveBeenCalledWith(1, 'pending', 3);
  });

  it('test_POST_when_forceContainer_invalid_value_then_400_unexpected_body', async () => {
    const res = await POST(makeRequest(JSON.stringify({ forceContainer: 'avi' })), ctx('1'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unexpected_body');
    expect(mockJobEnqueue).not.toHaveBeenCalled();
  });

  it('test_POST_when_forceContainer_and_enqueue_returns_null_then_409_state_changed', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockJobEnqueue.mockReturnValue(null);
    // Second getById for freshness check — return same version (no OCC conflict)
    mockFileGetById.mockReturnValueOnce(baseFile).mockReturnValueOnce({ ...baseFile, version: 99 });
    const res = await POST(makeRequest(JSON.stringify({ forceContainer: 'mp4' })), ctx('1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('state_changed');
  });

  it('test_POST_when_forceContainer_and_pino_info_action_library_retry_force_container_requested', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    await POST(makeRequest(JSON.stringify({ forceContainer: 'mp4' })), ctx('1'));
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'library_retry_force_container_requested',
        fileId: 1,
        jobId: 42,
        forceContainer: 'mp4',
        previousStatus: 'done-larger',
      }),
      expect.any(String),
    );
  });

  it('test_POST_when_forceContainer_and_active_job_present_then_markCancelled_before_enqueue', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockJobFindByFileId.mockReturnValue({ id: 77, status: 'encoding' });
    await POST(makeRequest(JSON.stringify({ forceContainer: 'mp4' })), ctx('1'));
    expect(mockJobMarkCancelled).toHaveBeenCalledWith(77);
    expect(mockJobEnqueue).toHaveBeenCalled();
  });
});
