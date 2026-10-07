// Two-phase scan: files without a sidecar are processed (and handed to the
// enqueue hook) during the walk of every share; files with a sidecar are
// verified afterwards by size and mtime, hashing only when they differ.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const { mockHashFile, mockFfprobe } = vi.hoisted(() => ({
  mockHashFile: vi.fn<(filePath: string) => Promise<string>>(),
  mockFfprobe: vi.fn<(filePath: string) => Promise<unknown>>(),
}));

vi.mock('@/src/lib/scan/hash', () => ({
  hashFile: mockHashFile,
  default: { hashFile: mockHashFile },
}));

vi.mock('@/src/lib/scan/ffprobe', () => ({
  ffprobe: mockFfprobe,
  default: { ffprobe: mockFfprobe },
}));

import { writeSidecarResolved, type SidecarV2 } from '@/src/lib/encode/sidecar';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { runScan, type ScanHooks } from '@/src/lib/scan/orchestrator';
import { toScanMtime } from '@/src/lib/scan/walker';
import type { FileRow } from '@/src/lib/db/schema';
import {
  __forTests_setDb,
  __forTests_resetDb,
  shareRepo as shareRepoFn,
  settingRepo as settingRepoFn,
} from '@/src/lib/db';

type Db = InstanceType<typeof Database>;

const ABOVE_MIN = 2 * 1024 * 1024;
const probeResult = {
  codec: 'h264',
  bitrate: 5_000_000,
  durationSeconds: 60,
  width: 1920,
  height: 1080,
  container: 'mov,mp4,m4a',
};

const hashFor = (p: string): string => crypto.createHash('sha256').update(p).digest('hex');

function writeSized(p: string, sizeBytes = ABOVE_MIN): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(sizeBytes));
}

function sidecarFor(
  filePath: string,
  opts: { side: 'output' | 'source'; withMtime?: boolean; sizeOffset?: number; hash?: string },
): SidecarV2 {
  const st = fs.statSync(filePath);
  const disk = {
    contentHash: opts.hash ?? 'f'.repeat(64),
    sizeBytes: st.size + (opts.sizeOffset ?? 0),
    ...(opts.withMtime === false ? {} : { mtime: toScanMtime(st) }),
  };
  const other = { contentHash: 'e'.repeat(64), sizeBytes: 1 };
  return {
    schema: 'x265-butler/v2',
    processedBy: 'x265-butler',
    version: '2.53.0',
    gitHash: 'abc1234',
    processedAt: '2026-10-07T00:00:00.000Z',
    source: { filename: 's.mp4', ...(opts.side === 'source' ? disk : other) },
    output: { filename: 'o.mp4', ...(opts.side === 'output' ? disk : other) },
    encoder: 'libx265',
    quality: { mode: 'crf', value: 23 },
    outcome: 'done-smaller',
  };
}

function writeBesideSidecar(filePath: string, payload: SidecarV2): void {
  fs.writeFileSync(`${filePath}.x265-butler.json`, JSON.stringify(payload));
}

function makeLog() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    telemetry: vi.fn(),
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return log;
}

const base = (name: string): string => path.basename(name);

