// Resolve the ffmpeg / ffprobe binary path. Honors FFMPEG_PATH / FFPROBE_PATH
// env vars so developers without a libvmaf-capable system ffmpeg can point at
// a local BtbN build (same binary baked into the production Docker image)
// without modifying every spawn call.

import type { EncoderId } from './profiles';

export function ffmpegBinary(): string {
  return process.env.FFMPEG_PATH ?? 'ffmpeg';
}

export function ffprobeBinary(): string {
  return process.env.FFPROBE_PATH ?? 'ffprobe';
}

// 45-01 DUAL-BINARY: encoder-aware ffmpeg selector. encoder=nvenc routes to the
// jellyfin-ffmpeg binary (old NVENC floor → Pascal/Maxwell cards encode; modern
// RTX unaffected). Every other encoder AND undefined keeps the BtbN primary
// (libvmaf + qsv/vaapi/x265). FFMPEG_NVENC_PATH mirrors FFMPEG_PATH for dev and
// is the no-redeploy REVERT lever: set it to `ffmpeg` to force nvenc back onto
// BtbN (re-triggers the Pascal floor refusal — escape hatch only). Read per-call
// (no memoization → no restart needed). ffprobe stays BtbN (encoder-agnostic).
export function ffmpegBinaryFor(encoder?: EncoderId): string {
  if (encoder === 'nvenc') return process.env.FFMPEG_NVENC_PATH ?? 'ffmpeg-nvenc';
  return ffmpegBinary();
}
