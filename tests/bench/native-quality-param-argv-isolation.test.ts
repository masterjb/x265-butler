/*
 * 49-05 AC-12 — `bench_combo.native_quality_param` is provably NOT an argv source.
 *
 * This is what makes AC-11/AC-11b a pure DISPLAY change: if the stored string
 * ever reached the spawn, renaming `hevc_nvenc` from '-cq' to '-qp' would
 * silently change what bench Pass-1 encodes, and the apples-to-apples VMAF
 * invariant (11-03 SR3 / 35-01 AC-6 / 43-01 AC-8) would break from a cosmetic
 * edit. The proof is executed, not argued: spawn is mocked, `encodeForBench` is
 * driven with every value the column can hold, and the captured argv is compared
 * token for token.
 *
 * SEPARATE FILE ON PURPOSE. The plan named
 * `tests/encode/bench-argv-isolation.test.ts` for this, but that file already
 * exists — it is 49-03's AC-7/AC-22 guard, asserting that bench Pass-1 inherits
 * neither the `-pix_fmt` pin nor the 49-02 IDR tokens, and it deliberately runs
 * WITHOUT a child_process mock. Module-level mocking `node:child_process` in it
 * would change the conditions of a neighbouring invariant, so 49-05's proof
 * lives here instead. The AC-13 half the plan also assigned to that file is
 * already covered there ('the bench Pass-1 argv is token-identical to v2.45.0').
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock('node:child_process', () => ({ default: { spawn: mockSpawn }, spawn: mockSpawn }));
vi.mock('node:fs/promises', () => ({
  default: { stat: async () => ({ size: 4711 }) },
  stat: async () => ({ size: 4711 }),
}));

import { encodeForBench } from '@/src/lib/bench/vmaf';

/** A child that closes cleanly on the next tick. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter | null;
    stderr: EventEmitter;
  };
  child.stdout = null;
  child.stderr = new EventEmitter();
  process.nextTick(() => child.emit('close', 0));
  return child;
}

type Enc = 'libx265' | 'nvenc' | 'qsv' | 'vaapi';

async function spawnArgv(encoder: Enc, extra: Record<string, unknown> = {}): Promise<string[]> {
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => fakeChild());
  await encodeForBench({
    inputPath: '/in.mkv',
    outputPath: '/out.mkv',
    encoder,
    crf: 23,
    vaapiDevice: encoder === 'vaapi' ? '/dev/dri/renderD128' : undefined,
    ...extra,
  } as unknown as Parameters<typeof encodeForBench>[0]);
  return mockSpawn.mock.calls[0][1] as string[];
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe('49-05 AC-12: the stored native_quality_param never reaches the argv', () => {
  // Every value the column can hold today — including the pre-49-05 '-cq' that
  // older rows still carry, and the '-q:v' new CQP-host rows will carry.
  const PERSISTED_VALUES = ['-crf', '-cq', '-qp', '-global_quality', '-q:v'];

  it.each(['libx265', 'nvenc', 'qsv', 'vaapi'] as const)(
    'the %s Pass-1 argv is identical regardless of the stored display parameter',
    async (encoder) => {
      const baseline = await spawnArgv(encoder);
      for (const persisted of PERSISTED_VALUES) {
        // `encodeForBench` has NO channel for the column — buildCodecBlock owns
        // the flag dispatch (vmaf.ts:185). Handing the value in anyway (the shape
        // a future refactor might reintroduce) must change nothing.
        expect(await spawnArgv(encoder, { nativeQualityParam: persisted })).toEqual(baseline);
      }
    },
  );

  it('nvenc Pass-1 emits -qp — the string the corrected map now displays', async () => {
    const argv = await spawnArgv('nvenc');
    expect(argv).toContain('-qp');
    expect(argv).not.toContain('-cq');
  });

  it('the crf VALUE does reach the argv — this test is not vacuously green', async () => {
    const argv = await spawnArgv('libx265');
    expect(argv).toContain('-crf');
    expect(argv).toContain('23');
  });
});
