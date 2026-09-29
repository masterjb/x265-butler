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

// 50-02: the ATTACH TABLE — `codec_name → { ext, mimetype }`. Two consumers:
//
//  * cover-extract.ts derives the ON-DISK extension from `ext`. Measured (M-Q):
//    `-f image2 -c copy` does NOT transcode to match the path suffix — a png
//    stream written to a `.jpg` path stays a png and the suffix then LIES. The
//    extension must come from `codec_name`, never from the source filename.
//  * buildArgs emits `mimetype=<mimetype>` on the `-attach`. Measured (M-G): an
//    `-attach` whose mimetype tag is missing is exit 234 with a 0-byte output
//    ("Attachment stream N has no mimetype tag and it cannot be deduced from the
//    codec id"), so a cover whose codec is NOT in this table is DROPPED rather
//    than guessed (E4).
//
// EVERY KEY MUST CARRY AN EXECUTED ROUND-TRIP in tests/encode/real-ffmpeg-smoke
// (E11 / AC-26). Adding a key without measuring it is a rule break, not a
// feature: the matroska DEMUXER promotes only a narrow mimetype set back to an
// `attached_pic` video stream, so an unmeasured key would ship a claim about a
// round-trip nobody ever ran.
export type CoverMedia = Readonly<{ ext: string; mimetype: string }>;

export const COVER_MEDIA_BY_CODEC: Readonly<Record<string, CoverMedia>> = Object.freeze({
  mjpeg: Object.freeze({ ext: 'jpg', mimetype: 'image/jpeg' }),
  png: Object.freeze({ ext: 'png', mimetype: 'image/png' }),
  webp: Object.freeze({ ext: 'webp', mimetype: 'image/webp' }),
  bmp: Object.freeze({ ext: 'bmp', mimetype: 'image/bmp' }),
  gif: Object.freeze({ ext: 'gif', mimetype: 'image/gif' }),
});

// Image codecs a cover stream can legitimately carry. Used only by the
// mimetype-recognition branch below, never on its own. 50-02: DERIVED from the
// attach table above so the recognition set and the attach set cannot drift
// apart — a codec we recognize as a cover is a codec we can also attach.
const COVER_IMAGE_CODECS: ReadonlySet<string> = Object.freeze(
  new Set<string>(Object.keys(COVER_MEDIA_BY_CODEC)),
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

/**
 * 50-02 (AC-14): the ONE video-stream walk. `analyzeAttachedPictures` and
 * `describeAttachedPictures` BOTH run through it, so their cover sets cannot
 * drift apart — a duplicated loop would be two chances to disagree about which
 * ordinal carries the cover, and a disagreement there means `-map -0:v:N` drops
 * one stream while `-attach` re-attaches a different one.
 */
type VideoStreamWalk = {
  covers: Array<{ videoOrdinal: number; stream: ProbeStream }>;
  encodedVideoOrdinals: number[];
  allVideoStreamsAreCovers: boolean;
};

function walkVideoStreams(probe: ProbeResult): VideoStreamWalk {
  const streams: ReadonlyArray<ProbeStream> = probe.streams ?? [];
  const covers: Array<{ videoOrdinal: number; stream: ProbeStream }> = [];
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
      covers.push({ videoOrdinal, stream: s });
    } else {
      encodedVideoOrdinals.push(videoOrdinal);
    }
    videoOrdinal += 1;
  }

  return {
    covers,
    encodedVideoOrdinals,
    allVideoStreamsAreCovers: covers.length > 0 && encodedVideoOrdinals.length === 0,
  };
}

