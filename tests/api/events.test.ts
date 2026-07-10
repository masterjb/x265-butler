import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { JobRow } from '@/src/lib/db/schema';

const {
  mockListActive,
  mockCountByStatus,
  mockSubscribe,
  mockGetLastProgress,
  mockEnsureServerInit,
} = vi.hoisted(() => ({
  mockListActive: vi.fn<() => JobRow[]>(),
  mockCountByStatus: vi.fn<(status: string) => number>(),
  mockSubscribe: vi.fn<(listener: (ev: unknown) => void) => () => void>(),
  mockGetLastProgress: vi.fn<(jobId: number) => unknown | undefined>(),
  mockEnsureServerInit: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  jobRepo: () => ({ listActive: mockListActive, countByStatus: mockCountByStatus }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/encode/events', () => ({
  engineEvents: {
    emit: vi.fn(),
    subscribe: mockSubscribe,
    getLastProgress: mockGetLastProgress,
  },
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

import { GET, runtime } from '@/app/api/events/route';

async function readAllFrames(response: Response, maxMs = 200): Promise<string> {
  // Read everything available from the stream within maxMs window.
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const racePromise = Promise.race([
      reader.read(),
      new Promise<{ done: true; value?: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true }), 30),
      ),
    ]);
    const result = await racePromise;
    if (result.done) break;
    if (result.value) buffer += decoder.decode(result.value);
  }
  await reader.cancel().catch(() => {});
  return buffer;
}

