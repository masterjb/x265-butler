import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FileRow, JobRow } from '@/src/lib/db/schema';

const {
  mockFileGetById,
  mockFileSetStatus,
  mockJobFindByFileId,
  mockJobMarkCancelled,
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

import { POST, runtime } from '@/app/api/library/[id]/retry/route';

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
  path: '/movies/A.x265.mkv',
  size_bytes: 1024,
  mtime: 1700000000,
  content_hash: 'a'.repeat(64),
  codec: 'hevc',
  bitrate: 1000000,
  duration_seconds: 60,
  width: 1920,
  height: 1080,
  container: 'matroska',
  status: 'failed',
  last_scanned_at: 1700000000,
  created_at: 1700000000,
  updated_at: 1700000000,
  version: 7,
  container_override: null,
  share_id: null,
};

const baseJob: JobRow = {
  id: 99,
  file_id: 1,
  status: 'queued',
  started_at: null,
  finished_at: null,
  encoder: null,
  crf: null,
  queue_position: 0,
  bytes_in: null,
  bytes_out: null,
  duration_ms: null,
  exit_code: null,
  error_msg: null,
  log_tail: null,
  created_at: 1700000000,
};

beforeEach(() => {
  mockFileGetById.mockReset();
  mockFileSetStatus.mockReset().mockReturnValue(true);
  mockJobFindByFileId.mockReset();
  mockJobMarkCancelled.mockReset();
  mockEnsureServerInit.mockReset();
  mockLoggerInfo.mockReset();
  mockLoggerWarn.mockReset();
  mockLoggerError.mockReset();
  mockBlocklistMatchByFileIdOrPath.mockReset().mockReturnValue(false);
  delete process.env.NEXT_PHASE;
});

