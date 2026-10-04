// 05-03 T1.D: log retention sweep.
// Phase 5 Plan 05-03 (Logs Viewer) — AC-9 + audit M2.
//
// Deletes log files older than retentionDays + LRU-evicts when total bytes
// exceeds maxBytes. audit M2: skips files for jobs with status='encoding'
// OR 'queued' — defensive even if mtime makes deletion unlikely.

import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@/src/lib/logger';
import type { JobRepo } from '@/src/lib/db/repos/job';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const SWEEP_BUDGET = 1000;

export interface SweepResult {
  deletedCount: number;
  deletedBytes: number;
  remainingBytes: number;
  skippedActive: number;
}

interface LogFileEntry {
  jobId: string;
  filePath: string;
  size: number;
  mtimeMs: number;
}

/**
 * Sweep log files. Returns metrics + emits pino info on completion.
 * audit M2: consults jobRepo.findById before each deletion; skips active jobs.
 */
export async function sweepJobLogs({
  cachePoolPath,
  retentionDays,
  maxBytes = DEFAULT_MAX_BYTES,
  jobRepo,
}: {
  cachePoolPath: string;
  retentionDays: number;
  maxBytes?: number;
  jobRepo: JobRepo;
}): Promise<SweepResult> {
  const logsDir = path.join(cachePoolPath, 'logs');
  let entries: string[];
  try {
    entries = await fs.readdir(logsDir);
  } catch {
    return { deletedCount: 0, deletedBytes: 0, remainingBytes: 0, skippedActive: 0 };
  }
  const cutoffMs = Date.now() - retentionDays * 24 * 3600 * 1000;
  const candidates: LogFileEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.log')) continue;
    if (candidates.length >= SWEEP_BUDGET) break;
    const jobId = entry.slice(0, -4);
    const filePath = path.join(logsDir, entry);
    try {
      const stat = await fs.stat(filePath);
      candidates.push({ jobId, filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // entry vanished mid-readdir — skip
    }
  }

  let deletedCount = 0;
  let deletedBytes = 0;
  let skippedActive = 0;

  // Phase 1: age-based eviction.
  for (const entry of candidates) {
    if (entry.mtimeMs >= cutoffMs) continue;
    if (isActiveJob(entry.jobId, jobRepo)) {
      skippedActive++;
      continue;
    }
    try {
      await fs.unlink(entry.filePath);
      deletedCount++;
      deletedBytes += entry.size;
      entry.size = 0;
    } catch {
      // already gone or permission denied — count as no-op
    }
  }

  // Phase 2: size-cap LRU eviction across remaining candidates.
  const remaining = candidates.filter((e) => e.size > 0).sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let remainingBytes = remaining.reduce((sum, e) => sum + e.size, 0);
  for (const entry of remaining) {
    if (remainingBytes <= maxBytes) break;
    if (isActiveJob(entry.jobId, jobRepo)) {
      skippedActive++;
      continue;
    }
    try {
      await fs.unlink(entry.filePath);
      deletedCount++;
      deletedBytes += entry.size;
      remainingBytes -= entry.size;
      entry.size = 0;
    } catch {
      // skip
    }
  }

  logger.info(
    {
      event: 'log_retention_swept',
      deletedCount,
      deletedBytes,
      remainingBytes,
      skippedActive,
    },
    'log retention sweep complete',
  );

  return { deletedCount, deletedBytes, remainingBytes, skippedActive };
}

function isActiveJob(jobId: string, jobRepo: JobRepo): boolean {
  const numericId = Number.parseInt(jobId, 10);
  if (!Number.isFinite(numericId)) return false; // non-numeric jobId = legacy/unknown; safe to delete
  try {
    const job = jobRepo.findById(numericId);
    if (!job) return false;
    return job.status === 'encoding' || job.status === 'queued';
  } catch {
    return false;
  }
}
