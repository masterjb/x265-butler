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
import { __forTests_resetKeyframeCache } from '@/src/lib/encode/keyframe';
import type { DetectionResult, EncoderId } from '@/src/lib/encode/detection';

// 37-01: the libx265 block now appends `-x265-params pools=<min(cpuCount,16)>` by
// default, which is non-deterministic across CI hosts. Pin every byte-identical
// libx265 assertion in this file to the X265_POOLS=0 native path (pools=null → NO
// arg = the frozen pre-37 output) so the regression gate stays exact without
// weakening it. Restored after each test.
const _origX265Pools = process.env.X265_POOLS;

// 49-02 (AC-9): buildArgs now emits `-force_key_frames …` plus a per-encoder IDR
// pin BY DEFAULT. Every pre-49-02 byte-identical assertion in this file (≈45
// buildArgs calls) is a v2.45.0 snapshot, so the whole suite is pinned to BOTH
// kill-switches — that is exactly the combined pre-49 revert the levers promise,
// and it turns the existing regression gate into an executable proof of AC-8
// instead of deleting it. The 49-02 describe block below overrides the env
// per-test to exercise the DEFAULT form.
//
// The restore in afterEach is not optional: both accessors are memoized, so a
// leaked env value would make the ORDER of the tests in this file significant.
const _origKeyframeInterval = process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
const _origClosedGopDisabled = process.env.ENCODE_CLOSED_GOP_DISABLED;

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
  // 49-02 pin: both levers OFF ⇒ pre-49-02 (v2.45.0) argv for every assertion below.
  process.env.ENCODE_KEYFRAME_INTERVAL_SEC = '0';
  process.env.ENCODE_CLOSED_GOP_DISABLED = '1';
  __forTests_resetKeyframeCache();
});

afterEach(() => {
  vi.useRealTimers();
  if (_origX265Pools === undefined) delete process.env.X265_POOLS;
  else process.env.X265_POOLS = _origX265Pools;
  __forTests_resetX265PoolsCache();
  // 49-02: symmetric restore — memoized accessors must not leak across files.
  if (_origKeyframeInterval === undefined) delete process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
  else process.env.ENCODE_KEYFRAME_INTERVAL_SEC = _origKeyframeInterval;
  if (_origClosedGopDisabled === undefined) delete process.env.ENCODE_CLOSED_GOP_DISABLED;
  else process.env.ENCODE_CLOSED_GOP_DISABLED = _origClosedGopDisabled;
  __forTests_resetKeyframeCache();
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
      '0:v',
      '-map',
      '0:a?',
      '-map',
      '0:s?',
      '-map',
      '0:t?',
      '-map_metadata',
      '0',
      '-progress',
      'pipe:1',
      '-stats_period',
      '30',
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
      'frame=10\nfps=25.0\nout_time_ms=400000\ntotal_size=1024\nspeed=1.23x\nprogress=continue\n',
    );
    child.stdout.emit(
      'data',
      'frame=20\nfps=24.5\nout_time_ms=800000\ntotal_size=2048\nspeed=N/A\nprogress=end\n',
    );
    child.emit('close', 0);
    await p;
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      frame: 10,
      fps: 25.0,
      outTimeMs: 400, // 400000 us / 1000 = 400 ms
      totalSize: 1024,
      speed: 1.23, // 43-02: "1.23x" → 1.23 (trailing x stripped)
      progress: 'continue',
    });
    expect(events[1].progress).toBe('end');
    expect(events[1].frame).toBe(20);
    expect(events[1].speed).toBeNull(); // 43-02: "N/A" → null
  });

  // 43-02 (AC-1 / SR-1): speed edge cases — absent key → null, "0x" → 0
  // (the opening ffmpeg blocks emit speed=0x; guarded out downstream by speed>0
  // so it never produces an Infinity ETA).
  it('test_runEncode_speed_absent_yields_null_and_0x_yields_zero', async () => {
    const events: ProgressEvent[] = [];
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o',
      crf: 23,
      onProgress: (ev) => events.push(ev),
    });
    // First block: speed key entirely absent → null.
    child.stdout.emit('data', 'frame=1\nfps=10.0\nout_time_ms=100000\nprogress=continue\n');
    // Second block: speed=0x → 0 (opening-block sentinel).
    child.stdout.emit('data', 'frame=2\nfps=10.0\nout_time_ms=200000\nspeed=0x\nprogress=end\n');
    child.emit('close', 0);
    await p;
    expect(events).toHaveLength(2);
    expect(events[0].speed).toBeNull();
    expect(events[1].speed).toBe(0);
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

