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

import { describe, it, expect } from 'vitest';
import { buildTestEncodeArgs } from '@/src/lib/diagnostics/test-encode';
import type { EncoderId } from '@/src/lib/encode';

// Return the index of the first element of [a, b] appearing adjacently in argv,
// or -1 if the adjacent pair is absent.
function adjacentIndex(argv: string[], a: string, b: string): number {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === a && argv[i + 1] === b) return i;
  }
  return -1;
}

describe('buildTestEncodeArgs', () => {
  describe('AC-1: VAAPI argv carries the hwupload init chain', () => {
    const argv = buildTestEncodeArgs('vaapi');

    it('contains adjacent -vaapi_device <path>', () => {
      const i = argv.indexOf('-vaapi_device');
      expect(i).toBeGreaterThanOrEqual(0);
      // the value immediately after must be a non-flag device path
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
        const argv = buildTestEncodeArgs(encoder);
        expect(adjacentIndex(argv, '-c:v', codec)).toBeGreaterThanOrEqual(0);
        expect(argv).not.toContain('-vaapi_device');
        expect(argv).not.toContain('format=nv12,hwupload');
      });
    }
  });

  describe('test envelope preserved for every encoder', () => {
    const encoders: EncoderId[] = ['vaapi', 'nvenc', 'qsv', 'libx265'];
    for (const encoder of encoders) {
      it(`${encoder}: testsrc 320x240, -t 5, -f null /dev/null`, () => {
        const argv = buildTestEncodeArgs(encoder);
        expect(argv).toContain('testsrc=size=320x240:rate=1:duration=5');
        expect(adjacentIndex(argv, '-t', '5')).toBeGreaterThanOrEqual(0);
        expect(adjacentIndex(argv, '-f', 'null')).toBeGreaterThanOrEqual(0);
        expect(argv[argv.length - 1]).toBe('/dev/null');
      });
    }
  });

  describe('AC-6: devicePath threads through to the vaapi codec block', () => {
    it('vaapi with explicit devicePath probes that node, not the default', () => {
      const argv = buildTestEncodeArgs('vaapi', '/dev/dri/renderD129');
      const i = argv.indexOf('-vaapi_device');
      expect(argv[i + 1]).toBe('/dev/dri/renderD129');
    });

    it('devicePath for a non-vaapi encoder is a harmless no-op', () => {
      const argv = buildTestEncodeArgs('nvenc', '/dev/dri/renderD129');
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
      const argv = buildTestEncodeArgs(encoder);
      expect(adjacentIndex(argv, '-pix_fmt', 'nv12')).toBeGreaterThanOrEqual(0);
      expect(argv.filter((t) => t === '-pix_fmt')).toHaveLength(1);
    }
  });

  it('libx265 and vaapi carry NO -pix_fmt token', () => {
    for (const encoder of ['libx265', 'vaapi'] as const) {
      expect(buildTestEncodeArgs(encoder)).not.toContain('-pix_fmt');
    }
  });

  it('the envelope is unchanged for every encoder (testsrc 320x240 d=5, -t 5, -f null)', () => {
    for (const encoder of ['vaapi', 'nvenc', 'qsv', 'libx265'] as const) {
      const argv = buildTestEncodeArgs(encoder);
      expect(argv).toContain('testsrc=size=320x240:rate=1:duration=5');
      expect(adjacentIndex(argv, '-t', '5')).toBeGreaterThanOrEqual(0);
      expect(adjacentIndex(argv, '-f', 'null')).toBeGreaterThanOrEqual(0);
      expect(argv[argv.length - 1]).toBe('/dev/null');
      // the pin lives in the codec block, NOT grafted onto the lavfi source
      expect(argv.some((t) => t.startsWith('testsrc=') && t.includes('format='))).toBe(false);
    }
  });

  // AC-13 (D7): the builder stays PURE — forceIdr is threaded, never global-read.
  it('AC-13: forceIdr is threaded through and absent by default', () => {
    expect(buildTestEncodeArgs('qsv')).not.toContain('-forced_idr');
    expect(buildTestEncodeArgs('nvenc')).not.toContain('-forced-idr');

    const qsv = buildTestEncodeArgs('qsv', undefined, 'icq-full', true);
    expect(adjacentIndex(qsv, '-forced_idr', '1')).toBeGreaterThanOrEqual(0);
    expect(adjacentIndex(qsv, '-pix_fmt', 'nv12')).toBeGreaterThanOrEqual(0);

    const nvenc = buildTestEncodeArgs('nvenc', undefined, undefined, true);
    expect(adjacentIndex(nvenc, '-forced-idr', '1')).toBeGreaterThanOrEqual(0);

    // vaapi emits no IDR token either way (49-02 design)
    const vaapi = buildTestEncodeArgs('vaapi', undefined, undefined, true);
    expect(vaapi).not.toContain('-forced_idr');
    expect(vaapi).not.toContain('-forced-idr');
  });
});
