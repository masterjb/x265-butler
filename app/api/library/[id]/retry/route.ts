import crypto from 'node:crypto';
import { z } from 'zod';
import { blocklistRepo, fileRepo, jobRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import type { FileStatus } from '@/src/lib/db/schema';

import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import { requireNotBlocklisted } from '@/src/lib/blocklist/encode-guard';
// 04-03 Plan Task 1 — POST /api/library/[id]/retry.
// 10-03 E-D5: extended to accept optional { forceContainer: 'mp4'|'mkv' }.
// When forceContainer is present, job is enqueued immediately with force_container
// set so orchestrator bypasses container_override / output_container resolution.
// Without forceContainer, semantics are byte-identical to pre-10-03 retry.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ELIGIBLE_STATES: ReadonlySet<FileStatus> = new Set<FileStatus>([
  'failed',
  'interrupted',
  'done-larger',
]);

const retryBodySchema = z
  .object({
    forceContainer: z.enum(['mp4', 'mkv']).optional(),
  })
  .strict()
  .optional();

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const { denied } = await gateAuth(req);
  if (denied) return denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/[id]/retry' });

  // Parse optional body. Empty / whitespace / '{}' → no forceContainer (10-02 compat).
  const bodyText = await req.text();
  let forceContainer: 'mp4' | 'mkv' | undefined;
  if (bodyText.length > 0 && bodyText.trim() !== '' && bodyText.trim() !== '{}') {
    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      return jsonResponse({ error: 'unexpected_body', details: 'malformed JSON', requestId }, 400);
    }
    const parsed = retryBodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      log.warn(
        { action: 'retry_unexpected_body', issues: parsed.error.issues },
        'retry body schema validation failed',
      );
      return jsonResponse(
        { error: 'unexpected_body', details: parsed.error.issues, requestId },
        400,
      );
    }
    forceContainer = parsed.data?.forceContainer;
  }

  ensureServerInit();

  const params = await ctx.params;
  const fileId = parseInt(params.id, 10);
  if (!Number.isFinite(fileId) || fileId <= 0) {
    return jsonResponse({ error: 'invalid_file_id', requestId }, 400);
  }

  try {
    const file = fileRepo().getById(fileId);
    if (!file) {
      return jsonResponse({ error: 'file_not_found', requestId }, 404);
    }

    if (!ELIGIBLE_STATES.has(file.status)) {
      return jsonResponse({ error: 'not_eligible', currentStatus: file.status, requestId }, 409);
    }

    // 13-06 Layer-2 encode-path guard.
    const guard = requireNotBlocklisted(file, blocklistRepo());
    if (guard.blocked) {
      log.info(
        {
          action: 'retry_blocked_by_blocklist',
          fileId,
          currentStatus: file.status,
        },
        'file is blocklisted — retry rejected',
      );
      return jsonResponse({ error: 'blocklisted', currentStatus: file.status, requestId }, 409);
    }

    // Defensive: cancel any active job row (orphan races from state transitions).
    const activeJob = jobRepo().findByFileId(fileId);
    if (activeJob && (activeJob.status === 'queued' || activeJob.status === 'encoding')) {
      jobRepo().markCancelled(activeJob.id);
    }

    const previousStatus = file.status;

    if (forceContainer) {
      // E-D5: force-retry path — enqueue with force_container persisted to DB.
      // This atomically sets file→queued + creates job with force_container.
      const job = jobRepo().enqueue(file.id, 'libx265', file.version, null, forceContainer);
      if (!job) {
        const fresh = fileRepo().getById(fileId);
        if (!fresh || fresh.version !== file.version) {
          return jsonResponse({ error: 'state_changed', requestId }, 409);
        }
        return jsonResponse({ error: 'internal_error', requestId }, 500);
      }
      log.info(
        {
          action: 'library_retry_force_container_requested',
          fileId,
          jobId: job.id,
          forceContainer,
          previousStatus,
        },
        'force-retry enqueued with forceContainer',
      );
      return jsonResponse(
        { fileId, jobId: job.id, previousStatus, newStatus: 'queued', forceContainer, requestId },
        200,
      );
    }

    // Standard retry path (10-02 byte-identical semantics): reset to pending only.
    const ok = fileRepo().setStatus(fileId, 'pending', file.version);
    if (!ok) {
      return jsonResponse({ error: 'state_changed', currentStatus: file.status, requestId }, 409);
    }

    log.info(
      { action: 'file_retry_initiated', fileId, previousStatus },
      'file retry initiated — status reset to pending',
    );

    return jsonResponse({ fileId, previousStatus, newStatus: 'pending', requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/library/[id]/retry POST: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
