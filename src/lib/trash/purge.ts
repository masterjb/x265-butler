import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { logger as defaultLogger, type AppLogger } from '../logger';
import type { TrashRepo } from '../db/repos/trash';

// Removes expired trash entries together with their files. The row is deleted
// only after the file is gone (or was already gone), so a failed unlink never
// leaves a file nobody can see; the row stays and the next run tries again.

const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES = 10;
const MAX_FAILURE_EXAMPLES = 10;

// Exactly the shape trashPathFor builds: <root>/trash/<jobId>-<YYYYMMDDhhmmss>/<name>.
// Anything else is refused, so a broken or foreign row can never reach a live file.
const TRASH_LAYOUT_RE = /\/trash\/\d+-\d{14}\/[^/]+$/;

export function isPurgeableTrashPath(trashPath: string, originalPath: string): boolean {
  if (!path.isAbsolute(trashPath)) return false;
  if (path.normalize(trashPath) !== trashPath) return false;
  if (!TRASH_LAYOUT_RE.test(trashPath)) return false;
  return trashPath !== originalPath;
}

/**
 * TRASH_PURGE_DISABLED. Kill switch convention of the repo: only `1` turns the
 * purge off; unset, `0`, `true` or anything else leaves it on.
 */
export function resolveTrashPurgeEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim() !== '1';
}

let _enabledCache: boolean | undefined;
let _running = false;

function trashPurgeEnabled(log: AppLogger): boolean {
  if (_enabledCache === undefined) {
    const raw = process.env.TRASH_PURGE_DISABLED;
    _enabledCache = resolveTrashPurgeEnabled(raw);
    log.info(
      { action: 'trash_purge_resolved', enabled: _enabledCache, envRaw: raw ?? null },
      'trash purge resolved',
    );
  }
  return _enabledCache;
}

export function __forTests_resetTrashPurge(): void {
  _enabledCache = undefined;
  _running = false;
}

export interface PurgeFs {
  unlink(p: string): Promise<void>;
  rmdir(p: string): Promise<void>;
}

export interface PurgeOptions {
  now: number;
  repo: Pick<TrashRepo, 'listExpired' | 'findById' | 'deleteUnrestoredRow'>;
  logger?: AppLogger;
  fs?: PurgeFs;
  batchSize?: number;
  maxBatches?: number;
}

export interface PurgeResult {
  ran: boolean;
  deleted: number;
  failed: number;
  skipped: number;
}

type Failure = { id: number; trashPath: string; errno?: string; reason?: string };

function errnoOf(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'unknown';
}

export async function purgeExpiredTrash(opts: PurgeOptions): Promise<PurgeResult> {
  const log = opts.logger ?? defaultLogger;
  const result: PurgeResult = { ran: false, deleted: 0, failed: 0, skipped: 0 };
  if (!trashPurgeEnabled(log)) return result;
  // One run at a time: on a slow share a run can outlast the timer tick.
  if (_running) {
    log.info(
      { action: 'trash_purge_skipped', reason: 'previous_run_active' },
      'trash purge skipped',
    );
    return result;
  }
  _running = true;
  result.ran = true;
  const fs = opts.fs ?? { unlink: fsPromises.unlink, rmdir: fsPromises.rmdir };
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? DEFAULT_MAX_BATCHES;
  const failures: Failure[] = [];
  try {
    let cursor = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const rows = opts.repo.listExpired(opts.now, cursor, batchSize);
      for (const listed of rows) {
        cursor = listed.id;
        // Re-read right before deleting: a restore may have landed meanwhile.
        const row = opts.repo.findById(listed.id);
        if (!row || row.restored_at !== null || row.expires_at > opts.now) continue;
        if (!isPurgeableTrashPath(row.trash_path, row.original_path)) {
          result.skipped += 1;
          failures.push({ id: row.id, trashPath: row.trash_path, reason: 'trash_path_unexpected' });
          continue;
        }
        try {
          await fs.unlink(row.trash_path);
        } catch (err) {
          if (errnoOf(err) !== 'ENOENT') {
            result.failed += 1;
            failures.push({ id: row.id, trashPath: row.trash_path, errno: errnoOf(err) });
            continue;
          }
        }
        if (opts.repo.deleteUnrestoredRow(row.id)) result.deleted += 1;
        try {
          // Only removes the per-job folder when it is empty.
          await fs.rmdir(path.dirname(row.trash_path));
        } catch {
          // not empty or already gone
        }
      }
      if (rows.length < batchSize) break;
    }
  } finally {
    _running = false;
  }
  if (failures.length > 0) {
    log.error(
      {
        action: 'trash_purge_failed',
        count: failures.length,
        examples: failures.slice(0, MAX_FAILURE_EXAMPLES),
      },
      'trash purge could not remove some expired entries; rows kept for the next run',
    );
  }
  return result;
}
