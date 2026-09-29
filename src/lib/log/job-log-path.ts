// ISS-002 (2026-09-06): one job-log path resolution, shared by the two routes
// that read a per-job ffmpeg log.
//
// Before this file `GET /api/logs/[jobId]` and `GET /api/logs/[jobId]/download`
// each carried their own copy of the jobId regex, the containment check and the
// logs-dir derivation. The copies drifted in exactly the way duplicated code
// drifts: BOTH read `cache_pool_path` RAW and 404'd on an unset setting, while
// `openJobLogStream` (encode/log-capture.ts) wrote the file to the DC-B
// auto-resolved root. See src/lib/encode/cache-path-access.ts for the full
// account.
//
// The writer side stays where it is (`orchestrator.ts` passes its own
// dispatch-fresh `stageRoot` into `openJobLogStream`); this module is the READ
// side, and it resolves through the same resolver.
//
// SERVER-ONLY — transitively imports better-sqlite3 and node:fs.

import path from 'node:path';

import { readEffectiveCachePathCached } from '@/src/lib/encode/cache-path-access';
import type { CacheResolution } from '@/src/lib/encode/cache-path';

/** First-layer path-traversal defense (05-03 audit M1). ASCII-only by design. */
export const JOB_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export interface JobLogsDir {
  logsDir: string;
  cachePoolPath: string;
  resolution: CacheResolution;
}

/**
 * Resolve `<effective cache root>/logs`.
 *
 * NOTE it cannot return null. That is the point of ISS-002: an unset setting is
 * a RESOLVABLE state, not a missing one. A log that genuinely is not there
 * still 404s — from the `stat`, on evidence, not from a guard that never looked
 * at the filesystem.
 */
export function resolveJobLogsDir(): JobLogsDir {
  const { effectivePath, resolution } = readEffectiveCachePathCached();
  return {
    logsDir: path.resolve(effectivePath, 'logs'),
    cachePoolPath: effectivePath,
    resolution,
  };
}

/**
 * 05-03 audit M1: containment defense-in-depth. Even with JOB_ID_REGEX passed,
 * assert the resolved file sits under `<logsDir>/`. Null → caller returns 400
 * invalid_path.
 */
export function safeJobLogPath(logsDir: string, jobId: string): string | null {
  const candidate = path.resolve(path.join(logsDir, `${jobId}.log`));
  const prefix = logsDir + path.sep;
  if (!candidate.startsWith(prefix)) return null;
  return candidate;
}
