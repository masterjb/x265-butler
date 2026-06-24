import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}));

import {
  runEncode,
  buildArgs,
  __forTests_resetQsvDefaultedWarn,
  type ProgressEvent,
} from '@/src/lib/encode/ffmpeg';
import { __forTests_resetX265PoolsCache } from '@/src/lib/encode/profiles';
import type { DetectionResult } from '@/src/lib/encode/detection';

// 37-01: the libx265 block now appends `-x265-params pools=<min(cpuCount,16)>` by
// default, which is non-deterministic across CI hosts. Pin every byte-identical
// libx265 assertion in this file to the X265_POOLS=0 native path (pools=null → NO
// arg = the frozen pre-37 output) so the regression gate stays exact without
// weakening it. Restored after each test.
const _origX265Pools = process.env.X265_POOLS;

class FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding?: (enc: string) => void };
  stderr = new EventEmitter();
  kill = vi.fn();

  constructor() {
    super();
    const stdout = new EventEmitter() as EventEmitter & { setEncoding?: (enc: string) => void };
    stdout.setEncoding = vi.fn();
    this.stdout = stdout;
  }
}

beforeEach(() => {
  spawnMock.mockReset();
  process.env.X265_POOLS = '0'; // 37-01 native pin: libx265 block stays pre-37 byte-identical
  __forTests_resetX265PoolsCache();
});

afterEach(() => {
  vi.useRealTimers();
  if (_origX265Pools === undefined) delete process.env.X265_POOLS;
  else process.env.X265_POOLS = _origX265Pools;
  __forTests_resetX265PoolsCache();
});

describe('runEncode — args + happy path', () => {
  it('test_runEncode_when_called_then_spawns_ffmpeg_with_exact_args', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/in.mp4', output: '/out.x265.mkv', crf: 23 });
    child.emit('close', 0);
    await p;

    expect(spawnMock).toHaveBeenCalledOnce();
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('ffmpeg');
    // 05-14 spec change: MKV default no longer includes the MP4-specific
    // `-movflags +faststart` pair. The flag was a silent no-op under the
    // matroska muxer pre-05-14; explicit container plumbing means MKV gets
    // an empty muxer-args set per `muxerArgsFor('mkv')`.
    expect(args).toEqual([
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      '/in.mp4',
      '-c:v',
      'libx265',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-c:a',
      'copy',
      '-c:s',
      'copy',
      '-map',
      '0',
      '-map_metadata',
      '0',
      '-progress',
      'pipe:1',
      '/out.x265.mkv',
    ]);
  });

  it('test_runEncode_when_preset_overridden_then_uses_provided_value', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/i', output: '/o', crf: 28, preset: 'slow' });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args[8]).toBe('slow');
  });

  it('test_runEncode_when_exit_zero_then_resolves_with_exitCode_0_and_logTail', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/i', output: '/o', crf: 23 });
    child.stderr.emit('data', Buffer.from('encoder info\n'));
    child.emit('close', 0);
    const result = await p;
    expect(result.exitCode).toBe(0);
    expect(result.logTail).toContain('encoder info');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('test_runEncode_when_exit_nonzero_then_resolves_with_exitCode_and_stderr_tail', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/i', output: '/o', crf: 23 });
    child.stderr.emit('data', Buffer.from('Invalid data found when processing input'));
    child.emit('close', 1);
    const result = await p;
    expect(result.exitCode).toBe(1);
    expect(result.logTail).toContain('Invalid data found');
  });
});

