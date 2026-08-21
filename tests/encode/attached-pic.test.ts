// 49-01: analyzeAttachedPictures matrix. Pure module — cover art is addressed by
// VIDEO ORDINAL (position among video-typed streams), never by source index,
// because that is the semantics of `-c:v:N` in the ffmpeg output.

import { describe, it, expect } from 'vitest';
import {
  analyzeAttachedPictures,
  isAttachedPictureStream,
  // 50-02 additive (E5): new PURE functions, no new field on AttachedPicAnalysis —
  // the 18 `toEqual` assertions above stay untouched.
  describeAttachedPictures,
  countAttachmentStreams,
  sanitizeAttachmentFilename,
  COVER_MEDIA_BY_CODEC,
} from '@/src/lib/encode/attached-pic';
import type { ProbeResult, ProbeStream } from '@/src/lib/scan/ffprobe';

function probe(streams: ProbeStream[] | undefined): ProbeResult {
  return {
    codec: 'h264',
    bitrate: null,
    durationSeconds: null,
    width: 1920,
    height: 1080,
    container: 'matroska,webm',
    tags: {},
    color: { space: null, primaries: null, transfer: null, range: null },
    hdr10: { masterDisplay: null, maxCll: null },
    streams,
  };
}

const video = (index: number): ProbeStream => ({
  attachedPic: false,
  index,
  codec_type: 'video',
  codec_name: 'h264',
});
const audio = (index: number): ProbeStream => ({
  attachedPic: false,
  index,
  codec_type: 'audio',
  codec_name: 'aac',
});
const subtitle = (index: number): ProbeStream => ({
  attachedPic: false,
  index,
  codec_type: 'subtitle',
  codec_name: 'subrip',
});
const cover = (index: number): ProbeStream => ({
  attachedPic: true,
  index,
  codec_type: 'video',
  codec_name: 'mjpeg',
});

describe('analyzeAttachedPictures', () => {
  it('returns the empty analysis when no stream carries attached_pic (AC-4)', () => {
    const r = analyzeAttachedPictures(probe([video(0), audio(1), subtitle(2)]));
    expect(r.videoOrdinals).toEqual([]);
    expect(r.encodedVideoOrdinals).toEqual([]);
    expect(r.hasAttachedPictures).toBe(false);
    expect(r.allVideoStreamsAreCovers).toBe(false);
  });

  it('returns the empty analysis when streams is undefined (AC-4)', () => {
    const r = analyzeAttachedPictures(probe(undefined));
    expect(r.videoOrdinals).toEqual([]);
    expect(r.hasAttachedPictures).toBe(false);
  });

  it('ignores an attached_pic flag on a non-video stream (AC-4, defensive)', () => {
    const r = analyzeAttachedPictures(
      probe([video(0), { attachedPic: true, index: 1, codec_type: 'audio', codec_name: 'aac' }]),
    );
    expect(r.videoOrdinals).toEqual([]);
    expect(r.hasAttachedPictures).toBe(false);
  });

  it('counts video ordinals, not source indices, across interleaved streams (AC-2)', () => {
    // The forum-report shape: main video at 0, 20 audio/subtitle streams, cover
    // at SOURCE index 21 — which is VIDEO ordinal 1.
    const streams: ProbeStream[] = [video(0)];
    for (let i = 1; i <= 20; i += 1) {
      streams.push(i % 2 === 0 ? audio(i) : subtitle(i));
    }
    streams.push(cover(21));

    const r = analyzeAttachedPictures(probe(streams));
    expect(r.videoOrdinals).toEqual([1]);
    expect(r.videoOrdinals).not.toContain(21);
    expect(r.encodedVideoOrdinals).toEqual([0]);
    expect(r.hasAttachedPictures).toBe(true);
  });

  it('collects every cover when a source carries several (AC-3)', () => {
    const r = analyzeAttachedPictures(probe([video(0), audio(1), cover(2), cover(3)]));
    expect(r.videoOrdinals).toEqual([1, 2]);
    expect(r.encodedVideoOrdinals).toEqual([0]);
    expect(r.hasAttachedPictures).toBe(true);
  });

  it('handles a cover at video ordinal 0 with the real video at 1 (AC-14)', () => {
    const r = analyzeAttachedPictures(probe([cover(0), audio(1), video(2)]));
    expect(r.videoOrdinals).toEqual([0]);
    expect(r.encodedVideoOrdinals).toEqual([1]);
    expect(r.hasAttachedPictures).toBe(true);
  });

  it('bails out when every video stream is a cover (AC-7)', () => {
    const r = analyzeAttachedPictures(probe([cover(0), cover(1), audio(2)]));
    expect(r.videoOrdinals).toEqual([]);
    expect(r.encodedVideoOrdinals).toEqual([]);
    expect(r.hasAttachedPictures).toBe(false);
    expect(r.allVideoStreamsAreCovers).toBe(true);
  });

  it('keeps the two ordinal sets disjoint and complete by construction', () => {
    const r = analyzeAttachedPictures(probe([video(0), cover(1), video(2), cover(3)]));
    expect(r.videoOrdinals).toEqual([1, 3]);
    expect(r.encodedVideoOrdinals).toEqual([0, 2]);
    const union = [...r.videoOrdinals, ...r.encodedVideoOrdinals].sort((a, b) => a - b);
    expect(union).toEqual([0, 1, 2, 3]);
  });
});

