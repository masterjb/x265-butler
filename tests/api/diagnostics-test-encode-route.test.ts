// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DetectionResult } from '@/src/lib/encode/detection';

const { mockSpawn, mockDetectEncoders, mockEnsureServerInit, mockLoggerInfo, authMode } =
  vi.hoisted(() => ({
    mockSpawn: vi.fn(),
    mockDetectEncoders: vi.fn<() => Promise<DetectionResult>>(),
    mockEnsureServerInit: vi.fn(),
    mockLoggerInfo: vi.fn(),
    authMode: { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' },
  }));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// 24-02: test-encode.ts now imports buildCodecBlock + DEFAULT_PRESET_BY_ENCODER
// from this barrel for buildTestEncodeArgs. Pull the REAL pure builders from the
// leaf profiles module (no server side-effects) so the spawned argv is faithful;
// only detectEncoders is stubbed.
vi.mock('@/src/lib/encode', async () => {
  const profiles = await vi.importActual<typeof import('@/src/lib/encode/profiles')>(
    '@/src/lib/encode/profiles',
  );
  return {
    detectEncoders: mockDetectEncoders,
    ENCODER_IDS: profiles.ENCODER_IDS,
    buildCodecBlock: profiles.buildCodecBlock,
    DEFAULT_PRESET_BY_ENCODER: profiles.DEFAULT_PRESET_BY_ENCODER,
  };
});

vi.mock('@/src/lib/encode/ffmpeg-binary', () => ({
  ffmpegBinary: () => '/usr/bin/ffmpeg',
  ffprobeBinary: () => '/usr/bin/ffprobe',
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (authMode.value === 'denied') {
      return { ok: false, status: 401, body: { error_code: 'auth_required' } };
    }
    if (authMode.value === 'authenticated') {
      return { ok: true, mode: 'authenticated', username: 'admin' };
    }
    return { ok: true, mode: 'disabled', username: null };
  }),
  authGuard: (decision: { ok: boolean; status?: number; body?: unknown }) => {
    if (decision.ok) return null;
    return new Response(JSON.stringify(decision.body), {
      status: decision.status,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  withRenewCookie: (res: Response) => res,
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    info: mockLoggerInfo,
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { POST } from '@/app/api/diagnostics/test-encode/route';
import { _resetMutexForTesting } from '@/src/lib/diagnostics/test-encode';

interface MockChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: (e: string) => void };
  stderr: EventEmitter & { setEncoding: (e: string) => void };
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  emitClose: (code: number | null) => void;
  emitError: (err: Error) => void;
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
}

function makeMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  const stdout = new EventEmitter() as MockChild['stdout'];
  const stderr = new EventEmitter() as MockChild['stderr'];
  stdout.setEncoding = vi.fn();
  stderr.setEncoding = vi.fn();
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = vi.fn((_sig?: string) => {
    child.killed = true;
    return true;
  });
  child.emitClose = (code) => child.emit('close', code);
  child.emitError = (err) => child.emit('error', err);
  child.emitStdout = (chunk) => stdout.emit('data', chunk);
  child.emitStderr = (chunk) => stderr.emit('data', chunk);
  return child;
}

describe('POST /api/diagnostics/test-encode', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockDetectEncoders.mockReset();
    mockEnsureServerInit.mockReset();
    mockLoggerInfo.mockReset();
    authMode.value = 'disabled';
    _resetMutexForTesting();
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
  });

  afterEach(() => {
    _resetMutexForTesting();
    vi.useRealTimers();
  });

  it('happy-path: spawn exits 0 → 200 + outcome=success + audit-log emitted', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const pending = POST(
      new Request('http://test/api/diagnostics/test-encode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    // let microtasks settle so child handlers registered
    await Promise.resolve();
    await Promise.resolve();
    child.emitStdout('frame=1');
    child.emitStderr('ffmpeg version');
    child.emitClose(0);
    const res = await pending;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.encoderPicked).toBe('libx265');
    expect(body.exitCode).toBe(0);
    expect(body.ffmpegStdout).toContain('frame=1');
    expect(body.ffmpegStderr).toContain('ffmpeg version');
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success', encoder: 'libx265', exitCode: 0 }),
      'testEncodeTriggered',
    );
  });

  it('spawn exits non-zero → 200 + success=false + outcome=failed audit', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const pending = POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    child.emitClose(1);
    const res = await pending;
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.exitCode).toBe(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', exitCode: 1 }),
      'testEncodeTriggered',
    );
  });

  it('timeout: spawn never exits → AbortController fires → outcome=killed_timeout + exitCode=null + child.killed=true', async () => {
    vi.useFakeTimers();
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const pending = POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Advance past 10s timeout — kill fires, then we manually emit close from kill.
    const killSpy = child.kill;
    // Patch kill to immediately schedule close emission (mirrors real SIGKILL → close)
    (killSpy as ReturnType<typeof vi.fn>).mockImplementation(() => {
      child.killed = true;
      queueMicrotask(() => child.emitClose(null));
      return true;
    });
    await vi.advanceTimersByTimeAsync(10_100);
    const res = await pending;
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.exitCode).toBeNull();
    expect(child.killed).toBe(true);
    expect(killSpy).toHaveBeenCalledWith('SIGKILL');
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'killed_timeout', exitCode: null }),
      'testEncodeTriggered',
    );
  });

  it('mutex held: concurrent POST → 503 + Retry-After: 5 + audit outcome=mutex_held', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const first = POST(new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }));
    await Promise.resolve();
    // second call while first still pending
    const second = await POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    expect(second.status).toBe(503);
    expect(second.headers.get('retry-after')).toBe('5');
    const body = await second.json();
    expect(body.error_code).toBe('test_encode_in_flight');
    expect(body.retryAfterSeconds).toBe(5);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { encoder: null, durationMs: 0, outcome: 'mutex_held', exitCode: null },
      'testEncodeTriggered',
    );
    // unblock first
    child.emitClose(0);
    await first;
  });

  it('mutex released after spawn error → subsequent call succeeds', async () => {
    const childA = makeMockChild();
    mockSpawn.mockReturnValueOnce(childA);
    const first = POST(new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }));
    await Promise.resolve();
    await Promise.resolve();
    childA.emitClose(1);
    await first;

    const childB = makeMockChild();
    mockSpawn.mockReturnValueOnce(childB);
    const second = POST(new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }));
    await Promise.resolve();
    await Promise.resolve();
    childB.emitClose(0);
    const res = await second;
    expect(res.status).toBe(200);
  });

  it('auth_enabled=true + no cookie → 401 + spawn NEVER called', async () => {
    authMode.value = 'denied';
    const res = await POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    expect(res.status).toBe(401);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('stdout/stderr capped at 4 KB when spawn emits megabytes', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const pending = POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    // emit 10 KB total to stdout
    for (let i = 0; i < 20; i++) child.emitStdout('a'.repeat(512));
    for (let i = 0; i < 20; i++) child.emitStderr('b'.repeat(512));
    child.emitClose(0);
    const res = await pending;
    const body = await res.json();
    expect(body.ffmpegStdout.length).toBeLessThanOrEqual(4 * 1024);
    expect(body.ffmpegStderr.length).toBeLessThanOrEqual(4 * 1024);
  });

  it('spawn argv: no shell, synthetic input, /dev/null output', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const pending = POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    child.emitClose(0);
    await pending;
    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      expect.arrayContaining([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=1:duration=5',
        '-c:v',
        'libx265',
        '-f',
        'null',
        '/dev/null',
      ]),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('encoder picked: nvenc → hevc_nvenc', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['nvenc', 'libx265'],
      activeFromAuto: 'nvenc',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const pending = POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    child.emitClose(0);
    const res = await pending;
    const body = await res.json();
    expect(body.encoderPicked).toBe('hevc_nvenc');
  });

  it('encoder picked: vaapi → hevc_vaapi; qsv → hevc_qsv', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['vaapi', 'libx265'],
      activeFromAuto: 'vaapi',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    let child = makeMockChild();
    mockSpawn.mockReturnValueOnce(child);
    let pending = POST(new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }));
    await Promise.resolve();
    await Promise.resolve();
    child.emitClose(0);
    let body = await (await pending).json();
    expect(body.encoderPicked).toBe('hevc_vaapi');

    mockDetectEncoders.mockResolvedValue({
      detected: ['qsv', 'libx265'],
      activeFromAuto: 'qsv',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    child = makeMockChild();
    mockSpawn.mockReturnValueOnce(child);
    pending = POST(new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }));
    await Promise.resolve();
    await Promise.resolve();
    child.emitClose(0);
    body = await (await pending).json();
    expect(body.encoderPicked).toBe('hevc_qsv');
  });

  // 24-02 AC-6: the operator test-encode must probe the SAME discovered node as
  // the boot-probe + production encode, NOT the hardcoded renderD128 default.
  it('vaapi: spawned -vaapi_device equals the discovered det.vaapiDevice (not renderD128)', async () => {
    mockDetectEncoders.mockResolvedValue({
      detected: ['vaapi', 'libx265'],
      activeFromAuto: 'vaapi',
      vaapiDevice: '/dev/dri/renderD129',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'functional', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const pending = POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    child.emitClose(0);
    await pending;
    const argv = mockSpawn.mock.calls[0][1] as string[];
    const i = argv.indexOf('-vaapi_device');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('/dev/dri/renderD129');
    expect(argv).not.toContain('/dev/dri/renderD128');
  });

  // 24-02 AC-7: buildTestEncodeArgs → buildCodecBlock is now a synchronous throw-site
  // inside the mutex-guarded route path. A throw during arg-building MUST still hit
  // the route's finally releaseMutex() (no permanent one-way-door lock) and map to
  // HTTP 500. Locked here so a future refactor cannot move arg-building outside the
  // try/finally and silently re-introduce a deadlock.
  it('synchronous arg-build throw → 500 test_encode_failed AND mutex released', async () => {
    // activeFromAuto is an unknown encoder → buildCodecBlock throws TypeError
    // synchronously inside runTestEncode (the new 24-02 throw-site).
    mockDetectEncoders.mockResolvedValueOnce({
      detected: ['libx265'],
      activeFromAuto: 'bogus' as unknown as 'libx265',
      warnings: [],
      outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
    });
    const failing = await POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    expect(failing.status).toBe(500);
    expect((await failing.json()).error_code).toBe('test_encode_failed');
    expect(mockSpawn).not.toHaveBeenCalled();

    // mutex must be free now — a subsequent normal call acquires it and succeeds.
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const pending = POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    child.emitClose(0);
    const res = await pending;
    expect(res.status).toBe(200);
  });
});
