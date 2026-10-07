// @vitest-environment node
//
// Bench Pass-1 argv isolation.
//
// WHY THIS FILE EXISTS AS EXECUTED ARGV ASSERTIONS, NOT AS A GREP:
// a grep on `pixFmt` / `forceIdr` / `ENCODE_CLOSED_GOP_DISABLED` counts TEXT
// PATTERNS — and the change that added the pixel-format pin (and the IDR change
// before it) writes those exact names into profiles.ts COMMENTS. Such a gate
// passes on its own documentation and proves nothing: a self-referential gate.
// So the invariant is asserted the
// only way that cannot lie: build the argv the way bench Pass-1 builds it, and
// look at the tokens.
//
// THE INVARIANT: bench Pass-1 — `encodeForBench` (bench/vmaf.ts) and the CRF
// probe sweep (bench/orchestrator.ts, which routes through encodeForBench) —
// calls `buildCodecBlock` DIRECTLY, bypassing `buildArgs`. It must therefore
// inherit NEITHER the `-pix_fmt` pin NOR the forced-IDR tokens, or every
// historical VMAF comparison shifts underneath the operator.
//
// TWO SEPARATE LEAK PATHS ARE COVERED:
//   1. env   — a `process.env` read inside the builder (no env read in profiles.ts)
//   2. cache — a `globalThis.__x265butler_encoder_cache` read inside the builder
//              (the same rule extended to the detection cache). Both verdict read sites must live in
//              ffmpeg.ts (buildArgs) and test-encode.ts (runTestEncode) only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildCodecBlock,
  DEFAULT_PRESET_BY_ENCODER,
  ENCODER_IDS,
  __forTests_resetX265PoolsCache,
  type EncoderId,
} from '@/src/lib/encode/profiles';
import { __forTests_resetKeyframeCache } from '@/src/lib/encode/keyframe';
import { __forTests_resetEncoderCache } from '@/src/lib/encode/detection';
import type { DetectionResult } from '@/src/lib/encode/detection';
import { __forTests_buildProbeEncodeArgs } from '@/src/lib/encode/detection';

// Mirror of the bench Pass-1 call shape (bench/vmaf.ts `encodeForBench`): encoder,
// crf, preset, optional devicePath, and — for qsv only — the detection-validated
// ratecontrol variant. NOTHING else is ever passed. If a future edit adds a field
// here to make a test pass, that edit IS the regression.
function benchPass1CodecBlock(encoder: EncoderId, qsvRateControl?: 'icq-full' | 'cqp'): string[] {
  return buildCodecBlock({
    encoder,
    crf: 24,
    preset: DEFAULT_PRESET_BY_ENCODER[encoder],
    devicePath: encoder === 'vaapi' ? '/dev/dri/renderD128' : undefined,
    qsvRateControl: encoder === 'qsv' ? (qsvRateControl ?? 'icq-full') : undefined,
  });
}

const FORBIDDEN_TOKENS = ['-pix_fmt', '-forced_idr', '-forced-idr'];

function expectCleanBenchArgv(argv: string[]): void {
  for (const token of FORBIDDEN_TOKENS) expect(argv).not.toContain(token);
  // libx265 carries `open-gop=0` inside the single `-x265-params` token, not as
  // a standalone argv element — check the joined string for that one.
  expect(argv.join(' ')).not.toContain('open-gop');
  expect(argv.join(' ')).not.toContain('nv12,hwupload,'); // chain not mutated
}

const ORIG_ENV = {
  closedGop: process.env.ENCODE_CLOSED_GOP_DISABLED,
  interval: process.env.ENCODE_KEYFRAME_INTERVAL_SEC,
  pools: process.env.X265_POOLS,
};

beforeEach(() => {
  // Pin the libx265 thread pool to the native path so the frozen argv below is
  // deterministic across CI hosts (same discipline as profiles.test.ts).
  process.env.X265_POOLS = '0';
  __forTests_resetX265PoolsCache();
  __forTests_resetKeyframeCache();
  __forTests_resetEncoderCache();
});

