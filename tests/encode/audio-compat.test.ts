// 05-14 audit-added (G3): audio-compat helper coverage. Pure-module tests
// covering MP4/MKV codec sets + analyzeAudioStreams over a synthetic
// ProbeResult.
// 10-02 E-D3: updated assertions to discriminated union AudioAnalysisOutcome
// (hasIncompatibleAudio/incompatibleAudioStreams → outcome/incompatibleStreams).

import { describe, it, expect } from 'vitest';

import {
  MP4_INCOMPATIBLE_AUDIO_CODECS,
  analyzeAudioStreams,
  incompatibleAudioCodecsFor,
} from '@/src/lib/encode/audio-compat';
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
    color: { space: null, primaries: null, transfer: null, range: null },
    hdr10: { masterDisplay: null, maxCll: null },
    streams,
  };
}

describe('incompatibleAudioCodecsFor', () => {
  it.each([
    'truehd',
    'dts',
    'flac',
    'opus',
    'pcm_s16le',
    'pcm_s16be',
    'pcm_s24le',
    'pcm_s24be',
    'pcm_s32le',
    'pcm_f32le',
    'mlp',
  ])('test_incompatibleAudioCodecsFor_mp4_contains_%s', (codec) => {
    expect(incompatibleAudioCodecsFor('mp4').has(codec)).toBe(true);
  });

  it('test_incompatibleAudioCodecsFor_when_mkv_then_empty_set', () => {
    expect(incompatibleAudioCodecsFor('mkv').size).toBe(0);
  });

  it.each(['eac3', 'aac', 'mp3', 'ac3', 'alac'])(
    'test_incompatibleAudioCodecsFor_mp4_does_NOT_contain_%s',
    (codec) => {
      expect(incompatibleAudioCodecsFor('mp4').has(codec)).toBe(false);
    },
  );

  it('test_MP4_INCOMPATIBLE_AUDIO_CODECS_set_is_frozen', () => {
    expect(Object.isFrozen(MP4_INCOMPATIBLE_AUDIO_CODECS)).toBe(true);
  });

  it('test_incompatibleAudioCodecsFor_returns_referentially_stable_set_per_container', () => {
    expect(incompatibleAudioCodecsFor('mkv')).toBe(incompatibleAudioCodecsFor('mkv'));
    expect(incompatibleAudioCodecsFor('mp4')).toBe(incompatibleAudioCodecsFor('mp4'));
  });
});

describe('analyzeAudioStreams', () => {
  it('test_analyzeAudioStreams_when_empty_streams_then_compatible', () => {
    const result = analyzeAudioStreams(makeProbe([]), 'mp4');
    expect(result.outcome).toBe('compatible');
  });

  it('test_analyzeAudioStreams_when_only_video_then_compatible', () => {
    const result = analyzeAudioStreams(
      makeProbe([{ index: 0, codec_type: 'video', codec_name: 'h264' }]),
      'mp4',
    );
    expect(result.outcome).toBe('compatible');
  });

  it('test_analyzeAudioStreams_when_one_truehd_audio_and_mp4_then_fail_fast', () => {
    // autoTranscode defaults to false → fail_fast outcome.
    // sourceStreamIndex is audio-specific (0 = first audio stream).
    const result = analyzeAudioStreams(
      makeProbe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'truehd' },
      ]),
      'mp4',
    );
    expect(result.outcome).toBe('fail_fast');
    if (result.outcome === 'fail_fast') {
      expect(result.incompatibleStreams).toEqual([0]);
      expect(result.droppedCodecs).toEqual(['truehd']);
    }
  });

  it('test_analyzeAudioStreams_when_one_truehd_audio_and_mkv_then_compatible', () => {
    const result = analyzeAudioStreams(
      makeProbe([{ index: 1, codec_type: 'audio', codec_name: 'truehd' }]),
      'mkv',
    );
    expect(result.outcome).toBe('compatible');
  });

  it('test_analyzeAudioStreams_when_mixed_aac_and_truehd_and_mp4_then_only_truehd_incompatible', () => {
    // aac is audio-idx 0 (compatible), truehd is audio-idx 1 (incompatible).
    const result = analyzeAudioStreams(
      makeProbe([
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
        { index: 2, codec_type: 'audio', codec_name: 'truehd' },
      ]),
      'mp4',
    );
    expect(result.outcome).toBe('fail_fast');
    if (result.outcome === 'fail_fast') {
      expect(result.incompatibleStreams).toEqual([1]);
      expect(result.droppedCodecs).toEqual(['truehd']);
    }
  });

  it('test_analyzeAudioStreams_when_audio_stream_missing_codec_name_then_skipped_no_throw', () => {
    expect(() =>
      analyzeAudioStreams(makeProbe([{ index: 1, codec_type: 'audio' }]), 'mp4'),
    ).not.toThrow();
  });

  it('test_analyzeAudioStreams_result_is_frozen', () => {
    const result = analyzeAudioStreams(makeProbe([]), 'mp4');
    expect(Object.isFrozen(result)).toBe(true);
  });
});
