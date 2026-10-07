// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  VAAPI_HW_DECODE_SETTING_KEY,
  VAAPI_HW_DECODE_CODECS,
  parseVaapiHwDecode,
  resolveVaapiDecode,
  encodedVideoCodecs,
  vaapiDecodeInputArgs,
  createVaapiFallbackDetector,
} from '@/src/lib/encode/hw-decode';
import {
  buildCodecBlock,
  __forTests_resetX265PoolsCache,
  type EncoderId,
} from '@/src/lib/encode/profiles';
import { buildArgs } from '@/src/lib/encode/ffmpeg';
import { __forTests_resetKeyframeCache } from '@/src/lib/encode/keyframe';
import type { ProbeResult, ProbeStream } from '@/src/lib/scan/ffprobe';

const ORIG_ENV = {
  pools: process.env.X265_POOLS,
  interval: process.env.ENCODE_KEYFRAME_INTERVAL_SEC,
  closedGop: process.env.ENCODE_CLOSED_GOP_DISABLED,
};

beforeEach(() => {
  process.env.X265_POOLS = '0';
  process.env.ENCODE_KEYFRAME_INTERVAL_SEC = '0';
  process.env.ENCODE_CLOSED_GOP_DISABLED = '1';
  __forTests_resetX265PoolsCache();
  __forTests_resetKeyframeCache();
});

