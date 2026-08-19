// 49-01: analyzeAttachedPictures matrix. Pure module — cover art is addressed by
// VIDEO ORDINAL (position among video-typed streams), never by source index,
// because that is the semantics of `-c:v:N` in the ffmpeg output.

import { describe, it, expect } from 'vitest';
import { analyzeAttachedPictures, isAttachedPictureStream } from '@/src/lib/encode/attached-pic';
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
