// Optional VAAPI hardware decode for the production encode.
//
// Without it, a vaapi job decodes on the CPU and uploads every frame
// (`format=nv12,hwupload`); a 4K HEVC source then keeps several CPU cores busy
// just for decoding. With the setting on, ffmpeg decodes on the GPU instead.
//
// Everything that decides WHETHER and HOW lives here as plain functions of their
// inputs. The codec block builder in profiles.ts only receives the resulting mode
// as a value, never the setting itself: bench Pass-1 calls the builder directly
// and must keep decoding on the CPU so VMAF comparisons stay comparable.

import type { EncoderId } from './profiles';
import type { ProbeResult } from '../scan/ffprobe';
import { isAttachedPictureStream } from './attached-pic';

export const VAAPI_HW_DECODE_SETTING_KEY = 'vaapi_hw_decode';

// Code-fallback default off, no migration: existing installs keep their argv.
export function parseVaapiHwDecode(raw: string | null | undefined): boolean {
  return raw === 'true';
}

// Codecs for which libavcodec has a VAAPI decode path. Driver gaps (a GPU that
// lacks one of these profiles) are handled by ffmpeg at runtime: it logs
// `Failed setup for format vaapi` and decodes in software. A codec with no VAAPI
// path at all is a different case: how ffmpeg reacts to an explicit
// `-hwaccel vaapi` there depends on the version, and some versions refuse to open
// the decoder. Keeping such codecs on the plain CPU argv makes the outcome
// predictable.
export const VAAPI_HW_DECODE_CODECS: ReadonlySet<string> = new Set([
  'h264',
  'hevc',
  'vp9',
  'av1',
  'mpeg2video',
  'vc1',
]);

export type VaapiDecodeMode = 'off' | 'cpu' | 'zero-copy' | 'download';
export type VaapiHwDecodeArgvMode = Extract<VaapiDecodeMode, 'zero-copy' | 'download'>;

export interface VaapiDecodeInput {
  enabled: boolean;
  encoder: EncoderId;
  // One entry per ENCODED video stream. `-hwaccel` applies to every decoder of
  // the input file, so every one of them has to be on the list.
  sourceCodecs: ReadonlyArray<string | null | undefined>;
  crop?: string;
}

export interface VaapiDecodeDecision {
  mode: VaapiDecodeMode;
  // Set only for 'cpu': the first codec that kept the job on the CPU, or null
  // when the codec is unknown.
  unlistedCodec?: string | null;
}

function normalizeCodec(codec: string | null | undefined): string | null {
  if (typeof codec !== 'string') return null;
  const trimmed = codec.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

export function resolveVaapiDecode(input: VaapiDecodeInput): VaapiDecodeDecision {
  if (!input.enabled || input.encoder !== 'vaapi') return { mode: 'off' };
  if (input.sourceCodecs.length === 0) return { mode: 'cpu', unlistedCodec: null };
  for (const raw of input.sourceCodecs) {
    const codec = normalizeCodec(raw);
    if (codec === null) return { mode: 'cpu', unlistedCodec: null };
    if (!VAAPI_HW_DECODE_CODECS.has(codec)) return { mode: 'cpu', unlistedCodec: codec };
  }
  // A crop filter on frames that live in GPU memory is not something the
  // pipeline relies on. With a crop, ffmpeg copies the decoded frames back to RAM
  // and the existing CPU crop chain runs unchanged.
  return { mode: input.crop ? 'download' : 'zero-copy' };
}

// `ProbeResult.codec` is the FIRST video stream, which is the cover image when
// an mp4 carries one at ordinal 0. The decision needs the streams that are
// actually encoded.
export function encodedVideoCodecs(probe: ProbeResult): Array<string | null> {
  if (!probe.streams) return [probe.codec];
  return probe.streams
    .filter((s) => s.codec_type === 'video' && !isAttachedPictureStream(s))
    .map((s) => s.codec_name ?? null);
}

// Decoder and filters share ONE named device. With two device contexts on the
// same node, `hwupload` would not be guaranteed to pass decoded GPU frames
// through.
export const VAAPI_DECODE_DEVICE_NAME = 'va';

export function vaapiDecodeDeviceArgs(devicePath: string): string[] {
  return [
    '-init_hw_device',
    `vaapi=${VAAPI_DECODE_DEVICE_NAME}:${devicePath}`,
    '-filter_hw_device',
    VAAPI_DECODE_DEVICE_NAME,
  ];
}

// Input options: they must stand before `-i`.
export function vaapiDecodeInputArgs(mode: VaapiHwDecodeArgvMode | undefined): string[] {
  if (!mode) return [];
  return [
    '-hwaccel',
    'vaapi',
    '-hwaccel_device',
    VAAPI_DECODE_DEVICE_NAME,
    ...(mode === 'zero-copy' ? ['-hwaccel_output_format', 'vaapi'] : []),
  ];
}

// libavcodec prints this when the GPU cannot decode the stream and it falls back
// to software decoding. The wording has been stable across ffmpeg 4 to 9.
const FALLBACK_SIGNATURE = 'Failed setup for format vaapi';
const CARRY_CHARS = FALLBACK_SIGNATURE.length - 1;

// Reports true exactly once per encode. The tail of the previous chunk is kept
// so a message split across two stderr chunks is still recognised.
export function createVaapiFallbackDetector(): (chunk: Buffer | string) => boolean {
  let carry = '';
  let fired = false;
  return (chunk) => {
    if (fired) return false;
    const text = carry + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    if (text.includes(FALLBACK_SIGNATURE)) {
      fired = true;
      carry = '';
      return true;
    }
    carry = text.slice(-CARRY_CHARS);
    return false;
  };
}

// The job log line for a planned decode path. Only written when the setting is on.
export function decodePathLogLine(decision: VaapiDecodeDecision): string | null {
  switch (decision.mode) {
    case 'zero-copy':
      return 'video decode: GPU (VAAPI), frames stay on the GPU';
    case 'download':
      return 'video decode: GPU (VAAPI), frames copied to RAM for cropping';
    case 'cpu':
      return `video decode: CPU, hardware decode not used for codec ${decision.unlistedCodec ?? 'unknown'}`;
    default:
      return null;
  }
}

export const VAAPI_FALLBACK_LOG_LINE =
  'GPU could not decode this source, ffmpeg decodes it on the CPU';
