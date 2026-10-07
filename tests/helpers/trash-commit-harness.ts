// Shared setup for orchestrator tests around the commit step: a real SQLite
// database, real files in temp folders and the real staging module, with seams
// to fail single steps.

import { vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeJobRepo, type JobRepo } from '@/src/lib/db/repos/job';
import { makeSettingRepo, type SettingRepo } from '@/src/lib/db/repos/setting';
import { makeShareRepo, type ShareRepo } from '@/src/lib/db/repos/share';
import { makeTrashRepo, type TrashRepo } from '@/src/lib/db/repos/trash';
import { __forTests_resetOrchestrator, __forTests_setDeps } from '@/src/lib/encode/orchestrator';
import type { EncodeOptions, EncodeResult } from '@/src/lib/encode/ffmpeg';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';
import * as realStaging from '@/src/lib/encode/staging';
import { __forTests_resetCachePoolCooldowns } from '@/src/lib/encode/staging';

type Db = InstanceType<typeof Database>;

export const NOW_SECONDS = 1_800_000_000;
export const SOURCE_BYTES = 1_000_000;
export const OUTPUT_BYTES = 600_000;

export interface Harness {
  db: Db;
  fileRepo: FileRepo;
  jobRepo: JobRepo;
  settingRepo: SettingRepo;
  shareRepo: ShareRepo;
  trashRepo: TrashRepo;
  stageRoot: string;
  mediaRoot: string;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

export async function createHarness(): Promise<Harness> {
  await __forTests_resetOrchestrator();
  __forTests_resetCachePoolCooldowns();
  const db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  const fileRepo = makeFileRepo(db);
  const jobRepo = makeJobRepo(db, {
    setFileStatus: (id, status, expectedVersion) => fileRepo.setStatus(id, status, expectedVersion),
    bulkSetFileStatusToPending: (ids, expectedStates) =>
      fileRepo.bulkSetStatusToPendingByIds(ids, expectedStates),
  });
  return {
    db,
    fileRepo,
    jobRepo,
    settingRepo: makeSettingRepo(db),
    shareRepo: makeShareRepo(db),
    trashRepo: makeTrashRepo(db),
    stageRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'x265-commit-stage-')),
    mediaRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'x265-commit-media-')),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export async function disposeHarness(h: Harness): Promise<void> {
  await __forTests_resetOrchestrator();
  h.db.close();
  fs.rmSync(h.stageRoot, { recursive: true, force: true });
  fs.rmSync(h.mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
}

const probe = (): ProbeResult => ({
  codec: 'h264',
  bitrate: 5_000_000,
  durationSeconds: 60,
  width: 1920,
  height: 1080,
  container: 'matroska',
  tags: {},
  color: { space: null, primaries: null, transfer: null, range: null },
  hdr10: { masterDisplay: null, maxCll: null },
  streams: [
    { attachedPic: false, index: 0, codec_type: 'video', codec_name: 'h264' },
    { attachedPic: false, index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
});

export interface SetupOptions {
  outputMode: 'suffix' | 'replace';
  settings?: Record<string, string>;
  sourceName?: string;
  shareId?: number | null;
  outputBytes?: number;
  encodeExitCode?: number;
  // Runs inside the fake encode, after the output is written.
  duringEncode?: (ctx: { sourcePath: string; output: string }) => void;
  staging?: Partial<typeof realStaging>;
  unlinkSync?: (p: fs.PathLike) => void;
  withShareRepo?: boolean;
}

export interface SetupResult {
  fileId: number;
  jobId: number;
  sourcePath: string;
  unlinked: string[];
}

export function setupJob(h: Harness, opts: SetupOptions): SetupResult {
  const sourcePath = path.join(h.mediaRoot, opts.sourceName ?? 'movie.mkv');
  fs.writeFileSync(sourcePath, Buffer.alloc(SOURCE_BYTES, 'x'));
  const file = h.fileRepo.upsertByPath({
    path: sourcePath,
    size_bytes: SOURCE_BYTES,
    mtime: 1_700_000_000,
    content_hash: 'a'.repeat(64),
    codec: 'h264',
    bitrate: 5_000_000,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: path.extname(sourcePath).slice(1),
    last_scanned_at: 1_700_000_500,
    share_id: opts.shareId ?? null,
  });
  const job = h.jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create job');

  h.settingRepo.set('cache_pool_path', h.stageRoot);
  h.settingRepo.set('default_crf', '23');
  h.settingRepo.set('min_savings_percent', '5');
  h.settingRepo.set('trash_retention_days', '30');
  h.settingRepo.set('output_mode', opts.outputMode);
  h.settingRepo.set('output_container', 'mkv');
  for (const [k, v] of Object.entries(opts.settings ?? {})) h.settingRepo.set(k, v);

  const unlinked: string[] = [];
  __forTests_setDeps({
    runEncode: (async (o: EncodeOptions) => {
      fs.writeFileSync(o.output, Buffer.alloc(opts.outputBytes ?? OUTPUT_BYTES, 'y'));
      opts.duringEncode?.({ sourcePath, output: o.output });
      return {
        exitCode: opts.encodeExitCode ?? 0,
        durationMs: 30_000,
        logTail: '',
      } satisfies EncodeResult;
    }) as unknown as (o: EncodeOptions) => Promise<EncodeResult>,
    ffprobe: (async () => probe()) as never,
    fs: {
      statSync: fs.statSync as never,
      statfsSync: (() => ({ bavail: BigInt(100_000_000), bsize: BigInt(1) }) as never) as never,
      accessSync: fs.accessSync,
      existsSync: ((p: fs.PathLike) => fs.existsSync(String(p))) as never,
      unlinkSync: ((p: fs.PathLike) => {
        unlinked.push(String(p));
        if (opts.unlinkSync) return opts.unlinkSync(p);
        return fs.unlinkSync(p);
      }) as never,
    },
    fileRepo: () => h.fileRepo,
    jobRepo: () => h.jobRepo,
    settingRepo: () => h.settingRepo,
    trashRepo: () => h.trashRepo,
    ...(opts.withShareRepo === false ? {} : { shareRepo: () => h.shareRepo }),
    logger: {
      info: h.info,
      warn: h.warn,
      error: h.error,
      debug: vi.fn(),
      telemetry: vi.fn(),
    } as never,
    now: () => NOW_SECONDS,
    staging: {
      ...realStaging,
      unlinkSidecarTmpAt: (async () => undefined) as never,
      ...opts.staging,
    } as never,
  });
  return { fileId: file.id, jobId: job.id, sourcePath, unlinked };
}

export function trashRows(
  h: Harness,
): Array<{ id: number; trash_path: string; original_path: string }> {
  return h.db.prepare('SELECT * FROM trash_entry').all() as never;
}

export function jobRow(h: Harness, jobId: number): { status: string; error_msg: string | null } {
  return h.db.prepare('SELECT status, error_msg FROM job WHERE id = ?').get(jobId) as never;
}

export function logActions(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.map((c) => (c[0] as { action?: string })?.action ?? '');
}

export function logEntries(
  spy: ReturnType<typeof vi.fn>,
  action: string,
): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((o) => o?.action === action);
}
