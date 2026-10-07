// Queues new work while a scan is still running (the scanner's onPending /
// onBatchEnd hooks). An AUTOMATIC enqueue path: every call consults the
// auto_encode master switch, so switching it off mid-scan stops at once.
//
// The row the scanner hands over may be stale: between its upsert and this
// call the scanner awaited the skip pipeline, and an encode commit can change
// the row meanwhile. jobRepo.enqueue only checks the version, not the status,
// so the row is read again and queued only while it is still `pending`.
import type { FileRow } from '../db/schema';
import type { FileRepo } from '../db/repos/file';
import type { JobRepo } from '../db/repos/job';
import type { SettingRepo } from '../db/repos/setting';
import type { AppLogger } from '@/src/lib/logger';
import { isAutoEncodeEnabled } from './auto-encode';
import { automaticEnqueueCap } from './enqueue-cap';

export interface ScanEnqueueDeps {
  settingRepo: () => Pick<SettingRepo, 'get'>;
  fileRepo: () => Pick<FileRepo, 'getById'>;
  jobRepo: () => Pick<JobRepo, 'enqueue'>;
  encoder: () => string;
  emitQueueUpdated: () => void;
  log: AppLogger;
}

export interface ScanEnqueueHook {
  onPending(row: FileRow): boolean;
  onBatchEnd(): void;
  enqueuedCount(): number;
  // Rows not queued because the cap was reached; the end-of-scan and
  // reconcile sweeps pick them up later.
  cappedCount(): number;
}

export function createScanEnqueueHook(deps: ScanEnqueueDeps): ScanEnqueueHook {
  const cap = automaticEnqueueCap();
  let enqueued = 0;
  let capped = 0;
  let sinceLastEmit = 0;

  return {
    onPending(row) {
      if (!isAutoEncodeEnabled(deps.settingRepo())) return false;
      if (enqueued >= cap) {
        if (capped === 0) {
          deps.log.warn(
            { action: 'scan_enqueue_capped', capped: cap },
            'enqueue during scan reached its cap, remaining files are queued by the later sweeps',
          );
        }
        capped++;
        return false;
      }
      const fresh = deps.fileRepo().getById(row.id);
      if (!fresh || fresh.status !== 'pending') return false;
      try {
        const job = deps.jobRepo().enqueue(fresh.id, deps.encoder(), fresh.version, null);
        if (!job) return false;
      } catch (err) {
        deps.log.warn(
          {
            action: 'scan_enqueue_failed',
            fileId: fresh.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'enqueue during scan threw, file stays pending',
        );
        return false;
      }
      enqueued++;
      sinceLastEmit++;
      return true;
    },
    onBatchEnd() {
      if (sinceLastEmit === 0) return;
      sinceLastEmit = 0;
      deps.emitQueueUpdated();
    },
    enqueuedCount: () => enqueued,
    cappedCount: () => capped,
  };
}