describe('GET /api/events (SSE)', () => {
  let capturedListener: ((ev: unknown) => void) | null = null;
  let unsubscribed = false;

  beforeEach(() => {
    mockListActive.mockReset();
    mockCountByStatus.mockReset();
    mockSubscribe.mockReset();
    mockGetLastProgress.mockReset();
    mockEnsureServerInit.mockReset();
    capturedListener = null;
    unsubscribed = false;
    mockListActive.mockReturnValue([]);
    mockCountByStatus.mockReturnValue(0);
    mockGetLastProgress.mockReturnValue(undefined);
    mockSubscribe.mockImplementation((listener) => {
      capturedListener = listener;
      return () => {
        unsubscribed = true;
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_GET_when_opened_then_response_status_200_and_correct_headers', async () => {
    const ac = new AbortController();
    // undici's Request rejects cross-realm AbortSignal sometimes; build a Request-shaped
    // object structurally — the handler only reads request.signal.
    const req = {
      signal: ac.signal,
      url: 'http://localhost/api/events',
      headers: new Headers(),
    } as unknown as Request;
    const response = await GET(req);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-store');
    expect(response.headers.get('connection')).toBe('keep-alive');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(mockEnsureServerInit).toHaveBeenCalledOnce();
    ac.abort();
  });

  it('test_GET_when_opened_then_first_frame_is_queue_updated_with_baseline', async () => {
    mockListActive.mockReturnValue([{ id: 1 } as JobRow]);
    mockCountByStatus.mockReturnValue(7);
    const ac = new AbortController();
    const req = {
      signal: ac.signal,
      url: 'http://localhost/api/events',
      headers: new Headers(),
    } as unknown as Request;
    const response = await GET(req);
    const buffer = await readAllFrames(response, 100);
    expect(buffer).toContain('data: ');
    expect(buffer).toMatch(/"type":"queue\.updated"/);
    expect(buffer).toMatch(/"activeJobs":1/);
    expect(buffer).toMatch(/"pendingJobs":7/);
    ac.abort();
  });

  it('test_GET_when_active_jobs_have_cached_progress_then_replay_in_initial_frames_S13', async () => {
    mockListActive.mockReturnValue([{ id: 42 } as JobRow]);
    mockCountByStatus.mockReturnValue(0);
    mockGetLastProgress.mockImplementation((jobId) =>
      jobId === 42
        ? {
            type: 'job.progress',
            jobId: 42,
            fileId: 1,
            frame: 500,
            fps: 30,
            outTimeMs: 16500000,
            totalSize: 99999,
            progress: 'continue',
          }
        : undefined,
    );
    const ac = new AbortController();
    const req = {
      signal: ac.signal,
      url: 'http://localhost/api/events',
      headers: new Headers(),
    } as unknown as Request;
    const response = await GET(req);
    const buffer = await readAllFrames(response, 100);
    expect(buffer).toMatch(/"type":"job\.progress"/);
    expect(buffer).toMatch(/"frame":500/);
    expect(mockGetLastProgress).toHaveBeenCalledWith(42);
    ac.abort();
  });

  it('test_GET_when_engineEvents_emit_then_data_frame_written', async () => {
    const ac = new AbortController();
    const req = {
      signal: ac.signal,
      url: 'http://localhost/api/events',
      headers: new Headers(),
    } as unknown as Request;
    const response = await GET(req);
    // Wait for start callback to register subscriber
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedListener).toBeTruthy();
    capturedListener!({ type: 'job.started', jobId: 7, fileId: 1, encoder: 'libx265' });
    const buffer = await readAllFrames(response, 100);
    expect(buffer).toMatch(/"type":"job\.started"/);
    expect(buffer).toMatch(/"jobId":7/);
    ac.abort();
  });

  it('test_GET_when_progress_events_within_1s_for_same_jobId_then_throttled', async () => {
    const ac = new AbortController();
    const req = {
      signal: ac.signal,
      url: 'http://localhost/api/events',
      headers: new Headers(),
    } as unknown as Request;
    const response = await GET(req);
    await new Promise((r) => setTimeout(r, 10));
    // First progress passes; second within 1s dropped; third still dropped
    capturedListener!({
      type: 'job.progress',
      jobId: 1,
      fileId: 1,
      frame: 100,
      fps: 30,
      outTimeMs: 1000000,
      totalSize: 1,
      progress: 'continue',
    });
    capturedListener!({
      type: 'job.progress',
      jobId: 1,
      fileId: 1,
      frame: 101,
      fps: 30,
      outTimeMs: 2000000,
      totalSize: 2,
      progress: 'continue',
    });
    const buffer = await readAllFrames(response, 50);
    const progressFrames = buffer.match(/"type":"job\.progress"/g) ?? [];
    expect(progressFrames.length).toBe(1);
    ac.abort();
  });

  it('test_GET_when_progress_for_different_jobIds_then_NOT_throttled_against_each_other', async () => {
    const ac = new AbortController();
    const req = {
      signal: ac.signal,
      url: 'http://localhost/api/events',
      headers: new Headers(),
    } as unknown as Request;
    const response = await GET(req);
    await new Promise((r) => setTimeout(r, 10));
    capturedListener!({
      type: 'job.progress',
      jobId: 1,
      fileId: 1,
      frame: 1,
      fps: 30,
      outTimeMs: 1,
      totalSize: 1,
      progress: 'continue',
    });
    capturedListener!({
      type: 'job.progress',
      jobId: 2,
      fileId: 2,
      frame: 1,
      fps: 30,
      outTimeMs: 1,
      totalSize: 1,
      progress: 'continue',
    });
    const buffer = await readAllFrames(response, 50);
    const progressFrames = buffer.match(/"type":"job\.progress"/g) ?? [];
    expect(progressFrames.length).toBe(2);
    ac.abort();
  });

  it('test_GET_when_signal_aborts_then_unsubscribe_called', async () => {
    const ac = new AbortController();
    const req = {
      signal: ac.signal,
      url: 'http://localhost/api/events',
      headers: new Headers(),
    } as unknown as Request;
    const response = await GET(req);
    await new Promise((r) => setTimeout(r, 10));
    expect(unsubscribed).toBe(false);
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(unsubscribed).toBe(true);
    // Drain to satisfy reader cleanup
    await readAllFrames(response, 50);
  });

  it('test_GET_when_non_progress_event_then_NOT_throttled', async () => {
    const ac = new AbortController();
    const req = {
      signal: ac.signal,
      url: 'http://localhost/api/events',
      headers: new Headers(),
    } as unknown as Request;
    const response = await GET(req);
    await new Promise((r) => setTimeout(r, 10));
    capturedListener!({ type: 'queue.updated', activeJobs: 1, pendingJobs: 1 });
    capturedListener!({ type: 'queue.updated', activeJobs: 2, pendingJobs: 0 });
    const buffer = await readAllFrames(response, 50);
    const queueFrames = buffer.match(/"type":"queue\.updated"/g) ?? [];
    expect(queueFrames.length).toBeGreaterThanOrEqual(2); // initial + 2 emits
    ac.abort();
  });
});
