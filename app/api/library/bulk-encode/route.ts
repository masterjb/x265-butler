// 32-01 Plan T1 — POST /api/library/bulk-encode.
// Bulk enqueue up to 500 file IDs for encoding (Library multi-selection action).
// Per-ID guarded enqueue — partial-success safe. HTTP 200 always (body discriminates
// via successCount / failed[]). HTTP 500 only on a truly-unexpected outer throw.
//
// audit SR-2: NO outer db.transaction + NO manual SAVEPOINT loop. jobRepo.enqueue
//   (src/lib/db/repos/job.ts:486-519) ALREADY wraps its INSERT+setFileStatus in its
//   own db.transaction() and returns null (never throws) on active_job_exists /
//   file_version_stale, so each per-ID enqueue is self-atomic. A plain per-ID
//   try/catch loop gives automatic partial-success isolation: a failed id pushes to
//   failed[] and the loop continues; committed enqueues are untouched.
// audit SR-1: per-ID requireNotBlocklisted (same guard as single /api/queue) — it does
//   its own matchByFileIdOrPath lookup, so NO listAllPatterns() hoist (would be dead).
// audit SR-3: audit-trail field is `audit:` (NOT action:) for SOC2 grep consistency.
//
// Failed reasons: 'not_found' | 'not_eligible' | 'already_queued' | 'blocklisted'
//   | 'version_conflict' | 'internal_error'.
// ELIGIBLE_STATES = single-enqueue set (mirrors /api/queue POST): pending | failed
//   | interrupted | done-larger. NOT bulk-RETRY's set (no done-not-worth).

import crypto from 'node:crypto';
import { z } from 'zod';
import { blocklistRepo, fileRepo, jobRepo } from '@/src/lib/db';
import type { FileStatus } from '@/src/lib/db/schema';
import { engineEvents } from '@/src/lib/encode/events';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import { requireNotBlocklisted } from '@/src/lib/blocklist/encode-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BULK = 500;

// Mirrors /api/queue POST ELIGIBLE_STATES exactly — the enqueue set, NOT the
// bulk-retry set (no 'done-not-worth').
const ELIGIBLE_STATES: ReadonlySet<FileStatus> = new Set<FileStatus>([
  'pending',
  'failed',
  'interrupted',
  'done-larger',
]);

const bodySchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_BULK)
    .refine((arr) => new Set(arr).size === arr.length, { message: 'duplicate_ids' }),
});

type FailedEntry = {
  id: number;
  reason:
    | 'not_found'
    | 'not_eligible'
    | 'already_queued'
    | 'blocklisted'
    | 'version_conflict'
    | 'internal_error';
};

class BulkReasonError extends Error {
  constructor(public reason: FailedEntry['reason']) {
    super(reason);
  }
}

export async function POST(req: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(req);
  if (denied) return denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/bulk-encode' });

  // CSRF defense — 415 Content-Type guard.
  const contentType = (req.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  let body: unknown;
  try {
    const text = await req.text();
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'invalid_json', requestId }, 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid_body', details: parsed.error.issues, requestId }, 400);
  }

  const actor = auth.ok && auth.mode === 'authenticated' ? auth.username : null;

  try {
    const blocklistRepoInstance = blocklistRepo();
    const successIds: number[] = [];
    const failed: FailedEntry[] = [];

    // SR-2: plain per-ID loop. Each enqueue is self-atomic (its own db.transaction).
    for (const id of parsed.data.ids) {
      try {
        const file = fileRepo().getById(id);
        if (!file) throw new BulkReasonError('not_found');
        if (!ELIGIBLE_STATES.has(file.status)) throw new BulkReasonError('not_eligible');

        // SR-1: per-ID blocklist guard — same guard as single /api/queue.
        const guard = requireNotBlocklisted(file, blocklistRepoInstance);
        if (guard.blocked) throw new BulkReasonError('blocklisted');

        // 05-08 B4: crf=null at enqueue — orchestrator resolves encoder + per-encoder
        // CRF via setEncoder/setCrf before ffmpeg spawn. encoder='libx265' literal
        // matches the single-route default.
        const job = jobRepo().enqueue(id, 'libx265', file.version, null);
        if (!job) {
          // enqueue returns null for active_job_exists OR file_version_stale.
          // Re-read to disambiguate (mirror single route 128-157).
          const fresh = fileRepo().getById(id);
          if (fresh && fresh.version !== file.version) {
            throw new BulkReasonError('version_conflict');
          }
          throw new BulkReasonError('already_queued');
        }
        successIds.push(id);
      } catch (e) {
        if (e instanceof BulkReasonError) {
          failed.push({ id, reason: e.reason });
        } else {
          failed.push({ id, reason: 'internal_error' });
          log.error(
            { err: e instanceof Error ? e.stack : String(e), id },
            'bulk-encode per-id internal_error',
          );
        }
      }
    }

    // SR-2: emit AFTER the loop — counts read post-commit so they reflect the
    // newly-inserted job rows. Non-fatal (mirror single route 162-177).
    if (successIds.length > 0) {
      try {
        engineEvents.emit({
          type: 'queue.updated',
          activeJobs: jobRepo().listActive().length,
          pendingJobs: jobRepo().countByStatus('queued'),
          paused: false,
        });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'queue.updated emit failed',
        );
      }
    }

    log.info(
      {
        audit: 'bulk_library_encode',
        requestId,
        actorId: actor,
        idsRequested: parsed.data.ids.length,
        successCount: successIds.length,
        failedCount: failed.length,
        failedSample: failed.slice(0, 10),
      },
      'bulk_library_encode',
    );

    return jsonResponse({ successCount: successIds.length, failed, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/library/bulk-encode POST: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
