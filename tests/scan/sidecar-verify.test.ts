import { describe, it, expect } from 'vitest';
import { matchSidecar, toVerifyKeys } from '@/src/lib/scan/sidecar-verify';
import type { SidecarV2 } from '@/src/lib/encode/sidecar';

const SRC_HASH = 'a'.repeat(64);
const OUT_HASH = 'B'.repeat(64);

function payload(
  source: { sizeBytes: number; mtime?: number },
  output: { sizeBytes: number; mtime?: number },
): SidecarV2 {
  return {
    schema: 'x265-butler/v2',
    processedBy: 'x265-butler',
    version: '2.53.0',
    gitHash: 'abc1234',
    processedAt: '2026-10-07T10:00:00.000Z',
    source: { filename: 'a.mkv', contentHash: SRC_HASH, ...source },
    output: { filename: 'a-x265.mkv', contentHash: OUT_HASH, ...output },
    encoder: 'libx265',
    quality: { mode: 'crf', value: 23 },
    outcome: 'done-smaller',
  };
}

describe('sidecar verify keys', () => {
  const keys = toVerifyKeys(
    payload({ sizeBytes: 1000, mtime: 100 }, { sizeBytes: 500, mtime: 100 }),
  );

  it.each([
    ['output side matches', { size: 500, mtime: 100 }, OUT_HASH.toLowerCase()],
    ['source side matches', { size: 1000, mtime: 100 }, SRC_HASH],
    ['size differs', { size: 501, mtime: 100 }, null],
    ['mtime differs', { size: 500, mtime: 101 }, null],
  ])('%s', (_name, disk, expected) => {
    expect(matchSidecar(keys, disk)).toBe(expected);
  });

  it('a side without mtime never matches', () => {
    const legacy = toVerifyKeys(payload({ sizeBytes: 1000 }, { sizeBytes: 500 }));
    expect(matchSidecar(legacy, { size: 500, mtime: 100 })).toBeNull();
    expect(matchSidecar(legacy, { size: 1000, mtime: 100 })).toBeNull();
  });

  it('checks the output side before the source side', () => {
    const same = toVerifyKeys(
      payload({ sizeBytes: 700, mtime: 100 }, { sizeBytes: 700, mtime: 100 }),
    );
    expect(matchSidecar(same, { size: 700, mtime: 100 })).toBe(OUT_HASH.toLowerCase());
  });

  it('a sidecar without an output block still yields source keys', () => {
    const p = payload({ sizeBytes: 1000, mtime: 100 }, { sizeBytes: 500 });
    delete (p as { output?: unknown }).output;
    const k = toVerifyKeys(p);
    expect(matchSidecar(k, { size: 1000, mtime: 100 })).toBe(SRC_HASH);
    expect(matchSidecar(k, { size: 500, mtime: 100 })).toBeNull();
  });
});
