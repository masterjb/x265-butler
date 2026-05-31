// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DetectionResult } from '@/src/lib/encode/detection';
import { CLIENT_ALLOWED_EVENTS } from '@/src/lib/diagnostics/log-event-allowlist';

const { mockSpawn, mockDetectEncoders, mockEnsureServerInit, mockLoggerInfo } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockDetectEncoders: vi.fn<() => Promise<DetectionResult>>(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
// 24-02: test-encode.ts now imports buildCodecBlock + DEFAULT_PRESET_BY_ENCODER
// from this barrel (buildTestEncodeArgs). Pull the REAL pure builders from the
// leaf profiles module; only detectEncoders is stubbed.
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
vi.mock('@/src/lib/server-init', () => ({ ensureServerInit: mockEnsureServerInit }));
vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ ok: true, mode: 'disabled', username: null })),
  authGuard: () => null,
  withRenewCookie: (res: Response) => res,
}));
vi.mock('@/src/lib/logger', () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { POST } from '@/app/api/diagnostics/test-encode/route';
import { _resetMutexForTesting } from '@/src/lib/diagnostics/test-encode';

interface MockChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: (e: string) => void };
  stderr: EventEmitter & { setEncoding: (e: string) => void };
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  emitClose: (code: number | null) => void;
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
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.emitClose = (code) => child.emit('close', code);
  child.emitStderr = (chunk) => stderr.emit('data', chunk);
  return child;
}

describe('POST /api/diagnostics/test-encode — 23-01 error mapping', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockDetectEncoders.mockReset();
    mockEnsureServerInit.mockReset();
    mockLoggerInfo.mockReset();
    _resetMutexForTesting();
    mockDetectEncoders.mockResolvedValue({
      detected: ['qsv', 'libx265'],
      activeFromAuto: 'qsv',
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

  it('qsv -9 failure → body.mappedError + flat testEncodeErrorMapped emit', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const pending = POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    child.emitStderr('[hevc_qsv @ 0x55] Error creating a MFX session: -9.');
    child.emitClose(1);
    const res = await pending;
    const body = await res.json();

    expect(body.encoderPicked).toBe('hevc_qsv');
    expect(body.mappedError).toEqual({ code: 'qsvMfxSessionUnsupported', severity: 'warning' });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { encoder: 'hevc_qsv', code: 'qsvMfxSessionUnsupported', severity: 'warning', exitCode: 1 },
      'testEncodeErrorMapped',
    );
  });

  it('success → mappedError null + NO testEncodeErrorMapped emit', async () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const pending = POST(
      new Request('http://test/api/diagnostics/test-encode', { method: 'POST' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    child.emitStderr('ffmpeg version 7.x\nframe=5');
    child.emitClose(0);
    const res = await pending;
    const body = await res.json();

    expect(body.mappedError).toBeNull();
    const mappedCalls = mockLoggerInfo.mock.calls.filter((c) => c[1] === 'testEncodeErrorMapped');
    expect(mappedCalls).toHaveLength(0);
  });

  it('audit-SR4: testEncodeErrorMapped is NOT a client-allowed event (server-only)', () => {
    expect(CLIENT_ALLOWED_EVENTS as readonly string[]).not.toContain('testEncodeErrorMapped');
  });
});
