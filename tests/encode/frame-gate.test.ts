// The output frame-count gate leaf: kill-switch resolver, the binding skip
// ORDER, the exclusive 0.98 threshold and the reporter's own numbers.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FRAME_GATE_THRESHOLD,
  resolveFrameGateEnabled,
  frameGateEnabled,
  evaluateFrameGate,
  __forTests_resetFrameGateCache,
} from '@/src/lib/encode/frame-gate';
import { logger } from '@/src/lib/logger';

const _origEnv = process.env.ENCODE_FRAME_GATE_DISABLED;

afterEach(() => {
  if (_origEnv === undefined) delete process.env.ENCODE_FRAME_GATE_DISABLED;
  else process.env.ENCODE_FRAME_GATE_DISABLED = _origEnv;
  __forTests_resetFrameGateCache();
  vi.restoreAllMocks();
});

describe('resolveFrameGateEnabled — kill-switch convention', () => {
  it("ONLY exactly '1' disables the gate", () => {
    expect(resolveFrameGateEnabled('1')).toBe(false);
    expect(resolveFrameGateEnabled(' 1 ')).toBe(false);
  });

  it('unset / 0 / true / junk all leave the gate ACTIVE', () => {
    for (const raw of [undefined, '', '   ', '0', 'true', 'TRUE', 'yes', 'disabled', '11', 'x']) {
      expect(resolveFrameGateEnabled(raw)).toBe(true);
    }
  });
});

describe('frameGateEnabled — memoization + exactly one info line', () => {
  it('resolves once per process and logs frame_gate_resolved exactly once', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger as never);
    delete process.env.ENCODE_FRAME_GATE_DISABLED;
    expect(frameGateEnabled()).toBe(true);
    expect(frameGateEnabled()).toBe(true);
    expect(frameGateEnabled()).toBe(true);
    const lines = infoSpy.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'frame_gate_resolved',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({ enabled: true, source: 'default', envRaw: null });
  });

  it('ENCODE_FRAME_GATE_DISABLED=1 → enabled=false, source=env, one info line', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger as never);
    process.env.ENCODE_FRAME_GATE_DISABLED = '1';
    expect(frameGateEnabled()).toBe(false);
    expect(frameGateEnabled()).toBe(false);
    const lines = infoSpy.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'frame_gate_resolved',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({ enabled: false, source: 'env', envRaw: '1' });
  });

  // The resolved line must survive the LOG_LEVEL instance gate to reach the ring
  // buffer: info (30), never debug (20).
  it('the resolved line is emitted at info, never at debug', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger as never);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger as never);
    frameGateEnabled();
    expect(infoSpy).toHaveBeenCalled();
    expect(
      debugSpy.mock.calls.some(
        (c) => (c[0] as { action?: string }).action === 'frame_gate_resolved',
      ),
    ).toBe(false);
  });
});

describe('evaluateFrameGate — threshold', () => {
  it('expected 1000 → 980 passes, 979 fails (exclusive undershoot)', () => {
    const base = { durationSeconds: 100, avgFrameRate: 10 }; // expected = 1000
    expect(evaluateFrameGate({ ...base, actualPackets: 980 })).toEqual({
      kind: 'pass',
      expected: 1000,
      threshold: 980,
      actual: 980,
    });
    expect(evaluateFrameGate({ ...base, actualPackets: 979 })).toEqual({
      kind: 'fail',
      expected: 1000,
      threshold: 980,
      actual: 979,
    });
  });

  it('the threshold constant is 0.98', () => {
    expect(FRAME_GATE_THRESHOLD).toBe(0.98);
  });

  it('an over-complete output passes too (more packets than expected)', () => {
    expect(
      evaluateFrameGate({ durationSeconds: 100, avgFrameRate: 10, actualPackets: 1200 }).kind,
    ).toBe('pass');
  });
});

describe('evaluateFrameGate — the BINDING skip order', () => {
  it.each([[null], [undefined], [0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'duration %s → no_duration, and it wins over a missing fps',
    (duration) => {
      expect(
        evaluateFrameGate({
          durationSeconds: duration as number | null | undefined,
          avgFrameRate: undefined,
          actualPackets: null,
        }),
      ).toEqual({ kind: 'skip', reason: 'no_duration' });
    },
  );

  it.each([[undefined], [0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'fps %s → no_frame_rate, and it wins over a failed count',
    (fps) => {
      expect(
        evaluateFrameGate({
          durationSeconds: 100,
          avgFrameRate: fps as number | undefined,
          actualPackets: null,
        }),
      ).toEqual({ kind: 'skip', reason: 'no_frame_rate' });
    },
  );

  it('valid duration + fps but a null count → count_failed (never fail)', () => {
    expect(
      evaluateFrameGate({ durationSeconds: 100, avgFrameRate: 10, actualPackets: null }),
    ).toEqual({ kind: 'skip', reason: 'count_failed' });
  });

  // E7 — this is exactly the probe the caller uses to decide whether the count
  // spawn is worth launching at all.
  it('E7: a pre-check with actualPackets=null separates "no spawn" from "spawn"', () => {
    const noSpawnA = evaluateFrameGate({
      durationSeconds: null,
      avgFrameRate: 24,
      actualPackets: null,
    });
    const noSpawnB = evaluateFrameGate({
      durationSeconds: 100,
      avgFrameRate: undefined,
      actualPackets: null,
    });
    const spawn = evaluateFrameGate({
      durationSeconds: 100,
      avgFrameRate: 24,
      actualPackets: null,
    });
    expect(noSpawnA).toEqual({ kind: 'skip', reason: 'no_duration' });
    expect(noSpawnB).toEqual({ kind: 'skip', reason: 'no_frame_rate' });
    expect(spawn).toEqual({ kind: 'skip', reason: 'count_failed' });
  });
});

describe('evaluateFrameGate — the reporter numbers', () => {
  it('15503 s × 23.976 fps ≈ 371 722 expected — 17 packets trip the gate', () => {
    const v = evaluateFrameGate({
      durationSeconds: 15503,
      avgFrameRate: 24000 / 1001,
      actualPackets: 17,
    });
    expect(v.kind).toBe('fail');
    if (v.kind !== 'fail') throw new Error('unreachable');
    // The reporter's ffmpeg line reported 371 722 total frames; 15503 s ×
    // 24000/1001 works out to 371 700 — the same number within 0.006 %, which is
    // why the gate needs a 2 % slack and not an exact match.
    expect(Math.abs(v.expected - 371_722)).toBeLessThan(100);
    expect(v.actual).toBe(17);
    expect(v.threshold).toBeCloseTo(0.98 * v.expected, 6);
  });

  it('the same source encoded completely passes', () => {
    const v = evaluateFrameGate({
      durationSeconds: 15503,
      avgFrameRate: 24000 / 1001,
      actualPackets: 371_700,
    });
    expect(v.kind).toBe('pass');
  });

  // M-A rebuilt in numbers: 30.023 s × 24 fps = 720.55 expected, 17 counted.
  it('M-A: the locally measured collapse form rips the gate', () => {
    expect(
      evaluateFrameGate({ durationSeconds: 30.023, avgFrameRate: 24, actualPackets: 17 }).kind,
    ).toBe('fail');
  });
});
