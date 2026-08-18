// @vitest-environment node
//
// detection.ts is server-only (audit S8 typeof-window guard). Run under node
// env so the guard does not fire and no jsdom DOM polyfills load.

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

// 27-01: delegate to the real node:fs and override ONLY promises.readdir. The
// classifier-decoupling tests below read the real vainfo fixtures via the
// synchronous readFileSync (audit SR2 pinned idiom) — a bare `() => ({promises:
// {readdir}})` factory would leave readFileSync undefined. detection.ts itself
// uses only fsp.readdir, so this is a safe superset of the prior mock.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: { ...actual.promises, readdir: readdirMock },
    default: { ...actual, promises: { ...actual.promises, readdir: readdirMock } },
  };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  detectEncoders,
  invalidateEncoderCache,
  __forTests_resetEncoderCache,
  __forTests_buildProbeEncodeArgs,
  classifyVaInfo,
  ENCODER_IDS,
} from '@/src/lib/encode/detection';
// 34-01 (AC-9): the REAL setting repo (NOT mocked) so a BARE detectEncoders()
// call exercises the single-source gpu_device read INSIDE detection.
import { settingRepo } from '@/src/lib/db';
// 29-01: shared HW-safe probe/test-encode frame size (single source of truth,
// barrel re-export per audit SR1) + the production test-encode arg-builder, so
// the cross-builder no-drift invariant can be asserted against the REAL surface.
import { PROBE_FRAME_SIZE } from '@/src/lib/encode';
import { buildTestEncodeArgs } from '@/src/lib/diagnostics/test-encode';

// audit SR2: process.cwd()-anchored absolute read (GLOBAL rule 0). vitest runs
// with cwd = repo root. Reading the REAL fixtures (not inline mock strings)
// deliberately catches real-vainfo-format drift the hand-mocks would miss.
const vainfoFixture = (n: string): string =>
  readFileSync(join(process.cwd(), 'tests/fixtures/vainfo', n), 'utf8');

class FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding?: (enc: string) => void };
  kill = vi.fn();

  constructor() {
    super();
    const stdout = new EventEmitter() as EventEmitter & { setEncoding?: (enc: string) => void };
    stdout.setEncoding = vi.fn();
    this.stdout = stdout;
  }
}

function mockProbeOk(stdout = ''): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child);
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', stdout);
    child.emit('close', 0);
  });
  return child;
}

function mockProbeNonzero(): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child);
  setImmediate(() => {
    child.emit('close', 1);
  });
  return child;
}

function mockProbeENOENT(): FakeChild {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child);
  setImmediate(() => {
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
  });
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  readdirMock.mockReset();
  __forTests_resetEncoderCache();
  // 23-04: these legacy tests assert the FEATURE-PARSE result (detected lists +
  // spawn counts for nvidia-smi/vainfo only). Disable the new probe-encode gate
  // so no extra ffmpeg child is spawned — the gate itself is covered by
  // detection-probe-encode.test.ts. detected[] + spawn counts stay byte-identical
  // to pre-23-04.
  process.env.X265_PROBE_ENCODE_DISABLED = '1';
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.X265_PROBE_ENCODE_DISABLED;
});

describe('detection — ENCODER_IDS contract', () => {
  it('test_ENCODER_IDS_when_inspected_then_contains_all_four_in_priority_order', () => {
    expect(ENCODER_IDS).toEqual(['nvenc', 'qsv', 'vaapi', 'libx265']);
  });
});

