// @vitest-environment node
//
// 23-04: runtime probe-encode gate. detection.ts is server-only (audit S8
// typeof-window guard) → node env so the guard does not fire.
//
// Spawn order inside runDetection:
//   1. nvidia-smi -L          (probeNvenc, captures STDOUT)
//   2. [readdir /dev/dri]     (findRenderDDevice — not a spawn)
//   3. vainfo --display drm   (probeVaInfo, captures STDOUT)   [only if /dev/dri]
//   4. ffmpeg <probe args>    (probeEncodeFunctional, captures STDERR) per HW candidate

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock, readdirMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  readdirMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}));

vi.mock('node:fs', () => ({
  promises: { readdir: readdirMock },
  default: { promises: { readdir: readdirMock } },
}));

import { detectEncoders, __forTests_resetEncoderCache } from '@/src/lib/encode/detection';
import { notificationsFromDetection } from '@/src/lib/notifications/from-detection';
import { logger } from '@/src/lib/logger';

class FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding?: (enc: string) => void };
  stderr: EventEmitter & { setEncoding?: (enc: string) => void };
  kill = vi.fn();

  constructor() {
    super();
    const mk = (): EventEmitter & { setEncoding?: (enc: string) => void } => {
      const e = new EventEmitter() as EventEmitter & { setEncoding?: (enc: string) => void };
      e.setEncoding = vi.fn();
      return e;
    };
    this.stdout = mk();
    this.stderr = mk();
  }
}

// Feature-parse probe (nvidia-smi / vainfo) — emits STDOUT then close(code).
function queueParse(stdout = '', code = 0): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child);
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', stdout);
    child.emit('close', code);
  });
  return child;
}

// Probe-encode (ffmpeg) success — close(0), no stderr.
function queueEncodeOk(): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child);
  setImmediate(() => child.emit('close', 0));
  return child;
}

// Probe-encode failure — emit STDERR then close(non-zero).
function queueEncodeFail(stderr: string): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child);
  setImmediate(() => {
    child.stderr.emit('data', stderr);
    child.emit('close', 1);
  });
  return child;
}

// Probe-encode spawn ENOENT (binary missing) — 'error' event.
function queueEncodeENOENT(): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child);
  setImmediate(() => {
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
  });
  return child;
}

function allSpawnArgs(): string[][] {
  return spawnMock.mock.calls.map((c) => (c[1] as string[]) ?? []);
}

function ffmpegSpawnCount(): number {
  // ffmpeg probe args always carry '-f','lavfi' + '-frames:v'; feature-parse
  // probes (nvidia-smi/vainfo) never do.
  return allSpawnArgs().filter((a) => a.includes('lavfi')).length;
}

beforeEach(() => {
  spawnMock.mockReset();
  readdirMock.mockReset();
  __forTests_resetEncoderCache();
  delete process.env.X265_PROBE_ENCODE_DISABLED;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.X265_PROBE_ENCODE_DISABLED;
});

describe('23-04 probe-encode gate — AC-1 functional encoder stays detected', () => {
  it('test_probe_when_nvenc_exits_0_then_detected_and_outcome_functional', async () => {
    queueParse('GPU 0: NVIDIA GeForce RTX 3060\n'); // nvidia-smi → nvenc candidate
    readdirMock.mockResolvedValueOnce([]); // no /dev/dri → no vainfo
    queueEncodeOk(); // ffmpeg nvenc probe exit 0

    const r = await detectEncoders();

    expect(r.detected).toContain('nvenc');
    expect(r.outcome.nvenc).toBe('functional');
    expect(r.warnings.map((w) => w.code)).not.toContain('encoder_runtime_broken');
    // probe uses the REAL codec block — hevc_nvenc, with -i before the codec block
    const ff = allSpawnArgs().find((a) => a.includes('lavfi'))!;
    expect(ff).toContain('hevc_nvenc');
    expect(ff.indexOf('-i')).toBeLessThan(ff.indexOf('-c:v'));
  });
});

describe('23-04 probe-encode gate — AC-2 compiled-in-but-broken is gated out', () => {
  it('test_probe_when_qsv_exits_nonzero_then_gated_out_with_warning_and_excerpt', async () => {
    queueParse('', 1); // nvidia-smi exit 1 (no GPU)
    readdirMock.mockResolvedValueOnce(['renderD128']); // /dev/dri
    queueParse('vainfo: iHD driver\n'); // vainfo → qsv candidate
    queueEncodeFail('libva info: ...\nError creating a MFX session: -9\n'); // qsv probe fails

    const r = await detectEncoders();

    expect(r.detected).not.toContain('qsv');
    expect(r.detected).toEqual(['libx265']);
    expect(r.outcome.qsv).toBe('compiled-in-broken');
    const w = r.warnings.find((x) => x.code === 'encoder_runtime_broken');
    expect(w).toBeDefined();
    expect(w?.severity).toBe('warn');
    expect(w?.detail).toContain('qsv');
    expect(w?.detail).toContain('MFX session: -9');
    expect(r.brokenExcerpts.qsv).toBeDefined();
    expect(r.brokenExcerpts.qsv!.length).toBeLessThanOrEqual(240);
  });
});