export function analyzeAttachedPictures(probe: ProbeResult): AttachedPicAnalysis {
  const walk = walkVideoStreams(probe);
  const videoOrdinals: number[] = walk.covers.map((c) => c.videoOrdinal);
  const encodedVideoOrdinals: number[] = walk.encodedVideoOrdinals;

  // AC-7: a source whose video streams are ALL covers has no real video track.
  // Copying every one of them would yield an "encode" that encodes nothing and
  // would feed the skip/verify chain a result it cannot recognize as a failure.
  // Bail out to the empty analysis — both lists empty ⇒ no copy arg AND no
  // filter narrowing ⇒ argv byte-identical to v2.45.0, and the job fails the
  // way it did before rather than in a new, quieter way.
  if (walk.allVideoStreamsAreCovers) {
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

// ─────────────────────────────────────────────────────────────────────────────
// 50-02 — the ATTACH half. Additive, still PURE (E5): no new field on
// AttachedPicAnalysis, because tests/encode/attached-pic.test.ts carries 18
// `toEqual` assertions on that object and an extra field would churn every one
// of them. New descriptors ride their own functions instead.
// ─────────────────────────────────────────────────────────────────────────────

/** One cover-art stream, described well enough to extract and re-attach it. */
export type CoverStream = Readonly<{
  /** Position among the VIDEO-typed streams — the `-map -0:v:N` / `0:v:N` index. */
  videoOrdinal: number;
  /** Verbatim ffprobe `codec_name`, or null when the probe carried none. */
  codecName: string | null;
  /** The attach-table entry, or null ⇒ this cover is DROPPED, never guessed (E4). */
  media: CoverMedia | null;
  /** The sanitized source FILENAME tag, or null ⇒ caller falls back (AC-12). */
  sourceFilename: string | null;
}>;

/**
 * Characters that must never reach a `filename=` tag or a path segment: the two
 * path separators are handled by the basename reduction below, NUL and the C0/C1
 * control range are stripped outright.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Cap in BYTES, cutting only at code-point boundaries (AC-30). */
const FILENAME_MAX_BYTES = 255;

function capUtf8Bytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  // Iterating a string with for..of walks CODE POINTS, so a multi-byte sequence
  // is never cut in half — a character-count cap would both overshoot the byte
  // promise on non-ASCII names and risk a lone surrogate.
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/**
 * Sanitize a source-supplied attachment filename down to a bare, harmless
 * basename — or null when nothing usable survives.
 *
 * THIS VALUE NEVER DECIDES A PATH. The on-disk extraction target is built from
 * the cover's position and its codec (AC-11); this function only produces the
 * `filename=` METADATA tag that ends up inside the output file. It is sanitized
 * anyway because that tag is read back by players and by our own next encode.
 */
export function sanitizeAttachmentFilename(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Basename reduction: everything up to the LAST separator of either flavour
  // goes, so '../../etc/passwd' and 'C:\\Windows\\cover.jpg' collapse to their
  // last segment and no path segment of the source can survive.
  const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  const base = lastSlash === -1 ? raw : raw.slice(lastSlash + 1);
  const cleaned = base.replace(CONTROL_CHARS, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null;
  const capped = capUtf8Bytes(cleaned, FILENAME_MAX_BYTES);
  return capped === '' ? null : capped;
}

/**
 * Describe every cover-art stream of a probe, in video-ordinal order.
 *
 * Runs the SAME walk as `analyzeAttachedPictures` (AC-14) and bails to `[]` on
 * the identical `allVideoStreamsAreCovers` guard — a source whose video streams
 * are ALL covers has no real video track, and dropping every one of them would
 * produce an output with no video at all.
 */
export function describeAttachedPictures(probe: ProbeResult): CoverStream[] {
  const walk = walkVideoStreams(probe);
  if (walk.allVideoStreamsAreCovers) return [];
  return walk.covers.map(({ videoOrdinal, stream }) => {
    const codecName = typeof stream.codec_name === 'string' ? stream.codec_name : null;
    return Object.freeze({
      videoOrdinal,
      codecName,
      media: codecName !== null ? (COVER_MEDIA_BY_CODEC[codecName] ?? null) : null,
      // Tags are UPPER-normalized by normalizeTags in scan/ffprobe.ts.
      sourceFilename: sanitizeAttachmentFilename(stream.tags?.FILENAME),
    });
  });
}

/**
 * Count the ATTACHMENT-typed streams of a probe — the base index for the
 * `-metadata:s:t:<n>` specifiers of the covers we attach.
 *
 * MEASURED (M-J): an image/* AttachedFile does NOT demux as an attachment
 * stream, ffmpeg promotes it to a VIDEO stream carrying `attached_pic`. So a
 * source cover is never counted here — which is exactly what makes this number
 * the right base: the attachments that survive `-map 0:t?` are precisely the
 * NON-image ones (fonts, chapters, arbitrary blobs), and our own `-attach`
 * blocks land after them, in order.
 *
 * The index is ship-critical, not cosmetic: measured (M-H) a wrong
 * `-metadata:s:t:<n>` is exit 234 with a 0-byte output, and measured (M-F) the
 * UNINDEXED form renames the source fonts to the cover's name and turns them
 * into phantom video streams.
 */
export function countAttachmentStreams(probe: ProbeResult): number {
  const streams: ReadonlyArray<ProbeStream> = probe.streams ?? [];
  let n = 0;
  for (const s of streams) if (s.codec_type === 'attachment') n += 1;
  return n;
}