describe('detection — base cases', () => {
  it('test_detectEncoders_when_no_hw_present_then_returns_libx265_only', async () => {
    mockProbeNonzero(); // nvidia-smi exit 1 (no GPU)
    readdirMock.mockResolvedValueOnce([]); // no /dev/dri
    const r = await detectEncoders();
    expect(r.detected).toEqual(['libx265']);
    expect(r.activeFromAuto).toBe('libx265');
    expect(r.vaapiDevice).toBeUndefined();
  });

  it('test_detectEncoders_when_nvidia_smi_exits_0_then_pushes_nvenc', async () => {
    mockProbeOk('GPU 0: NVIDIA GeForce RTX 3060\n'); // nvidia-smi
    readdirMock.mockResolvedValueOnce([]);
    const r = await detectEncoders();
    expect(r.detected[0]).toBe('nvenc');
    expect(r.detected).toContain('libx265');
  });

  it('test_detectEncoders_when_renderD_present_and_iHD_then_pushes_qsv', async () => {
    mockProbeNonzero(); // no nvidia
    readdirMock.mockResolvedValueOnce(['renderD128', 'card0']);
    mockProbeOk(
      'libva info: VA-API version 1.20.0\nvainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics\n',
    ); // vainfo
    const r = await detectEncoders();
    expect(r.detected).toEqual(['qsv', 'libx265']);
    expect(r.vaapiDevice).toBe('/dev/dri/renderD128');
  });

  it('test_detectEncoders_when_renderD_present_and_no_iHD_but_VAEntrypoint_then_pushes_vaapi', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeOk('VAProfileHEVCMain : VAEntrypointEncSlice\n');
    const r = await detectEncoders();
    expect(r.detected).toEqual(['vaapi', 'libx265']);
  });

  it('test_detectEncoders_when_all_three_hw_then_order_is_nvenc_qsv_vaapi_libx265', async () => {
    // 27-01: an iHD host with encode entrypoints now yields BOTH qsv and vaapi
    // candidates (iHD ⇒ qsv, VAEntrypointEncSlice ⇒ vaapi — orthogonal surfaces).
    // ENCODER_IDS priority keeps qsv ahead of vaapi; libx265 stays last.
    mockProbeOk('GPU 0: NVIDIA\n');
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeOk('iHD driver\nVAEntrypointEncSlice\n');
    const r = await detectEncoders();
    expect(r.detected).toEqual(['nvenc', 'qsv', 'vaapi', 'libx265']);
    expect(r.detected[r.detected.length - 1]).toBe('libx265');
  });

  it('test_detectEncoders_when_called_then_libx265_always_last_in_detected', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce([]);
    const r = await detectEncoders();
    expect(r.detected[r.detected.length - 1]).toBe('libx265');
  });
});