describe('25-02 AC-4 — probe argv inherits the libvpl-compat fix via shared buildCodecBlock', () => {
  it('test_probe_when_qsv_candidate_then_ffmpeg_argv_carries_NO_lookahead_family', async () => {
    queueParse('', 1); // nvidia-smi exit 1 (no GPU)
    readdirMock.mockResolvedValueOnce(['renderD128']); // /dev/dri
    queueParse('vainfo: iHD driver\n'); // vainfo → qsv candidate
    queueEncodeOk(); // qsv probe exit 0

    await detectEncoders();

    // The qsv probe reuses the production codec block — proves the 25-02 fix
    // repairs the boot-probe gate, not just production encode.
    const ff = allSpawnArgs().find((a) => a.includes('lavfi') && a.includes('hevc_qsv'))!;
    expect(ff).toBeDefined();
    expect(ff).toContain('hevc_qsv');
    expect(ff).toContain('-global_quality');
    expect(ff).not.toContain('-look_ahead');
    expect(ff).not.toContain('-look_ahead_depth');
  });
});

describe('23-04 probe-encode gate — AC-3 inconclusive fails OPEN', () => {
  it('test_probe_when_ENOENT_then_stays_detected_outcome_probe_inconclusive_no_broken_warning', async () => {
    queueParse('GPU 0: NVIDIA\n'); // nvenc candidate
    readdirMock.mockResolvedValueOnce([]);
    queueEncodeENOENT(); // ffmpeg missing

    const r = await detectEncoders();

    expect(r.detected).toContain('nvenc'); // fail-open: trust feature-parse
    expect(r.outcome.nvenc).toBe('probe-inconclusive');
    expect(r.warnings.map((w) => w.code)).not.toContain('encoder_runtime_broken');
  });

  it('test_probe_when_timeout_then_SIGKILL_and_fails_open_inconclusive', async () => {
    queueParse('GPU 0: NVIDIA\n'); // nvenc candidate
    readdirMock.mockResolvedValueOnce([]);
    const hung = new FakeChild();
    spawnMock.mockReturnValueOnce(hung); // ffmpeg probe: never closes

    vi.useFakeTimers();
    const p = detectEncoders();
    await vi.advanceTimersByTimeAsync(5001); // past PROBE_TIMEOUT_MS
    vi.useRealTimers();
    const r = await p;

    expect(hung.kill).toHaveBeenCalledWith('SIGKILL');
    expect(r.detected).toContain('nvenc');
    expect(r.outcome.nvenc).toBe('probe-inconclusive');
  });
});

describe('23-04 probe-encode gate — AC-4 libx265 never probed', () => {
  it('test_probe_when_no_hw_then_libx265_functional_and_no_ffmpeg_probe', async () => {
    queueParse('', 1); // nvidia-smi exit 1
    readdirMock.mockResolvedValueOnce([]); // no /dev/dri

    const r = await detectEncoders();

    expect(r.detected).toEqual(['libx265']);
    expect(r.outcome.libx265).toBe('functional');
    expect(ffmpegSpawnCount()).toBe(0);
    // No spawn argv ever references the libx265 codec.
    expect(allSpawnArgs().some((a) => a.includes('libx265'))).toBe(false);
  });
});

describe('23-04 probe-encode gate — AC-5 kill-switch restores pre-23-04 behaviour', () => {
  it('test_killswitch_when_set_then_zero_ffmpeg_probes_and_feature_parse_detected', async () => {
    process.env.X265_PROBE_ENCODE_DISABLED = '1';
    queueParse('GPU 0: NVIDIA\n'); // nvenc candidate
    readdirMock.mockResolvedValueOnce(['renderD128']);
    queueParse('vainfo: iHD driver\n'); // qsv candidate

    const r = await detectEncoders();

    expect(r.detected).toEqual(['nvenc', 'qsv', 'libx265']);
    expect(ffmpegSpawnCount()).toBe(0);
    expect(r.probeEncodeDisabled).toBe(true);
    // Nothing was probed → 'probe-inconclusive', NOT 'functional' (audit SR1/SR2).
    expect(r.outcome.nvenc).toBe('probe-inconclusive');
    expect(r.outcome.qsv).toBe('probe-inconclusive');
    expect(r.outcome.libx265).toBe('functional');
  });
});