describe('runScan two phases', () => {
  let tmpdir: string;
  let db: Db;
  let repo: FileRepo;
  let events: string[];

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-2p-'));
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    db.prepare('DELETE FROM shares').run();
    __forTests_setDb(db);
    repo = makeFileRepo(db);
    events = [];
    mockHashFile.mockReset();
    mockFfprobe.mockReset();
    mockHashFile.mockImplementation(async (p) => {
      events.push(`hash:${base(p)}`);
      return hashFor(p);
    });
    mockFfprobe.mockImplementation(async (p) => {
      events.push(`probe:${base(p)}`);
      return probeResult;
    });
  });

  afterEach(() => {
    __forTests_resetDb();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  const scan = (hooks?: ScanHooks, log = makeLog()) =>
    runScan({ rootPath: tmpdir, extensions: ['mp4'], minSizeMb: 1 }, repo, log as never, hooks);

  function recordingHooks(onPending?: (row: FileRow) => void) {
    const pending: string[] = [];
    let batches = 0;
    const hooks: ScanHooks = {
      onPending: (row) => {
        events.push(`pending:${base(row.path)}`);
        pending.push(base(row.path));
        onPending?.(row);
        return true;
      },
      onBatchEnd: () => {
        batches++;
      },
    };
    return { hooks, pending, batches: () => batches };
  }

  it('processes files without a sidecar before verifying sidecar files', async () => {
    const newFiles: string[] = [];
    const doneFiles: string[] = [];
    for (let i = 0; i < 8; i++) {
      const p = path.join(tmpdir, `f${i}.mp4`);
      writeSized(p);
      if (i % 2 === 0) {
        writeBesideSidecar(p, sidecarFor(p, { side: 'output' }));
        doneFiles.push(base(p));
      } else {
        newFiles.push(base(p));
      }
    }

    const result = await scan();

    const lastNew = Math.max(...newFiles.map((n) => events.lastIndexOf(`probe:${n}`)));
    const firstDone = Math.min(...doneFiles.map((n) => events.indexOf(`probe:${n}`)));
    expect(lastNew).toBeGreaterThanOrEqual(0);
    expect(firstDone).toBeGreaterThan(lastNew);
    for (const n of doneFiles) expect(events).not.toContain(`hash:${n}`);
    expect(result.filesScanned).toBe(8);
  });

  it('counter invariant holds across both phases', async () => {
    const gone = path.join(tmpdir, 'gone.mp4');
    writeSized(gone);
    writeBesideSidecar(gone, sidecarFor(gone, { side: 'output' }));
    const done = path.join(tmpdir, 'done.mp4');
    writeSized(done);
    writeBesideSidecar(done, sidecarFor(done, { side: 'output' }));
    const fresh = path.join(tmpdir, 'new.mp4');
    writeSized(fresh);
    const { hooks } = recordingHooks(() => fs.rmSync(gone));

    const r = await scan(hooks);

    expect(r.filesScanned).toBe(3);
    expect(r.filesAdded + r.filesUpdated + r.filesUnchanged + r.filesFailed).toBe(r.filesScanned);
    expect(r.filesFailed).toBe(1);
  });

  it('calls onPending during the walk, before runScan resolves', async () => {
    const done = path.join(tmpdir, 'done.mp4');
    writeSized(done);
    writeBesideSidecar(done, sidecarFor(done, { side: 'output' }));
    writeSized(path.join(tmpdir, 'new.mp4'));
    const { hooks, pending } = recordingHooks();

    const promise = scan(hooks);
    await promise;

    expect(pending).toEqual(['new.mp4']);
    // handed over before the verify phase touched the sidecar file
    expect(events.indexOf('pending:new.mp4')).toBeLessThan(events.indexOf('probe:done.mp4'));
  });

  it('calls onBatchEnd once per window that handed over rows', async () => {
    for (let i = 0; i < 6; i++) writeSized(path.join(tmpdir, `n${i}.mp4`));
    const { hooks, pending, batches } = recordingHooks();

    await scan(hooks);

    expect(pending).toHaveLength(6);
    // SCAN_PROBE_CONCURRENCY = 4 → windows of 4 and 2
    expect(batches()).toBe(2);
  });

  it('no onPending for skipped rows', async () => {
    const legacy = path.join(tmpdir, 'legacy.mp4');
    writeSized(legacy);
    writeBesideSidecar(
      legacy,
      sidecarFor(legacy, { side: 'source', withMtime: false, hash: hashFor(legacy) }),
    );
    const matched = path.join(tmpdir, 'matched.mp4');
    writeSized(matched);
    writeBesideSidecar(matched, sidecarFor(matched, { side: 'output' }));
    const { hooks, pending } = recordingHooks();

    await scan(hooks);

    expect(pending).toEqual([]);
    expect(repo.findByPath(legacy)?.status).toBe('skipped-sidecar');
    expect(repo.findByPath(matched)?.status).toBe('skipped-sidecar');
  });

  it('fast-path pending rows do not reach the hook', async () => {
    writeSized(path.join(tmpdir, 'a.mp4'));
    await scan();
    expect(repo.findByPath(path.join(tmpdir, 'a.mp4'))?.status).toBe('pending');
    const { hooks, pending } = recordingHooks();

    const r = await scan(hooks);

    expect(r.filesUnchanged).toBe(1);
    expect(pending).toEqual([]);
  });

  it('sidecar match skips the hash and stores the sidecar hash', async () => {
    const p = path.join(tmpdir, 'movie-x265.mp4');
    writeSized(p);
    writeBesideSidecar(p, sidecarFor(p, { side: 'output', hash: 'C'.repeat(64) }));
    const log = makeLog();

    await scan(undefined, log);

    expect(mockHashFile).not.toHaveBeenCalled();
    const row = repo.findByPath(p);
    expect(row?.status).toBe('skipped-sidecar');
    expect(row?.content_hash).toBe('c'.repeat(64));
    expect(row?.codec).toBe('h264');
  });

  it('source-side match skips the hash too', async () => {
    const p = path.join(tmpdir, 'kept-source.mp4');
    writeSized(p);
    writeBesideSidecar(p, sidecarFor(p, { side: 'source', hash: 'd'.repeat(64) }));

    await scan();

    expect(mockHashFile).not.toHaveBeenCalled();
    expect(repo.findByPath(p)?.content_hash).toBe('d'.repeat(64));
    expect(repo.findByPath(p)?.status).toBe('skipped-sidecar');
  });

  it('sidecar match stays skipped when ffprobe fails', async () => {
    const p = path.join(tmpdir, 'movie-x265.mp4');
    writeSized(p);
    writeBesideSidecar(p, sidecarFor(p, { side: 'output' }));
    mockFfprobe.mockRejectedValue(new Error('probe broke'));
    const { hooks, pending } = recordingHooks();

    await scan(hooks);

    const row = repo.findByPath(p);
    expect(row?.status).toBe('skipped-sidecar');
    expect(row?.codec).toBeNull();
    expect(pending).toEqual([]);
  });

  it('central mode reads the central sidecar', async () => {
    const centralRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-2p-central-'));
    try {
      settingRepoFn().set('sidecar_mode', 'central');
      settingRepoFn().set('sidecar_central_path', centralRoot);
      const p = path.join(tmpdir, 'movie-x265.mp4');
      writeSized(p);
      await writeSidecarResolved(p, sidecarFor(p, { side: 'output' }), 'central', centralRoot);

      await scan();

      expect(mockHashFile).not.toHaveBeenCalled();
      expect(repo.findByPath(p)?.status).toBe('skipped-sidecar');
    } finally {
      fs.rmSync(centralRoot, { recursive: true, force: true });
    }
  });

  it('size mismatch hashes and runs the pipeline', async () => {
    const p = path.join(tmpdir, 'replaced.mp4');
    writeSized(p);
    writeBesideSidecar(p, sidecarFor(p, { side: 'output', sizeOffset: 10 }));
    const { hooks, pending } = recordingHooks();
    const log = makeLog();

    await scan(hooks, log);

    expect(mockHashFile).toHaveBeenCalledWith(p);
    expect(repo.findByPath(p)?.status).toBe('pending');
    expect(pending).toEqual(['replaced.mp4']);
    const summary = log.info.mock.calls.find((c) => c[0]?.action === 'scan_two_phase_summary');
    expect(summary?.[0]).toMatchObject({ deferred: 1, verifyHashed: 1, verifyMatched: 0 });
  });

  it('legacy sidecar without mtime hashes', async () => {
    const p = path.join(tmpdir, 'legacy.mp4');
    writeSized(p);
    writeBesideSidecar(p, sidecarFor(p, { side: 'output', withMtime: false, hash: hashFor(p) }));

    await scan();

    expect(mockHashFile).toHaveBeenCalledWith(p);
    expect(repo.findByPath(p)?.status).toBe('skipped-sidecar');
  });

  it('replaced file ends pending and is enqueued', async () => {
    const p = path.join(tmpdir, 'replaced.mp4');
    writeSized(p);
    // pending row from an earlier scan of the previous file at this path
    repo.upsertByPath({
      path: p,
      size_bytes: 123,
      mtime: 1,
      content_hash: 'old'.padEnd(64, '0'),
      codec: 'h264',
      bitrate: null,
      duration_seconds: null,
      width: null,
      height: null,
      container: null,
      last_scanned_at: 1,
      share_id: null,
    });
    writeBesideSidecar(p, sidecarFor(p, { side: 'output', withMtime: false }));
    const { hooks, pending } = recordingHooks();

    const r = await scan(hooks);

    expect(r.filesUpdated).toBe(1);
    expect(repo.findByPath(p)?.content_hash).toBe(hashFor(p));
    expect(pending).toEqual(['replaced.mp4']);
  });

  it('corrupt sidecar takes the hash path in the walk', async () => {
    const p = path.join(tmpdir, 'corrupt.mp4');
    writeSized(p);
    fs.writeFileSync(`${p}.x265-butler.json`, '{not json');
    const log = makeLog();

    await scan(undefined, log);

    expect(mockHashFile).toHaveBeenCalledWith(p);
    expect(repo.findByPath(p)?.status).toBe('pending');
    const summary = log.info.mock.calls.find((c) => c[0]?.action === 'scan_two_phase_summary');
    expect(summary?.[0]).toMatchObject({ deferred: 0 });
  });

  it('changed file with stored outcome keeps its status and is counted', async () => {
    const p = path.join(tmpdir, 'evaluated.mp4');
    writeSized(p);
    const row = repo.upsertByPath({
      path: p,
      size_bytes: 123,
      mtime: 1,
      content_hash: 'old'.padEnd(64, '0'),
      codec: 'h264',
      bitrate: null,
      duration_seconds: null,
      width: null,
      height: null,
      container: null,
      last_scanned_at: 1,
      share_id: null,
    });
    repo.setStatus(row.id, 'done-larger', row.version);
    const { hooks, pending } = recordingHooks();
    const log = makeLog();

    await scan(hooks, log);

    expect(repo.findByPath(p)?.status).toBe('done-larger');
    expect(pending).toEqual([]);
    const summary = log.info.mock.calls.find((c) => c[0]?.action === 'scan_two_phase_summary');
    expect(summary?.[0]).toMatchObject({ changedKeptOutcome: 1 });
  });

  it('row matching size and mtime at verify counts as unchanged', async () => {
    const done = path.join(tmpdir, 'done.mp4');
    writeSized(done);
    writeBesideSidecar(done, sidecarFor(done, { side: 'output' }));
    writeSized(path.join(tmpdir, 'new.mp4'));
    const st = fs.statSync(done);
    // a watcher ingest creates the row between walk and verify
    const { hooks } = recordingHooks(() => {
      repo.upsertByPath({
        path: done,
        size_bytes: st.size,
        mtime: toScanMtime(st),
        content_hash: 'w'.repeat(64),
        codec: 'hevc',
        bitrate: null,
        duration_seconds: null,
        width: null,
        height: null,
        container: null,
        last_scanned_at: 1,
        share_id: null,
      });
    });

    const r = await scan(hooks);

    expect(r.filesUnchanged).toBe(1);
    expect(events).not.toContain('probe:done.mp4');
    expect(repo.findByPath(done)?.content_hash).toBe('w'.repeat(64));
  });

  it('file deleted before verify counts as failed without upsert', async () => {
    const done = path.join(tmpdir, 'done.mp4');
    writeSized(done);
    writeBesideSidecar(done, sidecarFor(done, { side: 'output' }));
    writeSized(path.join(tmpdir, 'new.mp4'));
    const { hooks } = recordingHooks(() => fs.rmSync(done));

    const r = await scan(hooks);

    expect(r.filesFailed).toBe(1);
    expect(repo.findByPath(done)).toBeUndefined();
  });

  it('file changed before verify uses fresh stat values', async () => {
    const done = path.join(tmpdir, 'done.mp4');
    writeSized(done);
    writeBesideSidecar(done, sidecarFor(done, { side: 'output' }));
    writeSized(path.join(tmpdir, 'new.mp4'));
    const { hooks } = recordingHooks(() => fs.appendFileSync(done, Buffer.alloc(10)));

    await scan(hooks);

    expect(mockHashFile).toHaveBeenCalledWith(done);
    expect(repo.findByPath(done)?.size_bytes).toBe(ABOVE_MIN + 10);
    expect(repo.findByPath(done)?.status).toBe('pending');
  });

  it('an output with its sidecar found by the walk is skipped, not handed to the hook', async () => {
    const out = path.join(tmpdir, 'later', 'movie-x265.mp4');
    writeSized(out);
    writeBesideSidecar(out, sidecarFor(out, { side: 'output' }));
    writeSized(path.join(tmpdir, 'movie.mp4'));
    const { hooks, pending } = recordingHooks();

    await scan(hooks);

    expect(repo.findByPath(out)?.status).toBe('skipped-sidecar');
    expect(pending).toEqual(['movie.mp4']);
  });

  it('logs one summary line per share without paths', async () => {
    const done = path.join(tmpdir, 'done.mp4');
    writeSized(done);
    writeBesideSidecar(done, sidecarFor(done, { side: 'output' }));
    writeSized(path.join(tmpdir, 'new.mp4'));
    const log = makeLog();
    const { hooks } = recordingHooks();

    await scan(hooks, log);

    const lines = log.info.mock.calls.filter((c) => c[0]?.action === 'scan_two_phase_summary');
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toEqual({
      action: 'scan_two_phase_summary',
      shareId: null,
      deferred: 1,
      verifyMatched: 1,
      verifyHashed: 0,
      verifyGone: 0,
      changedKeptOutcome: 0,
      enqueuedDuringScan: 1,
    });
    expect(JSON.stringify(lines[0][0])).not.toContain(tmpdir);
  });

  it('hook throw is logged and the scan continues', async () => {
    writeSized(path.join(tmpdir, 'a.mp4'));
    writeSized(path.join(tmpdir, 'b.mp4'));
    const log = makeLog();
    const hooks: ScanHooks = {
      onPending: () => {
        throw new Error('queue down');
      },
      onBatchEnd: () => {
        throw new Error('emit down');
      },
    };

    const r = await scan(hooks, log);

    expect(r.filesAdded).toBe(2);
    const warns = log.warn.mock.calls.filter((c) => c[0]?.action === 'scan_enqueue_hook_failed');
    expect(warns).toHaveLength(3);
  });

  describe('two shares', () => {
    let dirA: string;
    let dirB: string;

    beforeEach(() => {
      dirA = path.join(tmpdir, 'a');
      dirB = path.join(tmpdir, 'b');
      fs.mkdirSync(dirA);
      fs.mkdirSync(dirB);
    });

    const addShare = (name: string, p: string) =>
      shareRepoFn().create({
        name,
        path: p,
        min_size_mb: 1,
        extensions_csv: 'mp4',
        max_depth: null,
      });

    it('two shares: all files without sidecar before any verify', async () => {
      addShare('A', dirA);
      addShare('B', dirB);
      const done = path.join(dirA, 'done.mp4');
      writeSized(done);
      writeBesideSidecar(done, sidecarFor(done, { side: 'output' }));
      writeSized(path.join(dirB, 'new.mp4'));

      await scan();

      expect(events.indexOf('probe:new.mp4')).toBeGreaterThanOrEqual(0);
      expect(events.indexOf('probe:new.mp4')).toBeLessThan(events.indexOf('probe:done.mp4'));
    });

    it('byShare sums both phases', async () => {
      const a = addShare('A', dirA);
      addShare('B', dirB);
      const done = path.join(dirA, 'done.mp4');
      writeSized(done);
      writeBesideSidecar(done, sidecarFor(done, { side: 'output' }));
      writeSized(path.join(dirA, 'new.mp4'));
      writeSized(path.join(dirB, 'other.mp4'));

      const r = await scan();

      const shareA = r.byShare?.find((s) => s.shareId === a.id);
      expect(shareA).toMatchObject({ filesScanned: 2, filesAdded: 2, filesFailed: 0 });
      for (const s of r.byShare ?? []) {
        expect(s.filesAdded + s.filesUpdated + s.filesUnchanged + s.filesFailed).toBe(
          s.filesScanned,
        );
      }
      expect(r.filesScanned).toBe(3);
    });

    it('share failing in the walk is zeroed, the other completes', async () => {
      const broken = addShare('Broken', dirA);
      const ok = addShare('OK', dirB);
      fs.rmSync(dirA, { recursive: true });
      writeSized(path.join(dirB, 'new.mp4'));
      const log = makeLog();

      const r = await scan(undefined, log);

      expect(r.byShare?.find((s) => s.shareId === broken.id)?.filesScanned).toBe(0);
      expect(r.byShare?.find((s) => s.shareId === ok.id)?.filesAdded).toBe(1);
      const summaries = log.info.mock.calls.filter(
        (c) => c[0]?.action === 'scan_two_phase_summary',
      );
      expect(summaries.map((c) => c[0].shareId)).toEqual([ok.id]);
    });
  });
});