afterEach(() => {
  for (const [key, value] of [
    ['X265_POOLS', ORIG_ENV.pools],
    ['ENCODE_KEYFRAME_INTERVAL_SEC', ORIG_ENV.interval],
    ['ENCODE_CLOSED_GOP_DISABLED', ORIG_ENV.closedGop],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __forTests_resetX265PoolsCache();
  __forTests_resetKeyframeCache();
});

const CROP = '1920:800:0:140';

describe('vaapi hardware decode setting', () => {
  it('uses the vaapi_hw_decode key and is on only for the exact string true', () => {
    expect(VAAPI_HW_DECODE_SETTING_KEY).toBe('vaapi_hw_decode');
    expect(parseVaapiHwDecode('true')).toBe(true);
    for (const raw of ['false', 'TRUE', '1', 'yes', '', null, undefined]) {
      expect(parseVaapiHwDecode(raw)).toBe(false);
    }
  });

  it('lists exactly the codecs with a hardware decode path', () => {
    expect([...VAAPI_HW_DECODE_CODECS].sort()).toEqual(
      ['av1', 'h264', 'hevc', 'mpeg2video', 'vc1', 'vp9'].sort(),
    );
  });
});

describe('resolveVaapiDecode', () => {
  const base = { enabled: true, encoder: 'vaapi' as EncoderId, sourceCodecs: ['hevc'] };

  it.each<[string, Parameters<typeof resolveVaapiDecode>[0], string, string | null | undefined]>([
    ['setting off', { ...base, enabled: false }, 'off', undefined],
    ['libx265 encoder', { ...base, encoder: 'libx265' }, 'off', undefined],
    ['nvenc encoder', { ...base, encoder: 'nvenc' }, 'off', undefined],
    ['qsv encoder', { ...base, encoder: 'qsv' }, 'off', undefined],
    ['listed codec, no crop', base, 'zero-copy', undefined],
    ['listed codec, upper case', { ...base, sourceCodecs: [' HEVC '] }, 'zero-copy', undefined],
    ['listed codec, crop', { ...base, crop: CROP }, 'download', undefined],
    ['listed codec, empty crop string', { ...base, crop: '' }, 'zero-copy', undefined],
    ['unlisted codec', { ...base, sourceCodecs: ['prores'] }, 'cpu', 'prores'],
    ['null codec', { ...base, sourceCodecs: [null] }, 'cpu', null],
    ['empty codec', { ...base, sourceCodecs: [''] }, 'cpu', null],
    ['no codecs at all', { ...base, sourceCodecs: [] }, 'cpu', null],
    ['second stream unlisted', { ...base, sourceCodecs: ['h264', 'prores'] }, 'cpu', 'prores'],
    ['two listed streams', { ...base, sourceCodecs: ['h264', 'hevc'] }, 'zero-copy', undefined],
  ])('%s', (_name, input, mode, unlisted) => {
    const result = resolveVaapiDecode(input);
    expect(result.mode).toBe(mode);
    if (mode === 'cpu') expect(result.unlistedCodec).toBe(unlisted);
    else expect(result.unlistedCodec).toBeUndefined();
  });
});

function stream(index: number, codec: string, attachedPic = false): ProbeStream {
  return { index, codec_type: 'video', codec_name: codec, attachedPic };
}

function probe(codec: string, streams?: ProbeStream[]): ProbeResult {
  return {
    codec,
    bitrate: null,
    durationSeconds: 10,
    width: 1920,
    height: 1080,
    container: 'mov,mp4',
    color: { space: null, primaries: null, transfer: null, range: null },
    hdr10: { masterDisplay: null, maxCll: null },
    tags: {},
    streams,
  };
}

describe('encodedVideoCodecs', () => {
  it('skips a cover stream at ordinal 0 and audio streams', () => {
    const p = probe('mjpeg', [
      stream(0, 'mjpeg', true),
      stream(1, 'h264'),
      { index: 2, codec_type: 'audio', codec_name: 'aac', attachedPic: false },
    ]);
    expect(encodedVideoCodecs(p)).toEqual(['h264']);
  });

  it('returns every encoded video stream', () => {
    expect(encodedVideoCodecs(probe('h264', [stream(0, 'h264'), stream(1, 'prores')]))).toEqual([
      'h264',
      'prores',
    ]);
  });

  it('keeps a stream without codec name as null so the decision falls back to the CPU', () => {
    const p = probe('h264', [
      stream(0, 'h264'),
      { index: 1, codec_type: 'video', attachedPic: false },
    ]);
    expect(encodedVideoCodecs(p)).toEqual(['h264', null]);
  });

  it('falls back to the probe codec when the stream list is absent', () => {
    expect(encodedVideoCodecs(probe('hevc'))).toEqual(['hevc']);
  });
});

describe('vaapiDecodeInputArgs', () => {
  it('zero-copy keeps decoded frames on the GPU', () => {
    expect(vaapiDecodeInputArgs('zero-copy')).toEqual([
      '-hwaccel',
      'vaapi',
      '-hwaccel_device',
      'va',
      '-hwaccel_output_format',
      'vaapi',
    ]);
  });

  it('download lets ffmpeg copy decoded frames to RAM', () => {
    expect(vaapiDecodeInputArgs('download')).toEqual([
      '-hwaccel',
      'vaapi',
      '-hwaccel_device',
      'va',
    ]);
  });

  it('no mode, no tokens', () => {
    expect(vaapiDecodeInputArgs(undefined)).toEqual([]);
  });
});

describe('createVaapiFallbackDetector', () => {
  const LINE =
    '[hevc @ 0x55] Failed setup for format vaapi: hwaccel initialisation returned error.\n';

  it('fires once on the libavcodec fallback message', () => {
    const detect = createVaapiFallbackDetector();
    expect(detect('frame=1 fps=0\n')).toBe(false);
    expect(detect(LINE)).toBe(true);
    expect(detect(LINE)).toBe(false);
  });

  it('fires when the message is split across two chunks', () => {
    const detect = createVaapiFallbackDetector();
    const cut = LINE.indexOf('format va') + 5;
    expect(detect(Buffer.from(LINE.slice(0, cut)))).toBe(false);
    expect(detect(Buffer.from(LINE.slice(cut)))).toBe(true);
  });

  it('ignores unrelated output', () => {
    const detect = createVaapiFallbackDetector();
    expect(detect('Failed setup for format cuda\n')).toBe(false);
    expect(detect('Stream #0:0: Video: hevc\n')).toBe(false);
  });
});

describe('vaapi codec block with hardware decode', () => {
  const vfValue = (block: string[]): string => block[block.indexOf('-vf') + 1];

  it('is byte-identical when hardware decode is not requested', () => {
    const withField = buildCodecBlock({
      encoder: 'vaapi',
      crf: 22,
      preset: 'slow',
      devicePath: '/dev/dri/renderD129',
      hwDecode: undefined,
    });
    expect(withField).toEqual([
      '-vaapi_device',
      '/dev/dri/renderD129',
      '-vf',
      'format=nv12,hwupload',
      '-c:v',
      'hevc_vaapi',
      '-preset',
      'slow',
      '-rc_mode',
      'CQP',
      '-qp',
      '22',
      '-compression_level',
      '1',
    ]);
  });

  it('zero-copy uses one named device and keeps GPU frames on the GPU', () => {
    const block = buildCodecBlock({
      encoder: 'vaapi',
      crf: 22,
      preset: 'slow',
      devicePath: '/dev/dri/renderD129',
      hwDecode: 'zero-copy',
    });
    expect(block.slice(0, 4)).toEqual([
      '-init_hw_device',
      'vaapi=va:/dev/dri/renderD129',
      '-filter_hw_device',
      'va',
    ]);
    expect(block).not.toContain('-vaapi_device');
    expect(vfValue(block)).toBe('format=nv12|vaapi,hwupload,scale_vaapi=format=nv12');
    expect(block).not.toContain('-profile:v');
  });

  it('zero-copy with 10-bit pins p010le on both sides and the main10 profile', () => {
    const block = buildCodecBlock({
      encoder: 'vaapi',
      crf: 22,
      preset: 'slow',
      tenBit: true,
      hwDecode: 'zero-copy',
    });
    expect(vfValue(block)).toBe('format=p010le|vaapi,hwupload,scale_vaapi=format=p010le');
    expect(block.slice(-2)).toEqual(['-profile:v', 'main10']);
  });

  it('falls back to the default render node, the same one -vaapi_device uses', () => {
    const block = buildCodecBlock({
      encoder: 'vaapi',
      crf: 22,
      preset: 'slow',
      hwDecode: 'zero-copy',
    });
    expect(block[1]).toBe('vaapi=va:/dev/dri/renderD128');
    const off = buildCodecBlock({ encoder: 'vaapi', crf: 22, preset: 'slow' });
    expect(off[1]).toBe('/dev/dri/renderD128');
  });

  it('download mode keeps the crop chain and swaps only the device tokens', () => {
    const block = buildCodecBlock({
      encoder: 'vaapi',
      crf: 22,
      preset: 'slow',
      crop: CROP,
      hwDecode: 'download',
    });
    expect(block.slice(0, 4)).toEqual([
      '-init_hw_device',
      'vaapi=va:/dev/dri/renderD128',
      '-filter_hw_device',
      'va',
    ]);
    expect(vfValue(block)).toBe(`crop=${CROP},format=nv12,hwupload`);
  });

  it('narrows the zero-copy chain to the encoded ordinals like the plain chain', () => {
    const block = buildCodecBlock({
      encoder: 'vaapi',
      crf: 22,
      preset: 'slow',
      hwDecode: 'zero-copy',
      videoFilterOrdinals: [1],
    });
    expect(block).not.toContain('-vf');
    const i = block.indexOf('-filter:v:1');
    expect(block[i + 1]).toBe('format=nv12|vaapi,hwupload,scale_vaapi=format=nv12');
  });

  it.each(['libx265', 'nvenc', 'qsv'] as const)('%s ignores the field', (encoder) => {
    const plain = buildCodecBlock({
      encoder,
      crf: 22,
      preset: 'slow',
      devicePath: '/dev/dri/renderD128',
    });
    const withField = buildCodecBlock({
      encoder,
      crf: 22,
      preset: 'slow',
      devicePath: '/dev/dri/renderD128',
      hwDecode: 'zero-copy',
    });
    expect(withField).toEqual(plain);
  });
});

describe('buildArgs with vaapiHwDecode', () => {
  const opts = { input: '/in', output: '/out', crf: 22, vaapiDevice: '/dev/dri/renderD129' };

  it('hwaccel input tokens precede -i in zero-copy mode', () => {
    const args = buildArgs({ ...opts, encoder: 'vaapi', vaapiHwDecode: 'zero-copy' });
    const i = args.indexOf('-i');
    expect(args.slice(0, i)).toEqual([
      '-hide_banner',
      '-nostats',
      '-y',
      '-hwaccel',
      'vaapi',
      '-hwaccel_device',
      'va',
      '-hwaccel_output_format',
      'vaapi',
    ]);
    expect(args).toContain('vaapi=va:/dev/dri/renderD129');
    expect(args).not.toContain('-vaapi_device');
  });

  it('download mode omits hwaccel_output_format and keeps the crop chain', () => {
    const args = buildArgs({ ...opts, encoder: 'vaapi', vaapiHwDecode: 'download', crop: CROP });
    const i = args.indexOf('-i');
    expect(args.slice(0, i)).toEqual([
      '-hide_banner',
      '-nostats',
      '-y',
      '-hwaccel',
      'vaapi',
      '-hwaccel_device',
      'va',
    ]);
    expect(args).not.toContain('-hwaccel_output_format');
    expect(args[args.indexOf('-vf') + 1]).toBe(`crop=${CROP},format=nv12,hwupload`);
  });

  it('buildArgs is byte-identical without vaapiHwDecode for all four encoders', () => {
    for (const encoder of ['libx265', 'nvenc', 'qsv', 'vaapi'] as const) {
      const plain = buildArgs({ ...opts, encoder });
      expect(buildArgs({ ...opts, encoder, vaapiHwDecode: undefined })).toEqual(plain);
      expect(plain).not.toContain('-hwaccel');
    }
  });

  it('other encoders never pick up the decode tokens even when a mode is passed', () => {
    for (const encoder of ['libx265', 'nvenc', 'qsv'] as const) {
      const plain = buildArgs({ ...opts, encoder });
      expect(buildArgs({ ...opts, encoder, vaapiHwDecode: 'zero-copy' })).toEqual(plain);
    }
  });
});

describe('a crop always survives a zero-copy request', () => {
  it('builder keeps the crop chain when zero-copy and crop arrive together', () => {
    const block = buildCodecBlock({
      encoder: 'vaapi',
      crf: 22,
      preset: 'slow',
      crop: CROP,
      hwDecode: 'zero-copy',
    });
    expect(block[block.indexOf('-vf') + 1]).toBe(`crop=${CROP},format=nv12,hwupload`);
  });

  it('buildArgs downgrades zero-copy to download when a crop is set', () => {
    const args = buildArgs({
      input: '/in',
      output: '/out',
      crf: 22,
      encoder: 'vaapi',
      vaapiHwDecode: 'zero-copy',
      crop: CROP,
    });
    expect(args).not.toContain('-hwaccel_output_format');
    expect(args.indexOf('-hwaccel')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-vf') + 1]).toBe(`crop=${CROP},format=nv12,hwupload`);
  });
});