describe('23-04 probe-encode gate — AC-6 outcome is stable-shape', () => {
  it('test_outcome_when_any_result_then_all_four_keys_in_4state_union', async () => {
    queueParse('', 1);
    readdirMock.mockResolvedValueOnce([]);
    const r = await detectEncoders();
    expect(Object.keys(r.outcome).sort()).toEqual(['libx265', 'nvenc', 'qsv', 'vaapi']);
    const allowed = ['functional', 'compiled-in-broken', 'probe-inconclusive', 'missing'];
    for (const v of Object.values(r.outcome)) {
      expect(allowed).toContain(v);
    }
  });
});

describe('23-04 probe-encode gate — audit M1 stderr TAIL truncation', () => {
  it('test_excerpt_when_long_stderr_then_contains_trailing_fatal_line_not_banner', async () => {
    const banner = Array.from({ length: 400 }, (_, i) => `  configuration: --flag-${i}`).join('\n');
    const stderr = `ffmpeg version n7.1\n${banner}\nError creating a MFX session: -9\n`;
    queueParse('', 1); // no nvenc
    readdirMock.mockResolvedValueOnce(['renderD128']);
    queueParse('vainfo: iHD driver\n'); // qsv candidate
    queueEncodeFail(stderr);

    const r = await detectEncoders();

    const excerpt = r.brokenExcerpts.qsv!;
    expect(excerpt.length).toBeLessThanOrEqual(240);
    expect(excerpt).toContain('MFX session: -9'); // TAIL preserved
    expect(excerpt).not.toContain('ffmpeg version n7.1'); // head dropped
  });
});

describe('23-04 probe-encode gate — audit M2 multi-broken keyed by encoder', () => {
  it('test_excerpts_when_two_broken_then_no_cross_contamination', async () => {
    queueParse('GPU 0: NVIDIA\n'); // nvenc candidate
    readdirMock.mockResolvedValueOnce(['renderD128']);
    queueParse('vainfo: iHD driver\n'); // qsv candidate
    // probe order = candidates order = [nvenc, qsv]
    queueEncodeFail('NVENC OpenEncodeSessionEx failed: out of memory\n');
    queueEncodeFail('Error creating a MFX session: -9\n');

    const r = await detectEncoders();

    expect(r.detected).toEqual(['libx265']);
    expect(r.outcome.nvenc).toBe('compiled-in-broken');
    expect(r.outcome.qsv).toBe('compiled-in-broken');
    expect(r.brokenExcerpts.nvenc).toContain('OpenEncodeSessionEx');
    expect(r.brokenExcerpts.nvenc).not.toContain('MFX session');
    expect(r.brokenExcerpts.qsv).toContain('MFX session: -9');
    expect(r.brokenExcerpts.qsv).not.toContain('OpenEncodeSessionEx');
  });
});

describe('23-04 probe-encode gate — audit SR4/AC-13 stderr excerpt is ICU-safe', () => {
  it('test_brace_containing_excerpt_renders_through_notifications_without_throw', async () => {
    queueParse('', 1); // no nvenc
    readdirMock.mockResolvedValueOnce(['renderD128']);
    queueParse('vainfo: iHD driver\n'); // qsv candidate
    queueEncodeFail('MFX init failed { context: {code: -9} } at frame {0}\n');

    const r = await detectEncoders();

    expect(r.brokenExcerpts.qsv).toContain('{');
    // notificationsFromDetection maps the warning → notification; the brace-laden
    // detail must travel as opaque text, never through ICU formatting.
    let notifs: ReturnType<typeof notificationsFromDetection> = [];
    expect(() => {
      notifs = notificationsFromDetection(r);
    }).not.toThrow();
    const n = notifs.find((x) => x.code === 'encoder_runtime_broken');
    expect(n).toBeDefined();
    expect(n!.detail).toContain('{');
  });
});

