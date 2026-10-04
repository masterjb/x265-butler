// @vitest-environment node
//
// Phase 50 Plan 50-06 — runTestEncode resolves the OPERATOR's configuration.
//
// These tests drive `runTestEncode` directly through its `settingsReader` DI seam
// (the same idiom `ffmpegPath` already used), so nothing here opens a database.
// That is deliberate: before 50-06 this function had no DB dependency at all, and
// the seam is what keeps its unit tests honest after gaining one.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DetectionResult } from '@/src/lib/encode/detection';

const {
  mockSpawn,
  mockDetectEncoders,
  mockIsForcedIdrSupported,
  mockLoggerWarn,
  mockSettingSet,
  mockSettingDelete,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockDetectEncoders: vi.fn<() => Promise<DetectionResult>>(),
  mockIsForcedIdrSupported: vi.fn<(encoder: string) => boolean>(() => true),
  mockLoggerWarn: vi.fn(),
  mockSettingSet: vi.fn(),
  mockSettingDelete: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));

vi.mock('@/src/lib/encode', async () => {
  const profiles = await vi.importActual<typeof import('@/src/lib/encode/profiles')>(
    '@/src/lib/encode/profiles',
  );
  return {
    detectEncoders: mockDetectEncoders,
    ENCODER_IDS: profiles.ENCODER_IDS,
    buildCodecBlock: profiles.buildCodecBlock,
    DEFAULT_PRESET_BY_ENCODER: profiles.DEFAULT_PRESET_BY_ENCODER,
    DEFAULT_CRF_BY_ENCODER: profiles.DEFAULT_CRF_BY_ENCODER,
    PROBE_FRAME_SIZE: profiles.PROBE_FRAME_SIZE,
    SYNTHETIC_PROBE_PIX_FMT: profiles.SYNTHETIC_PROBE_PIX_FMT,
    usesSyntheticPixFmtPin: profiles.usesSyntheticPixFmtPin,
    isForcedIdrSupported: mockIsForcedIdrSupported,
  };
});

vi.mock('@/src/lib/encode/ffmpeg-binary', () => ({
  ffmpegBinary: () => '/usr/bin/ffmpeg',
  ffprobeBinary: () => '/usr/bin/ffprobe',
  ffmpegBinaryFor: (encoder?: string) =>
    encoder === 'nvenc' ? '/usr/bin/ffmpeg-nvenc' : '/usr/bin/ffmpeg',
}));

// AC-29: the repo is mocked so the write methods can be SPIED ON. If the
// diagnostic path ever grows a write, these spies catch it.
vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({
    getAll: () => ({}),
    get: () => undefined,
    set: mockSettingSet,
    delete: mockSettingDelete,
  }),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: mockLoggerWarn,
    debug: vi.fn(),
    error: vi.fn(),
    telemetry: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: mockLoggerWarn,
      debug: vi.fn(),
      error: vi.fn(),
      telemetry: vi.fn(),
    }),
  },
}));

import { runTestEncode, _resetMutexForTesting } from '@/src/lib/diagnostics/test-encode';
import { __forTests_resetKeyframeCache } from '@/src/lib/encode/keyframe';

function makeMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: () => void };
    stderr: EventEmitter & { setEncoding: () => void };
    kill: () => void;
    emitClose: (code: number) => void;
  };
  const mkStream = () => Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stdout = mkStream();
  child.stderr = mkStream();
  child.kill = () => {};
  child.emitClose = (code: number) => child.emit('close', code);
  return child;
}

function detection(over: Partial<DetectionResult> = {}): DetectionResult {
  return {
    detected: ['libx265'],
    activeFromAuto: 'libx265',
    vaapiDevice: '/dev/dri/renderD128',
    warnings: [],
    outcome: {},
    brokenExcerpts: {},
    probeEncodeDisabled: false,
    qsvRateControl: 'icq-full',
    forcedIdrSupported: {},
    ...over,
  } as DetectionResult;
}

/** Run to completion with a spawn that closes with `code`. */
async function run(
  settings: Record<string, string> | (() => Record<string, string>),
  code = 0,
): Promise<Awaited<ReturnType<typeof runTestEncode>>> {
  const child = makeMockChild();
  mockSpawn.mockReturnValue(child);
  const pending = runTestEncode({
    settingsReader: typeof settings === 'function' ? settings : () => settings,
  });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  child.emitClose(code);
  return pending;
}

function spawnedArgs(): string[] {
  return mockSpawn.mock.calls[0][1] as string[];
}
function spawnedBinary(): string {
  return mockSpawn.mock.calls[0][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetMutexForTesting();
  __forTests_resetKeyframeCache();
  delete process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
  mockIsForcedIdrSupported.mockReturnValue(true);
  mockDetectEncoders.mockResolvedValue(detection());
});