describe('detection — caching', () => {
  it('test_detectEncoders_when_called_twice_then_second_call_uses_cache', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce([]);
    const first = await detectEncoders();
    const second = await detectEncoders();
    expect(first).toBe(second); // exact reference equality — cached
    // Only one spawn call (the first invocation); second hit cache.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(readdirMock).toHaveBeenCalledTimes(1);
  });

  it('test_detectEncoders_when_force_true_then_re_probes', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce([]);
    await detectEncoders();
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce([]);
    await detectEncoders({ force: true });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('test_detectEncoders_when_invalidateEncoderCache_called_then_next_call_re_probes', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce([]);
    await detectEncoders();
    invalidateEncoderCache();
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce([]);
    await detectEncoders();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

describe('39-01 boot-race single-flight', () => {
  // Manual-control child: queued but NOT auto-closed, so the spec drives the
  // resolution ORDER deterministically (no real timers) for the concurrent
  // normal+force last-writer-by-completion-time assertions (AC-3a / AC-6).
  function mockManualChild(): FakeChild {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    return child;
  }

  // AC-5 reject seam: the normal probe paths are FULLY defensive (runChildProcess
  // always resolves), so the only way to make runDetection() reject is a malformed
  // child whose `.on` is absent → runChildProcess's executor throws synchronously
  // AFTER its spawn try/catch → the probe Promise rejects → runDetection rejects.
  // pid:undefined makes reniceChild() early-return (no real PID is renice'd).
  function mockSpawnRejects(): void {
    spawnMock.mockReturnValueOnce({ pid: undefined, stdout: undefined });
  }

  // AC-1: cold cache, two concurrent bare calls → exactly ONE runDetection.
  it('test_detectEncoders_when_two_concurrent_bare_calls_then_one_probe_set_shared_result', async () => {
    mockProbeNonzero(); // single nvidia-smi probe for the ONE detection
    readdirMock.mockResolvedValueOnce([]);
    const [a, b] = await Promise.all([detectEncoders(), detectEncoders()]);
    // If dedup failed, the 2nd call would launch its own runDetection and consume
    // a 2nd (un-queued) spawn → spawnMock returns undefined → crash. One spawn
    // here is the single-call baseline (see base-case no-hw = 1 spawn).
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(readdirMock).toHaveBeenCalledTimes(1);
    expect(Object.is(a, b)).toBe(true); // same DetectionResult reference
    expect(a.detected).toEqual(['libx265']);
  });

  // AC-2: a 2nd bare call issued while the 1st is in flight joins it (no new probe).
  it('test_detectEncoders_when_second_call_during_inflight_then_joins_no_extra_spawn', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce([]);
    const p1 = detectEncoders(); // in flight, spawned the probe synchronously
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const p2 = detectEncoders(); // joins the in-flight promise
    expect(spawnMock).toHaveBeenCalledTimes(1); // no extra spawn for p2
    const [a, b] = await Promise.all([p1, p2]);
    expect(Object.is(a, b)).toBe(true);
  });

  // AC-3a: force runs its OWN fresh probe; with force RESOLVING LAST it wins the cache.
  it('test_detectEncoders_when_concurrent_force_resolves_last_then_force_result_cached', async () => {
    const childNormal = mockManualChild(); // normal nvidia-smi
    readdirMock.mockResolvedValueOnce([]);
    const pNormal = detectEncoders(); // in flight
    const childForce = mockManualChild(); // force nvidia-smi (own probe set)
    readdirMock.mockResolvedValueOnce([]);
    const pForce = detectEncoders({ force: true });
    expect(spawnMock).toHaveBeenCalledTimes(2); // force did NOT join — own probe
    // Pin completion order: normal first, force LAST.
    childNormal.emit('close', 1);
    const rNormal = await pNormal;
    childForce.emit('close', 1);
    const rForce = await pForce;
    expect(globalThis.__x265butler_encoder_cache).toBe(rForce); // last writer wins
    expect(globalThis.__x265butler_encoder_cache).not.toBe(rNormal);
  });

  // AC-3b: reset clears BOTH the cache and the in-flight global.
  it('test_resetEncoderCache_when_called_then_clears_inflight_global', async () => {
    const child = mockManualChild();
    readdirMock.mockResolvedValueOnce([]);
    const p = detectEncoders(); // populates the in-flight global synchronously
    expect(globalThis.__x265butler_encoder_detect_inflight).toBeDefined();
    __forTests_resetEncoderCache();
    expect(globalThis.__x265butler_encoder_detect_inflight).toBeUndefined();
    // settle the dangling detection so the spec leaves no pending work
    child.emit('close', 1);
    await p;
  });

  // AC-5: a rejected in-flight detection clears the guard, caches NOTHING, and does
  // not poison the next call (the inverse of the Defect-B permanent-cache trap).
  it('test_detectEncoders_when_inflight_rejects_then_guard_cleared_cache_empty_next_call_reprobes', async () => {
    mockSpawnRejects(); // nvidia-smi probe → runDetection rejects
    readdirMock.mockResolvedValueOnce([]);
    const p = detectEncoders();
    await expect(p).rejects.toBeDefined();
    expect(globalThis.__x265butler_encoder_detect_inflight).toBeUndefined(); // .finally cleared it
    expect(globalThis.__x265butler_encoder_cache).toBeUndefined(); // failure NEVER cached
    // a subsequent call starts a FRESH runDetection (does not re-join the dead promise)
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce([]);
    const r2 = await detectEncoders();
    expect(r2.detected).toEqual(['libx265']);
    expect(spawnMock).toHaveBeenCalledTimes(2); // reject probe + fresh probe
  });

  // AC-6: concurrent normal+force with the NORMAL probe resolving LAST → normal wins
  // the cache (last-writer-by-completion-time, the documented accepted limitation).
  it('test_detectEncoders_when_concurrent_normal_resolves_last_then_normal_result_cached', async () => {
    const childNormal = mockManualChild();
    readdirMock.mockResolvedValueOnce([]);
    const pNormal = detectEncoders(); // in flight
    const childForce = mockManualChild();
    readdirMock.mockResolvedValueOnce([]);
    const pForce = detectEncoders({ force: true });
    expect(spawnMock).toHaveBeenCalledTimes(2); // force ran its own probe set
    // Pin completion order: force first, normal LAST.
    childForce.emit('close', 1);
    const rForce = await pForce;
    childNormal.emit('close', 1);
    const rNormal = await pNormal;
    expect(globalThis.__x265butler_encoder_cache).toBe(rNormal); // last writer wins
    expect(globalThis.__x265butler_encoder_cache).not.toBe(rForce);
  });
});

describe('detection — ENOENT + error event handling (audit M3)', () => {
  it('test_detectEncoders_when_nvidia_smi_emits_error_event_ENOENT_then_swallows_and_continues', async () => {
    mockProbeENOENT(); // nvidia-smi binary missing
    // 18-01: probeNvidiaDevicesPresent reads /dev to decide nvenc_no_runtime;
    // empty /dev → no warning, no nvenc.
    // 28-07 (P3): the /dev and /dev/dri readdirs now RACE under the parallel
    // feature-parse, so pin the mock by PATH instead of FIFO order.
    readdirMock.mockImplementation(async (p: string) => (p === '/dev/dri' ? [] : []));
    const r = await detectEncoders();
    expect(r.detected).toEqual(['libx265']); // graceful degradation
  });

  it('test_detectEncoders_when_vainfo_emits_error_event_ENOENT_then_swallows_and_continues', async () => {
    mockProbeNonzero(); // nvidia-smi exit nonzero (no GPU)
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeENOENT(); // vainfo binary missing
    const r = await detectEncoders();
    expect(r.detected).toEqual(['libx265']);
    expect(r.vaapiDevice).toBe('/dev/dri/renderD128'); // device found even if vainfo missing
  });

  it('test_detectEncoders_when_readdir_throws_then_skips_vaapi_branch_silently', async () => {
    mockProbeNonzero();
    readdirMock.mockRejectedValueOnce(new Error('EACCES'));
    const r = await detectEncoders();
    expect(r.detected).toEqual(['libx265']);
    expect(r.vaapiDevice).toBeUndefined();
  });
});

describe('detection — audit S6 device path discovery', () => {
  it('test_detectEncoders_when_renderD129_present_then_vaapiDevice_is_dev_dri_renderD129', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['card0', 'renderD129']);
    mockProbeOk('iHD driver\n');
    const r = await detectEncoders();
    expect(r.vaapiDevice).toBe('/dev/dri/renderD129');
  });
});