describe('runEncode — progress parser', () => {
  it('test_runEncode_when_progress_lines_emitted_then_onProgress_called_per_event', async () => {
    const events: ProgressEvent[] = [];
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o',
      crf: 23,
      onProgress: (ev) => events.push(ev),
    });
    child.stdout.emit(
      'data',
      'frame=10\nfps=25.0\nout_time_ms=400000\ntotal_size=1024\nprogress=continue\n',
    );
    child.stdout.emit(
      'data',
      'frame=20\nfps=24.5\nout_time_ms=800000\ntotal_size=2048\nprogress=end\n',
    );
    child.emit('close', 0);
    await p;
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      frame: 10,
      fps: 25.0,
      outTimeMs: 400, // 400000 us / 1000 = 400 ms
      totalSize: 1024,
      progress: 'continue',
    });
    expect(events[1].progress).toBe('end');
    expect(events[1].frame).toBe(20);
  });

  it('test_runEncode_when_progress_split_across_chunks_then_buffered_correctly', async () => {
    const events: ProgressEvent[] = [];
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o',
      crf: 23,
      onProgress: (ev) => events.push(ev),
    });
    // Split mid-key: parser must wait for newline.
    child.stdout.emit('data', 'frame=10\nfp');
    child.stdout.emit('data', 's=25.0\nprogress=continue\n');
    child.emit('close', 0);
    await p;
    expect(events).toHaveLength(1);
    expect(events[0].fps).toBe(25.0);
  });
});

describe('runEncode — caps + abort + close-await', () => {
  it('test_runEncode_when_stdout_exceeds_cap_then_kills_and_rejects', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/i', output: '/o', crf: 23 });
    // 9 MiB of data — exceeds 8 MiB cap.
    const huge = 'x'.repeat(9 * 1024 * 1024);
    child.stdout.emit('data', huge);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    // Audit M2: close MUST fire before promise settles.
    child.emit('close', null);
    await expect(p).rejects.toThrow(/stdout exceeded cap/);
  });

  it('test_runEncode_when_stderr_exceeds_tail_window_then_only_tail_kept', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/i', output: '/o', crf: 23 });
    // Push 30 KiB of stderr; tail should keep last 16 KiB.
    const filler = 'a'.repeat(14 * 1024);
    const tail = 'TAIL_MARKER';
    child.stderr.emit('data', Buffer.from(filler));
    child.stderr.emit('data', Buffer.from(filler));
    child.stderr.emit('data', Buffer.from(tail));
    child.emit('close', 0);
    const result = await p;
    expect(result.logTail.length).toBeLessThanOrEqual(16 * 1024);
    expect(result.logTail).toContain('TAIL_MARKER');
  });

  it('test_runEncode_when_signal_aborts_then_SIGTERM_then_SIGKILL_after_5s', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const ctrl = new AbortController();
    const p = runEncode({ input: '/i', output: '/o', crf: 23, signal: ctrl.signal });
    ctrl.abort();
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    vi.advanceTimersByTime(5001);
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    child.emit('close', null);
    await expect(p).rejects.toThrow(/aborted/);
  });

  it('test_runEncode_when_signal_aborts_then_rejects_with_AbortError', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const ctrl = new AbortController();
    const p = runEncode({ input: '/i', output: '/o', crf: 23, signal: ctrl.signal });
    ctrl.abort();
    child.emit('close', null);
    let caught: Error | null = null;
    try {
      await p;
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.name).toBe('AbortError');
  });

  it('test_runEncode_when_close_event_fires_after_kill_then_promise_settles_only_then', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    let resolved = false;
    const p = runEncode({ input: '/i', output: '/o', crf: 23 }).then(() => {
      resolved = true;
    });
    // Trigger kill via stdout-cap exceeded.
    child.stdout.emit('data', 'x'.repeat(9 * 1024 * 1024));
    expect(child.kill).toHaveBeenCalled();
    // BEFORE close: promise must NOT have settled.
    await Promise.resolve();
    expect(resolved).toBe(false);
    child.emit('close', null);
    await expect(p).rejects.toBeTruthy();
  });

  it('test_runEncode_when_spawn_error_ENOENT_then_rejects_and_logs_warn', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/i', output: '/o', crf: 23 });
    const err = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
    await expect(p).rejects.toThrow(/ENOENT/);
  });
});

