// Resolve the ffmpeg / ffprobe binary path. Honors FFMPEG_PATH / FFPROBE_PATH
// env vars so developers without a libvmaf-capable system ffmpeg can point at
// a local BtbN build (same binary baked into the production Docker image)
// without modifying every spawn call.

export function ffmpegBinary(): string {
  return process.env.FFMPEG_PATH ?? 'ffmpeg';
}

export function ffprobeBinary(): string {
  return process.env.FFPROBE_PATH ?? 'ffprobe';
}