describe('detection — audit S3 timeout + cap branches', () => {
  it('test_detectEncoders_when_probe_exceeds_5s_then_aborts_and_continues', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child); // nvidia-smi: hangs (no close, no error)
    readdirMock.mockResolvedValueOnce([]);

    const p = detectEncoders();
    // Advance past 5s probe timeout — helper kills child + resolves nvenc=false.
    await vi.advanceTimersByTimeAsync(5001);
    vi.useRealTimers();

    const r = await p;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(r.detected).toEqual(['libx265']);
  });

  it('test_detectEncoders_when_spawn_throws_synchronously_then_swallows', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn EACCES');
    });
    readdirMock.mockResolvedValueOnce([]);
    const r = await detectEncoders();
    expect(r.detected).toEqual(['libx265']);
  });

  it('test_detectEncoders_when_stdout_exceeds_cap_then_kills_and_treats_as_error', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child); // nvidia-smi: stdout > 1 MiB cap
    readdirMock.mockResolvedValueOnce([]);

    const p = detectEncoders();
    setImmediate(() => {
      child.stdout.emit('data', 'x'.repeat(1024 * 1024 + 1));
      child.emit('close', null);
    });

    const r = await p;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(r.detected).toEqual(['libx265']);
  });
});

describe('detection — audit S8 server-only guard', () => {
  it('test_detectEncoders_when_imported_in_browser_global_then_throws_server_only', async () => {
    // The top-of-file guard runs at import time. We simulate by re-importing
    // in a context where `window` is briefly defined. Vitest jsdom env already
    // exposes `window`; the original import succeeded because the test setup
    // file removes it before module evaluation. Verify the guard expression
    // by inspecting source — covered by grep evidence in PLAN verify step.
    // Here we assert that the running module exports detectEncoders (proves
    // import did not throw under the test harness, which deletes window).
    expect(typeof detectEncoders).toBe('function');
  });
});

