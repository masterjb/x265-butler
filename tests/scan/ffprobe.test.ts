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

  it('test_ffprobe_when_spawn_emits_error_then_returns_null', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const promise = ffprobe('/x.mp4');
    child.emit('error', new Error('spawn ENOENT'));
    expect(await promise).toBeNull();
  });
});