describe('AC-10: a pinned, DETECTED encoder is the one probed', () => {
  it('encoder=vaapi while auto prefers qsv → vaapi is probed, not qsv', async () => {
    mockDetectEncoders.mockResolvedValue(
      detection({ detected: ['qsv', 'vaapi', 'libx265'], activeFromAuto: 'qsv' }),
    );
    const { body } = await run({ encoder: 'vaapi' });
    expect(body.encoderPicked).toBe('hevc_vaapi');
    expect(body.encoderRequested).toBe('vaapi');
    expect(spawnedArgs()).toContain('hevc_vaapi');
    // the pre-50-06 behaviour would have probed the auto pick
    expect(spawnedArgs()).not.toContain('hevc_qsv');
  });
});

describe('AC-11: a pinned but UNDETECTED encoder falls back to libx265, like production', () => {
  it('encoder=nvenc with only libx265 detected → libx265', async () => {
    mockDetectEncoders.mockResolvedValue(detection({ detected: ['libx265'] }));
    const { body } = await run({ encoder: 'nvenc' });
    expect(body.encoderPicked).toBe('libx265');
    // AC-28: the divergence is REPORTED, not swallowed — this pair is what the
    // surfaces render as "requested nvenc, ran libx265".
    expect(body.encoderRequested).toBe('nvenc');
    expect(body.encoderRequested).not.toBe(body.encoderPicked);
  });

  it('the binary follows the FALLBACK encoder, not the requested one', async () => {
    mockDetectEncoders.mockResolvedValue(detection({ detected: ['libx265'] }));
    await run({ encoder: 'nvenc' });
    expect(spawnedBinary()).toBe('/usr/bin/ffmpeg');
  });
});

describe('AC-12: auto / absent / junk all land on activeFromAuto', () => {
  for (const [label, settings] of [
    ['explicit auto', { encoder: 'auto' }],
    ['absent', {}],
    ['junk', { encoder: 'hevc_magic' }],
  ] as const) {
    it(`${label} → activeFromAuto`, async () => {
      mockDetectEncoders.mockResolvedValue(
        detection({ detected: ['qsv', 'libx265'], activeFromAuto: 'qsv' }),
      );
      const { body } = await run(settings);
      expect(body.encoderPicked).toBe('hevc_qsv');
    });
  }

  it('the production capacity walk is NOT reproduced — a diagnostic occupies no slot', async () => {
    // detected[0] is taken verbatim; nothing consults per-encoder limits.
    mockDetectEncoders.mockResolvedValue(
      detection({ detected: ['vaapi', 'libx265'], activeFromAuto: 'vaapi' }),
    );
    const { body } = await run({});
    expect(body.encoderPicked).toBe('hevc_vaapi');
  });
});

describe('AC-13: the binary follows the RESOLVED encoder (45-01 dual binary)', () => {
  it('a pinned+detected nvenc spawns the jellyfin binary', async () => {
    mockDetectEncoders.mockResolvedValue(
      detection({ detected: ['nvenc', 'libx265'], activeFromAuto: 'libx265' }),
    );
    await run({ encoder: 'nvenc' });
    expect(spawnedBinary()).toBe('/usr/bin/ffmpeg-nvenc');
  });

  it('AC-27: commandLine[0] IS the spawned binary, and the rest IS the spawned argv', async () => {
    mockDetectEncoders.mockResolvedValue(
      detection({ detected: ['nvenc', 'libx265'], activeFromAuto: 'libx265' }),
    );
    const { body } = await run({ encoder: 'nvenc' });
    expect(body.commandLine[0]).toBe('/usr/bin/ffmpeg-nvenc');
    expect(body.commandLine.slice(1)).toEqual(spawnedArgs());
  });

  it('AC-27: every other encoder reports the BtbN binary', async () => {
    const { body } = await run({});
    expect(body.commandLine[0]).toBe('/usr/bin/ffmpeg');
  });
});

describe('AC-5/AC-7/AC-8/AC-9: the stored settings reach the argv', () => {
  it('crf_<enc> and preset_<enc> are emitted', async () => {
    const { body } = await run({ crf_libx265: '19', preset_libx265: 'veryslow' });
    const a = spawnedArgs();
    expect(a[a.indexOf('-crf') + 1]).toBe('19');
    expect(a[a.indexOf('-preset') + 1]).toBe('veryslow');
    expect(body.crf).toBe(19);
    expect(body.preset).toBe('veryslow');
  });

  it('force_10bit reaches the encoder while the input stays 8-bit', async () => {
    const { body } = await run({ force_10bit: 'true' });
    const a = spawnedArgs();
    expect(a[a.indexOf('-pix_fmt') + 1]).toBe('yuv420p10le');
    expect(a[a.indexOf('-i') + 1]).toContain('format=yuv420p');
    expect(body.force10bit).toBe(true);
  });

  it('the keyframe interval comes from the env resolver, not from a literal', async () => {
    process.env.ENCODE_KEYFRAME_INTERVAL_SEC = '3';
    const { body } = await run({});
    expect(spawnedArgs()).toContain('expr:gte(t,n_forced*3)');
    expect(body.keyframeIntervalSec).toBe(3);
  });

  it('ENCODE_KEYFRAME_INTERVAL_SEC=0 emits no token and reports 0', async () => {
    process.env.ENCODE_KEYFRAME_INTERVAL_SEC = '0';
    const { body } = await run({});
    expect(spawnedArgs()).not.toContain('-force_key_frames');
    expect(body.keyframeIntervalSec).toBe(0);
  });
});

