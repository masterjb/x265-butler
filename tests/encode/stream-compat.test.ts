// 41-01: analyzeIncompatibleStreams matrix. Pure module — MKV drops data+unknown
// ONLY; attachment (MH-1: anime ASS fonts) + A/V/S are kept; MP4 always empty.

import { describe, it, expect } from 'vitest';
import {
  analyzeIncompatibleStreams,
  MKV_COMPATIBLE_STREAM_TYPES,
} from '@/src/lib/encode/stream-compat';
import type { ProbeResult, ProbeStream } from '@/src/lib/scan/ffprobe';

function probe(streams: ProbeStream[]): ProbeResult {
  return {
    codec: 'h264',
    bitrate: null,
    durationSeconds: null,
    width: 1920,
    height: 1080,
    container: 'mov',
    tags: {},
    streams,
  };
}

describe('analyzeIncompatibleStreams — MKV container', () => {
  it('drops data streams (iPhone mebx case → data:none) and unknown, keeps video', () => {
    const r = analyzeIncompatibleStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'data', codec_name: 'none' },
      ]),
      'mkv',
    );
    expect(r.hasIncompatible).toBe(true);
    expect(r.incompatibleStreamIndices).toEqual([1]);
    expect(r.droppedDescriptors).toEqual(['data:none']);
  });

  it('flags an unknown codec_type', () => {
    const r = analyzeIncompatibleStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'hevc' },
        { index: 1, codec_type: 'unknown', codec_name: 'bin_data' },
      ]),
      'mkv',
    );
    expect(r.incompatibleStreamIndices).toEqual([1]);
    expect(r.droppedDescriptors).toEqual(['unknown:bin_data']);
  });

  it('MH-1: KEEPS attachment streams (fonts) — never flagged, no descriptor', () => {
    const r = analyzeIncompatibleStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
        { index: 2, codec_type: 'subtitle', codec_name: 'ass' },
        { index: 3, codec_type: 'attachment', codec_name: 'ttf' },
      ]),
      'mkv',
    );
    expect(r.hasIncompatible).toBe(false);
    expect(r.incompatibleStreamIndices).toEqual([]);
    expect(r.droppedDescriptors).toEqual([]);
    // attachment IS in the compatible set.
    expect(MKV_COMPATIBLE_STREAM_TYPES.has('attachment')).toBe(true);
  });

  it('A/V/S-only source → no incompatible streams', () => {
    const r = analyzeIncompatibleStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
        { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
      ]),
      'mkv',
    );
    expect(r.hasIncompatible).toBe(false);
  });

  it('missing codec_name → `none` descriptor', () => {
    const r = analyzeIncompatibleStreams(probe([{ index: 0, codec_type: 'data' }]), 'mkv');
    expect(r.droppedDescriptors).toEqual(['data:none']);
  });

  it('sorts + dedupes descriptors across multiple data streams', () => {
    const r = analyzeIncompatibleStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'data', codec_name: 'none' },
        { index: 2, codec_type: 'data', codec_name: 'none' },
        { index: 3, codec_type: 'data', codec_name: 'bin_data' },
      ]),
      'mkv',
    );
    expect(r.incompatibleStreamIndices).toEqual([1, 2, 3]);
    expect(r.droppedDescriptors).toEqual(['data:bin_data', 'data:none']);
  });

  it('skips a stream with missing/empty codec_type (defensive guard)', () => {
    const r = analyzeIncompatibleStreams(
      // empty codec_type exercises the defensive guard path
      probe([
        { index: 0, codec_type: '' },
        { index: 1, codec_type: 'video', codec_name: 'h264' },
      ]),
      'mkv',
    );
    expect(r.hasIncompatible).toBe(false);
  });

  it('empty streams → empty result', () => {
    const r = analyzeIncompatibleStreams(probe([]), 'mkv');
    expect(r.hasIncompatible).toBe(false);
    expect(r.incompatibleStreamIndices).toEqual([]);
    expect(r.droppedDescriptors).toEqual([]);
  });
});

describe('analyzeIncompatibleStreams — MP4 container', () => {
  it('returns the empty result even with data streams (MP4 keeps timed metadata)', () => {
    const r = analyzeIncompatibleStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'data', codec_name: 'none' },
      ]),
      'mp4',
    );
    expect(r.hasIncompatible).toBe(false);
    expect(r.incompatibleStreamIndices).toEqual([]);
    expect(r.droppedDescriptors).toEqual([]);
  });
});

describe('analyzeIncompatibleStreams — purity', () => {
  it('returns a frozen result', () => {
    const r = analyzeIncompatibleStreams(probe([{ index: 0, codec_type: 'data' }]), 'mkv');
    expect(Object.isFrozen(r)).toBe(true);
  });
});
