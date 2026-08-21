// Phase 24 Plan 24-02 — F4 VAAPI test-encode hwupload-chain regression sentinel.
//
// The /diagnostics test-encode (21-01) hand-built its ffmpeg argv with only
// `-c:v hevc_vaapi`, OMITTING the `-vaapi_device <dev>` + `-vf format=nv12,hwupload`
// chain that every real encode (profiles.ts buildCodecBlock) and the 23-04 boot
// probe (detection.ts buildProbeEncodeArgs) carry → false `-38` on good VAAPI HW.
//
// This file asserts buildTestEncodeArgs reuses buildCodecBlock so the VAAPI init
// chain flows in automatically, while non-VAAPI encoders stay byte-identical in
// the codec block and the test envelope (testsrc 320x240, 5s, -f null /dev/null)
// is preserved. NO mocking of buildCodecBlock — assert against the REAL shared
// builder so this stays a faithful regression sentinel.
//
// 50-06: the builder took an options object and two required inputs (crf, preset)
// so no default can hide inside it again. The helper below supplies the former
// hard-coded values, which keeps every pre-50-06 assertion meaningful.

import { describe, it, expect } from 'vitest';
import {
  buildTestEncodeArgs,
  SYNTHETIC_INPUT_PIX_FMT,
  type TestEncodeArgsInput,
} from '@/src/lib/diagnostics/test-encode';
import { DEFAULT_PRESET_BY_ENCODER, type EncoderId } from '@/src/lib/encode';

// Return the index of the first element of [a, b] appearing adjacently in argv,
// or -1 if the adjacent pair is absent.
function adjacentIndex(argv: string[], a: string, b: string): number {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === a && argv[i + 1] === b) return i;
  }
  return -1;
}

function argvFor(encoder: EncoderId, over: Partial<TestEncodeArgsInput> = {}): string[] {
  return buildTestEncodeArgs({
    encoder,
    crf: 28,
    preset: DEFAULT_PRESET_BY_ENCODER[encoder],
    ...over,
  });
}

const ALL: EncoderId[] = ['vaapi', 'nvenc', 'qsv', 'libx265'];