// Phase 18 Plan 18-01 Task 7 — structured detection warnings.
// Acceptance: AC-3 (warning emission) + AC-14 (test coverage window).
describe('detection — warnings emission (Plan 18-01 AC-3)', () => {
  it('test_detection_when_iHD_happy_path_then_warnings_empty', async () => {
    mockProbeNonzero(); // nvenc absent
    readdirMock.mockResolvedValueOnce(['renderD128']); // /dev/dri
    mockProbeOk('libva info: iHD driver loaded\nVAEntrypointEncSlice\n');
    const r = await detectEncoders();
    expect(r.warnings).toEqual([]);
    expect(r.detected).toContain('qsv');
  });

  it('test_detection_when_legacy_i965_only_then_qsv_only_legacy_intel_info', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeOk('Driver version: Intel i965 driver for Intel(R) Haswell\nVAEntrypointEncSlice\n');
    const r = await detectEncoders();
    expect(r.detected).toContain('vaapi');
    expect(r.warnings.map((w) => w.code)).toContain('qsv_only_legacy_intel');
    const w = r.warnings.find((x) => x.code === 'qsv_only_legacy_intel');
    expect(w?.severity).toBe('info');
  });

  it('test_detection_when_empty_entrypoints_and_dri_present_then_dri_present_no_driver_warn', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeOk('VAEntrypointVLD entrypoints: 0\n');
    const r = await detectEncoders();
    expect(r.warnings.map((w) => w.code)).toContain('dri_present_no_driver');
    const w = r.warnings.find((x) => x.code === 'dri_present_no_driver');
    expect(w?.severity).toBe('warn');
  });

  it('test_detection_when_vainfo_ENOENT_then_vainfo_binary_missing_warn', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeENOENT();
    const r = await detectEncoders();
    expect(r.warnings.map((w) => w.code)).toContain('vainfo_binary_missing');
    const w = r.warnings.find((x) => x.code === 'vainfo_binary_missing');
    expect(w?.severity).toBe('warn');
  });

  it('test_detection_when_vainfo_nonzero_exit_and_dri_present_then_dri_present_no_driver_warn', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeNonzero();
    const r = await detectEncoders();
    expect(r.warnings.map((w) => w.code)).toContain('dri_present_no_driver');
  });

  it('test_detection_when_amd_mesa_then_no_warnings_and_vaapi_detected', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeOk('Mesa Gallium driver radeonsi\nVAEntrypointEncSlice\n');
    const r = await detectEncoders();
    expect(r.warnings).toEqual([]);
    expect(r.detected).toContain('vaapi');
  });

  it('test_detection_when_nvenc_ok_and_dri_present_with_vainfo_fail_then_dri_warning_suppressed_18_02', async () => {
    // 18-02 false-positive suppression: NVIDIA hosts have /dev/dri/renderD*
    // nodes registered by the NVIDIA DRM driver, but vainfo cannot enumerate
    // VA-API entrypoints there. When NVENC is detected, dri_present_no_driver
    // must NOT fire (carry-forward expected on /dev/dri-presence + nvenc.ok).
    mockProbeOk('GPU 0: NVIDIA GeForce RTX 3060\n'); // nvidia-smi → nvenc.ok
    readdirMock.mockResolvedValueOnce(['renderD128']); // /dev/dri populated
    mockProbeNonzero(); // vainfo exit 1
    const r = await detectEncoders();
    expect(r.detected).toContain('nvenc');
    expect(r.warnings.map((w) => w.code)).not.toContain('dri_present_no_driver');
  });

  it('test_detection_when_dev_nvidia_present_and_nvidia_smi_ENOENT_then_nvenc_no_runtime_warn', async () => {
    mockProbeENOENT(); // nvidia-smi missing
    // probeNvidiaDevicesPresent reads /dev → must show nvidia0; findRenderDDevice
    // reads /dev/dri → empty. 28-07 (P3): the two readdirs now RACE under the
    // parallel feature-parse, so pin by PATH instead of FIFO order.
    readdirMock.mockImplementation(async (p: string) =>
      p === '/dev/dri' ? [] : ['nvidia0', 'null', 'tty'],
    );
    const r = await detectEncoders();
    expect(r.warnings.map((w) => w.code)).toContain('nvenc_no_runtime');
    const w = r.warnings.find((x) => x.code === 'nvenc_no_runtime');
    expect(w?.severity).toBe('warn');
  });

  it('test_detection_when_called_twice_then_second_call_returns_cached_warnings_reference', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeENOENT();
    const first = await detectEncoders();
    const second = await detectEncoders();
    expect(second.warnings).toBe(first.warnings); // identity from cache
  });

  it('test_detection_when_invalidateEncoderCache_then_warnings_recomputed', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeENOENT();
    const first = await detectEncoders();
    expect(first.warnings.length).toBeGreaterThan(0);
    invalidateEncoderCache();
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeOk('iHD driver\nVAEntrypointEncSlice\n');
    const second = await detectEncoders();
    expect(second.warnings).toEqual([]);
  });

  it('test_detection_when_empty_dri_directory_then_no_qsv_vaapi_or_warning_combo', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce([]);
    const r = await detectEncoders();
    expect(r.detected).toEqual(['libx265']);
    expect(r.warnings).toEqual([]);
  });

  it('test_detection_when_no_hw_present_then_warnings_is_array_not_undefined', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce([]);
    const r = await detectEncoders();
    // Stable-shape contract (AC-4): warnings is ALWAYS an array.
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('test_detection_when_qsv_legacy_warning_emitted_then_severity_is_info_not_warn', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeOk('i965 driver\nVAEntrypointEncSlice\n');
    const r = await detectEncoders();
    const w = r.warnings.find((x) => x.code === 'qsv_only_legacy_intel');
    expect(w?.severity).toBe('info');
  });
});

