/*
 * 33-01 (audit-SR-2/SR-3): REAL-FS round-trip for central-mode anti-double-work.
 *
 * This is the load-bearing correctness test the plan mandates be LOCAL (this is
 * PURE filesystem logic — NO hardware dependency). Mocked sidecars hide the one
 * bug class that re-queued Chris' library: a drift between the central path the
 * WRITE side (writeSidecarResolved) produces and the path the READ side
 * (readSidecarResolved via the skip-pipeline) looks under. We exercise the real
 * write→central-mirror→read path against os.tmpdir to prove path-equivalence (AC-8):
 *   writeSidecarResolved(P, …, 'central', tmpRoot)
 *     → runSkipPipeline({ filePath: P }, { sidecarMode: 'central', sidecarCentralPath: tmpRoot })
 *     → { skip: true }
 *
 * Covers AC-1 (central output-hash), AC-2 (central source-hash), AC-3 (central
 * miss → beside fallback) end-to-end with NO fs/sidecar mocks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  writeSidecarResolved,
  resolveSidecarTarget,
  type SidecarV2,
} from '@/src/lib/encode/sidecar';
import { runSkipPipeline, type PipelineDeps } from '@/src/lib/skip/pipeline';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';

const SRC_HASH = 'a'.repeat(64);
const OUT_HASH = 'b'.repeat(64);

function payload(over: Partial<SidecarV2> = {}): SidecarV2 {
  return {
    schema: 'x265-butler/v2',
    processedBy: 'x265-butler',
    version: '2.30.0',
    gitHash: 'deadbee',
    processedAt: '2026-06-18T00:00:00.000Z',
    source: { filename: 'x.mkv', contentHash: SRC_HASH, sizeBytes: 1000 },
    output: { filename: 'x.x265.mkv', contentHash: OUT_HASH, sizeBytes: 500 },
    encoder: 'libx265',
    quality: { mode: 'crf', value: 23 },
    outcome: 'done-smaller',
    ...over,
  };
}

function probe(): ProbeResult {
  return {
    codec: 'h264',
    bitrate: 5_000_000,
    durationSeconds: 3600,
    width: 1920,
    height: 1080,
    container: 'matroska,webm',
    tags: {},
  };
}

// Step-1 sidecar hits short-circuit before Step-2, so fileRepo is never read;
// a stub satisfies the required dep without a DB.
const fileRepo = { findByContentHash: () => undefined } as unknown as PipelineDeps['fileRepo'];

let centralRoot: string;
let srcDir: string;

beforeEach(async () => {
  centralRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'x265-central-'));
  srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'x265-src-'));
});

afterEach(async () => {
  await fs.rm(centralRoot, { recursive: true, force: true });
  await fs.rm(srcDir, { recursive: true, force: true });
});

describe('33-01 central-mode skip-pipeline — real-FS round-trip (AC-8)', () => {
  it('AC-2: central sidecar written at the SOURCE path is found → skip', async () => {
    const p = path.join(srcDir, 'movie.mkv');
    await writeSidecarResolved(p, payload(), 'central', centralRoot);

    const decision = await runSkipPipeline(
      { filePath: p, probe: probe(), diskContentHash: SRC_HASH },
      { fileRepo, sidecarMode: 'central', sidecarCentralPath: centralRoot },
    );
    expect(decision).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  it('AC-1: central sidecar matched on OUTPUT hash (re-scanned output row) → skip', async () => {
    const p = path.join(srcDir, 'movie.x265.mkv');
    await writeSidecarResolved(p, payload(), 'central', centralRoot);

    // disk file hashes to the OUTPUT hash (source is gone, output is a new pending row)
    const decision = await runSkipPipeline(
      { filePath: p, probe: probe(), diskContentHash: OUT_HASH },
      { fileRepo, sidecarMode: 'central', sidecarCentralPath: centralRoot },
    );
    expect(decision).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  it('AC-8: the central sidecar written for path P is found when the pipeline runs for the SAME P', async () => {
    // path-equivalence: resolveSidecarTarget mirrors P verbatim (no realpath) on
    // BOTH sides → a write for P is read back for P. Use a nested mirrored tree.
    const p = path.join(srcDir, 'tv', 'show', 's01e01.mkv');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await writeSidecarResolved(p, payload(), 'central', centralRoot);

    // assert the central mirror file physically exists where BOTH sides compute it
    const mirrored = path.join(centralRoot, p.replace(/^[/\\]+/, '')) + '.x265-butler.json';
    await expect(fs.stat(mirrored)).resolves.toBeTruthy();

    const decision = await runSkipPipeline(
      { filePath: p, probe: probe(), diskContentHash: SRC_HASH },
      { fileRepo, sidecarMode: 'central', sidecarCentralPath: centralRoot },
    );
    expect(decision).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  it('AC-3: central MISS → beside sidecar (next to file) is still consulted → skip', async () => {
    const p = path.join(srcDir, 'legacy.mkv');
    // operator switched beside→central; old encode left a BESIDE sidecar only
    await writeSidecarResolved(p, payload(), 'beside', centralRoot);

    const decision = await runSkipPipeline(
      { filePath: p, probe: probe(), diskContentHash: SRC_HASH },
      { fileRepo, sidecarMode: 'central', sidecarCentralPath: centralRoot },
    );
    expect(decision).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  // 36-01 AC-2: the orchestrator's new SOURCE-keyed central write lands at exactly
  // resolveSidecarTarget(sourcePath,'central',root) — the same path the 33-01 read
  // resolver consults — and a later skip-pipeline scan of that source skips. This is
  // the write→read path-equivalence proof for the WRITE-side mirror added in 36-01.
  it('36-01 AC-2: source-keyed central write lands at resolveSidecarTarget(source) → round-trip skip', async () => {
    const p = path.join(srcDir, 'lib', 'movies', 'recovered.mkv');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await writeSidecarResolved(p, payload(), 'central', centralRoot);

    // Path-equivalence with the read resolver — exact same target on both sides.
    const expected = resolveSidecarTarget(p, 'central', centralRoot);
    expect(expected).not.toBeNull();
    await expect(fs.stat(expected as string)).resolves.toBeTruthy();

    const decision = await runSkipPipeline(
      { filePath: p, probe: probe(), diskContentHash: SRC_HASH },
      { fileRepo, sidecarMode: 'central', sidecarCentralPath: centralRoot },
    );
    expect(decision).toEqual({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' });
  });

  it('central miss + no beside → no skip (file proceeds to encode)', async () => {
    const p = path.join(srcDir, 'fresh.mkv');
    const decision = await runSkipPipeline(
      { filePath: p, probe: probe(), diskContentHash: SRC_HASH },
      { fileRepo, sidecarMode: 'central', sidecarCentralPath: centralRoot },
    );
    expect(decision.skip).toBe(false);
  });
});