// 03-01 audit M1 — encoder dispatch via profiles.ts buildCodecBlock.
describe('runEncode — encoder dispatch (03-01 audit M1)', () => {
  it('test_runEncode_when_encoder_undefined_then_full_args_byte_identical_to_pre_03_01', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/in.mp4', output: '/out.x265.mkv', crf: 23 });
    child.emit('close', 0);
    await p;
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('ffmpeg');
    // 05-14 spec change: MKV default no longer emits the MP4-specific
    // `-movflags +faststart` pair. Pre-05-14 byte-identical regression baseline
    // updated accordingly. The orchestrator-integration MKV path is
    // re-validated against the new shape; MP4 path covered in the dedicated
    // describe block below.
    expect(args).toEqual([
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      '/in.mp4',
      '-c:v',
      'libx265',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-c:a',
      'copy',
      '-c:s',
      'copy',
      '-map',
      '0',
      '-map_metadata',
      '0',
      '-progress',
      'pipe:1',
      '/out.x265.mkv',
    ]);
  });

  // 2026-04-27 hotfix: ffmpeg encoder name is `hevc_nvenc` (NOT `h265_nvenc`).
  it('test_runEncode_when_encoder_nvenc_then_args_dispatch_to_hevc_nvenc_block', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/i', output: '/o', crf: 23, encoder: 'nvenc' });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('hevc_nvenc');
    expect(args).not.toContain('h265_nvenc');
    expect(args).toContain('constqp');
    expect(args).not.toContain('libx265');
  });

  it('test_runEncode_when_encoder_vaapi_with_vaapiDevice_then_args_use_provided_device', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o',
      crf: 22,
      encoder: 'vaapi',
      vaapiDevice: '/dev/dri/renderD129',
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('/dev/dri/renderD129');
    expect(args).toContain('hevc_vaapi');
    expect(args).toContain('format=nv12,hwupload');
  });
});

// 04-01: PROCESSED_BY metadata args (additive — byte-identical when undefined).
describe('runEncode — 04-01 metadata args', () => {
  // audit S1: explicit array snapshot — regression gate must be deterministic.
  // 05-14: MKV default container now produces an empty muxer-args set (the
  // legacy `-movflags +faststart` was MP4-specific and silently ignored by
  // the matroska muxer pre-05-14).
  it('test_buildArgs_libx265_crf23_metadata_undefined_snapshot_exact_array', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/in.mkv', output: '/out.x265.mkv', crf: 23 });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual([
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      '/in.mkv',
      '-c:v',
      'libx265',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-c:a',
      'copy',
      '-c:s',
      'copy',
      '-map',
      '0',
      '-map_metadata',
      '0',
      '-progress',
      'pipe:1',
      '/out.x265.mkv',
    ]);
  });

  // audit S1: snapshot of metadata-present arg order.
  it('test_buildArgs_libx265_crf23_metadata_4_keys_snapshot_exact_array', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/in.mkv',
      output: '/out.x265.mkv',
      crf: 23,
      metadata: [
        ['PROCESSED_BY', 'x265-butler'],
        ['X265_BUTLER_VERSION', '1.4.0'],
        ['X265_BUTLER_HASH', 'ab12cd34'],
        ['X265_BUTLER_PROCESSED_AT', '2026-04-27T14:30:00.000Z'],
      ],
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual([
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      '/in.mkv',
      '-c:v',
      'libx265',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-c:a',
      'copy',
      '-c:s',
      'copy',
      '-map',
      '0',
      '-map_metadata',
      '0',
      '-metadata',
      'PROCESSED_BY=x265-butler',
      '-metadata',
      'X265_BUTLER_VERSION=1.4.0',
      '-metadata',
      'X265_BUTLER_HASH=ab12cd34',
      '-metadata',
      'X265_BUTLER_PROCESSED_AT=2026-04-27T14:30:00.000Z',
      '-progress',
      'pipe:1',
      '/out.x265.mkv',
    ]);
  });

  // 05-14: under MKV default the metadata args land directly before `-progress`
  // (no muxer args between them). MP4 path is exercised in the 05-14 describe
  // block below where the `-movflags +faststart` ordering is asserted.
  it('test_buildArgs_when_metadata_provided_mkv_default_then_metadata_AFTER_map_metadata_BEFORE_progress', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o',
      crf: 23,
      metadata: [['PROCESSED_BY', 'x265-butler']],
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    const mapMetadataIdx = args.indexOf('-map_metadata');
    const metaIdx = args.indexOf('-metadata');
    const progressIdx = args.indexOf('-progress');
    expect(mapMetadataIdx).toBeLessThan(metaIdx);
    expect(metaIdx).toBeLessThan(progressIdx);
    expect(args.indexOf('-movflags')).toBe(-1);
  });

  it('test_buildArgs_when_metadata_with_4_keys_then_argv_has_8_metadata_tokens', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o',
      crf: 23,
      metadata: [
        ['A', '1'],
        ['B', '2'],
        ['C', '3'],
        ['D', '4'],
      ],
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    const metaCount = args.filter((a: string) => a === '-metadata').length;
    expect(metaCount).toBe(4);
  });
});