describe('isAttachedPictureStream — our-own-output recognition (AC-16)', () => {
  it('recognizes a cover that lost its disposition but kept MIMETYPE + image codec', () => {
    // The matroska muxer writes the copied cover as a plain video track: the
    // attached_pic disposition is GONE, only FILENAME/MIMETYPE survive.
    const roundTripped: ProbeStream = {
      attachedPic: false,
      index: 1,
      codec_type: 'video',
      codec_name: 'mjpeg',
      tags: { FILENAME: 'cover.jpg', MIMETYPE: 'image/jpeg' },
    };
    expect(isAttachedPictureStream(roundTripped)).toBe(true);

    const r = analyzeAttachedPictures(probe([video(0), roundTripped]));
    expect(r.videoOrdinals).toEqual([1]);
    expect(r.encodedVideoOrdinals).toEqual([0]);
  });

  it('does NOT treat a real h264 track with an image mimetype tag as a cover', () => {
    // Mimetype alone would silently set a real video track to copy — an
    // "encode" that encodes nothing. Both conditions are required.
    const bogus: ProbeStream = {
      attachedPic: false,
      index: 1,
      codec_type: 'video',
      codec_name: 'h264',
      tags: { MIMETYPE: 'image/jpeg' },
    };
    expect(isAttachedPictureStream(bogus)).toBe(false);

    const r = analyzeAttachedPictures(probe([video(0), bogus]));
    expect(r.videoOrdinals).toEqual([]);
    expect(r.hasAttachedPictures).toBe(false);
  });

  it('does NOT treat an mjpeg stream without an image mimetype as a cover', () => {
    const mjpegNoTag: ProbeStream = {
      attachedPic: false,
      index: 1,
      codec_type: 'video',
      codec_name: 'mjpeg',
    };
    expect(isAttachedPictureStream(mjpegNoTag)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 50-02 — the attach half. All still PURE; nothing here spawns or touches fs.
// ─────────────────────────────────────────────────────────────────────────────

const attachment = (index: number, mimetype = 'application/x-truetype-font'): ProbeStream => ({
  attachedPic: false,
  index,
  codec_type: 'attachment',
  codec_name: 'ttf',
  tags: { MIMETYPE: mimetype, FILENAME: `font${index}.ttf` },
});
const coverWith = (index: number, codec: string, filename?: string): ProbeStream => ({
  attachedPic: true,
  index,
  codec_type: 'video',
  codec_name: codec,
  tags: filename === undefined ? undefined : { FILENAME: filename, MIMETYPE: 'image/jpeg' },
});

describe('50-02 COVER_MEDIA_BY_CODEC (E4/E11)', () => {
  it('carries exactly the five measured codecs and their mimetypes', () => {
    expect(Object.keys(COVER_MEDIA_BY_CODEC).sort()).toEqual([
      'bmp',
      'gif',
      'mjpeg',
      'png',
      'webp',
    ]);
    expect(COVER_MEDIA_BY_CODEC.mjpeg).toEqual({ ext: 'jpg', mimetype: 'image/jpeg' });
    expect(COVER_MEDIA_BY_CODEC.png).toEqual({ ext: 'png', mimetype: 'image/png' });
    expect(COVER_MEDIA_BY_CODEC.webp).toEqual({ ext: 'webp', mimetype: 'image/webp' });
    expect(COVER_MEDIA_BY_CODEC.bmp).toEqual({ ext: 'bmp', mimetype: 'image/bmp' });
    expect(COVER_MEDIA_BY_CODEC.gif).toEqual({ ext: 'gif', mimetype: 'image/gif' });
  });

  it('is the SOURCE of the recognition set — every key is recognized as a cover', () => {
    // The derivation is what keeps the recognize-set and the attach-set from
    // drifting: a codec we can attach is a codec we recognize, and vice versa.
    for (const codec of Object.keys(COVER_MEDIA_BY_CODEC)) {
      expect(
        isAttachedPictureStream({
          attachedPic: false,
          index: 1,
          codec_type: 'video',
          codec_name: codec,
          tags: { MIMETYPE: 'image/png' },
        }),
      ).toBe(true);
    }
  });
});

describe('50-02 describeAttachedPictures — AC-14 (cannot drift from analyze)', () => {
  const fixtures: Array<{ name: string; streams: ProbeStream[] | undefined }> = [
    { name: 'no streams at all', streams: undefined },
    { name: 'no cover', streams: [video(0), audio(1), subtitle(2)] },
    { name: 'one cover behind the video', streams: [video(0), cover(1), audio(2)] },
    { name: 'cover FIRST, real video second', streams: [cover(0), video(1), audio(2)] },
    { name: 'two covers + a font', streams: [video(0), cover(1), cover(2), attachment(3)] },
    { name: 'audio/subs between the video ordinals', streams: [video(0), audio(1), cover(2)] },
    { name: 'EVERY video stream is a cover (the bail)', streams: [cover(0), cover(1)] },
  ];

  it.each(fixtures)('$name — the ordinal sets are identical', ({ streams }) => {
    const p = probe(streams);
    expect(describeAttachedPictures(p).map((c) => c.videoOrdinal)).toEqual(
      analyzeAttachedPictures(p).videoOrdinals,
    );
  });

  it('AC-14: both bail to EMPTY when every video stream is a cover', () => {
    const p = probe([cover(0), cover(1)]);
    expect(describeAttachedPictures(p)).toEqual([]);
    expect(analyzeAttachedPictures(p).allVideoStreamsAreCovers).toBe(true);
  });

  it('resolves media + sanitized source filename per cover', () => {
    const p = probe([video(0), coverWith(1, 'mjpeg', 'cover.jpg')]);
    expect(describeAttachedPictures(p)).toEqual([
      {
        videoOrdinal: 1,
        codecName: 'mjpeg',
        media: { ext: 'jpg', mimetype: 'image/jpeg' },
        sourceFilename: 'cover.jpg',
      },
    ]);
  });

  it('AC-6: a cover whose codec is NOT in the table gets media=null, never a guess', () => {
    const p = probe([
      video(0),
      { attachedPic: true, index: 1, codec_type: 'video', codec_name: 'tiff' },
    ]);
    const d = describeAttachedPictures(p);
    expect(d).toHaveLength(1);
    expect(d[0].codecName).toBe('tiff');
    expect(d[0].media).toBeNull();
  });

  it('AC-6: a cover with NO codec_name at all gets media=null', () => {
    const p = probe([video(0), { attachedPic: true, index: 1, codec_type: 'video' }]);
    expect(describeAttachedPictures(p)[0]).toMatchObject({ codecName: null, media: null });
  });

  it('AC-12: a cover without a FILENAME tag yields sourceFilename=null (caller falls back)', () => {
    const p = probe([video(0), coverWith(1, 'png')]);
    expect(describeAttachedPictures(p)[0].sourceFilename).toBeNull();
  });

  it('AC-11/AC-30: a hostile FILENAME tag is reduced to a bare basename', () => {
    const p = probe([video(0), coverWith(1, 'mjpeg', '../../etc/passwd')]);
    expect(describeAttachedPictures(p)[0].sourceFilename).toBe('passwd');
  });
});

describe('50-02 countAttachmentStreams — the -metadata:s:t base index (AC-3)', () => {
  it('counts attachment-typed streams only', () => {
    expect(countAttachmentStreams(probe([video(0), audio(1), attachment(2), attachment(3)]))).toBe(
      2,
    );
  });

  it('is 0 for a source without attachments, and for an absent stream list', () => {
    expect(countAttachmentStreams(probe([video(0), audio(1)]))).toBe(0);
    expect(countAttachmentStreams(probe(undefined))).toBe(0);
  });

  it('M-J: an image cover does NOT count — it demuxes as a VIDEO stream', () => {
    // This is precisely why the count is the right base index: the attachments
    // that survive `-map 0:t?` are exactly the NON-image ones.
    expect(countAttachmentStreams(probe([video(0), cover(1), attachment(2)]))).toBe(1);
  });
});

describe('50-02 sanitizeAttachmentFilename — AC-30 hostile-input table', () => {
  const table: Array<[string, string | null]> = [
    ['cover.jpg', 'cover.jpg'],
    ['../../etc/passwd', 'passwd'],
    ['/abs/pfad/cover.jpg', 'cover.jpg'],
    ['C:\\Windows\\cover.jpg', 'cover.jpg'],
    ['cover\u0000.jpg', 'cover.jpg'],
    ['a\nb.jpg', 'ab.jpg'],
    ['.', null],
    ['..', null],
    ['   ', null],
    ['', null],
    ['  spaced.png  ', 'spaced.png'],
  ];

  it.each(table)('%j → %j', (raw, expected) => {
    expect(sanitizeAttachmentFilename(raw)).toBe(expected);
  });

  it('never returns a path separator, a NUL or a control character', () => {
    for (const [raw] of table) {
      const r = sanitizeAttachmentFilename(raw);
      if (r === null) continue;
      expect(r).not.toMatch(/[/\\]/);
      // eslint-disable-next-line no-control-regex
      expect(r).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    }
  });

  it('AC-30: the length cap is in UTF-8 BYTES, not characters', () => {
    const ascii = sanitizeAttachmentFilename('a'.repeat(400));
    expect(ascii).not.toBeNull();
    expect(Buffer.byteLength(ascii as string, 'utf8')).toBe(255);

    // 400 × 'ä' = 800 bytes. A character cap would return 255 chars = 510 bytes
    // and the 255-byte promise would simply be false.
    const nonAscii = sanitizeAttachmentFilename('ä'.repeat(400));
    expect(nonAscii).not.toBeNull();
    expect(Buffer.byteLength(nonAscii as string, 'utf8')).toBeLessThanOrEqual(255);
    expect(nonAscii).toBe('ä'.repeat(127));
  });

  it('never cuts a multi-byte sequence in half', () => {
    // 4-byte code points: a byte-slice cap would produce a lone surrogate here.
    const emoji = sanitizeAttachmentFilename('😀'.repeat(100));
    expect(emoji).not.toBeNull();
    expect(Buffer.byteLength(emoji as string, 'utf8')).toBeLessThanOrEqual(255);
    expect([...(emoji as string)].every((c) => c === '😀')).toBe(true);
  });

  it('rejects non-string input', () => {
    expect(sanitizeAttachmentFilename(undefined)).toBeNull();
    expect(sanitizeAttachmentFilename(42)).toBeNull();
    expect(sanitizeAttachmentFilename(null)).toBeNull();
  });
});