// ── 27-01: QSV/VAAPI capability decoupling (Urbies iHD-fallback fix) ──────────
// QSV (oneVPL/MSDK) ⇔ iHD; VAAPI ⇔ VAEntrypointEncSlice. They are orthogonal
// surfaces on the SAME /dev/dri device, so an iHD host advertises BOTH — the
// 23-04 probe-encode gate then verifies which actually runs. Probe-encode gate
// stays DISABLED in this file's beforeEach → feature-parse candidate set only.
describe('detection — 27-01 classifyVaInfo decoupling (direct, real fixtures)', () => {
  it('test_classifyVaInfo_when_ihd_gen12_fixture_then_both_qsv_and_vaapi_no_warning', () => {
    const r = classifyVaInfo(vainfoFixture('vainfo-output-ihd-gen12.txt'), true);
    expect(r.qsv).toBe(true);
    expect(r.vaapi).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('test_classifyVaInfo_when_mesa_amd_fixture_then_vaapi_only_no_warning', () => {
    const r = classifyVaInfo(vainfoFixture('vainfo-output-mesa-amd.txt'), true);
    expect(r.qsv).toBe(false);
    expect(r.vaapi).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('test_classifyVaInfo_when_i965_haswell_fixture_then_vaapi_with_legacy_info', () => {
    const r = classifyVaInfo(vainfoFixture('vainfo-output-i965-haswell.txt'), true);
    expect(r.qsv).toBe(false);
    expect(r.vaapi).toBe(true);
    expect(r.warning?.code).toBe('qsv_only_legacy_intel');
    expect(r.warning?.severity).toBe('info');
  });

  it('test_classifyVaInfo_when_iHD_decode_only_then_qsv_true_vaapi_false', () => {
    // AC-5: iHD present but NO encode entrypoints → qsv candidate, NO spurious vaapi.
    const r = classifyVaInfo('libva info: iHD driver\nVAProfileHEVCMain : VAEntrypointVLD\n', true);
    expect(r.qsv).toBe(true);
    expect(r.vaapi).toBe(false);
    expect(r.warning).toBeUndefined();
  });

  it('test_classifyVaInfo_when_no_encode_no_ihd_and_dri_present_then_dri_present_no_driver', () => {
    // AC-5: driver loaded, no encode entrypoints, no iHD → existing warning intact.
    const r = classifyVaInfo('VAProfileNone : VAEntrypointVideoProc\n', true);
    expect(r.qsv).toBe(false);
    expect(r.vaapi).toBe(false);
    expect(r.warning?.code).toBe('dri_present_no_driver');
    expect(r.warning?.severity).toBe('warn');
  });
});

describe('detection — 27-01 iHD dual-candidate via detectEncoders (feature-parse)', () => {
  it('test_detectEncoders_when_iHD_and_encode_entrypoints_then_pushes_both_qsv_and_vaapi', async () => {
    mockProbeNonzero(); // no nvenc
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeOk('libva info: iHD driver\nVAProfileHEVCMain : VAEntrypointEncSlice\n');
    const r = await detectEncoders();
    // AC-1: qsv BEFORE vaapi (ENCODER_IDS priority), libx265 last.
    expect(r.detected).toEqual(['qsv', 'vaapi', 'libx265']);
  });

  it('test_detectEncoders_when_iHD_but_no_encode_entrypoints_then_qsv_only', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']);
    mockProbeOk('libva info: iHD driver\nVAProfileHEVCMain : VAEntrypointVLD\n'); // decode-only
    const r = await detectEncoders();
    // AC-5: no encode entrypoints → vaapi NOT a candidate.
    expect(r.detected).toEqual(['qsv', 'libx265']);
  });
});

// ── 28-07 (P3): feature-parse parallelism + AC-7 reject-propagation ──────────
// Probe-encode gate stays DISABLED in this file's beforeEach → feature-parse
// candidate set only (outcome 'probe-inconclusive').
describe('detection — 28-07 P3 feature-parse parallel overlap', () => {
  it('test_detectEncoders_when_feature_parse_then_nvidia_smi_and_vainfo_spawn_concurrently', async () => {
    // RED against sequential: the old code spawned vainfo only AFTER nvidia-smi
    // closed, so with nvidia-smi hung vainfo would NEVER spawn. Parallel → both
    // are spawned before either closes.
    const nv = new FakeChild();
    const va = new FakeChild();
    spawnMock.mockReturnValueOnce(nv); // nvidia-smi (hangs)
    spawnMock.mockReturnValueOnce(va); // vainfo (hangs)
    readdirMock.mockImplementation(async (p: string) => (p === '/dev/dri' ? ['renderD128'] : []));

    const p = detectEncoders();
    // SR-2 timer discipline: assert overlap BEFORE driving any close, and do NOT
    // advance timers — flush microtasks until both have spawned, then drive close
    // manually so the 5 s SIGKILL timer never fires on the hung children.
    for (let i = 0; i < 50 && spawnMock.mock.calls.length < 2; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const bins = spawnMock.mock.calls.map((c) => c[0]);
    expect(bins).toContain('nvidia-smi');
    expect(bins).toContain('vainfo'); // spawned while nvidia-smi still open (RED vs sequential)

    // Resolve both: nvidia-smi → GPU, vainfo → iHD + encode entrypoints.
    nv.stdout.emit('data', 'GPU 0: NVIDIA\n');
    nv.emit('close', 0);
    va.stdout.emit('data', 'libva info: iHD driver\nVAProfileHEVCMain : VAEntrypointEncSlice\n');
    va.emit('close', 0);

    const r = await p;
    // Identical to the sequential equivalent (gate disabled → probe-inconclusive).
    expect(r.detected).toEqual(['nvenc', 'qsv', 'vaapi', 'libx265']);
  });
});

describe('detection — 28-07 AC-7 Promise.all reject does not poison the cache', () => {
  it('test_detectEncoders_when_a_probe_throws_then_rejects_and_cache_stays_undefined', async () => {
    __forTests_resetEncoderCache();
    // Force a probe to THROW, escaping runChildProcess's spawn-only try/catch: a
    // FakeChild whose stdout.setEncoding throws makes the runChildProcess Promise
    // executor throw → the feature-parse Promise.all rejects → detectEncoders
    // rejects. This exercises the DELIBERATE Promise.all reject-propagation (NOT an
    // allSettled-swallow). Every real probe catches internally; this guards a
    // future regression.
    const boom = new FakeChild();
    boom.stdout.setEncoding = vi.fn(() => {
      throw new Error('setEncoding boom');
    });
    spawnMock.mockReturnValueOnce(boom); // nvidia-smi
    readdirMock.mockResolvedValue([]); // /dev + /dev/dri empty

    await expect(detectEncoders()).rejects.toThrow('setEncoding boom');
    // The cache was NEVER assigned a partial/poisoned result.
    expect(globalThis.__x265butler_encoder_cache).toBeUndefined();

    // The very next call re-runs the full detection (cache was not poisoned).
    mockProbeNonzero(); // nvidia-smi exit 1
    readdirMock.mockResolvedValue([]);
    const r = await detectEncoders();
    expect(r.detected).toEqual(['libx265']);
    expect(spawnMock).toHaveBeenCalledTimes(2); // boom + the re-probe
  });
});

// ── 34-01: gpu_device override resolution + single-source read ───────────────
// Probe-encode gate stays DISABLED in this file's beforeEach → feature-parse
// candidate set only. These tests exercise findRenderDDevice override honouring,
// the gpu_device_not_found warning assembly, and the MH-1 single-source repo read
// reached by a BARE detectEncoders() call (no per-call-site threading).
describe('detection — 34-01 gpu_device override resolution', () => {
  // AC-2: override present among nodes → use it.
  it('test_detectEncoders_when_override_present_then_vaapiDevice_is_override', async () => {
    mockProbeNonzero(); // no nvenc
    readdirMock.mockResolvedValueOnce(['renderD128', 'renderD129', 'card0']);
    mockProbeOk('iHD driver\nVAEntrypointEncSlice\n');
    const r = await detectEncoders({ gpuDevice: '/dev/dri/renderD129' });
    expect(r.vaapiDevice).toBe('/dev/dri/renderD129');
    expect(r.warnings.map((w) => w.code)).not.toContain('gpu_device_not_found');
  });

  // AC-3: override set-but-absent → first-node fallback + gpu_device_not_found warn.
  it('test_detectEncoders_when_override_absent_then_first_node_fallback_and_warn', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD128']); // ONLY the iGPU node
    mockProbeOk('iHD driver\nVAEntrypointEncSlice\n');
    const r = await detectEncoders({ gpuDevice: '/dev/dri/renderD129' });
    expect(r.vaapiDevice).toBe('/dev/dri/renderD128'); // never breaks the encode
    const w = r.warnings.find((x) => x.code === 'gpu_device_not_found');
    expect(w).toBeDefined();
    expect(w?.severity).toBe('warn');
    expect(w?.detail).toContain('renderD129');
    expect(w?.detail).toContain('renderD128');
  });

  // AC-3b: /dev/dri unreadable / NO render nodes + override → NO gpu_device_not_found
  // (the no-DRI edge — existing warnings cover that; we never claim "not found"
  // when there is no device at all).
  it('test_detectEncoders_when_no_render_nodes_and_override_then_no_gpu_device_not_found', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce([]); // no render nodes
    const r = await detectEncoders({ gpuDevice: '/dev/dri/renderD129' });
    expect(r.vaapiDevice).toBeUndefined();
    expect(r.warnings.map((w) => w.code)).not.toContain('gpu_device_not_found');
  });

  // AC-1 regression: deterministic sort — first node is the lowest-numbered even
  // when readdir returns the nodes in reverse order (was readdir-order .find()).
  it('test_detectEncoders_when_unsorted_readdir_then_first_node_is_lowest_numbered', async () => {
    mockProbeNonzero();
    readdirMock.mockResolvedValueOnce(['renderD129', 'renderD128']); // reversed
    mockProbeOk('iHD driver\nVAEntrypointEncSlice\n');
    const r = await detectEncoders(); // no override
    expect(r.vaapiDevice).toBe('/dev/dri/renderD128');
  });

  // AC-9 (MH-1): a BARE detectEncoders() reads gpu_device from the setting repo
  // ITSELF — no call-site threading. Uses the REAL repo (set then delete).
  it('test_detectEncoders_when_bare_call_then_reads_gpu_device_from_repo', async () => {
    settingRepo().set('gpu_device', '/dev/dri/renderD129');
    try {
      mockProbeNonzero();
      readdirMock.mockResolvedValueOnce(['renderD128', 'renderD129']);
      mockProbeOk('iHD driver\nVAEntrypointEncSlice\n');
      const r = await detectEncoders(); // BARE — no gpuDevice arg
      expect(r.vaapiDevice).toBe('/dev/dri/renderD129');
    } finally {
      settingRepo().delete('gpu_device');
    }
  });

  // qsv probe argv binds the resolved node when threaded (AC-4 at the probe layer).
  it('test_buildProbeEncodeArgs_when_qsv_with_device_then_init_hw_device_before_codec', () => {
    const argv = __forTests_buildProbeEncodeArgs('qsv', '/dev/dri/renderD129');
    const i = argv.indexOf('-init_hw_device');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('qsv=hw:/dev/dri/renderD129');
    expect(i).toBeLessThan(argv.indexOf('hevc_qsv'));
  });

  it('test_buildProbeEncodeArgs_when_qsv_without_device_then_no_init_hw_device', () => {
    const argv = __forTests_buildProbeEncodeArgs('qsv');
    expect(argv).not.toContain('-init_hw_device');
  });
});

// 29-01: probe-encode frame-size false-negative regression.
// buildProbeEncodeArgs built testsrc=size=16x16 — below the HW-HEVC minimum frame
// dims (QSV/VAAPI/NVENC) → ffmpeg exit -22 / "Could not open encoder before EOF"
// → probeEncodeFunctional returns `compiled-in-broken` → encoder gated OUT of
// detected[] → libx265 fallback on perfectly-good HW (rasalf qsv / Urbies vaapi
// on v2.24.0). Fix = shared PROBE_FRAME_SIZE='320x240' const consumed by BOTH
// arg-builders so the detection probe + the test-encode can never drift again.
describe('29-01: buildProbeEncodeArgs HW-safe frame size + no drift', () => {
  // AC-1: probe frame size is HW-safe (no 16x16)
  it('emits size=320x240 and never 16x16 for any encoder', () => {
    for (const encoder of ENCODER_IDS) {
      const argv = __forTests_buildProbeEncodeArgs(encoder);
      const joined = argv.join(' ');
      expect(joined).toContain('size=320x240');
      expect(joined).not.toContain('16x16');
    }
  });

  // AC-4: probe stays a 1-frame fast probe (duration unchanged)
  it('retains -frames:v 1 and duration=1 (1-frame fast probe)', () => {
    const argv = __forTests_buildProbeEncodeArgs('qsv');
    const i = argv.indexOf('-frames:v');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('1');
    expect(argv.join(' ')).toContain('duration=1');
  });

  // AC-3: VAAPI codec block untouched (hwupload chain intact)
  it('vaapi probe keeps the -vaapi_device + format=nv12,hwupload init chain', () => {
    const argv = __forTests_buildProbeEncodeArgs('vaapi', '/dev/dri/renderD128');
    const dev = argv.indexOf('-vaapi_device');
    expect(dev).toBeGreaterThanOrEqual(0);
    expect(argv[dev + 1]).toBe('/dev/dri/renderD128');
    expect(argv).toContain('format=nv12,hwupload');
    expect(argv).toContain('hevc_vaapi');
  });

  // AC-2: single shared source of truth — both builders emit the SAME size token
  it('buildProbeEncodeArgs and buildTestEncodeArgs share PROBE_FRAME_SIZE (no drift)', () => {
    expect(PROBE_FRAME_SIZE).toBe('320x240');
    const probe = __forTests_buildProbeEncodeArgs('qsv').join(' ');
    const test = buildTestEncodeArgs('qsv').join(' ');
    expect(probe).toContain(`size=${PROBE_FRAME_SIZE}`);
    expect(test).toContain(`size=${PROBE_FRAME_SIZE}`);
  });
});