// 05-14: outputContainer + dropIncompatibleSubtitles + pino warn audit-trail.
import { logger } from '@/src/lib/logger';

describe('runEncode — 05-14 outputContainer + subtitle drop', () => {
  it('test_runEncode_when_outputContainer_mkv_then_argv_has_NO_movflags', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/out.x265.mkv',
      crf: 23,
      outputContainer: 'mkv',
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args.indexOf('-movflags')).toBe(-1);
    expect(args.indexOf('+faststart')).toBe(-1);
    // 31-01 AC-2: mkv path carries no codec fourcc tag (Matroska ignores it).
    expect(args.indexOf('-tag:v')).toBe(-1);
    expect(args.indexOf('hvc1')).toBe(-1);
  });

  it('test_runEncode_when_outputContainer_mp4_then_argv_has_movflags_faststart_before_output_path', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/in.mkv',
      output: '/out.x265.mp4',
      crf: 23,
      outputContainer: 'mp4',
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    const movflagsIdx = args.indexOf('-movflags');
    expect(movflagsIdx).toBeGreaterThan(-1);
    expect(args[movflagsIdx + 1]).toBe('+faststart');
    const outputIdx = args.lastIndexOf('/out.x265.mp4');
    expect(movflagsIdx).toBeLessThan(outputIdx);
    // 31-01 AC-3: '-tag:v' 'hvc1' adjacent pair appears after '-map_metadata 0'
    // and before the output path (Apple QuickTime/Photos compat fourcc).
    const tagIdx = args.indexOf('-tag:v');
    expect(tagIdx).toBeGreaterThan(-1);
    expect(args[tagIdx + 1]).toBe('hvc1');
    const mapMetadataIdx = args.indexOf('-map_metadata');
    expect(mapMetadataIdx).toBeGreaterThan(-1);
    expect(args[mapMetadataIdx + 1]).toBe('0');
    expect(tagIdx).toBeGreaterThan(mapMetadataIdx);
    expect(tagIdx).toBeLessThan(outputIdx);
    // 31-01 SR-2: exactly one '-tag:v' token (anti-double-emit guard).
    expect(args.filter((a: string) => a === '-tag:v')).toHaveLength(1);
    // 31-01 SR-1: the hvc1 fourcc is valid ONLY for an HEVC stream — assert an
    // HEVC encoder token in the SAME argv so a future non-HEVC mp4 path trips
    // this gate instead of silently mislabeling output.
    expect(args.some((a: string) => /^(libx265|hevc_(nvenc|qsv|vaapi))$/.test(a))).toBe(true);
  });

  it('test_runEncode_when_dropIncompatibleSubtitles_true_and_mp4_then_argv_has_sn_after_input_before_codec', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/in.mkv',
      output: '/out.x265.mp4',
      crf: 23,
      outputContainer: 'mp4',
      dropIncompatibleSubtitles: true,
      jobId: 42,
      droppedSubtitleCount: 2,
      droppedSubtitleCodecs: ['ass', 'subrip'],
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    const inputIdx = args.indexOf('/in.mkv');
    const snIdx = args.indexOf('-sn');
    const codecIdx = args.indexOf('-c:v');
    expect(snIdx).toBeGreaterThan(inputIdx);
    expect(snIdx).toBeLessThan(codecIdx);
    // Defensive: `-c:s copy` MUST be absent when `-sn` is present (ffmpeg
    // would warn about conflicting subtitle codec selection).
    expect(args.indexOf('-c:s')).toBe(-1);
    // Pino warn audit-trail event fires exactly once with expected payload.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'subtitle_streams_dropped_for_mp4',
        jobId: 42,
        droppedCount: 2,
        codecs: ['ass', 'subrip'],
        container: 'mp4',
      }),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it('test_runEncode_when_dropIncompatibleSubtitles_true_and_mkv_then_argv_has_NO_sn_AND_no_pino_warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o.x265.mkv',
      crf: 23,
      outputContainer: 'mkv',
      dropIncompatibleSubtitles: true,
      jobId: 99,
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args.indexOf('-sn')).toBe(-1);
    expect(args).toContain('-c:s');
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subtitle_streams_dropped_for_mp4' }),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  // audit-added G7: argv-snapshot pinning canonical mp4+drop ordering.
  it('test_runEncode_argv_snapshot_mp4_dropSubs_canonical', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/in.mkv',
      output: '/out.x265.mp4',
      crf: 23,
      outputContainer: 'mp4',
      dropIncompatibleSubtitles: true,
      jobId: 1,
      droppedSubtitleCount: 2,
      droppedSubtitleCodecs: ['ass', 'subrip'],
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toMatchInlineSnapshot(`
      [
        "-hide_banner",
        "-nostats",
        "-y",
        "-i",
        "/in.mkv",
        "-sn",
        "-c:v",
        "libx265",
        "-preset",
        "medium",
        "-crf",
        "23",
        "-c:a",
        "copy",
        "-map",
        "0",
        "-map_metadata",
        "0",
        "-movflags",
        "+faststart",
        "-tag:v",
        "hvc1",
        "-progress",
        "pipe:1",
        "/out.x265.mp4",
      ]
    `);
  });

  // audit-added G8: stream-map collision sanity. With `-sn` present, the argv
  // must NOT explicitly request subtitle stream mapping (would conflict).
  it('test_runEncode_when_sn_present_then_no_explicit_subtitle_stream_map', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o.x265.mp4',
      crf: 23,
      outputContainer: 'mp4',
      dropIncompatibleSubtitles: true,
      jobId: 7,
      droppedSubtitleCount: 1,
      droppedSubtitleCodecs: ['subrip'],
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    // `-map 0` (full-mapping) is fine; ffmpeg+`-sn` together drop subtitle
    // streams from the default mapping. What MUST NOT appear is an explicit
    // `-map 0:s` directive that contradicts `-sn`.
    expect(args.includes('0:s')).toBe(false);
    expect(args.some((a: string) => /^0:s\??$/.test(a))).toBe(false);
  });
});

