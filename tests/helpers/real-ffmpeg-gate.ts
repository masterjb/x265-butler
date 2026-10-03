// 52-06 (AC-5): decides what tests/encode/real-ffmpeg-smoke.test.ts does. Without ffmpeg on PATH
// the smoke skips (developers, CI job `test`, whose image has no ffmpeg). The CI job
// `ffmpeg-smoke` sets REQUIRE_REAL_FFMPEG=1 and puts the pinned binary on PATH; there a missing
// ffmpeg must fail the run instead of turning it silently green.

export type RealFfmpegGate = 'run' | 'skip' | 'fail';

export function realFfmpegGate(opts: {
  available: boolean;
  require?: boolean;
  env?: Record<string, string | undefined>;
}): RealFfmpegGate {
  const required = opts.require ?? (opts.env ?? process.env).REQUIRE_REAL_FFMPEG === '1';
  if (opts.available) return 'run';
  return required ? 'fail' : 'skip';
}