describe('POST /api/library/[id]/retry', () => {
  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_POST_when_status_failed_then_setStatus_pending_AND_returns_200', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockJobFindByFileId.mockReturnValue(undefined);
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fileId).toBe(1);
    expect(body.previousStatus).toBe('failed');
    expect(body.newStatus).toBe('pending');
    expect(body.requestId).toBeTypeOf('string');
    expect(mockFileSetStatus).toHaveBeenCalledWith(1, 'pending', 7);
  });

  it('test_POST_when_status_interrupted_then_setStatus_pending_AND_returns_200', async () => {
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'interrupted' });
    mockJobFindByFileId.mockReturnValue(undefined);
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.previousStatus).toBe('interrupted');
    expect(mockFileSetStatus).toHaveBeenCalledWith(1, 'pending', 7);
  });

  it('test_POST_when_status_done_larger_then_setStatus_pending_AND_returns_200', async () => {
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'done-larger' });
    mockJobFindByFileId.mockReturnValue(undefined);
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.previousStatus).toBe('done-larger');
  });

  it('test_POST_when_active_job_present_then_markCancelled_called', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockJobFindByFileId.mockReturnValue({ ...baseJob, status: 'encoding' });
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(200);
    expect(mockJobMarkCancelled).toHaveBeenCalledWith(99);
  });

  it('test_POST_when_inactive_job_present_then_markCancelled_NOT_called', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockJobFindByFileId.mockReturnValue({ ...baseJob, status: 'done' });
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(200);
    expect(mockJobMarkCancelled).not.toHaveBeenCalled();
  });

  it('test_POST_when_status_done_smaller_then_409_not_eligible_AND_NO_setStatus', async () => {
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'done-smaller' });
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('not_eligible');
    expect(body.currentStatus).toBe('done-smaller');
    expect(mockFileSetStatus).not.toHaveBeenCalled();
    expect(mockJobMarkCancelled).not.toHaveBeenCalled();
  });

  it('test_POST_when_status_blocklisted_then_409_not_eligible', async () => {
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'blocklisted' });
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('not_eligible');
    expect(body.currentStatus).toBe('blocklisted');
  });

  it('test_POST_when_status_pending_then_409_not_eligible', async () => {
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'pending' });
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('not_eligible');
  });

  it('test_POST_when_status_skipped_codec_then_409_not_eligible', async () => {
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'skipped-codec' });
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(409);
  });

  it('test_POST_when_file_not_found_then_404', async () => {
    mockFileGetById.mockReturnValue(undefined);
    const res = await POST(makeRequest(), ctx('999'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('file_not_found');
  });

  it('test_POST_when_invalid_id_then_400', async () => {
    const res = await POST(makeRequest(), ctx('abc'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_file_id');
  });

  // audit S4: state_changed error code on OCC stale
  it('test_POST_when_setStatus_returns_false_then_409_state_changed', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockJobFindByFileId.mockReturnValue(undefined);
    mockFileSetStatus.mockReturnValue(false);
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('state_changed');
    expect(body.currentStatus).toBe('failed');
  });

  it('test_POST_when_NEXT_PHASE_phase_production_build_then_short_circuits', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(mockFileSetStatus).not.toHaveBeenCalled();
  });

  it('test_POST_when_called_then_cache_control_no_store', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockJobFindByFileId.mockReturnValue(undefined);
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('test_POST_when_called_then_pino_info_action_file_retry_initiated_with_previousStatus', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockJobFindByFileId.mockReturnValue(undefined);
    await POST(makeRequest(), ctx('1'));
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'file_retry_initiated',
        fileId: 1,
        previousStatus: 'failed',
      }),
      expect.any(String),
    );
  });

  it('test_POST_when_409_response_then_NO_pino_info_fires', async () => {
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'done-smaller' });
    await POST(makeRequest(), ctx('1'));
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  // audit S1: strict empty-body
  it('test_POST_when_non_empty_body_then_400_unexpected_body_AND_pino_warn', async () => {
    const res = await POST(makeRequest('{"foo":"bar"}'), ctx('1'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unexpected_body');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'retry_unexpected_body' }),
      expect.any(String),
    );
    expect(mockFileSetStatus).not.toHaveBeenCalled();
  });

  it('test_POST_when_empty_object_body_then_proceeds_normally', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockJobFindByFileId.mockReturnValue(undefined);
    const res = await POST(makeRequest('{}'), ctx('1'));
    expect(res.status).toBe(200);
  });

  it('test_POST_when_whitespace_only_body_then_proceeds_normally', async () => {
    mockFileGetById.mockReturnValue(baseFile);
    mockJobFindByFileId.mockReturnValue(undefined);
    const res = await POST(makeRequest('   \n\t '), ctx('1'));
    expect(res.status).toBe(200);
  });

  it('test_POST_when_internal_error_then_500_internal_error', async () => {
    mockFileGetById.mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(mockLoggerError).toHaveBeenCalled();
  });

  // 13-06 T4-B — Layer-2 encode-path guard for /api/library/[id]/retry.

  it('test_POST_AC2_pattern_blocked_file_returns_409_blocklisted', async () => {
    mockFileGetById.mockReturnValue({
      ...baseFile,
      status: 'failed',
      path: '/extras/promo.mkv',
    });
    mockBlocklistMatchByFileIdOrPath.mockReturnValue(true);
    const res = await POST(makeRequest(), ctx('99'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('blocklisted');
    expect(body.currentStatus).toBe('failed');
    expect(mockFileSetStatus).not.toHaveBeenCalled();
    expect(mockJobMarkCancelled).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'retry_blocked_by_blocklist' }),
      expect.any(String),
    );
  });

  it('test_POST_AC4_file_pinned_blocked_returns_409_blocklisted', async () => {
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'failed' });
    mockBlocklistMatchByFileIdOrPath.mockReturnValue(true);
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('blocklisted');
    expect(mockFileSetStatus).not.toHaveBeenCalled();
  });

  it('test_POST_forceContainer_with_blocklisted_returns_409_guard_BEFORE_forceContainer', async () => {
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'failed' });
    mockBlocklistMatchByFileIdOrPath.mockReturnValue(true);
    const res = await POST(makeRequest(JSON.stringify({ forceContainer: 'mp4' })), ctx('1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('blocklisted');
    // jobRepo.enqueue path NOT entered.
    expect(mockFileSetStatus).not.toHaveBeenCalled();
  });

  it('test_POST_clean_file_no_blocklist_proceeds_200_regression', async () => {
    mockFileGetById.mockReturnValue({ ...baseFile, status: 'failed' });
    mockJobFindByFileId.mockReturnValue(undefined);
    mockBlocklistMatchByFileIdOrPath.mockReturnValue(false);
    const res = await POST(makeRequest(), ctx('1'));
    expect(res.status).toBe(200);
    expect(mockFileSetStatus).toHaveBeenCalledWith(1, 'pending', 7);
  });
});