// ── 25-01: boilerplate-trailing excerpt — codec error survives ──────────────
// 2026-05-31 3rd-party report: a broken-qsv probe excerpt surfaced only the
// generic ffmpeg muxer epilogue ("Nothing was written … Conversion failed!"),
// front-truncating the real MFX/param codec-init error to the useless 11-char
// tail "d argument)". tailExcerpt must strip the generic epilogue lines BEFORE
// the 240-char tail-slice so the codec-error line carries the budget.
describe('25-01 boilerplate-trailing excerpt — codec error survives', () => {
  // Faithful real-world qsv stderr: codec error FIRST, generic muxer epilogue
  // AFTER (mirrors the 2026-05-31 report). Padded so 'MFX session' sits well
  // beyond the 240-char tail boundary (RED-integrity, audit F5).
  const codecLine =
    '[hevc_qsv @ 0x55e289783a40] Error initializing an internal MFX session: unsupported (-3) — invalid pixel format or unsupported d argument)';
  const stderr = [
    'libva info: VA-API version 1.22.0',
    codecLine,
    '[out#0/null @ 0x55e289783a40] Nothing was written into output file, because at least one of its streams received no packets.',
    'frame=    0 fps=0.0 q=0.0 size=       0KiB time=N/A bitrate=N/A speed=N/A',
    'frame=    0 fps=0.0 q=0.0 Lsize=       0KiB time=N/A bitrate=N/A speed=N/A elapsed=0:00:00.04',
    'video:0kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: unknown',
    'Conversion failed!',
    '',
  ].join('\n');

  // RED-INTEGRITY (audit F5): the codec line MUST land comfortably (>280 chars)
  // outside the last-240 window of the collapsed string, else a blind tail-slice
  // could accidentally include it and the RED would pass for the wrong reason.
  it('25-01 fixture keeps the codec line >280 chars past the 240 tail boundary', () => {
    const collapsed = stderr.replace(/\s+/g, ' ').trim();
    expect(collapsed.length - collapsed.indexOf('MFX session')).toBeGreaterThan(280);
  });

  it('test_excerpt_when_trailing_boilerplate_then_codec_error_survives_AC1', async () => {
    queueParse('', 1); // no nvenc
    readdirMock.mockResolvedValueOnce(['renderD128']);
    queueParse('vainfo: iHD driver\n'); // qsv candidate
    queueEncodeFail(stderr);

    const r = await detectEncoders();

    const excerpt = r.brokenExcerpts.qsv!;
    expect(excerpt).toContain('MFX session'); // the codec-error signal survives
    // NOT reduced to only "Nothing was written … Conversion failed!" boilerplate.
    expect(excerpt).not.toMatch(/^.*Nothing was written.*Conversion failed!?$/);
    expect(excerpt.length).toBeLessThanOrEqual(240);
  });

  // AC-6 (audit F2): ffmpeg overwrites the progress line with CARRIAGE RETURN
  // (\r), not \n — a "frame= …\r<codec error>" run is one physical line under a
  // \n-only split and the denylist mis-classifies it (drop signal OR leak noise).
  it('test_excerpt_when_CR_glued_progress_then_codec_survives_no_frame_leak_AC6', async () => {
    const crStderr =
      'libva info: VA-API version 1.22.0\n' +
      '[hevc_qsv @ 0x55e289783a40] Error initializing an internal MFX session: unsupported (-3) invalid pixel format or unsupported d argument)' +
      '\rframe=    0 fps=0.0 q=0.0 size=       0KiB time=N/A bitrate=N/A speed=N/A' +
      '\rframe=    1 fps=0.0 q=0.0 Lsize=       0KiB time=N/A bitrate=N/A speed=N/A elapsed=0:00:00.04\n' +
      '[out#0/null @ 0x55e289783a40] Nothing was written into output file, because at least one of its streams received no packets.\n' +
      'Conversion failed!\n';
    queueParse('', 1); // no nvenc
    readdirMock.mockResolvedValueOnce(['renderD128']);
    queueParse('vainfo: iHD driver\n'); // qsv candidate
    queueEncodeFail(crStderr);

    const r = await detectEncoders();

    const excerpt = r.brokenExcerpts.qsv!;
    expect(excerpt).toContain('MFX session'); // codec line isolated + survives
    expect(excerpt).not.toContain('frame='); // no \r-glued progress fragment leaks
    expect(excerpt.length).toBeLessThanOrEqual(240);
  });

  // AC-3: ENTIRELY boilerplate stderr → fail-soft to the raw tail (never empty).
  it('test_excerpt_when_all_boilerplate_then_non_empty_fallback_AC3', async () => {
    const allNoise = [
      'frame=    0 fps=0.0 q=0.0 Lsize=       0KiB time=N/A bitrate=N/A speed=N/A',
      '[out#0/null @ 0x0] Nothing was written into output file, because at least one of its streams received no packets.',
      'Conversion failed!',
      '',
    ].join('\n');
    queueParse('', 1);
    readdirMock.mockResolvedValueOnce(['renderD128']);
    queueParse('vainfo: iHD driver\n');
    queueEncodeFail(allNoise);

    const r = await detectEncoders();

    const excerpt = r.brokenExcerpts.qsv!;
    expect(excerpt.length).toBeGreaterThan(0); // fail-soft: generic msg beats empty
    expect(excerpt.length).toBeLessThanOrEqual(240);
  });

  // AC-5 (audit F1): tailExcerpt is now a LOSSY transform. The raw (pre-strip)
  // capped stderr must persist to a structured log so the source-of-truth
  // evidence survives even if the denylist mis-fires on a future ffmpeg wording.
  it('test_broken_probe_emits_encoder_probe_broken_log_with_raw_stderr_AC5', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      queueParse('', 1);
      readdirMock.mockResolvedValueOnce(['renderD128']);
      queueParse('vainfo: iHD driver\n'); // qsv candidate
      queueEncodeFail(stderr);

      await detectEncoders();

      const brokenLog = warnSpy.mock.calls.find(
        (c) => (c[0] as { action?: string })?.action === 'encoder_probe_broken',
      );
      expect(brokenLog).toBeDefined();
      const ctx = brokenLog![0] as { encoder?: string; rawStderr?: string; excerpt?: string };
      expect(ctx.encoder).toBe('qsv');
      // raw pre-strip stderr carries the FULL evidence incl. the dropped boilerplate
      expect(ctx.rawStderr).toContain('MFX session');
      expect(ctx.rawStderr).toContain('Nothing was written into output file');
      // operator-facing excerpt is the stripped form (boilerplate removed)
      expect(ctx.excerpt).toContain('MFX session');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// Per-NOISE-class strip coverage (audit F4): one case per FFMPEG_EPILOGUE_NOISE
// entry. A future ffmpeg wording drift that breaks one denylist pattern fails
// THAT case loudly instead of silently re-introducing front-truncation.
describe('25-01 per-noise-class denylist strip', () => {
  const SENTINEL = 'Error creating a MFX session: -9';
  const cases: ReadonlyArray<{ klass: string; noise: string; absent: string }> = [
    { klass: 'frame=', noise: 'frame=    0 fps=0.0 q=0.0 time=N/A', absent: 'frame=' },
    { klass: 'size=', noise: 'size=       0KiB time=N/A bitrate=N/A', absent: 'size=' },
    {
      klass: '[out#',
      noise:
        '[out#0/null @ 0x0] Nothing was written into output file, because at least one of its streams received no packets.',
      absent: 'Nothing was written',
    },
    {
      klass: 'Nothing was written (no [out#] prefix)',
      noise:
        'Nothing was written into output file, because at least one of its streams received no packets.',
      absent: 'Nothing was written',
    },
    {
      klass: 'video:',
      noise: 'video:0kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB',
      absent: 'video:0kB',
    },
    { klass: 'muxing overhead', noise: 'muxing overhead: unknown', absent: 'muxing overhead' },
    { klass: 'Conversion failed', noise: 'Conversion failed!', absent: 'Conversion failed' },
    { klass: '[q]', noise: '[q] command received. Exiting.', absent: '[q]' },
  ];

  it.each(cases)('strips $klass while sentinel codec line survives', async ({ noise, absent }) => {
    const stderr = `${SENTINEL}\n${noise}\n`;
    queueParse('', 1);
    readdirMock.mockResolvedValueOnce(['renderD128']);
    queueParse('vainfo: iHD driver\n'); // qsv candidate
    queueEncodeFail(stderr);

    const r = await detectEncoders();

    const excerpt = r.brokenExcerpts.qsv!;
    expect(excerpt).toContain('MFX session: -9'); // sentinel survives
    expect(excerpt).not.toContain(absent); // noise class stripped
  });
});

describe('23-04 probe-encode gate — AC-10 probe only for feature-present HW', () => {
  it('test_probe_when_vaapi_candidate_then_device_path_passed_to_probe', async () => {
    queueParse('', 1); // no nvenc
    readdirMock.mockResolvedValueOnce(['renderD129']);
    queueParse('Mesa Gallium driver radeonsi\nVAEntrypointEncSlice\n'); // vaapi candidate
    queueEncodeOk();

    const r = await detectEncoders();

    expect(r.detected).toContain('vaapi');
    expect(r.outcome.vaapi).toBe('functional');
    const ff = allSpawnArgs().find((a) => a.includes('lavfi'))!;
    expect(ff).toContain('hevc_vaapi');
    expect(ff).toContain('/dev/dri/renderD129'); // probed with the detected device
    expect(ffmpegSpawnCount()).toBe(1); // exactly one HW candidate probed
  });
});