describe('buildTestEncodeArgs', () => {
  describe('AC-1: VAAPI argv carries the hwupload init chain', () => {
    const argv = argvFor('vaapi');

    it('contains adjacent -vaapi_device <path>', () => {
      const i = argv.indexOf('-vaapi_device');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(argv[i + 1]).toMatch(/^\/dev\/dri\/renderD\d+$/);
    });

    it('contains adjacent -vf format=nv12,hwupload', () => {
      expect(adjacentIndex(argv, '-vf', 'format=nv12,hwupload')).toBeGreaterThanOrEqual(0);
    });

    it('contains adjacent -c:v hevc_vaapi', () => {
      expect(adjacentIndex(argv, '-c:v', 'hevc_vaapi')).toBeGreaterThanOrEqual(0);
    });

    it('-vaapi_device and -vf appear AFTER the -i input arg (production ordering)', () => {
      const iInput = argv.indexOf('-i');
      expect(iInput).toBeGreaterThanOrEqual(0);
      expect(argv.indexOf('-vaapi_device')).toBeGreaterThan(iInput);
      expect(argv.indexOf('-vf')).toBeGreaterThan(iInput);
    });
  });

  describe('AC-2: non-VAAPI encoders byte-identical codec block, no hwupload tokens', () => {
    const cases: Array<[EncoderId, string]> = [
      ['nvenc', 'hevc_nvenc'],
      ['qsv', 'hevc_qsv'],
      ['libx265', 'libx265'],
    ];

    for (const [encoder, codec] of cases) {
      it(`${encoder}: adjacent -c:v ${codec}, no vaapi tokens`, () => {
        const argv = argvFor(encoder);
        expect(adjacentIndex(argv, '-c:v', codec)).toBeGreaterThanOrEqual(0);
        expect(argv).not.toContain('-vaapi_device');
        expect(argv).not.toContain('format=nv12,hwupload');
      });
    }
  });

  describe('test envelope preserved for every encoder', () => {
    for (const encoder of ALL) {
      it(`${encoder}: testsrc 320x240, -t 5, -f null /dev/null`, () => {
        const argv = argvFor(encoder);
        expect(argv.some((t) => t.startsWith('testsrc=size=320x240:rate=1:duration=5'))).toBe(true);
        expect(adjacentIndex(argv, '-t', '5')).toBeGreaterThanOrEqual(0);
        expect(adjacentIndex(argv, '-f', 'null')).toBeGreaterThanOrEqual(0);
        expect(argv[argv.length - 1]).toBe('/dev/null');
      });
    }
  });

  describe('AC-6: devicePath threads through to the vaapi codec block', () => {
    it('vaapi with explicit devicePath probes that node, not the default', () => {
      const argv = argvFor('vaapi', { devicePath: '/dev/dri/renderD129' });
      const i = argv.indexOf('-vaapi_device');
      expect(argv[i + 1]).toBe('/dev/dri/renderD129');
    });

    it('devicePath for a non-vaapi encoder is a harmless no-op', () => {
      const argv = argvFor('nvenc', { devicePath: '/dev/dri/renderD129' });
      expect(argv).not.toContain('/dev/dri/renderD129');
      expect(argv).not.toContain('-vaapi_device');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-03 AC-6: the /diagnostics test encode pins the SAME synthetic pixel format
// as the boot probe. Same root cause (G3): `testsrc` emits rgb24, a modern
// `hevc_qsv` advertises RGB in `pix_fmts` so ffmpeg inserts no converter, iHD
// rejects it → the test encode reports "QSV broken" on a host whose real encodes
// run. The two synthetic builders must agree, or the diagnosis contradicts itself.
// ─────────────────────────────────────────────────────────────────────────────
describe('49-03 AC-6: test-encode argv pins the synthetic pixel format', () => {
  it('qsv and nvenc carry exactly one -pix_fmt nv12', () => {
    for (const encoder of ['qsv', 'nvenc'] as const) {
      const argv = argvFor(encoder);
      expect(adjacentIndex(argv, '-pix_fmt', 'nv12')).toBeGreaterThanOrEqual(0);
      expect(argv.filter((t) => t === '-pix_fmt')).toHaveLength(1);
    }
  });

  it('libx265 and vaapi carry NO -pix_fmt token', () => {
    for (const encoder of ['libx265', 'vaapi'] as const) {
      expect(argvFor(encoder)).not.toContain('-pix_fmt');
    }
  });

  // AC-13 (D7): the builder stays PURE — forceIdr is threaded, never global-read.
  it('AC-13: forceIdr is threaded through and absent by default', () => {
    expect(argvFor('qsv')).not.toContain('-forced_idr');
    expect(argvFor('nvenc')).not.toContain('-forced-idr');

    const qsv = argvFor('qsv', { qsvRateControl: 'icq-full', forceIdr: true });
    expect(adjacentIndex(qsv, '-forced_idr', '1')).toBeGreaterThanOrEqual(0);
    expect(adjacentIndex(qsv, '-pix_fmt', 'nv12')).toBeGreaterThanOrEqual(0);

    const nvenc = argvFor('nvenc', { forceIdr: true });
    expect(adjacentIndex(nvenc, '-forced-idr', '1')).toBeGreaterThanOrEqual(0);

    // vaapi emits no IDR token either way (49-02 design)
    const vaapi = argvFor('vaapi', { forceIdr: true });
    expect(vaapi).not.toContain('-forced_idr');
    expect(vaapi).not.toContain('-forced-idr');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 50-06 — the test encode runs the operator's configuration on 4:2:0 input.
// ─────────────────────────────────────────────────────────────────────────────
describe('50-06 AC-1/AC-3/AC-4: 4:2:0 input, untouched filter chains, untouched pin', () => {
  function lavfiToken(argv: string[]): string {
    const i = argv.indexOf('-i');
    expect(i).toBeGreaterThanOrEqual(0);
    return argv[i + 1];
  }

  it('AC-1: every encoder feeds testsrc through format=yuv420p', () => {
    for (const encoder of ALL) {
      expect(lavfiToken(argvFor(encoder))).toBe(
        `testsrc=size=320x240:rate=1:duration=5,format=${SYNTHETIC_INPUT_PIX_FMT}`,
      );
    }
    expect(SYNTHETIC_INPUT_PIX_FMT).toBe('yuv420p');
  });

  // This assertion REPLACES the 49-03 one that required the lavfi token to carry
  // NO `format=`. That rule meant "the pix_fmt PIN does not get grafted onto the
  // source", and it is preserved BELOW — split in two so inverting the input-side
  // half cannot quietly relax the encoder-side half.
  it('AC-3/AC-4: the pin stays in the CODEC BLOCK, never on the lavfi source', () => {
    for (const encoder of ALL) {
      const argv = argvFor(encoder);
      // the lavfi token carries the 4:2:0 conversion and NOTHING else
      expect(lavfiToken(argv)).not.toContain('nv12');
      expect(lavfiToken(argv)).not.toContain('-pix_fmt');
      // and the encoder-side pin is still an argv token of its own for qsv/nvenc
      if (encoder === 'qsv' || encoder === 'nvenc') {
        expect(adjacentIndex(argv, '-pix_fmt', 'nv12')).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('AC-3: vaapi still emits exactly one -vf, and it is its own hwupload chain', () => {
    const argv = argvFor('vaapi');
    expect(argv.filter((t) => t === '-vf')).toHaveLength(1);
    expect(adjacentIndex(argv, '-vf', 'format=nv12,hwupload')).toBeGreaterThanOrEqual(0);
  });

  // 50-06 review (R-3): AC-3 says the 4:2:0 conversion lives ONLY in the input
  // graph. Asserting "the lavfi token has it" does not say that; this does.
  it('AC-3: the 4:2:0 conversion appears in NO -vf / -filter:v value, for any encoder', () => {
    for (const encoder of ALL) {
      const argv = argvFor(encoder, { tenBit: true, keyframeIntervalSec: 5 });
      const filterValues = argv
        .map((t, i) => (t === '-vf' || t.startsWith('-filter:v') ? argv[i + 1] : null))
        .filter((v): v is string => v !== null);
      for (const v of filterValues) {
        expect(v, `${encoder}: the input conversion leaked into a filter chain`).not.toContain(
          SYNTHETIC_INPUT_PIX_FMT,
        );
      }
    }
  });
});

describe('50-06 AC-5/AC-7: crf and preset come from the caller, never from the builder', () => {
  it('AC-5: libx265 emits the supplied crf', () => {
    expect(adjacentIndex(argvFor('libx265', { crf: 19 }), '-crf', '19')).toBeGreaterThanOrEqual(0);
    expect(argvFor('libx265', { crf: 19 })).not.toContain('28');
  });

  it('AC-5: qsv emits the supplied crf on BOTH ratecontrol tiers', () => {
    const icq = argvFor('qsv', { crf: 26, qsvRateControl: 'icq-full' });
    expect(adjacentIndex(icq, '-global_quality', '26')).toBeGreaterThanOrEqual(0);
    const cqp = argvFor('qsv', { crf: 26, qsvRateControl: 'cqp' });
    expect(adjacentIndex(cqp, '-q:v', '26')).toBeGreaterThanOrEqual(0);
  });

  it('AC-5: nvenc and vaapi emit the supplied crf on their own quality flags', () => {
    expect(adjacentIndex(argvFor('nvenc', { crf: 21 }), '-qp', '21')).toBeGreaterThanOrEqual(0);
    expect(adjacentIndex(argvFor('vaapi', { crf: 22 }), '-qp', '22')).toBeGreaterThanOrEqual(0);
  });

  it('AC-7: the supplied preset is emitted verbatim when the Catalog accepts it', () => {
    expect(
      adjacentIndex(argvFor('libx265', { preset: 'veryslow' }), '-preset', 'veryslow'),
    ).toBeGreaterThanOrEqual(0);
  });

  it('AC-7: an out-of-Catalog preset still falls back inside buildCodecBlock', () => {
    // The defensive 12-03 Catalog-validator lives in profiles.ts and must keep
    // working even though the caller now resolves the preset itself.
    expect(
      adjacentIndex(argvFor('libx265', { preset: 'schnell-bitte' }), '-preset', 'medium'),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('50-06 AC-8: force_10bit reaches the encoder, the INPUT stays 8-bit', () => {
  it('libx265 emits the 10-bit pin and profile', () => {
    const argv = argvFor('libx265', { tenBit: true });
    expect(adjacentIndex(argv, '-pix_fmt', 'yuv420p10le')).toBeGreaterThanOrEqual(0);
    expect(adjacentIndex(argv, '-profile:v', 'main10')).toBeGreaterThanOrEqual(0);
  });

  it('AC-4: with tenBit the qsv/nvenc pin becomes p010le — still exactly ONE -pix_fmt', () => {
    for (const encoder of ['qsv', 'nvenc'] as const) {
      const argv = argvFor(encoder, { tenBit: true });
      expect(argv.filter((t) => t === '-pix_fmt')).toHaveLength(1);
      expect(adjacentIndex(argv, '-pix_fmt', 'p010le')).toBeGreaterThanOrEqual(0);
    }
  });

  it('vaapi swaps its filter-chain format instead of adding a pin', () => {
    const argv = argvFor('vaapi', { tenBit: true });
    expect(adjacentIndex(argv, '-vf', 'format=p010le,hwupload')).toBeGreaterThanOrEqual(0);
  });

  it('the lavfi input stays yuv420p for EVERY encoder even with tenBit on', () => {
    // M-4, measured: an 8-bit input plus the encoder-side 10-bit pin converts via
    // auto_scale. Feeding 10-bit here would simulate a source the operator does
    // not have — force_10bit means "encode my 8-bit source as 10-bit".
    for (const encoder of ALL) {
      const argv = argvFor(encoder, { tenBit: true });
      expect(argv[argv.indexOf('-i') + 1]).toContain('format=yuv420p');
      expect(argv[argv.indexOf('-i') + 1]).not.toContain('10le');
    }
  });

  it('without tenBit no 10-bit token appears anywhere', () => {
    for (const encoder of ALL) {
      const argv = argvFor(encoder);
      expect(argv).not.toContain('yuv420p10le');
      expect(argv).not.toContain('p010le');
      expect(argv).not.toContain('main10');
    }
  });
});

describe('50-06 AC-9: the forced-keyframe interval rides along', () => {
  it('a positive interval emits the time-based expression', () => {
    for (const encoder of ALL) {
      const argv = argvFor(encoder, { keyframeIntervalSec: 5 });
      expect(
        adjacentIndex(argv, '-force_key_frames', 'expr:gte(t,n_forced*5)'),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('the token sits AFTER the codec block and BEFORE the envelope tail', () => {
    const argv = argvFor('libx265', { keyframeIntervalSec: 5 });
    expect(argv.indexOf('-force_key_frames')).toBeGreaterThan(argv.indexOf('-c:v'));
    expect(argv.indexOf('-force_key_frames')).toBeLessThan(argv.indexOf('-t'));
  });

  it('0 and omitted emit NO token at all (the explicit off-state)', () => {
    for (const encoder of ALL) {
      expect(argvFor(encoder, { keyframeIntervalSec: 0 })).not.toContain('-force_key_frames');
      expect(argvFor(encoder)).not.toContain('-force_key_frames');
    }
  });

  it('no ordinal-narrowed variant exists here — there is one synthetic stream', () => {
    const argv = argvFor('libx265', { keyframeIntervalSec: 5 });
    expect(argv.some((t) => t.startsWith('-force_key_frames:v:'))).toBe(false);
  });
});