// 12-03 AC-4 + SR1: buildArgs threads preset for ALL 4 encoders (not just
// libx265). Non-preset flags BYTE-IDENTICAL pre-12-03 for nvenc/qsv (SR1).
// VAAPI carries BOTH `-preset` AND `-compression_level 1` (M5 coexistence).
describe('buildArgs — 12-03 uniform preset threading (AC-4 + SR1 + M5)', () => {
  it('test_buildArgs_when_encoder_nvenc_with_preset_p7_then_argv_threads_p7_AND_non_preset_flags_byte_identical_SR1', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/i', output: '/o', crf: 22, encoder: 'nvenc', preset: 'p7' });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    const presetIdx = args.indexOf('-preset');
    expect(args[presetIdx + 1]).toBe('p7');
    // SR1: NVENC non-preset block byte-identical.
    expect(args).toContain('-tune');
    expect(args[args.indexOf('-tune') + 1]).toBe('hq');
    expect(args).toContain('-rc');
    expect(args[args.indexOf('-rc') + 1]).toBe('constqp');
    expect(args).toContain('-b:v');
    expect(args[args.indexOf('-b:v') + 1]).toBe('0');
  });

  it('test_buildArgs_when_encoder_qsv_with_preset_veryslow_then_argv_threads_veryslow_AND_global_quality_only_NO_lookahead_SR1', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o',
      crf: 22,
      encoder: 'qsv',
      preset: 'veryslow',
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args[args.indexOf('-preset') + 1]).toBe('veryslow');
    // 25-02 SR1: QSV global_quality retained; look_ahead family REMOVED (libvpl-compat).
    expect(args).toContain('-global_quality');
    expect(args[args.indexOf('-global_quality') + 1]).toBe('22');
    expect(args).not.toContain('-look_ahead');
    expect(args).not.toContain('-look_ahead_depth');
  });

  it('test_buildArgs_when_encoder_vaapi_with_preset_fast_then_argv_contains_BOTH_preset_AND_compression_level_1_M5', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o',
      crf: 22,
      encoder: 'vaapi',
      preset: 'fast',
      vaapiDevice: '/dev/dri/renderD128',
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-preset');
    expect(args[args.indexOf('-preset') + 1]).toBe('fast');
    expect(args).toContain('-compression_level');
    expect(args[args.indexOf('-compression_level') + 1]).toBe('1');
  });

  it('test_buildArgs_when_encoder_libx265_with_preset_slow_then_argv_threads_slow', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o',
      crf: 23,
      encoder: 'libx265',
      preset: 'slow',
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args[args.indexOf('-preset') + 1]).toBe('slow');
  });

  it.each(['nvenc', 'qsv', 'vaapi'] as const)(
    'test_buildArgs_when_encoder_%s_omits_preset_then_DEFAULT_fallback_applied',
    async (encoder) => {
      const child = new FakeChild();
      spawnMock.mockReturnValueOnce(child);
      const p = runEncode({ input: '/i', output: '/o', crf: 22, encoder });
      child.emit('close', 0);
      await p;
      const [, args] = spawnMock.mock.calls[0];
      const defaults: Record<string, string> = { nvenc: 'p5', qsv: 'slow', vaapi: 'slow' };
      expect(args[args.indexOf('-preset') + 1]).toBe(defaults[encoder]);
    },
  );
});

