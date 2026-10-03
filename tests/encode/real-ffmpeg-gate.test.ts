import { describe, it, expect } from 'vitest';
import { realFfmpegGate } from '../helpers/real-ffmpeg-gate';

/**
 * 52-06 (AC-5): tests/encode/real-ffmpeg-smoke.test.ts skips without ffmpeg on PATH. The CI test
 * image has none, so until 52-06 the smoke ran nowhere in CI and nobody noticed. The CI job
 * `ffmpeg-smoke` sets REQUIRE_REAL_FFMPEG=1: there a missing ffmpeg must fail, not skip.
 */
describe('realFfmpegGate', () => {
  it('runs whenever ffmpeg is available', () => {
    expect(realFfmpegGate({ require: false, available: true })).toBe('run');
    expect(realFfmpegGate({ require: true, available: true })).toBe('run');
  });

  it('skips without ffmpeg when nothing requires it (developers, job `test`)', () => {
    expect(realFfmpegGate({ require: false, available: false })).toBe('skip');
  });

  it('fails without ffmpeg when REQUIRE_REAL_FFMPEG is set', () => {
    expect(realFfmpegGate({ require: true, available: false })).toBe('fail');
  });

  it('reads the requirement from the env exactly as "1"', () => {
    expect(realFfmpegGate({ env: { REQUIRE_REAL_FFMPEG: '1' }, available: false })).toBe('fail');
    expect(realFfmpegGate({ env: { REQUIRE_REAL_FFMPEG: 'true' }, available: false })).toBe('skip');
    expect(realFfmpegGate({ env: {}, available: false })).toBe('skip');
  });
});
