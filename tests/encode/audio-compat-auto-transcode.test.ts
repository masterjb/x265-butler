// 10-02 E-D3: audio auto-transcode path — analyzeAudioStreams when autoTranscode=true.
import { describe, it, expect } from 'vitest';
import { analyzeAudioStreams } from '@/src/lib/encode/audio-compat';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';

function probe(streams: ProbeResult['streams']): ProbeResult {
  return {
    codec: 'h264',
    bitrate: 5_000_000,
    durationSeconds: 60,
    width: 1920,
    height: 1080,
    container: 'matroska',
    tags: {},
    streams,
  };
}

describe('analyzeAudioStreams — auto-transcode path (10-02 E-D3)', () => {
  it('test_autoTranscode_when_truehd_mp4_then_outcome_auto_transcode_with_aac_target', () => {
    const result = analyzeAudioStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'truehd' },
      ]),
      'mp4',
      { autoTranscode: true },
    );
    expect(result.outcome).toBe('auto_transcode');
    if (result.outcome !== 'auto_transcode') return;
    expect(result.perStreamTargets).toHaveLength(1);
    expect(result.perStreamTargets[0]).toMatchObject({
      sourceStreamIndex: 0,
      action: 'aac',
      fromCodec: 'truehd',
    });
  });

  it('test_autoTranscode_when_truehd_multichannel_mp4_then_bitrate_256k', () => {
    const result = analyzeAudioStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 6 },
      ]),
      'mp4',
      { autoTranscode: true },
    );
    expect(result.outcome).toBe('auto_transcode');
    if (result.outcome !== 'auto_transcode') return;
    expect(result.perStreamTargets[0]?.bitrate).toBe(256000);
  });

  it('test_autoTranscode_when_truehd_stereo_mp4_then_bitrate_192k', () => {
    const result = analyzeAudioStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 2 },
      ]),
      'mp4',
      { autoTranscode: true },
    );
    expect(result.outcome).toBe('auto_transcode');
    if (result.outcome !== 'auto_transcode') return;
    expect(result.perStreamTargets[0]?.bitrate).toBe(192000);
  });

  it('test_autoTranscode_when_aac_truehd_mixed_then_copy_for_aac_aac_for_truehd', () => {
    const result = analyzeAudioStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
        { index: 2, codec_type: 'audio', codec_name: 'truehd' },
      ]),
      'mp4',
      { autoTranscode: true },
    );
    expect(result.outcome).toBe('auto_transcode');
    if (result.outcome !== 'auto_transcode') return;
    expect(result.perStreamTargets).toHaveLength(2);
    expect(result.perStreamTargets[0]).toMatchObject({
      sourceStreamIndex: 0,
      action: 'copy',
      fromCodec: 'aac',
    });
    expect(result.perStreamTargets[1]).toMatchObject({
      sourceStreamIndex: 1,
      action: 'aac',
      fromCodec: 'truehd',
    });
  });

  it('test_autoTranscode_when_all_aac_mp4_then_outcome_compatible', () => {
    const result = analyzeAudioStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
      ]),
      'mp4',
      { autoTranscode: true },
    );
    expect(result.outcome).toBe('compatible');
  });

  it('test_autoTranscode_when_truehd_mkv_then_compatible_regardless', () => {
    const result = analyzeAudioStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'truehd' },
      ]),
      'mkv',
      { autoTranscode: true },
    );
    expect(result.outcome).toBe('compatible');
  });

  it('test_autoTranscode_when_truehd_mp4_autoTranscode_false_then_fail_fast', () => {
    const result = analyzeAudioStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'truehd' },
      ]),
      'mp4',
      { autoTranscode: false },
    );
    expect(result.outcome).toBe('fail_fast');
  });

  it('test_autoTranscode_when_isMatchSource_true_takes_precedence_over_autoTranscode', () => {
    const result = analyzeAudioStreams(
      probe([
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'truehd' },
      ]),
      'mp4',
      { autoTranscode: true, isMatchSource: true },
    );
    expect(result.outcome).toBe('fallback_to_mkv');
  });
});
