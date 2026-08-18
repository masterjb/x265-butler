// 45-01 DUAL-BINARY: ffmpegBinaryFor(encoder) selector coverage.
// nvenc routes to the jellyfin ffmpeg-nvenc binary (Pascal/Maxwell floor); every
// other encoder + undefined keeps the BtbN primary. FFMPEG_NVENC_PATH / FFMPEG_PATH
// are the dev + no-redeploy-revert overrides.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ffmpegBinary, ffmpegBinaryFor } from './ffmpeg-binary';

describe('ffmpegBinaryFor', () => {
  let savedFfmpeg: string | undefined;
  let savedNvenc: string | undefined;

  beforeEach(() => {
    savedFfmpeg = process.env.FFMPEG_PATH;
    savedNvenc = process.env.FFMPEG_NVENC_PATH;
    delete process.env.FFMPEG_PATH;
    delete process.env.FFMPEG_NVENC_PATH;
  });

  afterEach(() => {
    if (savedFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = savedFfmpeg;
    if (savedNvenc === undefined) delete process.env.FFMPEG_NVENC_PATH;
    else process.env.FFMPEG_NVENC_PATH = savedNvenc;
  });

  it("routes 'nvenc' to the jellyfin binary when FFMPEG_NVENC_PATH is unset", () => {
    expect(ffmpegBinaryFor('nvenc')).toBe('ffmpeg-nvenc');
  });

  it("routes 'nvenc' to FFMPEG_NVENC_PATH when set", () => {
    process.env.FFMPEG_NVENC_PATH = '/opt/jellyfin/ffmpeg';
    expect(ffmpegBinaryFor('nvenc')).toBe('/opt/jellyfin/ffmpeg');
  });

  it('FFMPEG_NVENC_PATH=ffmpeg is the no-redeploy revert lever (nvenc back onto BtbN)', () => {
    process.env.FFMPEG_NVENC_PATH = 'ffmpeg';
    expect(ffmpegBinaryFor('nvenc')).toBe('ffmpeg');
  });

  it.each(['qsv', 'vaapi', 'libx265'] as const)(
    "routes '%s' to the BtbN primary (ffmpeg)",
    (encoder) => {
      expect(ffmpegBinaryFor(encoder)).toBe('ffmpeg');
    },
  );

  it('routes undefined to the BtbN primary (ffmpeg)', () => {
    expect(ffmpegBinaryFor(undefined)).toBe('ffmpeg');
    expect(ffmpegBinaryFor()).toBe('ffmpeg');
  });

  it('non-nvenc encoders honor FFMPEG_PATH (same as ffmpegBinary)', () => {
    process.env.FFMPEG_PATH = '/usr/local/bin/btbn-ffmpeg';
    expect(ffmpegBinaryFor('qsv')).toBe('/usr/local/bin/btbn-ffmpeg');
    expect(ffmpegBinaryFor(undefined)).toBe('/usr/local/bin/btbn-ffmpeg');
    expect(ffmpegBinaryFor('qsv')).toBe(ffmpegBinary());
  });

  it('nvenc does NOT read FFMPEG_PATH (only FFMPEG_NVENC_PATH)', () => {
    process.env.FFMPEG_PATH = '/usr/local/bin/btbn-ffmpeg';
    expect(ffmpegBinaryFor('nvenc')).toBe('ffmpeg-nvenc');
  });
});
