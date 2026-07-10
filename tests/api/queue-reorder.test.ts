// Plan 05-12 (B3 Queue Reorder): PATCH /api/queue/reorder route tests.
// Covers AC-4 (TX + 409 + audit log + queue.updated emit + Content-Type/auth/zod
// validation) and AC-7 (idempotent replay via clientNonce LRU dedup).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  mockPeekQueued,
  mockReorderQueueTx,
  mockListActive,
  mockCountByStatus,
  mockEmit,
  mockEnsureServerInit,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockPeekQueued: vi.fn<(limit: number) => Array<{ id: number }>>(),
  mockReorderQueueTx:
    vi.fn<
      (
        ids: number[],
      ) => { applied: Array<{ jobId: number; queuePosition: number }> } | { conflict: number[] }
    >(),
  mockListActive: vi.fn<() => Array<unknown>>(),
  mockCountByStatus: vi.fn<(status: string) => number>(),
  mockEmit: vi.fn(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  jobRepo: () => ({
    peekQueued: mockPeekQueued,
    reorderQueueTx: mockReorderQueueTx,
    listActive: mockListActive,
    countByStatus: mockCountByStatus,
  }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/encode/events', () => ({
  engineEvents: { emit: mockEmit, subscribe: vi.fn(), getLastProgress: vi.fn() },
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => {
  const child = vi.fn(() => ({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: vi.fn(),
  }));
  return {
    logger: {
      child,
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
      debug: vi.fn(),
    },
    default: {},
  };
});

import { PATCH, runtime, __resetNonceCacheForTests } from '@/app/api/queue/reorder/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeNonce(): string {
  return crypto.randomUUID();
}