afterEach(() => {
  for (const [key, value] of [
    ['ENCODE_CLOSED_GOP_DISABLED', ORIG_ENV.closedGop],
    ['ENCODE_KEYFRAME_INTERVAL_SEC', ORIG_ENV.interval],
    ['X265_POOLS', ORIG_ENV.pools],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __forTests_resetX265PoolsCache();
  __forTests_resetKeyframeCache();
  __forTests_resetEncoderCache();
});

describe('bench Pass-1 inherits neither pixFmt nor forceIdr', () => {
  it('every encoder: no -pix_fmt, no IDR token, no open-gop segment', () => {
    for (const encoder of ENCODER_IDS) {
      expectCleanBenchArgv(benchPass1CodecBlock(encoder));
    }
    // both qsv ratecontrol branches
    expectCleanBenchArgv(benchPass1CodecBlock('qsv', 'cqp'));
  });

  // The v2.45.0 argv, frozen as literals. These are the exact token lists bench
  // Pass-1 produced BEFORE forceIdr and pixFmt were introduced.
  it('the bench Pass-1 argv is token-identical to v2.45.0', () => {
    expect(benchPass1CodecBlock('libx265')).toEqual([
      '-c:v',
      'libx265',
      '-preset',
      'medium',
      '-crf',
      '24',
    ]);
    expect(benchPass1CodecBlock('nvenc')).toEqual([
      '-c:v',
      'hevc_nvenc',
      '-preset',
      'p5',
      '-tune',
      'hq',
      '-rc',
      'constqp',
      '-qp',
      '24',
      '-b:v',
      '0',
    ]);
    expect(benchPass1CodecBlock('qsv', 'icq-full')).toEqual([
      '-c:v',
      'hevc_qsv',
      '-preset',
      'slow',
      '-global_quality',
      '24',
      '-low_power',
      '0',
    ]);
    expect(benchPass1CodecBlock('qsv', 'cqp')).toEqual([
      '-c:v',
      'hevc_qsv',
      '-preset',
      'slow',
      '-q:v',
      '24',
    ]);
    expect(benchPass1CodecBlock('vaapi')).toEqual([
      '-vaapi_device',
      '/dev/dri/renderD128',
      '-vf',
      'format=nv12,hwupload',
      '-c:v',
      'hevc_vaapi',
      '-preset',
      'slow',
      '-rc_mode',
      'CQP',
      '-qp',
      '24',
      '-compression_level',
      '1',
    ]);
  });

  // Leak path 1 (no env read in profiles.ts), EXECUTED: flipping either keyframe env
  // must not move a single token in the bench argv. A grep on the env NAME would
  // hit the keyframe comment inside profiles.ts and pass regardless.
  it('neither keyframe env var changes the bench Pass-1 argv', () => {
    const baseline = ENCODER_IDS.map((e) => benchPass1CodecBlock(e));

    for (const env of [
      { ENCODE_CLOSED_GOP_DISABLED: '1' },
      { ENCODE_CLOSED_GOP_DISABLED: '0' },
      { ENCODE_KEYFRAME_INTERVAL_SEC: '2' },
      { ENCODE_KEYFRAME_INTERVAL_SEC: '0' },
    ]) {
      Object.assign(process.env, env);
      __forTests_resetKeyframeCache();
      ENCODER_IDS.forEach((e, i) => expect(benchPass1CodecBlock(e)).toEqual(baseline[i]));
      for (const key of Object.keys(env)) delete process.env[key];
      __forTests_resetKeyframeCache();
    }
  });
});

// The "no env read in profiles.ts" invariant gains a sibling — no
// DETECTION-CACHE read either. `encodeForBench` calls buildCodecBlock DIRECTLY,
// so an `isForcedIdrSupported()` call one level deeper would push the IDR pin (or
// its absence) into every bench Pass-1 encode, silently and untested.
describe('the detection cache never reaches the bench Pass-1 argv', () => {
  function seedCache(forcedIdrSupported: Partial<Record<EncoderId, boolean>>): void {
    globalThis.__x265butler_encoder_cache = {
      detected: ['qsv', 'libx265'],
      activeFromAuto: 'qsv',
      warnings: [],
      outcome: {
        nvenc: 'missing',
        qsv: 'functional',
        vaapi: 'missing',
        libx265: 'functional',
      },
      brokenExcerpts: {},
      probeEncodeDisabled: false,
      qsvRateControl: 'icq-full',
      forcedIdrSupported,
    } satisfies DetectionResult;
  }

  it('a negative verdict in the cache does NOT change the bench argv', () => {
    const baseline = ENCODER_IDS.map((e) => benchPass1CodecBlock(e));
    seedCache({ qsv: false });
    ENCODER_IDS.forEach((e, i) => expect(benchPass1CodecBlock(e)).toEqual(baseline[i]));
    expectCleanBenchArgv(benchPass1CodecBlock('qsv'));
  });

  it('a positive verdict in the cache does NOT change the bench argv either', () => {
    const baseline = ENCODER_IDS.map((e) => benchPass1CodecBlock(e));
    seedCache({ qsv: true, nvenc: true });
    ENCODER_IDS.forEach((e, i) => expect(benchPass1CodecBlock(e)).toEqual(baseline[i]));
    expectCleanBenchArgv(benchPass1CodecBlock('nvenc'));
  });
});

// ── The frame gate + the argv job-log line leave bench Pass-1 byte-identical.
// The frame gate touches neither buildCodecBlock nor buildArgs —
// the argv line is written through onLogChunk, not into the argument vector, and
// the gate lives in verifyOutput, which Pass-1 never reaches. Asserted, not
// asserted-by-comment: the tokens are read off a real build.
describe('bench Pass-1 argv is untouched by the frame gate', () => {
  it('no frame-gate token ever appears in a bench Pass-1 codec block', () => {
    for (const encoder of ENCODER_IDS) {
      const argv = benchPass1CodecBlock(encoder);
      expectCleanBenchArgv(argv);
      // The frame gate adds NO argument at all — the argv line goes to the job log only.
      expect(argv).not.toContain('-count_packets');
      expect(argv.join(' ')).not.toContain('ffmpeg argv:');
      expect(argv.join(' ')).not.toContain('frame_gate');
    }
  });

  it('the frame-gate kill-switch does not reach the bench builder', () => {
    const baseline = ENCODER_IDS.map((e) => benchPass1CodecBlock(e));
    process.env.ENCODE_FRAME_GATE_DISABLED = '1';
    try {
      ENCODER_IDS.forEach((e, i) => expect(benchPass1CodecBlock(e)).toEqual(baseline[i]));
    } finally {
      delete process.env.ENCODE_FRAME_GATE_DISABLED;
    }
  });
});

// ── The MKV cover-attach branch leaves bench Pass-1 byte-identical.
// Pass-1 calls buildCodecBlock DIRECTLY and never reaches buildArgs, which is
// where every cover-attach token is produced (`-attach`, `-map -0:v:`, `-metadata:s:t`).
// Asserted on real builds, not by comment — and the kill-switch is flipped to
// prove it cannot reach the builder either (buildArgs is the ONLY reader).
describe('bench Pass-1 argv is untouched by the cover attach branch', () => {
  it('no cover-attach token ever appears in a bench Pass-1 codec block', () => {
    for (const encoder of ENCODER_IDS) {
      const argv = benchPass1CodecBlock(encoder);
      expectCleanBenchArgv(argv);
      expect(argv).not.toContain('-attach');
      expect(argv.some((t) => t.startsWith('-metadata:s:t'))).toBe(false);
      expect(argv.some((t) => t.startsWith('-0:v:'))).toBe(false);
      expect(argv.join(' ')).not.toContain('-map');
    }
  });

  it('the cover-attach kill-switch does not reach the bench builder', () => {
    const baseline = ENCODER_IDS.map((e) => benchPass1CodecBlock(e));
    process.env.ENCODE_COVER_ATTACH_DISABLED = '1';
    try {
      ENCODER_IDS.forEach((e, i) => expect(benchPass1CodecBlock(e)).toEqual(baseline[i]));
    } finally {
      delete process.env.ENCODE_COVER_ATTACH_DISABLED;
    }
  });
});

describe('bench and boot probe never carry hardware decode tokens', () => {
  const HW_DECODE_MARKERS = ['-hwaccel', '-hwaccel_output_format', '-filter_hw_device'];

  function expectNoHwDecode(argv: string[]): void {
    for (const token of HW_DECODE_MARKERS) expect(argv).not.toContain(token);
    expect(argv.join(' ')).not.toContain('scale_vaapi');
    expect(argv.join(' ')).not.toContain('vaapi=va:');
  }

  it('bench Pass-1 codec block for every encoder', () => {
    for (const encoder of ENCODER_IDS) expectNoHwDecode(benchPass1CodecBlock(encoder));
  });

  it('boot probe argv for vaapi keeps the plain device and upload chain', () => {
    const argv = __forTests_buildProbeEncodeArgs('vaapi', '/dev/dri/renderD128');
    expectNoHwDecode(argv);
    expect(argv).toContain('-vaapi_device');
  });
});
