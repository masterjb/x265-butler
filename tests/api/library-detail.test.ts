import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FileRow, JobRow } from '@/src/lib/db/schema';

const { mockGetById, mockFindLatestByFileId } = vi.hoisted(() => ({
  mockGetById: vi.fn<(id: number) => FileRow | undefined>(),
  mockFindLatestByFileId: vi.fn<(fileId: number) => JobRow | undefined>(),
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({
    getById: mockGetById,
  }),
  jobRepo: () => ({
    findLatestByFileId: mockFindLatestByFileId,
  }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

import { GET } from '@/app/api/library/[id]/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const sample: FileRow = {
  id: 42,
  path: '/media/x.mp4',
  size_bytes: 1024,
  mtime: 1_700_000_000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 1_000_000,
  duration_seconds: 60,
  width: 1920,
  height: 1080,
  container: 'mp4',
  status: 'pending',
  last_scanned_at: 1_700_000_100,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_100,
  version: 0,
  container_override: null,
  share_id: null,
};

function call(id: string) {
  return GET(new Request(`http://localhost/api/library/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/library/:id', () => {
  beforeEach(() => {
    mockGetById.mockReset();
    mockFindLatestByFileId.mockReset();
    mockFindLatestByFileId.mockReturnValue(undefined);
  });

  it('test_GET_when_id_exists_then_200_returns_file', async () => {
    mockGetById.mockReturnValue(sample);
    const res = await call('42');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.file.id).toBe(42);
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockGetById).toHaveBeenCalledWith(42);
  });

  // 12-03 inline-extend Route-1: lastJob surfaced in response.
  it('test_GET_when_id_exists_AND_done_job_exists_then_200_body_includes_lastJob_with_preset_used', async () => {
    mockGetById.mockReturnValue(sample);
    const jobRow = {
      id: 99,
      file_id: 42,
      status: 'done',
      started_at: 1_700_000_500,
      finished_at: 1_700_000_900,
      encoder: 'libx265',
      crf: 23,
      preset_used: 'slow',
      bytes_in: 1024,
      bytes_out: 800,
      duration_ms: 60_000,
      exit_code: 0,
      error_msg: null,
      log_tail: null,
      created_at: 1_700_000_400,
      queue_position: 0,
    } as unknown as JobRow;
    mockFindLatestByFileId.mockReturnValue(jobRow);
    const res = await call('42');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastJob).toBeDefined();
    expect(body.lastJob.preset_used).toBe('slow');
    expect(body.lastJob.crf).toBe(23);
    expect(body.lastJob.encoder).toBe('libx265');
    expect(mockFindLatestByFileId).toHaveBeenCalledWith(42);
  });

  it('test_GET_when_id_exists_AND_no_job_then_lastJob_is_null', async () => {
    mockGetById.mockReturnValue(sample);
    mockFindLatestByFileId.mockReturnValue(undefined);
    const res = await call('42');
    const body = await res.json();
    expect(body.lastJob).toBeNull();
  });

  // 12-03 inline-extend Route-1: failed jobs ARE surfaced (operator can
  // diagnose "why is preset_used '—' when I pinned p5?" — answer: the encode
  // failed before completing, but the dispatch wrote preset_used regardless).
  it('test_GET_when_latest_job_is_failed_then_lastJob_is_returned_NOT_null', async () => {
    mockGetById.mockReturnValue(sample);
    const failedJob = {
      id: 192,
      file_id: 42,
      status: 'failed',
      started_at: 1_700_000_500,
      finished_at: 1_700_000_510,
      encoder: 'nvenc',
      crf: 23,
      preset_used: 'p5',
      bytes_in: null,
      bytes_out: null,
      duration_ms: null,
      exit_code: 0,
      error_msg: 'output_path_exists',
      log_tail: null,
      created_at: 1_700_000_400,
      queue_position: 0,
    } as unknown as JobRow;
    mockFindLatestByFileId.mockReturnValue(failedJob);
    const res = await call('42');
    const body = await res.json();
    expect(body.lastJob).toBeDefined();
    expect(body.lastJob.status).toBe('failed');
    expect(body.lastJob.preset_used).toBe('p5');
  });

  it('test_GET_when_id_missing_then_404', async () => {
    mockGetById.mockReturnValue(undefined);
    const res = await call('99999');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.error).toBe('not_found');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_GET_when_id_not_numeric_then_400_invalid_id', async () => {
    const res = await call('abc');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_id');
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('test_GET_when_id_negative_then_400_invalid_id', async () => {
    const res = await call('-5');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_id');
  });

  it('test_GET_when_id_zero_then_400_invalid_id', async () => {
    const res = await call('0');
    expect(res.status).toBe(400);
  });

  it('test_GET_when_repo_throws_then_500_with_requestId', async () => {
    mockGetById.mockImplementation(() => {
      throw new Error('boom');
    });
    const res = await call('42');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
  });
});
