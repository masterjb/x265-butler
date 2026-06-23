// @vitest-environment node
// 22-00 T2 IMP-8 audit-fix M2: patternsCache timestamp ref-identity-tracker.
// AC-3 contract: same patternsCache ref → SAME timestamp; new ref → new timestamp.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReadSidecar } = vi.hoisted(() => ({
  mockReadSidecar: vi.fn(),
}));

vi.mock('@/src/lib/encode/sidecar', () => ({
  readSidecar: mockReadSidecar,
  writeSidecar: vi.fn(),
  sweepSidecarTmpFiles: vi.fn(),
  sidecarPathFor: (p: string): string => `${p}.x265-butler.json`,
}));

vi.mock('@/src/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  runSkipPipeline,
  getPatternsCacheTimestamp,
  _resetPatternsCacheTimestampForTesting,
  type PipelineDeps,
  type PipelineInput,
} from '@/src/lib/skip/pipeline';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';
import type { FileRow, BlocklistRow } from '@/src/lib/db/schema';

const probe: ProbeResult = {
  codec: 'h264',
  bitrate: 5_000_000,
  durationSeconds: 3600,
  width: 1920,
  height: 1080,
  container: 'matroska,webm',
  tags: {},
};

const input: PipelineInput = {
  filePath: '/m/x.mkv',
  probe,
  diskContentHash: 'abc',
};

function makeFileRepo(): { findByContentHash: (h: string) => FileRow | null } {
  return {
    findByContentHash: () => null,
  };
}

describe('22-00 T2 audit-fix M2: getPatternsCacheTimestamp ref-identity tracker', () => {
  beforeEach(() => {
    mockReadSidecar.mockReset();
    mockReadSidecar.mockResolvedValue(null);
    _resetPatternsCacheTimestampForTesting();
  });

  it('returns null before any pipeline call with patternsCache', () => {
    expect(getPatternsCacheTimestamp()).toBeNull();
  });

  it('two calls with SAME patternsCache reference → SAME timestamp', async () => {
    const cache: BlocklistRow[] = [];
    const deps: PipelineDeps = {
      fileRepo: makeFileRepo() as never,
      patternsCache: cache,
    };

    await runSkipPipeline(input, deps);
    const ts1 = getPatternsCacheTimestamp();
    expect(ts1).not.toBeNull();

    // Wait a tick to ensure clock would advance if a new timestamp were taken.
    await new Promise((r) => setTimeout(r, 5));

    await runSkipPipeline(input, deps);
    const ts2 = getPatternsCacheTimestamp();
    expect(ts2).toBe(ts1);
  });

  it('call with NEW patternsCache reference → timestamp updates', async () => {
    const cacheA: BlocklistRow[] = [];
    const cacheB: BlocklistRow[] = []; // distinct reference, same contents
    const fileRepo = makeFileRepo();

    await runSkipPipeline(input, { fileRepo: fileRepo as never, patternsCache: cacheA });
    const ts1 = getPatternsCacheTimestamp();
    expect(ts1).not.toBeNull();

    await new Promise((r) => setTimeout(r, 5));

    await runSkipPipeline(input, { fileRepo: fileRepo as never, patternsCache: cacheB });
    const ts2 = getPatternsCacheTimestamp();
    expect(ts2).not.toBeNull();
    expect(ts2).not.toBe(ts1);
  });
});