// 30-01 (AC-5): buildArgs resolves the detection-validated qsv ratecontrol
// variant from the global cache (SR-1 global-read seam). Cache-absent → ICQ-full
// default + a once-per-process `qsv_ratecontrol_defaulted` warn.
describe('buildArgs — 30-01 qsv ratecontrol variant (AC-5 + SR-2)', () => {
  function seedCache(qsvRateControl: 'icq-full' | 'cqp' | undefined): void {
    globalThis.__x265butler_encoder_cache = qsvRateControl
      ? ({ qsvRateControl } as unknown as DetectionResult)
      : undefined;
  }

  beforeEach(() => {
    seedCache(undefined); // cold cache by default
    __forTests_resetQsvDefaultedWarn();
  });

  afterEach(() => {
    globalThis.__x265butler_encoder_cache = undefined;
  });

  it('test_buildArgs_when_qsv_and_cache_cqp_then_emits_cqp_block', () => {
    seedCache('cqp');
    const args = buildArgs({ input: '/i', output: '/o', crf: 28, encoder: 'qsv', preset: 'slow' });
    expect(args).toContain('-q:v');
    expect(args[args.indexOf('-q:v') + 1]).toBe('28');
    expect(args).not.toContain('-global_quality');
    expect(args).not.toContain('-low_power');
  });

  it('test_buildArgs_when_qsv_and_cache_absent_then_icq_full_default_AND_warns_once', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
    try {
      // cache is undefined (beforeEach) → ICQ-full default.
      const a1 = buildArgs({ input: '/i', output: '/o', crf: 28, encoder: 'qsv', preset: 'slow' });
      expect(a1).toContain('-global_quality');
      expect(a1).toContain('-low_power');
      expect(a1[a1.indexOf('-low_power') + 1]).toBe('0');
      expect(a1).not.toContain('-q:v');
      // SR-2: a SECOND cold-cache qsv encode must NOT re-warn (process-once).
      buildArgs({ input: '/i', output: '/o', crf: 24, encoder: 'qsv', preset: 'slow' });
      const defaultedCalls = warnSpy.mock.calls.filter(
        (c) => (c[0] as { action?: string })?.action === 'qsv_ratecontrol_defaulted',
      );
      expect(defaultedCalls).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('test_buildArgs_when_qsv_and_cache_icq_full_validated_then_no_defaulted_warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
    try {
      seedCache('icq-full'); // VALIDATED icq-full, not a default
      const args = buildArgs({
        input: '/i',
        output: '/o',
        crf: 28,
        encoder: 'qsv',
        preset: 'slow',
      });
      expect(args).toContain('-global_quality');
      expect(args).toContain('-low_power');
      const defaultedCalls = warnSpy.mock.calls.filter(
        (c) => (c[0] as { action?: string })?.action === 'qsv_ratecontrol_defaulted',
      );
      expect(defaultedCalls).toHaveLength(0); // validated ≠ defaulted
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('test_buildArgs_when_non_qsv_then_byte_identical_regardless_of_qsv_cache', () => {
    seedCache('cqp'); // a qsv variant in cache must NOT affect other encoders
    const withCache = buildArgs({ input: '/i', output: '/o', crf: 23, encoder: 'libx265' });
    seedCache(undefined);
    const without = buildArgs({ input: '/i', output: '/o', crf: 23, encoder: 'libx265' });
    expect(withCache).toEqual(without);
    expect(withCache).not.toContain('-q:v');
    expect(withCache).toContain('-crf');
  });
});

// 35-01 — auto-crop EncodeOptions.crop threading through buildArgs.
describe('buildArgs — 35-01 auto-crop threading', () => {
  const CROP = '1920:800:0:140';

  it('AC-1: crop undefined → NO crop token for any encoder (byte-identical)', () => {
    for (const enc of ['libx265', 'nvenc', 'qsv', 'vaapi'] as const) {
      const args = buildArgs({ input: '/i', output: '/o', crf: 23, encoder: enc });
      expect(args.join(' ')).not.toContain('crop=');
    }
  });

  it('AC-2: libx265/nvenc/qsv carry -vf crop=W:H:X:Y', () => {
    for (const enc of ['libx265', 'nvenc', 'qsv'] as const) {
      const args = buildArgs({ input: '/i', output: '/o', crf: 23, encoder: enc, crop: CROP });
      const vfIdx = args.indexOf('-vf');
      expect(vfIdx).toBeGreaterThan(-1);
      expect(args[vfIdx + 1]).toBe(`crop=${CROP}`);
    }
  });

  it('AC-2: vaapi carries -vf crop=W:H:X:Y,format=nv12,hwupload', () => {
    const args = buildArgs({ input: '/i', output: '/o', crf: 22, encoder: 'vaapi', crop: CROP });
    const vfIdx = args.indexOf('-vf');
    expect(args[vfIdx + 1]).toBe(`crop=${CROP},format=nv12,hwupload`);
  });

  it('AC-2: qsv crop -vf follows -init_hw_device, before -c:v', () => {
    const args = buildArgs({
      input: '/i',
      output: '/o',
      crf: 22,
      encoder: 'qsv',
      vaapiDevice: '/dev/dri/renderD129',
      crop: CROP,
    });
    const initIdx = args.indexOf('-init_hw_device');
    const vfIdx = args.indexOf('-vf');
    const cvIdx = args.indexOf('-c:v');
    expect(initIdx).toBeGreaterThan(-1);
    expect(vfIdx).toBeGreaterThan(initIdx);
    expect(cvIdx).toBeGreaterThan(vfIdx);
  });
});
