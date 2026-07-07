// 32-02: POST /api/queue/pause + /api/queue/resume — in-memory pause-after-current.
// Mirrors cancel-all route hardening (auth gate, 415/413, strict body) and asserts
// setQueuePaused is driven with true/false and the authoritative audit line is emitted.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockSetQueuePaused, mockEnsureServerInit, mockLoggerInfo, mockGateAuth } = vi.hoisted(
  () => ({
    mockSetQueuePaused: vi.fn<(paused: boolean) => void>(),
    mockEnsureServerInit: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockGateAuth: vi.fn(),
  }),
);

vi.mock('@/src/lib/encode', () => ({
  setQueuePaused: mockSetQueuePaused,
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/api/auth-gate', () => ({
  gateAuth: mockGateAuth,
  default: {},
}));

vi.mock('@/src/lib/logger', () => {
  const child = vi.fn(() => ({
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }));
  return {
    logger: { child, info: mockLoggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    default: {},
  };
});

import { POST as PAUSE, runtime as pauseRuntime } from '@/app/api/queue/pause/route';
import { POST as RESUME } from '@/app/api/queue/resume/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function req(
  url: string,
  body: string | undefined = '{}',
  headers: Record<string, string> = { 'content-type': 'application/json' },
): Request {
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) init.body = body;
  return new Request(url, init);
}

const PAUSE_URL = 'http://localhost/api/queue/pause';
const RESUME_URL = 'http://localhost/api/queue/resume';

function findAudit(action: string) {
  return mockLoggerInfo.mock.calls.find(
    (c) =>
      typeof c[0] === 'object' && c[0] !== null && (c[0] as { action?: string }).action === action,
  );
}

beforeEach(() => {
  mockSetQueuePaused.mockReset();
  mockEnsureServerInit.mockReset();
  mockLoggerInfo.mockReset();
  mockGateAuth.mockReset();
  // Default: auth allowed (authenticated actor).
  mockGateAuth.mockResolvedValue({
    denied: undefined,
    auth: { ok: true, mode: 'authenticated', username: 'tester' },
  });
});

describe('POST /api/queue/pause', () => {
  it('test_route_runtime_export_is_nodejs', () => {
    expect(pauseRuntime).toBe('nodejs');
  });

  it('AC-4 pause → 200 {paused:true} and drives setQueuePaused(true)', async () => {
    const res = await PAUSE(req(PAUSE_URL));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paused).toBe(true);
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockSetQueuePaused).toHaveBeenCalledWith(true);
  });

  it('AC-4 second pause while already paused → 200 {paused:true} (idempotent post-state)', async () => {
    await PAUSE(req(PAUSE_URL));
    const res = await PAUSE(req(PAUSE_URL));
    expect(res.status).toBe(200);
    expect((await res.json()).paused).toBe(true);
  });

  it('AC-4 emits authoritative queue_paused audit line with actorId', async () => {
    await PAUSE(req(PAUSE_URL));
    const audit = findAudit('queue_paused');
    expect(audit).toBeDefined();
    expect((audit![0] as { actorId?: unknown }).actorId).toEqual(expect.any(String));
    // SR-2: setter's distinct breadcrumb is NOT logged by the route.
    expect(findAudit('queue_pause_state_changed')).toBeUndefined();
  });

  it('AC-4 wrong content-type → 415', async () => {
    const res = await PAUSE(req(PAUSE_URL, '{}', { 'content-type': 'text/plain' }));
    expect(res.status).toBe(415);
    expect(mockSetQueuePaused).not.toHaveBeenCalled();
  });

  it('AC-4 content-length > 16384 → 413', async () => {
    const res = await PAUSE(
      req(PAUSE_URL, '{}', { 'content-type': 'application/json', 'content-length': '20000' }),
    );
    expect(res.status).toBe(413);
  });

  it('AC-4 extra keys in body → 400 (strict zod)', async () => {
    const res = await PAUSE(req(PAUSE_URL, '{"x":1}'));
    expect(res.status).toBe(400);
    expect(mockSetQueuePaused).not.toHaveBeenCalled();
  });

  it('AC-4 auth-enabled unauthenticated → denied', async () => {
    mockGateAuth.mockResolvedValue({
      denied: new Response('unauthorized', { status: 401 }),
      auth: { ok: false },
    });
    const res = await PAUSE(req(PAUSE_URL));
    expect(res.status).toBe(401);
    expect(mockSetQueuePaused).not.toHaveBeenCalled();
  });
});

describe('POST /api/queue/resume', () => {
  it('AC-4 resume → 200 {paused:false} and drives setQueuePaused(false)', async () => {
    const res = await RESUME(req(RESUME_URL));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paused).toBe(false);
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockSetQueuePaused).toHaveBeenCalledWith(false);
  });

  it('AC-4 emits authoritative queue_resumed audit line with actorId', async () => {
    await RESUME(req(RESUME_URL));
    const audit = findAudit('queue_resumed');
    expect(audit).toBeDefined();
    expect((audit![0] as { actorId?: unknown }).actorId).toEqual(expect.any(String));
    expect(findAudit('queue_pause_state_changed')).toBeUndefined();
  });

  it('AC-4 wrong content-type → 415', async () => {
    const res = await RESUME(req(RESUME_URL, '{}', { 'content-type': 'text/plain' }));
    expect(res.status).toBe(415);
  });

  it('AC-4 auth-enabled unauthenticated → denied', async () => {
    mockGateAuth.mockResolvedValue({
      denied: new Response('unauthorized', { status: 401 }),
      auth: { ok: false },
    });
    const res = await RESUME(req(RESUME_URL));
    expect(res.status).toBe(401);
    expect(mockSetQueuePaused).not.toHaveBeenCalled();
  });
});
