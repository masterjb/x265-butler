/*
 * 49-05 AC-11 + AC-11b — the bench_combo display parameter is resolved at row
 * CREATION time and names the flag the encoder really emits.
 *
 * Two corrections, one rule:
 *   - hevc_qsv was statically '-global_quality', which is a lie on a CQP host.
 *     The tier is not stored on the row, so the fix has to happen where the row
 *     is born; fixing it in the render layer would reinterpret OLD rows with
 *     TODAY's host tier and make the history lie instead of the future.
 *   - hevc_nvenc was '-cq', which no code path has ever emitted
 *     (PROFILE_BUILDERS.nvenc emits `-rc constqp -qp <crf>`).
 *
 * Both assertions are bound to the BUILDER output, not to a second hardcoded
 * table — otherwise this test would only restate the constant it is guarding.
 */

import { describe, it, expect } from 'vitest';
import { resolveNativeQualityParam } from '@/src/lib/bench/orchestrator';
import { buildCodecBlock } from '@/src/lib/encode/profiles';
import { getActiveQsvRateControl } from '@/src/lib/encode/detection';

describe('49-05 AC-11: hevc_qsv resolves per tier', () => {
  it("cqp → '-q:v', and the builder emits exactly that", () => {
    expect(resolveNativeQualityParam('hevc_qsv', 'cqp')).toBe('-q:v');
    expect(
      buildCodecBlock({ encoder: 'qsv', crf: 26, preset: 'slow', qsvRateControl: 'cqp' }),
    ).toContain('-q:v');
  });

  it("icq-full → '-global_quality', and the builder emits exactly that", () => {
    expect(resolveNativeQualityParam('hevc_qsv', 'icq-full')).toBe('-global_quality');
    expect(
      buildCodecBlock({ encoder: 'qsv', crf: 26, preset: 'slow', qsvRateControl: 'icq-full' }),
    ).toContain('-global_quality');
  });

  it('the default argument is the same fallback detection resolves', () => {
    // Empty globalThis cache → getActiveQsvRateControl() === 'icq-full'. If that
    // fallback is ever flipped, this pins that BOTH places move together.
    expect(resolveNativeQualityParam('hevc_qsv')).toBe(
      resolveNativeQualityParam('hevc_qsv', getActiveQsvRateControl()),
    );
  });
});

describe('49-05 AC-11b: hevc_nvenc is -qp, not -cq', () => {
  it("resolves to '-qp'", () => {
    expect(resolveNativeQualityParam('hevc_nvenc')).toBe('-qp');
  });

  it('the nvenc builder emits -qp and has never emitted -cq', () => {
    const argv = buildCodecBlock({ encoder: 'nvenc', crf: 23, preset: 'p5' });
    expect(argv).toContain('-qp');
    expect(argv).not.toContain('-cq');
  });
});

describe('49-05: the two untouched entries stay bound to their builders', () => {
  it.each([
    ['libx265', 'libx265', '-crf'],
    ['hevc_vaapi', 'vaapi', '-qp'],
  ] as const)('%s → %s emits %s', (benchName, encoder, param) => {
    expect(resolveNativeQualityParam(benchName)).toBe(param);
    expect(
      buildCodecBlock({
        encoder,
        crf: 23,
        preset: encoder === 'libx265' ? 'medium' : 'slow',
        devicePath: encoder === 'vaapi' ? '/dev/dri/renderD128' : undefined,
      }),
    ).toContain(param);
  });

  it('an unknown encoder name still degrades to -crf (pre-49-05 behaviour)', () => {
    expect(resolveNativeQualityParam('av1_something')).toBe('-crf');
  });
});
