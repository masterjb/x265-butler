// Env resolvers for the forced-keyframe interval and the closed-GOP (IDR) pin.
// Covers the pure parse (verbatim / explicit-off / reject-to-default + exactly
// one warn) and the accessors (one `info` line per resolver, NEVER debug).

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_KEYFRAME_INTERVAL_SEC,
  resolveKeyframeIntervalSec,
  resolveClosedGopEnabled,
  keyframeIntervalSec,
  closedGopEnabled,
  __forTests_resetKeyframeCache,
} from '@/src/lib/encode/keyframe';
import { logger } from '@/src/lib/logger';

const _origInterval = process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
const _origClosedGop = process.env.ENCODE_CLOSED_GOP_DISABLED;

function restoreEnv(): void {
  if (_origInterval === undefined) delete process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
  else process.env.ENCODE_KEYFRAME_INTERVAL_SEC = _origInterval;
  if (_origClosedGop === undefined) delete process.env.ENCODE_CLOSED_GOP_DISABLED;
  else process.env.ENCODE_CLOSED_GOP_DISABLED = _origClosedGop;
}

afterEach(() => {
  restoreEnv();
  __forTests_resetKeyframeCache();
  vi.restoreAllMocks();
});

describe('resolveKeyframeIntervalSec — pure resolver', () => {
  function warnSpy() {
    return vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
  }

  it('a positive integer is used VERBATIM (no clamp, no warn)', () => {
    const spy = warnSpy();
    expect(resolveKeyframeIntervalSec('12')).toBe(12);
    expect(resolveKeyframeIntervalSec(' 3 ')).toBe(3);
    // Unclamped UPWARDS by design — the resolver does not know the fps.
    // The EFFECTIVE spacing is min(interval, encoder default GOP); see the
    // upper-bound caveat on resolveKeyframeIntervalSec in src/lib/encode/keyframe.ts.
    expect(resolveKeyframeIntervalSec('60')).toBe(60);
    expect(spy).not.toHaveBeenCalled();
  });

  it("'0' is the EXPLICIT off-state — 0, NOT a reject, NOT a warn", () => {
    const spy = warnSpy();
    expect(resolveKeyframeIntervalSec('0')).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('unset / empty / whitespace → default, and NO warn (unset is normal)', () => {
    // NOTE (deliberate): the acceptance criterion groups '' with the invalid values
    // in one clause, but the task text was explicit: "a trimmed raw value of
    // '' → default (no warn, unset is the normal case)". Warning on unset
    // would print an "invalid value" warn on EVERY default install. The task
    // action wins; precedent: resolveX265Pools / resolvePollIntervalMs both take
    // the empty string as "not configured" silently.
    const spy = warnSpy();
    expect(resolveKeyframeIntervalSec(undefined)).toBe(DEFAULT_KEYFRAME_INTERVAL_SEC);
    expect(resolveKeyframeIntervalSec('')).toBe(DEFAULT_KEYFRAME_INTERVAL_SEC);
    expect(resolveKeyframeIntervalSec('   ')).toBe(DEFAULT_KEYFRAME_INTERVAL_SEC);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(['-3', '2.5', 'abc', 'NaN', '1e3x'])(
    'invalid %s → default (reject-to-default, NOT clamp) + exactly ONE warn',
    (raw) => {
      const spy = warnSpy();
      expect(resolveKeyframeIntervalSec(raw)).toBe(DEFAULT_KEYFRAME_INTERVAL_SEC);
      const calls = spy.mock.calls.filter(
        (c) => (c[0] as { action?: string }).action === 'keyframe_interval_invalid',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toMatchObject({ action: 'keyframe_interval_invalid', raw });
    },
  );

  // RAISED 5 → 10 on 2026-09-07. Not cosmetic, and not a free knob to "tidy"
  // back: at 5 s the measured worst-case size cost is +18.6 %, at 10 s it is
  // −0.03 % (same clip). The 5 was chosen partly against a player
  // report whose cause turned out to be a broken ffmpeg master nightly — v2.47.0
  // and v2.48.0 emit a byte-identical argv, yet only v2.48.0 played back
  // correctly. The IDR pin is NOT relaxed by that finding and stays ON; only the
  // interval moved. See the constant's comment in src/lib/encode/keyframe.ts.
  it('the default constant is 10', () => {
    expect(DEFAULT_KEYFRAME_INTERVAL_SEC).toBe(10);
  });
});

describe('resolveClosedGopEnabled — kill-switch convention', () => {
  it("only the exact '1' disables; everything else leaves the pin ENABLED", () => {
    expect(resolveClosedGopEnabled('1')).toBe(false);
    expect(resolveClosedGopEnabled(' 1 ')).toBe(false);
    expect(resolveClosedGopEnabled(undefined)).toBe(true);
    expect(resolveClosedGopEnabled('')).toBe(true);
    expect(resolveClosedGopEnabled('0')).toBe(true);
    expect(resolveClosedGopEnabled('true')).toBe(true);
    expect(resolveClosedGopEnabled('yes')).toBe(true);
  });
});

describe('memoized accessors — once-per-process info line', () => {
  function infoSpy() {
    return vi.spyOn(logger, 'info').mockImplementation(() => logger as never);
  }
  function debugSpy() {
    return vi.spyOn(logger, 'debug').mockImplementation(() => logger as never);
  }

  it('keyframeIntervalSec logs exactly ONE info line with resolvedSec + source', () => {
    process.env.ENCODE_KEYFRAME_INTERVAL_SEC = '7';
    __forTests_resetKeyframeCache();
    const info = infoSpy();
    const debug = debugSpy();

    expect(keyframeIntervalSec()).toBe(7);
    expect(keyframeIntervalSec()).toBe(7);
    expect(keyframeIntervalSec()).toBe(7);

    const calls = info.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'keyframe_interval_resolved',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      action: 'keyframe_interval_resolved',
      resolvedSec: 7,
      source: 'env',
      envRaw: '7',
    });
    // NEVER debug — the LOG_LEVEL instance gate drops debug before the
    // multistream fan-out, so the ring-buffer / copy-report would never see it
    // (a debug-level resolver line once left exactly that surface dark).
    expect(debug).not.toHaveBeenCalled();
  });

  it("source is 'default' when unset and 'env-invalid' on junk", () => {
    delete process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
    __forTests_resetKeyframeCache();
    let info = infoSpy();
    expect(keyframeIntervalSec()).toBe(DEFAULT_KEYFRAME_INTERVAL_SEC);
    expect(
      info.mock.calls.find(
        (c) => (c[0] as { action?: string }).action === 'keyframe_interval_resolved',
      )?.[0],
    ).toMatchObject({ source: 'default', resolvedSec: 10, envRaw: null });
    vi.restoreAllMocks();

    process.env.ENCODE_KEYFRAME_INTERVAL_SEC = 'abc';
    __forTests_resetKeyframeCache();
    info = infoSpy();
    vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
    expect(keyframeIntervalSec()).toBe(DEFAULT_KEYFRAME_INTERVAL_SEC);
    expect(
      info.mock.calls.find(
        (c) => (c[0] as { action?: string }).action === 'keyframe_interval_resolved',
      )?.[0],
    ).toMatchObject({ source: 'env-invalid', resolvedSec: 10, envRaw: 'abc' });
  });

  it("keyframeIntervalSec resolves '0' as source=env with resolvedSec 0", () => {
    process.env.ENCODE_KEYFRAME_INTERVAL_SEC = '0';
    __forTests_resetKeyframeCache();
    const info = infoSpy();
    expect(keyframeIntervalSec()).toBe(0);
    expect(
      info.mock.calls.find(
        (c) => (c[0] as { action?: string }).action === 'keyframe_interval_resolved',
      )?.[0],
    ).toMatchObject({ source: 'env', resolvedSec: 0 });
  });

  it('closedGopEnabled logs exactly ONE info line with enabled + source', () => {
    process.env.ENCODE_CLOSED_GOP_DISABLED = '1';
    __forTests_resetKeyframeCache();
    const info = infoSpy();
    const debug = debugSpy();

    expect(closedGopEnabled()).toBe(false);
    expect(closedGopEnabled()).toBe(false);

    const calls = info.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'closed_gop_resolved',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      action: 'closed_gop_resolved',
      enabled: false,
      source: 'env',
      envRaw: '1',
    });
    expect(debug).not.toHaveBeenCalled();
  });

  it("closedGopEnabled unset → enabled true, source 'default'", () => {
    delete process.env.ENCODE_CLOSED_GOP_DISABLED;
    __forTests_resetKeyframeCache();
    const info = infoSpy();
    expect(closedGopEnabled()).toBe(true);
    expect(
      info.mock.calls.find(
        (c) => (c[0] as { action?: string }).action === 'closed_gop_resolved',
      )?.[0],
    ).toMatchObject({ enabled: true, source: 'default', envRaw: null });
  });

  it('the invalid-value warn fires exactly once per process (memoized parse)', () => {
    process.env.ENCODE_KEYFRAME_INTERVAL_SEC = '2.5';
    __forTests_resetKeyframeCache();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger as never);
    vi.spyOn(logger, 'info').mockImplementation(() => logger as never);

    keyframeIntervalSec();
    keyframeIntervalSec();
    keyframeIntervalSec();

    const calls = warn.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'keyframe_interval_invalid',
    );
    expect(calls).toHaveLength(1);
  });

  it('__forTests_resetKeyframeCache clears BOTH caches', () => {
    vi.spyOn(logger, 'info').mockImplementation(() => logger as never);
    process.env.ENCODE_KEYFRAME_INTERVAL_SEC = '4';
    process.env.ENCODE_CLOSED_GOP_DISABLED = '1';
    __forTests_resetKeyframeCache();
    expect(keyframeIntervalSec()).toBe(4);
    expect(closedGopEnabled()).toBe(false);

    process.env.ENCODE_KEYFRAME_INTERVAL_SEC = '9';
    delete process.env.ENCODE_CLOSED_GOP_DISABLED;
    // still memoized
    expect(keyframeIntervalSec()).toBe(4);
    expect(closedGopEnabled()).toBe(false);

    __forTests_resetKeyframeCache();
    expect(keyframeIntervalSec()).toBe(9);
    expect(closedGopEnabled()).toBe(true);
  });
});
