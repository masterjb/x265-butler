// 49-01: attached-pic — identifies embedded cover-art video streams so buildArgs
// can copy them instead of pushing them through the HEVC encoder. Pure module:
// zero side effects, zero logger import, zero filesystem access (mirrors
// stream-compat.ts / subtitle-compat.ts / audio-compat.ts).
//
// WHY THIS EXISTS
// A Matroska `AttachedFile` whose mimetype is image/* is NOT demuxed as an
// attachment stream — ffmpeg turns it into a VIDEO stream carrying the
// `attached_pic` disposition. That means the 41-01 `-map 0:t?` branch does NOT
// catch it: the cover arrives via `-map 0:v`, and the codec block emits
// `-c:v <enc>` with NO stream specifier, so the 600x900 yuvj444p mjpeg is fed to
// the HEVC encoder. QSV/NVENC/VAAPI refuse it ("Could not open encoder before
// EOF → Conversion failed!") and the whole job dies. libx265 only survives
// because it happens to accept yuvj444p — the defect is missing stream
// selectivity, not the encoder.
//
// WHY `-c:v:N copy` AND NOT `-map -0:v:N` (D2, rejections C/D)
// Excluding the stream would drop the cover from the output. Copying keeps it.
// ffmpeg evaluates the LAST matching `-c` option for a stream, so a per-ordinal
// `-c:v:N copy` placed AFTER the global `-c:v <enc>` overrides it for exactly
// that stream and leaves the main video untouched.
//
// WHY ORDINALS AND NOT `s.index`
// `-c:v:N` counts N within the VIDEO streams of the OUTPUT, not within all
// source streams. A cover at source index 21 behind 20 audio/subtitle streams is
// video ordinal 1. Using `s.index` would address a stream that does not exist.
//
// THE FILTER HALF
// `encodedVideoOrdinals` is the complement set and is a REQUIRED output, not a
// convenience: a bare `-vf` specifier also matches the copied cover, and ffmpeg
// then aborts hard when opening the output ("Filtering and streamcopy cannot be
// used together"). The caller narrows the video filter to these ordinals. Both
// sets are built in the same pass so they cannot drift apart.

import type { ProbeResult, ProbeStream } from '../scan/ffprobe';

// Image codecs a cover stream can legitimately carry. Used only by the
// mimetype-recognition branch below, never on its own.
const COVER_IMAGE_CODECS: ReadonlySet<string> = Object.freeze(
  new Set<string>(['mjpeg', 'png', 'bmp', 'webp', 'gif']),
);

export type AttachedPicAnalysis = Readonly<{
  /** Video ordinals (position among video-typed streams) that carry cover art. */
  videoOrdinals: number[];
  /** The complement: video ordinals that ARE encoded and take the video filter. */
  encodedVideoOrdinals: number[];
  hasAttachedPictures: boolean;
  /** AC-7 guard tripped: every video stream is a cover, so nothing is copied. */
  allVideoStreamsAreCovers: boolean;
}>;

const EMPTY_ANALYSIS: AttachedPicAnalysis = Object.freeze({
  videoOrdinals: Object.freeze([]) as unknown as number[],
  encodedVideoOrdinals: Object.freeze([]) as unknown as number[],
  hasAttachedPictures: false,
  allVideoStreamsAreCovers: false,
});

/**
 * The ONE place that decides whether a video stream is cover art. Isolated as a
 * named function on purpose: if a later report shows a third `0:v` disposition
 * subset (e.g. `timed_thumbnails`), this is the single site that changes.
 *
 * Two branches, OR-joined:
 *  (a) the source-side normal case — ffprobe reported `attached_pic`;
 *  (b) the recognize-our-own-output case — the matroska muxer does NOT write the
 *      attached_pic disposition back, it writes the copied cover as a plain video
 *      track that keeps only FILENAME/MIMETYPE (measured, ffmpeg 6.1.1; the mp4
 *      muxer DOES preserve the disposition). Without (b) a second encode over our
 *      own output would be fatal again.
 *
 * Branch (b) requires BOTH an image/* mimetype AND an image codec. A mimetype tag
 * alone could theoretically hit a real video track and silently set it to copy —
 * producing an "encode" that encodes nothing. Both conditions together make that
 * false positive negligible.
 */
export function isAttachedPictureStream(s: ProbeStream): boolean {
  if (s.attachedPic === true) return true;
  const mimetype = s.tags?.MIMETYPE;
  if (typeof mimetype !== 'string' || !mimetype.startsWith('image/')) return false;
  return typeof s.codec_name === 'string' && COVER_IMAGE_CODECS.has(s.codec_name);
}

export function analyzeAttachedPictures(probe: ProbeResult): AttachedPicAnalysis {
  const streams: ReadonlyArray<ProbeStream> = probe.streams ?? [];
  const videoOrdinals: number[] = [];
  const encodedVideoOrdinals: number[] = [];
  let videoOrdinal = 0;

  for (const s of streams) {
    // Only video-typed streams get an ordinal. Audio / subtitle / attachment /
    // data streams in between do NOT shift it — that is the whole point of
    // ordinals over source indices. An attached_pic flag on a non-video stream
    // is ignored defensively: only video streams sit under the global `-c:v`,
    // so only they need the override.
    if (s.codec_type !== 'video') continue;
    if (isAttachedPictureStream(s)) {
      videoOrdinals.push(videoOrdinal);
    } else {
      encodedVideoOrdinals.push(videoOrdinal);
    }
    videoOrdinal += 1;
  }

  // AC-7: a source whose video streams are ALL covers has no real video track.
  // Copying every one of them would yield an "encode" that encodes nothing and
  // would feed the skip/verify chain a result it cannot recognize as a failure.
  // Bail out to the empty analysis — both lists empty ⇒ no copy arg AND no
  // filter narrowing ⇒ argv byte-identical to v2.45.0, and the job fails the
  // way it did before rather than in a new, quieter way.
  if (videoOrdinals.length > 0 && encodedVideoOrdinals.length === 0) {
    return Object.freeze({
      videoOrdinals: Object.freeze([]) as unknown as number[],
      encodedVideoOrdinals: Object.freeze([]) as unknown as number[],
      hasAttachedPictures: false,
      allVideoStreamsAreCovers: true,
    });
  }

  if (videoOrdinals.length === 0) return EMPTY_ANALYSIS;

  return Object.freeze({
    videoOrdinals,
    encodedVideoOrdinals,
    hasAttachedPictures: true,
    allVideoStreamsAreCovers: false,
  });
}