describe('AC-26: a non-finite CRF is reported as "unresolved", never as null', () => {
  it('both crf_<enc> and default_crf unparsable', async () => {
    const { body } = await run({ crf_libx265: 'abc', default_crf: 'xyz' });
    expect(body.crf).toBe('unresolved');
    // The whole point: a bare `number` field would serialise NaN to null and the
    // report would hide the value that kills the encode.
    expect(JSON.parse(JSON.stringify(body)).crf).toBe('unresolved');
  });

  it('a finite CRF is reported as a number and survives serialisation', async () => {
    const { body } = await run({ crf_libx265: '19' });
    expect(JSON.parse(JSON.stringify(body)).crf).toBe(19);
  });
});

describe('AC-25: the settings read is FAIL-OPEN', () => {
  it('a throwing reader still produces a full run on factory defaults', async () => {
    const { body, auditOutcome } = await run(() => {
      throw new Error('database is locked');
    });
    expect(auditOutcome).toBe('success');
    expect(body.success).toBe(true);
    expect(body.settingsSource).toBe('unavailable');
    // factory defaults, i.e. the v2.46.4 shape — NOT the operator's values
    expect(body.crf).toBe(23);
    expect(body.preset).toBe('medium');
    expect(body.force10bit).toBe(false);
    expect(body.encoderRequested).toBe('auto');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('emits EXACTLY ONE test_encode_settings_unavailable warn', async () => {
    await run(() => {
      throw new Error('database is locked');
    });
    const warns = mockLoggerWarn.mock.calls.filter(
      (c) => (c[0] as { action?: string })?.action === 'test_encode_settings_unavailable',
    );
    expect(warns).toHaveLength(1);
  });

  it('a healthy read reports settingsSource "settings"', async () => {
    const { body } = await run({ crf_libx265: '19' });
    expect(body.settingsSource).toBe('settings');
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('a pinned encoder is IGNORED on the fail-open path (nothing was read)', async () => {
    mockDetectEncoders.mockResolvedValue(
      detection({ detected: ['qsv', 'libx265'], activeFromAuto: 'qsv' }),
    );
    const { body } = await run(() => {
      throw new Error('nope');
    });
    expect(body.encoderPicked).toBe('hevc_qsv');
    expect(body.encoderRequested).toBe('auto');
  });
});

describe('AC-29: the diagnostic path writes NOTHING', () => {
  it('no settingRepo.set / .delete during a full run', async () => {
    // Drive the DEFAULT reader (no injected seam) so the mocked repo is used.
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);
    const pending = runTestEncode({});
    for (let i = 0; i < 8; i++) await Promise.resolve();
    child.emitClose(0);
    await pending;
    expect(mockSettingSet).not.toHaveBeenCalled();
    expect(mockSettingDelete).not.toHaveBeenCalled();
  });

  it('the module never imports the writing dispatch resolver', async () => {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync('src/lib/diagnostics/test-encode.ts', 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // resolveEncodeParams writes setCrf + setPresetUsed. Sharing the PURE leaf is
    // the contract; reaching for the dispatch function would drag writes in.
    expect(code).not.toContain('resolveEncodeParams');
    expect(code).not.toContain('jobRepo');
    expect(code).toContain('resolveCrfForEncoder');
  });
});

describe('AC-18: the response is purely ADDITIVE — key SET compared, not key presence', () => {
  it('every v2.46.4 key survives and exactly the 50-06 keys are new', async () => {
    const { body } = await run({});
    const legacy = [
      'success',
      'encoderPicked',
      'durationMs',
      'ffmpegStdout',
      'ffmpegStderr',
      'exitCode',
      'mappedError',
    ];
    const added = [
      'encoderRequested',
      'encoderFallback',
      'crf',
      'preset',
      'force10bit',
      'keyframeIntervalSec',
      'commandLine',
      'settingsSource',
    ];
    expect(Object.keys(body).sort()).toEqual([...legacy, ...added].sort());
  });
});

describe('AC-21: the reported command line carries no library path', () => {
  it('every absolute token is the binary, /dev/null, or a render node', async () => {
    mockDetectEncoders.mockResolvedValue(
      detection({ detected: ['vaapi', 'libx265'], activeFromAuto: 'vaapi' }),
    );
    const { body } = await run({});
    const binary = body.commandLine[0];
    for (const token of body.commandLine) {
      if (!token.startsWith('/')) continue;
      const allowed =
        token === binary || token === '/dev/null' || /^\/dev\/dri\/renderD\d+$/.test(token);
      expect(allowed, `unexpected absolute token: ${token}`).toBe(true);
    }
  });
});