// 41-02: hours-long 4K encodes tripped the 8 MiB stdout cap because the default
// `-progress pipe:1` stats_period (0.5s) emits ~2 blocks/s → ~40k blocks over
// 5.5h ≈ 8.4 MiB of progress stream → SIGKILL ("stdout exceeded cap"). Two
// independent fixes: (1) throttle progress emission via `-stats_period 30`;
// (2) stop forwarding the machine-only progress stream into the human-facing
// job log (it was 99.88% of the captured log, drowning the real stderr).
describe('runEncode — 41-02 progress-flood guard', () => {
  it('test_buildArgs_when_libx265_then_emits_stats_period_30_to_throttle_progress', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/i', output: '/o', crf: 23 });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    const idx = args.indexOf('-stats_period');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('30');
  });

  it('test_runEncode_when_stdout_progress_emitted_then_excluded_from_job_log', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const chunks: string[] = [];
    const p = runEncode({
      input: '/i',
      output: '/o',
      crf: 23,
      onLogChunk: (c) => chunks.push(c.toString()),
    });
    // stdout = machine-only -progress stream; stderr = real diagnostics.
    child.stdout.emit('data', 'frame=42\nbitrate=N/A\nprogress=continue\n');
    child.stderr.emit('data', Buffer.from('x265 [info]: real diagnostic line\n'));
    child.emit('close', 0);
    await p;
    const joined = chunks.join('');
    expect(joined).toContain('x265 [info]: real diagnostic line');
    expect(joined).not.toContain('progress=continue');
  });

  it('test_runEncode_when_stdout_progress_emitted_then_onProgress_still_parses', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const events: ProgressEvent[] = [];
    const p = runEncode({
      input: '/i',
      output: '/o',
      crf: 23,
      onProgress: (ev) => events.push(ev),
    });
    child.stdout.emit('data', 'frame=42\nout_time_ms=1000\nprogress=continue\n');
    child.emit('close', 0);
    await p;
    expect(events).toHaveLength(1);
    expect(events[0].frame).toBe(42);
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
      '0:v',
      '-map',
      '0:a?',
      '-map',
      '0:s?',
      '-map',
      '0:t?',
      '-map_metadata',
      '0',
      '-progress',
      'pipe:1',
      '-stats_period',
      '30',
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
      '0:v',
      '-map',
      '0:a?',
      '-map',
      '0:s?',
      '-map',
      '0:t?',
      '-map_metadata',
      '0',
      '-progress',
      'pipe:1',
      '-stats_period',
      '30',
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
      '0:v',
      '-map',
      '0:a?',
      '-map',
      '0:s?',
      '-map',
      '0:t?',
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
      '-stats_period',
      '30',
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

  // 41-01: MKV `-map` whitelist (drops data/unknown by omission) + warn.
  it('test_runEncode_when_outputContainer_mkv_then_argv_has_avst_whitelist_NOT_bare_map_0', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/i', output: '/o.x265.mkv', crf: 23, outputContainer: 'mkv' });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    // Positive: the four whitelist map specifiers, incl. attachment (MH-1: fonts).
    expect(args).toContain('0:v');
    expect(args).toContain('0:a?');
    expect(args).toContain('0:s?');
    expect(args).toContain('0:t?');
    // Negative: no bare `-map 0` token-pair for mkv.
    const bareMapIdx = args.findIndex(
      (a: string, i: number) => a === '-map' && args[i + 1] === '0',
    );
    expect(bareMapIdx).toBe(-1);
    // `-map 0:v` has NO `?` (D1.2 — zero-video source hard-fails by design).
    const vIdx = args.indexOf('0:v');
    expect(args[vIdx - 1]).toBe('-map');
  });

  it('test_runEncode_when_mkv_and_droppedIncompatibleStreamCount_gt0_then_pino_warn_fires_once', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o.x265.mkv',
      crf: 23,
      outputContainer: 'mkv',
      jobId: 7,
      droppedIncompatibleStreamCount: 2,
      droppedIncompatibleStreamDescriptors: ['data:none', 'data:bin_data'],
    });
    child.emit('close', 0);
    await p;
    const calls = warnSpy.mock.calls.filter(
      (c) => (c[0] as { action?: string })?.action === 'incompatible_streams_dropped',
    );
    expect(calls).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'incompatible_streams_dropped',
        jobId: 7,
        droppedCount: 2,
        descriptors: ['data:none', 'data:bin_data'],
        container: 'mkv',
      }),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it('test_runEncode_when_mkv_and_count_zero_or_undefined_then_NO_incompatible_warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({ input: '/i', output: '/o.x265.mkv', crf: 23, outputContainer: 'mkv' });
    child.emit('close', 0);
    await p;
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'incompatible_streams_dropped' }),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });

  it('test_runEncode_when_mp4_then_NO_incompatible_warn_even_with_count_set', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = runEncode({
      input: '/i',
      output: '/o.x265.mp4',
      crf: 23,
      outputContainer: 'mp4',
      droppedIncompatibleStreamCount: 3,
      droppedIncompatibleStreamDescriptors: ['data:none'],
    });
    child.emit('close', 0);
    await p;
    // MP4 retains bare `-map 0` and never emits the mkv-only warn.
    const [, args] = spawnMock.mock.calls[0];
    const bareMapIdx = args.findIndex(
      (a: string, i: number) => a === '-map' && args[i + 1] === '0',
    );
    expect(bareMapIdx).toBeGreaterThan(-1);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'incompatible_streams_dropped' }),
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
        "-stats_period",
        "30",
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

describe('buildArgs — 43-01 force-10bit threading', () => {
  // AC-1 regression gate at the buildArgs layer: force10bit omitted/false ⇒ NO
  // 10-bit token for any encoder, byte-identical between omitted and explicit-false.
  it('AC-1: force10bit omitted/false → NO 10-bit token, byte-identical (all encoders)', () => {
    for (const enc of ['libx265', 'nvenc', 'qsv', 'vaapi'] as const) {
      const omitted = buildArgs({ input: '/i', output: '/o', crf: 23, encoder: enc });
      const explicitFalse = buildArgs({
        input: '/i',
        output: '/o',
        crf: 23,
        encoder: enc,
        force10bit: false,
      });
      expect(explicitFalse).toEqual(omitted);
      const joined = omitted.join(' ');
      expect(joined).not.toContain('main10');
      expect(joined).not.toContain('yuv420p10le');
      expect(joined).not.toContain('p010le');
    }
  });

  it('AC-2: libx265 buildArgs gains the 10-bit tokens when force10bit:true', () => {
    const args = buildArgs({
      input: '/i',
      output: '/o',
      crf: 23,
      encoder: 'libx265',
      force10bit: true,
    });
    const pfIdx = args.indexOf('-pix_fmt');
    expect(pfIdx).toBeGreaterThan(-1);
    expect(args[pfIdx + 1]).toBe('yuv420p10le');
    const prIdx = args.indexOf('-profile:v');
    expect(args[prIdx + 1]).toBe('main10');
  });

  it('AC-5: vaapi buildArgs swaps the filter format to p010le when force10bit:true', () => {
    const args = buildArgs({
      input: '/i',
      output: '/o',
      crf: 22,
      encoder: 'vaapi',
      force10bit: true,
    });
    const vfIdx = args.indexOf('-vf');
    expect(args[vfIdx + 1]).toBe('format=p010le,hwupload');
    expect(args.join(' ')).toContain('-profile:v main10');
  });
});