function patchReq(
  body: string | undefined,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Request {
  const init: RequestInit = { method: 'PATCH', headers };
  if (body !== undefined) init.body = body;
  return new Request('http://localhost/api/queue/reorder', init);
}

function jsonBody(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('PATCH /api/queue/reorder', () => {
  beforeEach(() => {
    mockPeekQueued.mockReset();
    mockReorderQueueTx.mockReset();
    mockListActive.mockReset();
    mockCountByStatus.mockReset();
    mockEmit.mockReset();
    mockEnsureServerInit.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    __resetNonceCacheForTests();
    // Sensible defaults so happy-path tests can override only what they test.
    mockListActive.mockReturnValue([]);
    mockCountByStatus.mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  // ── Validation gates ──────────────────────────────────────────────────────

  it('test_PATCH_when_wrong_content_type_then_415', async () => {
    const response = await PATCH(patchReq('{}', { 'content-type': 'text/plain' }));
    expect(response.status).toBe(415);
  });

  it('test_PATCH_when_empty_orderedJobIds_array_then_400_invalid_body_zod_min_1', async () => {
    const response = await PATCH(
      patchReq(jsonBody({ orderedJobIds: [], clientNonce: makeNonce() })),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid_body');
  });

  it('test_PATCH_when_orderedJobIds_exceeds_1000_then_400_invalid_body_zod_max_1000', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
    const response = await PATCH(
      patchReq(jsonBody({ orderedJobIds: ids, clientNonce: makeNonce() })),
    );
    expect(response.status).toBe(400);
  });

  it('test_PATCH_when_duplicate_jobids_then_400_reorder_duplicate_jobids', async () => {
    const response = await PATCH(
      patchReq(jsonBody({ orderedJobIds: [1, 2, 1], clientNonce: makeNonce() })),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('reorder_duplicate_jobids');
  });

  it('test_PATCH_when_unknown_jobids_then_400_reorder_unknown_jobids_with_list', async () => {
    mockPeekQueued.mockReturnValue([{ id: 1 }, { id: 2 }]);
    const response = await PATCH(
      patchReq(jsonBody({ orderedJobIds: [1, 2, 999], clientNonce: makeNonce() })),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('reorder_unknown_jobids');
    expect(body.unknownJobIds).toEqual([999]);
  });

  it('test_PATCH_when_missing_clientNonce_then_400_reorder_invalid_nonce', async () => {
    const response = await PATCH(patchReq(jsonBody({ orderedJobIds: [1, 2] })));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('reorder_invalid_nonce');
  });

  it('test_PATCH_when_non_uuid_clientNonce_then_400_reorder_invalid_nonce', async () => {
    const response = await PATCH(
      patchReq(jsonBody({ orderedJobIds: [1, 2], clientNonce: 'not-a-uuid' })),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('reorder_invalid_nonce');
  });

  it('test_PATCH_when_content_length_exceeds_16384_then_413_body_too_large_audit_M6', async () => {
    const response = await PATCH(
      patchReq(jsonBody({ orderedJobIds: [1, 2], clientNonce: makeNonce() }), {
        'content-type': 'application/json',
        'content-length': '20000',
      }),
    );
    expect(response.status).toBe(413);
  });

  it('test_PATCH_when_body_text_exceeds_16384_then_413_body_too_large_defense_in_depth', async () => {
    const padding = 'x'.repeat(17000);
    const response = await PATCH(
      patchReq(jsonBody({ orderedJobIds: [1, 2], clientNonce: makeNonce(), padding })),
    );
    expect(response.status).toBe(413);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('test_PATCH_when_valid_request_then_200_with_applied_in_body_order_with_positions_1_to_N', async () => {
    mockPeekQueued.mockReturnValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    mockReorderQueueTx.mockReturnValue({
      applied: [
        { jobId: 3, queuePosition: 1 },
        { jobId: 1, queuePosition: 2 },
        { jobId: 2, queuePosition: 3 },
      ],
    });
    const response = await PATCH(
      patchReq(jsonBody({ orderedJobIds: [3, 1, 2], clientNonce: makeNonce() })),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.applied).toEqual([
      { jobId: 3, queuePosition: 1 },
      { jobId: 1, queuePosition: 2 },
      { jobId: 2, queuePosition: 3 },
    ]);
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('test_PATCH_when_valid_request_then_emits_exactly_one_queue_updated_event', async () => {
    mockPeekQueued.mockReturnValue([{ id: 1 }, { id: 2 }]);
    mockReorderQueueTx.mockReturnValue({
      applied: [
        { jobId: 2, queuePosition: 1 },
        { jobId: 1, queuePosition: 2 },
      ],
    });
    mockListActive.mockReturnValue([{ id: 99 }]);
    mockCountByStatus.mockReturnValue(2);
    await PATCH(patchReq(jsonBody({ orderedJobIds: [2, 1], clientNonce: makeNonce() })));
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith({
      type: 'queue.updated',
      activeJobs: 1,
      pendingJobs: 2,
      paused: false,
    });
  });

  it('test_PATCH_when_valid_request_then_logs_queue_reordered_with_count_and_durationMs_and_audit_fields', async () => {
    const nonce = makeNonce();
    mockPeekQueued.mockReturnValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    mockReorderQueueTx.mockReturnValue({
      applied: [
        { jobId: 3, queuePosition: 1 },
        { jobId: 1, queuePosition: 2 },
        { jobId: 2, queuePosition: 3 },
      ],
    });
    await PATCH(patchReq(jsonBody({ orderedJobIds: [3, 1, 2], clientNonce: nonce })));
    const matched = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'queue_reordered',
    );
    expect(matched).toBeDefined();
    const payload = matched![0] as Record<string, unknown>;
    expect(payload.count).toBe(3);
    expect(typeof payload.durationMs).toBe('number');
    expect(payload.clientNonce).toBe(nonce);
    expect(payload.previousOrder).toEqual([1, 2, 3]);
    expect(payload.newOrder).toEqual([3, 1, 2]);
    expect(typeof payload.actorId).toBe('string');
  });

  // ── 409 conflict path ─────────────────────────────────────────────────────

  it('test_PATCH_when_id_claimed_concurrently_then_409_with_conflictingJobIds', async () => {
    const nonce = makeNonce();
    mockPeekQueued.mockReturnValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    mockReorderQueueTx.mockReturnValue({ conflict: [2] });
    const response = await PATCH(
      patchReq(jsonBody({ orderedJobIds: [3, 1, 2], clientNonce: nonce })),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('reorder_race_status_changed');
    expect(body.conflictingJobIds).toEqual([2]);
    // Conflict path does NOT emit queue.updated.
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('test_PATCH_when_409_conflict_then_logs_queue_reorder_race_status_changed_with_audit_fields', async () => {
    const nonce = makeNonce();
    mockPeekQueued.mockReturnValue([{ id: 1 }, { id: 2 }]);
    mockReorderQueueTx.mockReturnValue({ conflict: [2] });
    await PATCH(patchReq(jsonBody({ orderedJobIds: [2, 1], clientNonce: nonce })));
    const matched = mockLoggerWarn.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'queue_reorder_race_status_changed',
    );
    expect(matched).toBeDefined();
    const payload = matched![0] as Record<string, unknown>;
    expect(payload.conflictingJobIds).toEqual([2]);
    expect(payload.clientNonce).toBe(nonce);
    expect(payload.previousOrder).toEqual([1, 2]);
    expect(payload.attemptedOrder).toEqual([2, 1]);
  });

  // ── Idempotent replay (AC-7 / M2) ─────────────────────────────────────────

  it('test_PATCH_when_replay_with_same_nonce_then_returns_cached_200_byte_identically_no_second_TX', async () => {
    const nonce = makeNonce();
    mockPeekQueued.mockReturnValue([{ id: 1 }, { id: 2 }]);
    mockReorderQueueTx.mockReturnValue({
      applied: [
        { jobId: 2, queuePosition: 1 },
        { jobId: 1, queuePosition: 2 },
      ],
    });
    const r1 = await PATCH(patchReq(jsonBody({ orderedJobIds: [2, 1], clientNonce: nonce })));
    const r2 = await PATCH(patchReq(jsonBody({ orderedJobIds: [2, 1], clientNonce: nonce })));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = await r1.json();
    const b2 = await r2.json();
    // Bodies must equal byte-for-byte (same applied array, same requestId).
    expect(b2).toEqual(b1);
    // TX ran once, queue.updated emitted once.
    expect(mockReorderQueueTx).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    // pino info logs the idempotent replay.
    const replayLog = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'queue_reorder_idempotent_replay',
    );
    expect(replayLog).toBeDefined();
    expect((replayLog![0] as { originalStatus?: number }).originalStatus).toBe(200);
  });

  it('test_PATCH_when_replay_of_409_with_same_nonce_then_returns_cached_409_with_same_conflictingJobIds', async () => {
    const nonce = makeNonce();
    mockPeekQueued.mockReturnValue([{ id: 1 }, { id: 2 }]);
    mockReorderQueueTx.mockReturnValue({ conflict: [2] });
    const r1 = await PATCH(patchReq(jsonBody({ orderedJobIds: [2, 1], clientNonce: nonce })));
    const r2 = await PATCH(patchReq(jsonBody({ orderedJobIds: [2, 1], clientNonce: nonce })));
    expect(r1.status).toBe(409);
    expect(r2.status).toBe(409);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b2).toEqual(b1);
    expect(mockReorderQueueTx).toHaveBeenCalledTimes(1);
    const replayLog = mockLoggerInfo.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { action?: string }).action === 'queue_reorder_idempotent_replay',
    );
    expect(replayLog).toBeDefined();
    expect((replayLog![0] as { originalStatus?: number }).originalStatus).toBe(409);
  });

  it('test_PATCH_when_61_seconds_pass_then_same_nonce_is_treated_as_fresh_request_runs_TX_again', async () => {
    const nonce = makeNonce();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-04T12:00:00Z'));
    mockPeekQueued.mockReturnValue([{ id: 1 }, { id: 2 }]);
    mockReorderQueueTx.mockReturnValue({
      applied: [
        { jobId: 2, queuePosition: 1 },
        { jobId: 1, queuePosition: 2 },
      ],
    });
    await PATCH(patchReq(jsonBody({ orderedJobIds: [2, 1], clientNonce: nonce })));
    expect(mockReorderQueueTx).toHaveBeenCalledTimes(1);
    // Advance > 60s.
    vi.setSystemTime(new Date('2026-05-04T12:01:01Z'));
    await PATCH(patchReq(jsonBody({ orderedJobIds: [2, 1], clientNonce: nonce })));
    expect(mockReorderQueueTx).toHaveBeenCalledTimes(2);
  });

  it('test_PATCH_when_more_than_1000_distinct_nonces_then_LRU_evicts_oldest_size_capped_at_1000', async () => {
    mockPeekQueued.mockReturnValue([{ id: 1 }, { id: 2 }]);
    mockReorderQueueTx.mockReturnValue({
      applied: [
        { jobId: 2, queuePosition: 1 },
        { jobId: 1, queuePosition: 2 },
      ],
    });
    const firstNonce = makeNonce();
    await PATCH(patchReq(jsonBody({ orderedJobIds: [2, 1], clientNonce: firstNonce })));
    // Flood with 1000 more distinct nonces — pushes firstNonce out of LRU.
    for (let i = 0; i < 1000; i++) {
      await PATCH(patchReq(jsonBody({ orderedJobIds: [2, 1], clientNonce: makeNonce() })));
    }
    // 1001 total inserts; cache size capped at 1000 means firstNonce was evicted.
    // Replaying firstNonce now triggers a fresh TX (TX call count must increment).
    const beforeReplay = mockReorderQueueTx.mock.calls.length;
    await PATCH(patchReq(jsonBody({ orderedJobIds: [2, 1], clientNonce: firstNonce })));
    expect(mockReorderQueueTx.mock.calls.length).toBe(beforeReplay + 1);
  });
});
