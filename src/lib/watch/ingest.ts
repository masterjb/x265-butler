// Phase 16-01: single-file ingest helper for the watcher.
//
// Plan-spec drift note: the PLAN frontmatter sketches flushBatch invoking
// `runScan({roots:[path], single:true})`. The real `runScan` signature
// (src/lib/scan/orchestrator.ts) accepts a single rootPath + extensions and
// walks the tree — calling it per single file would re-walk the entire share
// and the multi-share branch ignores opts entirely. To preserve the boundary
// (scan/orchestrator.ts signature frozen) AND keep watcher-flush O(1) per
// event, we compose the existing per-file primitives directly:
//   hashFile + ffprobe + fileRepo.upsertByPath + runSkipPipeline +
//   jobRepo.enqueue + engineEvents.emit
// — i.e. exactly what scanOneShare does for a single entry.

import fs from 'node:fs';
import { hashFile } from '../scan/hash';
import { ffprobe } from '../scan/ffprobe';
import { runSkipPipeline } from '../skip';
import type { FileRepo } from '../db/repos/file';
import type { JobRepo } from '../db/repos/job';
import type { BlocklistRepo } from '../db/repos/blocklist';
import { engineEvents } from '../encode/events';
import type pino from 'pino';
import type { SingleFileIngestResult } from './types';

export interface IngestDeps {
  fileRepo: () => FileRepo;
  jobRepo: () => JobRepo;
  blocklistRepo: () => BlocklistRepo;
  log: pino.Logger;
  encoderResolver: () => string; // typically reads settings.encoder; defaults to 'libx265'
}

export async function ingestSingleFile(
  absPath: string,
  shareId: number | null,
  deps: IngestDeps,
): Promise<SingleFileIngestResult> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absPath);
  } catch (err) {
    deps.log.warn(
      {
        action: 'auto_scan_ingest_stat_failed',
        absPath,
        err: err instanceof Error ? err.message : String(err),
      },
      'stat failed for watcher-event file',
    );
    return { enqueued: false, skipped: false };
  }
  if (!stat.isFile()) return { enqueued: false, skipped: false };

  const size = stat.size;
  const mtime = Math.floor(stat.mtimeMs / 1000);

  let contentHash: string;
  try {
    contentHash = await hashFile(absPath);
  } catch (err) {
    deps.log.warn(
      {
        action: 'auto_scan_ingest_hash_failed',
        absPath,
        err: err instanceof Error ? err.message : String(err),
      },
      'hashFile failed for watcher-event file',
    );
    return { enqueued: false, skipped: false };
  }

  // 28-05 R4: the previously-silent `.catch(() => null)` was the ONE failure
  // path in this file that swallowed without a forensic trail (stat/hash/skip/
  // enqueue all warn). Log + still degrade to null — behavior is unchanged
  // beyond the warn: the row is still upserted with null codec/bitrate/etc and
  // the `if (probe)` skip-pipeline branch below is still skipped.
  const probe = await ffprobe(absPath).catch((err) => {
    deps.log.warn(
      {
        action: 'auto_scan_ingest_ffprobe_failed',
        absPath,
        err: err instanceof Error ? err.message : String(err),
      },
      'ffprobe failed for watcher-event file — proceeding without probe metadata',
    );
    return null;
  });

  const lastScannedAt = Math.floor(Date.now() / 1000);
  const fileRow = deps.fileRepo().upsertByPath({
    path: absPath,
    size_bytes: size,
    mtime,
    content_hash: contentHash,
    codec: probe?.codec ?? null,
    bitrate: probe?.bitrate ?? null,
    duration_seconds: probe?.durationSeconds ?? null,
    width: probe?.width ?? null,
    height: probe?.height ?? null,
    container: probe?.container ?? null,
    last_scanned_at: lastScannedAt,
    share_id: shareId,
  });

  if (probe) {
    let decision: Awaited<ReturnType<typeof runSkipPipeline>> = { skip: false };
    try {
      decision = await runSkipPipeline(
        { filePath: absPath, probe, diskContentHash: contentHash },
        { fileRepo: deps.fileRepo(), blocklistRepo: deps.blocklistRepo() },
      );
    } catch (err) {
      deps.log.warn(
        {
          action: 'auto_scan_skip_pipeline_failed',
          absPath,
          err: err instanceof Error ? err.message : String(err),
        },
        'skip pipeline threw — proceeding to enqueue',
      );
    }
    if (decision.skip) {
      deps.fileRepo().setStatus(fileRow.id, decision.reason, fileRow.version);
      return { enqueued: false, skipped: true, reason: decision.reason, fileId: fileRow.id };
    }
  }

  // file must be in ELIGIBLE_STATES for enqueue. Newly-upserted rows default
  // to 'pending'; existing rows may be in other states. Let jobRepo.enqueue
  // surface 'already_queued' via null-return — the watcher treats it as a
  // benign no-op, the existing job will run.
  if (
    fileRow.status !== 'pending' &&
    fileRow.status !== 'failed' &&
    fileRow.status !== 'interrupted' &&
    fileRow.status !== 'done-larger'
  ) {
    return { enqueued: false, skipped: false, fileId: fileRow.id };
  }

  const encoder = deps.encoderResolver();
  let job;
  try {
    job = deps.jobRepo().enqueue(fileRow.id, encoder, fileRow.version, null);
  } catch (err) {
    deps.log.warn(
      {
        action: 'auto_scan_enqueue_threw',
        absPath,
        err: err instanceof Error ? err.message : String(err),
      },
      'jobRepo.enqueue threw — file dropped',
    );
    return { enqueued: false, skipped: false, fileId: fileRow.id };
  }
  if (!job) {
    // already_queued or file_version_conflict — benign for watcher flow
    return { enqueued: false, skipped: false, fileId: fileRow.id };
  }

  try {
    const activeJobs = deps.jobRepo().listActive().length;
    const pendingJobs = deps.jobRepo().countByStatus('queued');
    engineEvents.emit({
      type: 'queue.updated',
      activeJobs,
      pendingJobs,
      paused: false,
    });
  } catch {
    // non-fatal
  }

  return { enqueued: true, skipped: false, fileId: fileRow.id, jobId: job.id };
}