// 43-03: output-side VUI color passthrough in buildArgs. Color flags are emitted
// AFTER the codec block, ONLY for non-null source fields. opts.color undefined OR
// all-null ⇒ byte-identical to pre-43-03 (AC-1/AC-3). Values pass through verbatim.
describe('buildArgs — 43-03 color passthrough', () => {
  const ENCODERS = ['libx265', 'nvenc', 'qsv', 'vaapi'] as const;
  const COLOR_FLAGS = ['-colorspace', '-color_primaries', '-color_trc', '-color_range'];

  // AC-1: no color set ⇒ no color flags, all four encoders (byte-identical regression gate).
  it.each([...ENCODERS])('AC-1: color omitted → no color flags emitted (%s)', (encoder) => {
    const args = buildArgs({ input: '/i', output: '/o', crf: 23, encoder });
    for (const f of COLOR_FLAGS) expect(args).not.toContain(f);
  });

  // AC-1 (explicit): color omitted is byte-identical to the same call without the key.
  it('AC-1: passing color:undefined is byte-identical to omitting it (libx265)', () => {
    const base = buildArgs({ input: '/i', output: '/o', crf: 23, encoder: 'libx265' });
    const withUndef = buildArgs({
      input: '/i',
      output: '/o',
      crf: 23,
      encoder: 'libx265',
      color: undefined,
    });
    expect(withUndef).toEqual(base);
  });

  // AC-2: ON + SDR bt709 → the 4 flags with verbatim values.
  it('AC-2: bt709 SDR source emits the 4 VUI flags verbatim (libx265)', () => {
    const args = buildArgs({
      input: '/i',
      output: '/o',
      crf: 23,
      encoder: 'libx265',
      color: { space: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'tv' },
    });
    const joined = args.join(' ');
    expect(joined).toContain('-colorspace bt709');
    expect(joined).toContain('-color_primaries bt709');
    expect(joined).toContain('-color_trc bt709');
    expect(joined).toContain('-color_range tv');
  });

  // AC-3: ON + all-null source → no flags (byte-identical to OFF).
  it('AC-3: all-null source color → no flags (byte-identical to OFF)', () => {
    const off = buildArgs({ input: '/i', output: '/o', crf: 23, encoder: 'libx265' });
    const allNull = buildArgs({
      input: '/i',
      output: '/o',
      crf: 23,
      encoder: 'libx265',
      color: { space: null, primaries: null, transfer: null, range: null },
    });
    expect(allNull).toEqual(off);
  });

  // AC-3 (audit SR-2): partial spec at the buildArgs layer — per-field independence.
  // space+transfer set, primaries+range null ⇒ ONLY -colorspace + -color_trc.
  it('AC-3/SR-2: partial source emits ONLY the known fields (space+transfer)', () => {
    const args = buildArgs({
      input: '/i',
      output: '/o',
      crf: 23,
      encoder: 'libx265',
      color: { space: 'bt709', primaries: null, transfer: 'bt709', range: null },
    });
    const joined = args.join(' ');
    expect(joined).toContain('-colorspace bt709');
    expect(joined).toContain('-color_trc bt709');
    expect(args).not.toContain('-color_primaries');
    expect(args).not.toContain('-color_range');
  });

  // AC-4: ON + HDR source composes with force10bit (p010le/main10) for every encoder.
  it.each([...ENCODERS])(
    'AC-4: HDR bt2020/PQ + force10bit composes without conflict (%s)',
    (encoder) => {
      const args = buildArgs({
        input: '/i',
        output: '/o',
        crf: 22,
        encoder,
        force10bit: true,
        color: {
          space: 'bt2020nc',
          primaries: 'bt2020',
          transfer: 'smpte2084',
          range: 'tv',
        },
      });
      const joined = args.join(' ');
      // color tags emitted verbatim
      expect(joined).toContain('-colorspace bt2020nc');
      expect(joined).toContain('-color_primaries bt2020');
      expect(joined).toContain('-color_trc smpte2084');
      expect(joined).toContain('-color_range tv');
      // 10-bit Main10 still present (composes, no conflict)
      expect(joined).toContain('main10');
      expect(joined).toMatch(/p010le|yuv420p10le/);
    },
  );

  // SR-1: realistic enum-set passthrough — proves the value is gated, never
  // translated/dropped. HDR HLG (arib-std-b67) + pc range round-trip verbatim.
  it('SR-1: exotic-but-valid enums (arib-std-b67 HLG, pc range) pass through verbatim', () => {
    const args = buildArgs({
      input: '/i',
      output: '/o',
      crf: 22,
      encoder: 'nvenc',
      color: {
        space: 'bt2020nc',
        primaries: 'bt2020',
        transfer: 'arib-std-b67',
        range: 'pc',
      },
    });
    const joined = args.join(' ');
    expect(joined).toContain('-color_trc arib-std-b67');
    expect(joined).toContain('-color_range pc');
  });
});

