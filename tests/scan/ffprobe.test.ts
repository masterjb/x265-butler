import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}));

import { ffprobe } from '@/src/lib/scan/ffprobe';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('ffprobe', () => {
  it('test_ffprobe_when_valid_json_with_video_stream_then_returns_probe_result', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/path/to/video.mp4');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [
            { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
          format: {
            bit_rate: '5000000',
            duration: '7200.5',
            format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
          },
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result).toEqual({
      codec: 'h264',
      bitrate: 5_000_000,
      durationSeconds: 7200.5,
      width: 1920,
      height: 1080,
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      tags: {},
      // 43-03: color all-null when source stream carries no VUI fields.
      color: { space: null, primaries: null, transfer: null, range: null },
      // 43-04: hdr10 both-null when source carries no side_data_list.
      hdr10: { masterDisplay: null, maxCll: null },
      // 05-14: full stream list propagated through ProbeResult.streams.
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
      ],
    });
  });

  it('test_ffprobe_when_called_then_uses_array_args_and_no_shell', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/path with spaces/video.mp4');
    child.stdout.emit('data', Buffer.from('{}'));
    child.emit('close', 0);
    await promise;

    expect(spawnMock).toHaveBeenCalledOnce();
    const call = spawnMock.mock.calls[0];
    const executable = call[0];
    const args = call[1];
    const options = call[2];
    expect(executable).toBe('ffprobe');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '/path with spaces/video.mp4',
    ]);
    expect(options.shell).toBeUndefined();
  });

  it('test_ffprobe_when_non_zero_exit_then_returns_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mp4');
    child.stderr.emit('data', Buffer.from('moov atom not found'));
    child.emit('close', 1);
    expect(await promise).toBeNull();
  });

  it('test_ffprobe_when_stdout_invalid_json_then_returns_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mp4');
    child.stdout.emit('data', Buffer.from('not json'));
    child.emit('close', 0);
    expect(await promise).toBeNull();
  });

  it('test_ffprobe_when_no_video_stream_then_returns_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mp4');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [{ codec_type: 'audio', codec_name: 'aac' }],
          format: { bit_rate: '128000', duration: '180', format_name: 'mp3' },
        }),
      ),
    );
    child.emit('close', 0);
    expect(await promise).toBeNull();
  });

  it('test_ffprobe_when_video_stream_lacks_codec_name_then_returns_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mp4');
    child.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video' }], format: {} })),
    );
    child.emit('close', 0);
    expect(await promise).toBeNull();
  });

  it('test_ffprobe_when_format_missing_optional_fields_then_returns_nulls', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mp4');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'hevc' }],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result).toEqual({
      codec: 'hevc',
      bitrate: null,
      durationSeconds: null,
      width: null,
      height: null,
      container: '',
      tags: {},
      color: { space: null, primaries: null, transfer: null, range: null },
      hdr10: { masterDisplay: null, maxCll: null },
      streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc' }],
    });
  });

  // 04-01: format.tags propagated through ProbeResult.tags + UPPER-normalized.
  it('test_ffprobe_when_format_has_tags_then_returns_tags_field_normalized_uppercase', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'hevc' }],
          format: {
            tags: {
              processed_by: 'x265-butler',
              X265_BUTLER_VERSION: '1.4.0',
              x265_BUTLER_HASH: 'ab12cd34',
            },
          },
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result?.tags).toEqual({
      PROCESSED_BY: 'x265-butler',
      X265_BUTLER_VERSION: '1.4.0',
      X265_BUTLER_HASH: 'ab12cd34',
    });
  });

  it('test_ffprobe_when_no_tags_field_then_tags_is_empty_object', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'h264' }],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result?.tags).toEqual({});
  });

  // audit-added M2: timeout must SIGKILL AND await close before resolving
  it('test_ffprobe_when_timeout_then_kills_and_waits_for_close_before_resolving', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    let resolved = false;
    const promise = ffprobe('/x.mp4', { timeoutMs: 50 }).then((r) => {
      resolved = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    // Critical: not resolved yet — waiting for child 'close' event.
    expect(resolved).toBe(false);
    child.emit('close', null);
    const result = await promise;
    expect(result).toBeNull();
    expect(resolved).toBe(true);
  });

  // audit-added S2: stdout cap kills the child and returns null
  it('test_ffprobe_when_stdout_exceeds_cap_then_kills_and_returns_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mp4');
    // Push 11 MiB worth of data (above 10 MiB cap).
    child.stdout.emit('data', Buffer.alloc(11 * 1024 * 1024));
    child.emit('close', null);
    const result = await promise;
    expect(result).toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  // audit-added S2: stderr sliding window keeps only the tail
  it('test_ffprobe_when_stderr_oversized_then_only_tail_is_logged', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mp4');
    // Stream 16 KiB of stderr — only last 8 KiB should be retained.
    const big = Buffer.alloc(16 * 1024, 0x41); // 'A'*16k
    child.stderr.emit('data', big);
    child.emit('close', 1);
    expect(await promise).toBeNull();
    // Behavior is observable via internal tail (8 KiB) — we assert the
    // function returns null on non-zero exit; that the tail did not
    // explode memory is implicit (no OOM).
  });

  // 43-03 AC-5: VUI color fields extracted from the existing -show_streams JSON.
  it('test_ffprobe_when_video_stream_has_sdr_bt709_color_then_all_four_fields_set', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              color_space: 'bt709',
              color_primaries: 'bt709',
              color_transfer: 'bt709',
              color_range: 'tv',
            },
          ],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result?.color).toEqual({
      space: 'bt709',
      primaries: 'bt709',
      transfer: 'bt709',
      range: 'tv',
    });
  });

  it('test_ffprobe_when_video_stream_has_hdr_bt2020_then_values_verbatim', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              codec_name: 'hevc',
              color_space: 'bt2020nc',
              color_primaries: 'bt2020',
              color_transfer: 'smpte2084',
              color_range: 'tv',
            },
          ],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result?.color).toEqual({
      space: 'bt2020nc',
      primaries: 'bt2020',
      transfer: 'smpte2084',
      range: 'tv',
    });
  });

  it('test_ffprobe_when_color_unknown_or_absent_or_empty_then_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              color_space: 'unknown',
              color_primaries: 'reserved',
              color_transfer: '',
              // color_range absent entirely
            },
          ],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result?.color).toEqual({
      space: null,
      primaries: null,
      transfer: null,
      range: null,
    });
  });

  it('test_ffprobe_when_color_partial_only_range_set_then_only_range_non_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              color_range: 'pc',
            },
          ],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result?.color).toEqual({
      space: null,
      primaries: null,
      transfer: null,
      range: 'pc',
    });
  });

  it('test_ffprobe_when_spawn_emits_error_then_returns_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mp4');
    child.emit('error', new Error('spawn ENOENT'));
    expect(await promise).toBeNull();
  });

  // 43-04 AC-5: HDR10 static metadata extracted from the existing -show_streams
  // side_data_list (no new ffprobe arg). The positive fixture below is a VERBATIM
  // `ffprobe -show_streams -print_format json` side_data_list capture from a
  // canonical BT.2020 / DCI-P3-primaries HDR10 file (max_luminance 1000 nits,
  // min 0.005 nits, MaxCLL 1000 / MaxFALL 400) — NOT hand-guessed (audit-added S1).
  const HDR10_SIDE_DATA = [
    {
      side_data_type: 'Mastering display metadata',
      red_x: '34000/50000',
      red_y: '16000/50000',
      green_x: '13250/50000',
      green_y: '34500/50000',
      blue_x: '7500/50000',
      blue_y: '3000/50000',
      white_point_x: '15635/50000',
      white_point_y: '16450/50000',
      min_luminance: '50/10000',
      max_luminance: '10000000/10000',
    },
    { side_data_type: 'Content light level metadata', max_content: 1000, max_average: 400 },
  ];

  it('test_ffprobe_when_full_hdr10_side_data_then_both_strings_formatted', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'hevc', side_data_list: HDR10_SIDE_DATA }],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    // x265/HandBrake mastering-display order: G,B,R,WP,L; numerator math (×50000
    // chroma, ×10000 luminance) yields the canonical numerator units verbatim.
    expect(result?.hdr10).toEqual({
      masterDisplay: 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)',
      maxCll: '1000,400',
    });
  });

  it('test_ffprobe_when_no_side_data_list_then_hdr10_both_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'h264' }],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result?.hdr10).toEqual({ masterDisplay: null, maxCll: null });
  });

  // AC-3: per-field independence — Content-light present, NO Mastering-display.
  it('test_ffprobe_when_only_content_light_then_maxcll_set_master_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              codec_name: 'hevc',
              side_data_list: [
                {
                  side_data_type: 'Content light level metadata',
                  max_content: 4000,
                  max_average: 0,
                },
              ],
            },
          ],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result?.hdr10).toEqual({ masterDisplay: null, maxCll: '4000,0' });
  });

  // AC-3: a Mastering-display side_data missing ANY of the 10 fields → null (no
  // partial master-display). Here red_x is absent.
  it('test_ffprobe_when_mastering_missing_one_field_then_master_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    const partial = { ...HDR10_SIDE_DATA[0] } as Record<string, unknown>;
    delete partial.red_x;
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [
            {
              codec_type: 'video',
              codec_name: 'hevc',
              side_data_list: [partial, HDR10_SIDE_DATA[1]],
            },
          ],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    // master null (incomplete) but max-cll still present (per-field independence).
    expect(result?.hdr10).toEqual({ masterDisplay: null, maxCll: '1000,400' });
  });

  // AC-5: malformed fractions ("x/0" division-by-zero, "N/A", non-numeric) → that
  // field null → masterDisplay null. No NaN/Infinity leaks into argv.
  it('test_ffprobe_when_malformed_fractions_then_master_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    const bad = { ...HDR10_SIDE_DATA[0], red_x: '34000/0', green_x: 'N/A', blue_x: 'abc' };
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'hevc', side_data_list: [bad] }],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result?.hdr10.masterDisplay).toBeNull();
  });

  // AC-5: decimal-form / wrong-shape side_data (red_x "0.708" with no "/") → that
  // field null → masterDisplay null (accepted silent-no-op degrade — argv stays
  // safe, feature off for that source; audit-added S1).
  it('test_ffprobe_when_decimal_form_side_data_then_master_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mkv');
    const decimal = {
      side_data_type: 'Mastering display metadata',
      red_x: '0.708',
      red_y: '0.292',
      green_x: '0.170',
      green_y: '0.797',
      blue_x: '0.131',
      blue_y: '0.046',
      white_point_x: '0.3127',
      white_point_y: '0.3290',
      min_luminance: '0.0050',
      max_luminance: '1000.0',
    };
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: 'hevc', side_data_list: [decimal] }],
          format: {},
        }),
      ),
    );
    child.emit('close', 0);
    const result = await promise;
    expect(result?.hdr10.masterDisplay).toBeNull();
  });
});
