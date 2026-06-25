// 05-14: subtitle-compat helper coverage. Pure-module tests covering
// MP4/MKV codec sets + analyzeStreams over a synthetic ProbeResult.

import { describe, it, expect } from 'vitest';

import {
  MP4_INCOMPATIBLE_SUBTITLE_CODECS,
  analyzeStreams,
  incompatibleSubtitleCodecsFor,
} from '@/src/lib/encode/subtitle-compat';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';

function makeProbe(streams: ProbeResult['streams']): ProbeResult {
  return {
    codec: 'h264',
    bitrate: 5_000_000,
    durationSeconds: 3600,
    width: 1920,
    height: 1080,
    container: 'matroska,webm',
    tags: {},
    streams,
  };
}

describe('incompatibleSubtitleCodecsFor', () => {
  it('test_incompatibleSubtitleCodecsFor_when_mkv_then_empty_set', () => {
    const set = incompatibleSubtitleCodecsFor('mkv');
    expect(set.size).toBe(0);
  });

  it('test_incompatibleSubtitleCodecsFor_when_mp4_then_set_contains_all_9_codecs', () => {
    const set = incompatibleSubtitleCodecsFor('mp4');
    for (const codec of [
      'subrip',
      'ass',
      'ssa',
      'hdmv_pgs_subtitle',
      'dvd_subtitle',
      'pgssub',
      'webvtt',
      'dvb_subtitle',
      'xsub',
    ]) {
      expect(set.has(codec)).toBe(true);
    }
    expect(set.size).toBeGreaterThanOrEqual(9);
  });

  it('test_incompatibleSubtitleCodecsFor_when_mp4_then_mov_text_is_NOT_in_set', () => {
    const set = incompatibleSubtitleCodecsFor('mp4');
    expect(set.has('mov_text')).toBe(false);
  });

  it('test_incompatibleSubtitleCodecsFor_returns_referentially_stable_set_per_container', () => {
    expect(incompatibleSubtitleCodecsFor('mkv')).toBe(incompatibleSubtitleCodecsFor('mkv'));
    expect(incompatibleSubtitleCodecsFor('mp4')).toBe(incompatibleSubtitleCodecsFor('mp4'));
  });

  it('test_MP4_INCOMPATIBLE_SUBTITLE_CODECS_set_is_frozen_via_Object_isFrozen', () => {
    expect(Object.isFrozen(MP4_INCOMPATIBLE_SUBTITLE_CODECS)).toBe(true);
  });
});

describe('analyzeStreams', () => {
  it('test_analyzeStreams_when_empty_streams_then_empty_result', () => {
    const result = analyzeStreams(makeProbe([]), 'mp4');
    expect(result).toEqual({
      incompatibleSubtitleStreams: [],
      hasIncompatibleSubs: false,
      droppedCodecs: [],
    });
  });

  it('test_analyzeStreams_when_no_streams_field_then_empty_result', () => {
    const probe = makeProbe(undefined);
    const result = analyzeStreams(probe, 'mp4');
    expect(result.hasIncompatibleSubs).toBe(false);
    expect(result.incompatibleSubtitleStreams).toEqual([]);
  });

  it('test_analyzeStreams_when_only_video_audio_then_empty_result', () => {
    const result = analyzeStreams(
      makeProbe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
      ]),
      'mp4',
    );
    expect(result.hasIncompatibleSubs).toBe(false);
  });

  it('test_analyzeStreams_when_one_subrip_subtitle_and_mp4_then_one_incompatible_stream', () => {
    const result = analyzeStreams(
      makeProbe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'subtitle', codec_name: 'subrip' },
      ]),
      'mp4',
    );
    expect(result.incompatibleSubtitleStreams).toEqual([1]);
    expect(result.hasIncompatibleSubs).toBe(true);
    expect(result.droppedCodecs).toEqual(['subrip']);
  });

  it('test_analyzeStreams_when_one_subrip_subtitle_and_mkv_then_empty_result', () => {
    const result = analyzeStreams(
      makeProbe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'subtitle', codec_name: 'subrip' },
      ]),
      'mkv',
    );
    expect(result.hasIncompatibleSubs).toBe(false);
    expect(result.incompatibleSubtitleStreams).toEqual([]);
  });

  it('test_analyzeStreams_when_mixed_mov_text_and_ass_and_mp4_then_only_ass_incompatible', () => {
    const result = analyzeStreams(
      makeProbe([
        { index: 2, codec_type: 'subtitle', codec_name: 'mov_text' },
        { index: 3, codec_type: 'subtitle', codec_name: 'ass' },
      ]),
      'mp4',
    );
    expect(result.incompatibleSubtitleStreams).toEqual([3]);
    expect(result.droppedCodecs).toEqual(['ass']);
  });

  it('test_analyzeStreams_when_subtitle_stream_missing_codec_name_then_skipped_no_throw', () => {
    expect(() =>
      analyzeStreams(makeProbe([{ index: 1, codec_type: 'subtitle' }]), 'mp4'),
    ).not.toThrow();
    const result = analyzeStreams(makeProbe([{ index: 1, codec_type: 'subtitle' }]), 'mp4');
    expect(result.hasIncompatibleSubs).toBe(false);
  });

  it('test_analyzeStreams_when_multiple_incompatible_then_all_indices_collected_unique_codecs', () => {
    const result = analyzeStreams(
      makeProbe([
        { index: 1, codec_type: 'subtitle', codec_name: 'subrip' },
        { index: 2, codec_type: 'subtitle', codec_name: 'ass' },
        { index: 3, codec_type: 'subtitle', codec_name: 'subrip' },
      ]),
      'mp4',
    );
    expect(result.incompatibleSubtitleStreams).toEqual([1, 2, 3]);
    expect(result.droppedCodecs).toEqual(['ass', 'subrip']);
  });

  it('test_analyzeStreams_result_is_frozen_via_Object_isFrozen', () => {
    const result = analyzeStreams(makeProbe([]), 'mp4');
    expect(Object.isFrozen(result)).toBe(true);
  });
});