// 43-04: HDR10 static metadata. libx265 merges master-display/max-cll into the
// SINGLE -x265-params token (after the 37-01 pools= segment). HW encoders
// (nvenc/qsv/vaapi) ignore it → argv byte-identical to OFF (ride ffmpeg auto SEI
// passthrough). undefined / both-null ⇒ byte-identical for all four (AC-1).
describe('buildArgs — 43-04 HDR10 static-metadata threading', () => {
  const ENCODERS = ['libx265', 'nvenc', 'qsv', 'vaapi'] as const;
  // Canonical formatted strings (see tests/scan/ffprobe.test.ts HDR10 fixture).
  const MASTER = 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)';
  const MAXCLL = '1000,400';
  const FULL_HDR10 = { masterDisplay: MASTER, maxCll: MAXCLL };

  // AC-1: hdr10 omitted/both-null ⇒ NO master-display/max-cll token, byte-identical.
  it.each([...ENCODERS])(
    'AC-1: hdr10 omitted/both-null → byte-identical, no x265 hdr tokens (%s)',
    (encoder) => {
      const omitted = buildArgs({ input: '/i', output: '/o', crf: 23, encoder });
      const bothNull = buildArgs({
        input: '/i',
        output: '/o',
        crf: 23,
        encoder,
        hdr10: { masterDisplay: null, maxCll: null },
      });
      expect(bothNull).toEqual(omitted);
      const joined = omitted.join(' ');
      expect(joined).not.toContain('master-display');
      expect(joined).not.toContain('max-cll');
    },
  );

  // AC-2: libx265 ON + full HDR10 ⇒ exactly ONE -x265-params token, value =
  // master-display + max-cll (pools pinned to 0 via beforeEach → no pools= prefix).
  it('AC-2: libx265 emits single -x265-params master-display:max-cll', () => {
    const args = buildArgs({
      input: '/i',
      output: '/o',
      crf: 23,
      encoder: 'libx265',
      hdr10: FULL_HDR10,
    });
    // exactly one -x265-params token
    expect(args.filter((a) => a === '-x265-params')).toHaveLength(1);
    const idx = args.indexOf('-x265-params');
    expect(args[idx + 1]).toBe(`master-display=${MASTER}:max-cll=${MAXCLL}`);
  });

  // AC-3: per-field independence — master alone, or cll alone.
  it('AC-3: master-display alone (maxCll null)', () => {
    const args = buildArgs({
      input: '/i',
      output: '/o',
      crf: 23,
      encoder: 'libx265',
      hdr10: { masterDisplay: MASTER, maxCll: null },
    });
    const idx = args.indexOf('-x265-params');
    expect(args[idx + 1]).toBe(`master-display=${MASTER}`);
  });

  it('AC-3: max-cll alone (masterDisplay null)', () => {
    const args = buildArgs({
      input: '/i',
      output: '/o',
      crf: 23,
      encoder: 'libx265',
      hdr10: { masterDisplay: null, maxCll: MAXCLL },
    });
    const idx = args.indexOf('-x265-params');
    expect(args[idx + 1]).toBe(`max-cll=${MAXCLL}`);
  });

  // AC-4: composes with pools (37-01) — pools= segment precedes the HDR10 keys.
  it('AC-4: X265_POOLS present → pools=N:master-display=…:max-cll=… (single token)', () => {
    process.env.X265_POOLS = '8';
    __forTests_resetX265PoolsCache();
    const args = buildArgs({
      input: '/i',
      output: '/o',
      crf: 23,
      encoder: 'libx265',
      hdr10: FULL_HDR10,
    });
    expect(args.filter((a) => a === '-x265-params')).toHaveLength(1);
    const idx = args.indexOf('-x265-params');
    expect(args[idx + 1]).toBe(`pools=8:master-display=${MASTER}:max-cll=${MAXCLL}`);
    // restore native pin for subsequent tests
    process.env.X265_POOLS = '0';
    __forTests_resetX265PoolsCache();
  });

  // AC-4: composes with force10bit + crop + color (libx265) — all coexist.
  it('AC-4: libx265 hdr10 + force10bit + crop + color all coexist', () => {
    const args = buildArgs({
      input: '/i',
      output: '/o',
      crf: 22,
      encoder: 'libx265',
      force10bit: true,
      crop: '1920:800:0:140',
      color: { space: 'bt2020nc', primaries: 'bt2020', transfer: 'smpte2084', range: 'tv' },
      hdr10: FULL_HDR10,
    });
    const joined = args.join(' ');
    expect(joined).toContain('crop=1920:800:0:140');
    expect(joined).toContain('-pix_fmt yuv420p10le');
    expect(joined).toContain('-profile:v main10');
    expect(joined).toContain('-colorspace bt2020nc');
    expect(joined).toContain(`-x265-params master-display=${MASTER}:max-cll=${MAXCLL}`);
  });

  // AC-6: nvenc/qsv/vaapi argv UNCHANGED with HDR10 ON (passthrough-preservation).
  it.each(['nvenc', 'qsv', 'vaapi'] as const)(
    'AC-6: %s argv byte-identical with hdr10 ON vs OFF',
    (encoder) => {
      const off = buildArgs({ input: '/i', output: '/o', crf: 23, encoder });
      const on = buildArgs({ input: '/i', output: '/o', crf: 23, encoder, hdr10: FULL_HDR10 });
      expect(on).toEqual(off);
      const joined = on.join(' ');
      expect(joined).not.toContain('master-display');
      expect(joined).not.toContain('max-cll');
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-01: embedded cover art (`attached_pic`). A cover demuxes as a VIDEO stream,
// so `-map 0:v` picks it up and the global `-c:v <enc>` pushes a 600x900 yuvj444p
// mjpeg through the HEVC encoder — the whole job dies. Fix: per-ordinal
// `-c:v:N copy` AFTER the global codec token, plus a narrowed video filter.
// ─────────────────────────────────────────────────────────────────────────────
describe('49-01 attached-pic cover-art copy', () => {
  const base = { input: '/i', output: '/o', crf: 24, preset: 'slow' } as const;

  it('AC-5: emits -c:v:1 copy after the codec block, codec token stays global (qsv)', () => {
    const args = buildArgs({
      ...base,
      encoder: 'qsv',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });
    expect(args).toContain('-c:v');
    expect(args[args.indexOf('-c:v') + 1]).toBe('hevc_qsv');
    expect(args).toContain('-c:v:1');
    expect(args[args.indexOf('-c:v:1') + 1]).toBe('copy');
    // the codec block itself is NOT narrowed (D2 variant A stays rejected)
    expect(args).not.toContain('-c:v:0');
  });

  it('AC-5: works the same for both containers (mkv -map 0:v… and mp4 -map 0)', () => {
    for (const outputContainer of ['mkv', 'mp4'] as const) {
      const args = buildArgs({
        ...base,
        encoder: 'libx265',
        outputContainer,
        attachedPicVideoOrdinals: [1],
        encodedVideoOrdinals: [0],
      });
      expect(args).toContain('-c:v:1');
      expect(args[args.indexOf('-c:v:1') + 1]).toBe('copy');
    }
  });

  it('AC-6: every -c:v:N stands AFTER the last global -c:v (ffmpeg last-match-wins)', () => {
    const args = buildArgs({
      ...base,
      encoder: 'nvenc',
      attachedPicVideoOrdinals: [1, 2],
      encodedVideoOrdinals: [0],
    });
    // lastIndexOf, NOT indexOf — a future second global -c:v token must not be
    // able to slip past this invariant unnoticed.
    const globalIdx = args.lastIndexOf('-c:v');
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    for (const n of [1, 2]) {
      expect(args.indexOf(`-c:v:${n}`)).toBeGreaterThan(globalIdx);
    }
  });

  it('AC-3: several covers each get their own copy pair', () => {
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      attachedPicVideoOrdinals: [1, 2],
      encodedVideoOrdinals: [0],
    });
    expect(args).toContain('-c:v:1');
    expect(args).toContain('-c:v:2');
    expect(args[args.indexOf('-c:v:1') + 1]).toBe('copy');
    expect(args[args.indexOf('-c:v:2') + 1]).toBe('copy');
  });

  it('AC-14: cover at ordinal 0, real video at ordinal 1', () => {
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      crop: '1920:800:0:140',
      attachedPicVideoOrdinals: [0],
      encodedVideoOrdinals: [1],
    });
    expect(args).toContain('-c:v:0');
    expect(args[args.indexOf('-c:v:0') + 1]).toBe('copy');
    expect(args).toContain('-filter:v:1');
    expect(args).not.toContain('-vf');
  });

  it('AC-13: no bare -vf survives when a cover is present (crop case)', () => {
    const prev = process.env.X265_POOLS;
    process.env.X265_POOLS = '0';
    __forTests_resetX265PoolsCache();
    try {
      for (const encoder of ['libx265', 'nvenc', 'qsv'] as const) {
        const args = buildArgs({
          ...base,
          encoder,
          crop: '1920:800:0:140',
          attachedPicVideoOrdinals: [1],
          encodedVideoOrdinals: [0],
        });
        expect(args).not.toContain('-vf');
        expect(args).toContain('-filter:v:0');
        expect(args[args.indexOf('-filter:v:0') + 1]).toBe('crop=1920:800:0:140');
      }
    } finally {
      if (prev === undefined) delete process.env.X265_POOLS;
      else process.env.X265_POOLS = prev;
      __forTests_resetX265PoolsCache();
    }
  });

  it('AC-13: vaapi narrows even WITHOUT a crop — its filter chain is unconditional', () => {
    const args = buildArgs({
      ...base,
      encoder: 'vaapi',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });
    expect(args).not.toContain('-vf');
    expect(args).toContain('-filter:v:0');
    expect(args[args.indexOf('-filter:v:0') + 1]).toBe('format=nv12,hwupload');
    expect(args).toContain('-c:v:1');
  });

  it('AC-8: undefined ordinals ⇒ argv byte-identical to the pre-49 output', () => {
    const prev = process.env.X265_POOLS;
    process.env.X265_POOLS = '0';
    __forTests_resetX265PoolsCache();
    try {
      for (const encoder of ['libx265', 'nvenc', 'qsv', 'vaapi'] as const) {
        for (const crop of [undefined, '1920:800:0:140']) {
          const baseline = buildArgs({ ...base, encoder, crop });
          const withEmpty = buildArgs({
            ...base,
            encoder,
            crop,
            attachedPicVideoOrdinals: [],
            encodedVideoOrdinals: [],
          });
          expect(withEmpty).toEqual(baseline);
          expect(baseline.some((t) => t.startsWith('-c:v:'))).toBe(false);
          expect(baseline.some((t) => t.startsWith('-filter:v:'))).toBe(false);
        }
      }
    } finally {
      if (prev === undefined) delete process.env.X265_POOLS;
      else process.env.X265_POOLS = prev;
      __forTests_resetX265PoolsCache();
    }
  });

  it('AC-10: emits exactly ONE attached_pic_streams_copied warn with ordinals', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
    try {
      buildArgs({
        ...base,
        encoder: 'libx265',
        jobId: 4711,
        attachedPicVideoOrdinals: [1, 2],
        encodedVideoOrdinals: [0],
      });
      const calls = warnSpy.mock.calls.filter(
        (c) => (c[0] as { action?: string }).action === 'attached_pic_streams_copied',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toMatchObject({
        action: 'attached_pic_streams_copied',
        jobId: 4711,
        copiedCount: 2,
        videoOrdinals: [1, 2],
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  // 49-01 APPLY-time finding (NOT in the plan): `-tag:v hvc1` is a THIRD global
  // video specifier alongside `-c:v` and `-vf`. On mp4 output it lands on the
  // copied mjpeg cover and the muxer refuses the header outright:
  //   [mp4 @ …] Tag hvc1 incompatible with output codec id '7' (mp4v)
  // Without this narrowing, AC-5's "gilt für beide Container gleichermaßen"
  // clause is false — mkv would be fixed and mp4 would still die.
  it('AC-5 (mp4): -tag:v is narrowed to the encoded ordinals, never left bare', () => {
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      outputContainer: 'mp4',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });
    expect(args).not.toContain('-tag:v');
    expect(args).toContain('-tag:v:0');
    expect(args[args.indexOf('-tag:v:0') + 1]).toBe('hvc1');
    // faststart is a true format flag and stays untouched
    expect(args).toContain('-movflags');
  });

  it('AC-8 (mp4): without cover ordinals the bare -tag:v survives unchanged', () => {
    const args = buildArgs({ ...base, encoder: 'libx265', outputContainer: 'mp4' });
    expect(args).toContain('-tag:v');
    expect(args[args.indexOf('-tag:v') + 1]).toBe('hvc1');
    expect(args.some((t) => t.startsWith('-tag:v:'))).toBe(false);
  });

  it('AC-10: emits NO warn when the source carries no cover (no noise)', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
    try {
      buildArgs({ ...base, encoder: 'libx265', jobId: 4711 });
      const calls = warnSpy.mock.calls.filter(
        (c) => (c[0] as { action?: string }).action === 'attached_pic_streams_copied',
      );
      expect(calls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-02: deterministic closed keyframes. Two INDEPENDENT levers —
//   ENCODE_KEYFRAME_INTERVAL_SEC  → the `-force_key_frames` interval (default 5)
//   ENCODE_CLOSED_GOP_DISABLED    → the per-encoder IDR pin (default ON)
//
// NOTE: the file-wide beforeEach pins BOTH levers OFF so every pre-49-02
// byte-identical assertion above keeps its v2.45.0 snapshot. Every test in THIS
// block therefore sets the env it needs explicitly and resets the memo.
// ─────────────────────────────────────────────────────────────────────────────
describe('49-02 forced keyframes + closed GOP', () => {
  const base = { input: '/i', output: '/o', crf: 24, preset: 'slow' } as const;
  const EXPR5 = 'expr:gte(t,n_forced*5)';

  /** Put the levers in the requested state and drop the memo. */
  function withLevers(intervalSec: string | null, closedGopDisabled: boolean): void {
    if (intervalSec === null) delete process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
    else process.env.ENCODE_KEYFRAME_INTERVAL_SEC = intervalSec;
    if (closedGopDisabled) process.env.ENCODE_CLOSED_GOP_DISABLED = '1';
    else delete process.env.ENCODE_CLOSED_GOP_DISABLED;
    __forTests_resetKeyframeCache();
  }

  // AC-1 — the default interval lands as a TIME expression, and no frame-based
  // GOP arg is emitted (so no fps probe is ever needed).
  it.each(['libx265', 'nvenc', 'qsv', 'vaapi'] as const)(
    'AC-1: %s default ⇒ exactly one -force_key_frames pair with expr:gte(t,n_forced*5), no -g',
    (encoder) => {
      withLevers(null, false);
      const args = buildArgs({ ...base, encoder });
      const pairs = args.filter((t) => t === '-force_key_frames');
      expect(pairs).toHaveLength(1);
      expect(args[args.indexOf('-force_key_frames') + 1]).toBe(EXPR5);
      expect(args).not.toContain('-g');
      expect(args.some((t) => t.startsWith('-force_key_frames:v:'))).toBe(false);
    },
  );

  it('AC-1: the expression is time-based verbatim — the interval is interpolated', () => {
    withLevers('2', false);
    const args = buildArgs({ ...base, encoder: 'libx265' });
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe('expr:gte(t,n_forced*2)');
  });

  // AC-3 — 0 is the explicit off state: no token at all, in either form.
  it.each(['libx265', 'nvenc', 'qsv', 'vaapi'] as const)(
    'AC-3: %s with ENCODE_KEYFRAME_INTERVAL_SEC=0 ⇒ NO -force_key_frames token',
    (encoder) => {
      withLevers('0', false);
      const args = buildArgs({ ...base, encoder });
      expect(args.some((t) => t.startsWith('-force_key_frames'))).toBe(false);
    },
  );

  it('AC-3: an INVALID interval falls back to the 5 s default, it does not disable', () => {
    withLevers('abc', false);
    const args = buildArgs({ ...base, encoder: 'libx265' });
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe(EXPR5);
  });

  // AC-4 — the 49-01 class rule: narrowed to the ENCODED ordinals when a cover
  // is present. (M5a measured that the bare form is a silent no-op on a copied
  // stream, so this is class consistency, NOT a bug fix — see forceKeyFrameArgs.)
  it('AC-4: one cover ⇒ -force_key_frames:v:0 and NEVER the bare token', () => {
    withLevers(null, false);
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });
    expect(args).not.toContain('-force_key_frames');
    expect(args).toContain('-force_key_frames:v:0');
    expect(args[args.indexOf('-force_key_frames:v:0') + 1]).toBe(EXPR5);
  });

  it('AC-4: two encoded video streams + a cover ⇒ one pair per ordinal, identical expr', () => {
    withLevers(null, false);
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      attachedPicVideoOrdinals: [2],
      encodedVideoOrdinals: [0, 1],
    });
    expect(args).not.toContain('-force_key_frames');
    expect(args[args.indexOf('-force_key_frames:v:0') + 1]).toBe(EXPR5);
    expect(args[args.indexOf('-force_key_frames:v:1') + 1]).toBe(EXPR5);
  });

  it('AC-4: cover at ordinal 0, real video at ordinal 1 ⇒ :v:1 only', () => {
    withLevers(null, false);
    const args = buildArgs({
      ...base,
      encoder: 'vaapi',
      attachedPicVideoOrdinals: [0],
      encodedVideoOrdinals: [1],
    });
    expect(args).toContain('-force_key_frames:v:1');
    expect(args).not.toContain('-force_key_frames:v:0');
    expect(args).not.toContain('-force_key_frames');
  });

  it('AC-4: interval=0 + cover ordinals ⇒ still NO token in either form', () => {
    withLevers('0', false);
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });
    expect(args.some((t) => t.startsWith('-force_key_frames'))).toBe(false);
  });

  // The IDR pin, per encoder, through the full buildArgs path.
  it('default ⇒ libx265 carries open-gop=0 in its single -x265-params token', () => {
    withLevers(null, false);
    const args = buildArgs({ ...base, encoder: 'libx265' });
    expect(args.filter((t) => t === '-x265-params')).toHaveLength(1);
    expect(args[args.indexOf('-x265-params') + 1]).toBe('open-gop=0');
  });

  it('default ⇒ qsv carries -forced_idr 1 and nvenc carries -forced-idr 1', () => {
    withLevers(null, false);
    const qsv = buildArgs({ ...base, encoder: 'qsv' });
    expect(qsv[qsv.indexOf('-forced_idr') + 1]).toBe('1');
    const nvenc = buildArgs({ ...base, encoder: 'nvenc' });
    expect(nvenc[nvenc.indexOf('-forced-idr') + 1]).toBe('1');
  });

  it('default ⇒ vaapi carries the interval but NO IDR token (by design)', () => {
    withLevers(null, false);
    const args = buildArgs({ ...base, encoder: 'vaapi' });
    expect(args).toContain('-force_key_frames');
    expect(args).not.toContain('-forced_idr');
    expect(args).not.toContain('-forced-idr');
    expect(args).not.toContain('-idr_interval');
  });

  // AC-7 — the levers are INDEPENDENT: killing the IDR pin must leave the
  // interval untouched (D-C: two knobs, two switches).
  it.each(['libx265', 'nvenc', 'qsv', 'vaapi'] as const)(
    'AC-7: %s with ENCODE_CLOSED_GOP_DISABLED=1 ⇒ no IDR token, interval UNCHANGED',
    (encoder) => {
      withLevers(null, true);
      const args = buildArgs({ ...base, encoder });
      const joined = args.join(' ');
      expect(joined).not.toContain('open-gop=0');
      expect(args).not.toContain('-forced_idr');
      expect(args).not.toContain('-forced-idr');
      // the OTHER lever is untouched
      expect(args).toContain('-force_key_frames');
      expect(args[args.indexOf('-force_key_frames') + 1]).toBe(EXPR5);
    },
  );

  it('AC-7: killing the IDR pin drops -x265-params entirely when nothing else feeds it', () => {
    withLevers(null, true);
    const args = buildArgs({ ...base, encoder: 'libx265' });
    // X265_POOLS=0 (suite beforeEach) → pools=null, no hdr10 → no segments left
    expect(args).not.toContain('-x265-params');
  });

  // AC-8 — both levers off ⇒ token-for-token identical to the v2.45.0 argv.
  it.each(['libx265', 'nvenc', 'qsv', 'vaapi'] as const)(
    'AC-8: %s with BOTH levers off ⇒ argv token-identical to the pre-49-02 snapshot',
    (encoder) => {
      withLevers(null, false);
      const withFeature = buildArgs({ ...base, encoder });
      withLevers('0', true);
      const reverted = buildArgs({ ...base, encoder });

      expect(reverted.some((t) => t.startsWith('-force_key_frames'))).toBe(false);
      expect(reverted).not.toContain('-forced_idr');
      expect(reverted).not.toContain('-forced-idr');
      expect(reverted.join(' ')).not.toContain('open-gop=0');
      // the reverted argv is a strict token subset — the ONLY delta is 49-02's
      expect(withFeature.length).toBeGreaterThan(reverted.length);
    },
  );

  it('AC-8: the combined revert holds with cover ordinals, crop, 10-bit and mp4 too', () => {
    const opts = {
      ...base,
      encoder: 'qsv' as const,
      outputContainer: 'mp4' as const,
      crop: '1920:800:0:140',
      force10bit: true,
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    };
    withLevers('0', true);
    const reverted = buildArgs(opts);
    expect(reverted.some((t) => t.startsWith('-force_key_frames'))).toBe(false);
    expect(reverted).not.toContain('-forced_idr');
    // and the 49-01 narrowing still works — 49-02 did not disturb it
    expect(reverted).toContain('-filter:v:0');
    expect(reverted).toContain('-tag:v:0');
    expect(reverted).toContain('-c:v:1');
  });

  // AC-9 — the new DEFAULT form is frozen too, not just the reverted one. This
  // is the "additional test" the AC demands next to the repinned legacy gate.
  it('AC-9: the DEFAULT libx265 argv is frozen token-for-token (both levers at factory)', () => {
    withLevers(null, false);
    const args = buildArgs({ input: '/in.mp4', output: '/out.x265.mkv', crf: 23 });
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
      '-x265-params',
      'open-gop=0',
      '-force_key_frames',
      EXPR5,
      '-c:a',
      'copy',
      '-c:s',
      'copy',
      '-map',
      '0:v',
      '-map',
      '0:a?',
      '-map',
      '0:s?',
      '-map',
      '0:t?',
      '-map_metadata',
      '0',
      '-progress',
      'pipe:1',
      '-stats_period',
      '30',
      '/out.x265.mkv',
    ]);
  });

  it('the keyframe pair sits AFTER the cover-copy block and BEFORE the colour tail', () => {
    withLevers(null, false);
    const args = buildArgs({
      ...base,
      encoder: 'libx265',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
      color: { space: 'bt709', primaries: null, transfer: null, range: null },
    });
    const coverIdx = args.indexOf('-c:v:1');
    const kfIdx = args.indexOf('-force_key_frames:v:0');
    const colorIdx = args.indexOf('-colorspace');
    expect(coverIdx).toBeGreaterThanOrEqual(0);
    expect(kfIdx).toBeGreaterThan(coverIdx);
    expect(colorIdx).toBeGreaterThan(kfIdx);
  });

  // AC-19 — bench Pass-2 goes through runEncode → buildArgs, so it DOES carry
  // both tokens. That is deliberate (11-03 SR3: Pass-2 IS the production path),
  // and it is asserted POSITIVELY here so the change can never be mistaken for an
  // unnoticed side effect. Its counterpart — bench Pass-1 / the CRF probe sweep
  // call buildCodecBlock DIRECTLY and never set forceIdr — is the vmaf.ts
  // isolation gate in the plan's verification block (AC-10).
  it('AC-19: bench Pass-2 (runEncode → buildArgs) carries BOTH tokens — intentional', async () => {
    withLevers(null, false);
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    // exactly the shape bench/orchestrator.ts:200 dispatches
    const p = runEncode({
      input: '/sample.mkv',
      output: '/pass2.mkv',
      encoder: 'qsv',
      preset: 'slow',
      crf: 24,
    });
    child.emit('close', 0);
    await p;
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-force_key_frames');
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe(EXPR5);
    expect(args[args.indexOf('-forced_idr') + 1]).toBe('1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-03 AC-12: buildArgs reads the forced-IDR verdict — and changes nothing else.
//
// 49-02 shipped `-forced_idr` / `-forced-idr` UNPROBED: on a runtime that rejects
// the option, /diagnostics stayed green while 100 % of real jobs died. A host
// whose confirm spawn PROVED the rejection now degrades itself to open GOPs.
// The degrade must cost EXACTLY the IDR tokens and not one token more.
//
// NOTE: the file-wide beforeEach pins ENCODE_CLOSED_GOP_DISABLED=1 so the legacy
// v2.45.0 snapshots hold. Every test here re-enables the lever explicitly.
// ─────────────────────────────────────────────────────────────────────────────
describe('49-03 AC-12: the production argv honours the forced-IDR verdict', () => {
  const base = { input: '/i', output: '/o', crf: 22 };

  function seedVerdict(forcedIdrSupported: Partial<Record<EncoderId, boolean>> | undefined): void {
    globalThis.__x265butler_encoder_cache = forcedIdrSupported
      ? ({ forcedIdrSupported, qsvRateControl: 'icq-full' } as unknown as DetectionResult)
      : undefined;
  }

  beforeEach(() => {
    // BOTH levers back at the factory default for this block — the file-wide
    // beforeEach pins them off, and this block is about the PRODUCTION shape.
    delete process.env.ENCODE_CLOSED_GOP_DISABLED;
    delete process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
    __forTests_resetKeyframeCache();
    seedVerdict(undefined);
  });

  afterEach(() => {
    globalThis.__x265butler_encoder_cache = undefined;
    // hand the file-wide afterEach the state it expects
    process.env.ENCODE_CLOSED_GOP_DISABLED = '1';
    process.env.ENCODE_KEYFRAME_INTERVAL_SEC = '0';
    __forTests_resetKeyframeCache();
  });

  it('cold cache ⇒ fail OPEN ⇒ argv byte-identical to v2.46.0 (the pin is emitted)', () => {
    expect(buildArgs({ ...base, encoder: 'qsv' })).toContain('-forced_idr');
    expect(buildArgs({ ...base, encoder: 'nvenc' })).toContain('-forced-idr');
    expect(buildArgs({ ...base, encoder: 'libx265' }).join(' ')).toContain('open-gop=0');
  });

  it('a POSITIVE verdict is byte-identical to a cold cache', () => {
    const cold = buildArgs({ ...base, encoder: 'qsv' });
    seedVerdict({ qsv: true });
    expect(buildArgs({ ...base, encoder: 'qsv' })).toEqual(cold);
  });

  it.each([
    ['qsv', '-forced_idr'],
    ['nvenc', '-forced-idr'],
  ] as const)(
    '%s degraded ⇒ the argv loses EXACTLY the IDR pair and nothing else',
    (encoder, token) => {
      const healthy = buildArgs({ ...base, encoder });
      seedVerdict({ [encoder]: false } as Partial<Record<EncoderId, boolean>>);
      const degraded = buildArgs({ ...base, encoder });

      expect(degraded).not.toContain(token);
      // the delta is the two-token pair, and the remaining tokens are IDENTICAL
      // in value AND order (the `-force_key_frames` interval is untouched).
      expect(degraded).toEqual(
        healthy.filter((_, i) => {
          const idx = healthy.indexOf(token);
          return i !== idx && i !== idx + 1;
        }),
      );
      expect(degraded.some((t) => t.startsWith('-force_key_frames'))).toBe(true);
    },
  );

  it('libx265 degraded ⇒ open-gop=0 leaves the -x265-params token, nothing else moves', () => {
    // (libx265 is never confirm-probed, so a false verdict cannot arise in the
    // field — but the read must still be encoder-scoped and total.)
    const healthy = buildArgs({ ...base, encoder: 'libx265' });
    seedVerdict({ libx265: false });
    const degraded = buildArgs({ ...base, encoder: 'libx265' });
    expect(degraded.join(' ')).not.toContain('open-gop=0');
    expect(degraded.some((t) => t.startsWith('-force_key_frames'))).toBe(true);
    expect(healthy.length).toBeGreaterThanOrEqual(degraded.length);
  });

  it('a qsv rejection does NOT strip nvenc (per-encoder, not global)', () => {
    seedVerdict({ qsv: false });
    expect(buildArgs({ ...base, encoder: 'qsv' })).not.toContain('-forced_idr');
    expect(buildArgs({ ...base, encoder: 'nvenc' })).toContain('-forced-idr');
  });

  it('the env kill-switch still wins on its own — a POSITIVE verdict cannot re-enable it', () => {
    process.env.ENCODE_CLOSED_GOP_DISABLED = '1';
    __forTests_resetKeyframeCache();
    seedVerdict({ qsv: true, nvenc: true });
    expect(buildArgs({ ...base, encoder: 'qsv' })).not.toContain('-forced_idr');
    expect(buildArgs({ ...base, encoder: 'nvenc' })).not.toContain('-forced-idr');
  });
});
