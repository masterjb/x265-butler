// 52-05 (E4): the bench DB and form speak ffmpeg encoder names ("hevc_nvenc"),
// production code (buildCodecBlock, PRESETS_BY_ENCODER, ffmpegBinaryFor) speaks
// EncoderId ("nvenc"). One mapping, as a leaf without Node imports, so the
// orchestrator, the API validation and the client form cannot drift apart.
import type { EncoderId } from '../encode/profiles';

export const BENCH_ENCODER_TO_PRODUCTION_ID: Readonly<Record<string, EncoderId>> = Object.freeze({
  libx265: 'libx265',
  hevc_nvenc: 'nvenc',
  hevc_qsv: 'qsv',
  hevc_vaapi: 'vaapi',
});

export function isKnownBenchEncoder(benchEncoder: string): boolean {
  return Object.prototype.hasOwnProperty.call(BENCH_ENCODER_TO_PRODUCTION_ID, benchEncoder);
}

export function normalizeBenchEncoderToProductionId(benchEncoder: string): EncoderId {
  const mapped = isKnownBenchEncoder(benchEncoder)
    ? BENCH_ENCODER_TO_PRODUCTION_ID[benchEncoder]
    : undefined;
  if (!mapped) {
    throw new Error(`bench encoder '${benchEncoder}' has no production EncoderId mapping`);
  }
  return mapped;
}
