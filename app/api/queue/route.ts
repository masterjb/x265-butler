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

// audit-added S5 (02-03 TOCTOU note): file states from which an encode is allowed.
// Pre-check is racy with concurrent state changes, but jobRepo.enqueue's TX-safe
// constraint (02-01 M4 partial UNIQUE INDEX + S2 transactional helper) bounds the
// outcome to "request rejected, no work done" — same UX, possibly different error
// code (file_version_conflict vs not_eligible_for_encode). Documented in PLAN.
const ELIGIBLE_STATES: readonly FileStatus[] = [
  'pending',
  'failed',
  'interrupted',
  'done-larger',
] as const;

const enqueueSchema = z
  .object({
    fileId: z.number().int().positive(),
    encoder: z.string().min(1).max(64).optional(),
    expectedFileVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

const listQuerySchema = z
  .object({
    recentLimit: z.coerce.number().int().positive().max(500).default(50),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const { denied } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/queue', method: 'POST' });

  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type, rejecting with 415');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  try {
    let bodyJson: unknown = {};
    const text = await request.text();
    if (text.trim().length > 0) {
      try {
        bodyJson = JSON.parse(text);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'invalid JSON body');
        return jsonResponse({ error: 'invalid_body', details: 'malformed JSON', requestId }, 400);
      }
    }

    const parsed = enqueueSchema.safeParse(bodyJson);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'body schema validation failed');
      return jsonResponse({ error: 'invalid_body', details: parsed.error.issues, requestId }, 400);
    }
    const body = parsed.data;
    const encoder = body.encoder ?? 'libx265';

    const file = fileRepo().getById(body.fileId);
    if (!file) {
      log.warn({ fileId: body.fileId }, 'file_not_found');
      return jsonResponse({ error: 'file_not_found', fileId: body.fileId, requestId }, 404);
    }

    if (!ELIGIBLE_STATES.includes(file.status)) {
      log.warn({ fileId: file.id, currentStatus: file.status }, 'file not in an enqueueable state');
      return jsonResponse(
        {
          error: 'not_eligible_for_encode',
          currentStatus: file.status,
          requestId,
        },
        409,
      );
    }

    // 13-06 Layer-2 encode-path guard — defense-in-depth (skip-pipeline is
    // primary). Rejects files that match a file-pinned OR pattern blocklist
    // entry. AFTER ELIGIBLE_STATES so semantics unchanged for non-blocklisted
    // files; BEFORE enqueue so no job row is created for blocklisted file.
    const guard = requireNotBlocklisted(file, blocklistRepo());
    if (guard.blocked) {
      log.info(
        {
          action: 'enqueue_blocked_by_blocklist',
          fileId: file.id,
          currentStatus: file.status,
        },
        'file is blocklisted — enqueue rejected',
      );
      return jsonResponse({ error: 'blocklisted', currentStatus: file.status, requestId }, 409);
    }

    const expectedFileVersion = body.expectedFileVersion ?? file.version;

    let job;
    try {
      // 05-08 B4: crf=null at enqueue — orchestrator dispatch path resolves
      // encoder + writes the per-encoder CRF via setEncoder + setCrf before
      // ffmpeg spawn. Settings cache lookup deferred to dispatch (avoids
      // double-resolution when 'auto' encoder ends up routing differently).
      job = jobRepo().enqueue(file.id, encoder, expectedFileVersion, null);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.stack : String(err) },
        'jobRepo.enqueue threw unexpectedly',
      );
      return jsonResponse({ error: 'internal_error', requestId }, 500);
    }

    if (!job) {
      // jobRepo.enqueue returns null for either active_job_exists OR
      // file_version_stale (TX rolled back). Re-read file to disambiguate.
      const fresh = fileRepo().getById(file.id);
      if (!fresh) {
        return jsonResponse({ error: 'file_not_found', fileId: file.id, requestId }, 404);
      }
      if (fresh.version !== expectedFileVersion) {
        log.warn(
          {
            fileId: file.id,
            expectedFileVersion,
            currentVersion: fresh.version,
          },
          'file_version_conflict',
        );
        return jsonResponse(
          {
            error: 'file_version_conflict',
            expectedVersion: expectedFileVersion,
            currentVersion: fresh.version,
            requestId,
          },
          409,
        );
      }
      // Otherwise the partial UNIQUE INDEX rejected — already an active job.
      log.warn({ fileId: file.id }, 'already_queued');
      return jsonResponse({ error: 'already_queued', fileId: file.id, requestId }, 409);
    }

    // audit-added M3 (02-03): emit queue.updated BEFORE response so SSE subscribers
    // see count change immediately, not at next ≤1s orchestrator poll.
    // 05-09 Decision §2: paused field permanently false (Pause concept retired).
    try {
      const activeJobs = jobRepo().listActive().length;
      const pendingJobs = jobRepo().countByStatus('queued');
      engineEvents.emit({
        type: 'queue.updated',
        activeJobs,
        pendingJobs,
        paused: false,
      });
    } catch (err) {
      // Non-fatal — pino warn but still return 201.
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'queue.updated emit failed',
      );
    }

    log.info({ action: 'enqueue', jobId: job.id, fileId: file.id, encoder }, 'job enqueued');

    // audit-added S7 (02-03): include full JobRow per 02-01 S5 contract — caller
    // does not need a follow-up GET to read encoder/started_at/created_at fields.
    return jsonResponse({ job, requestId }, 201);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/queue POST: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}

export async function GET(request: Request): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const { denied } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/queue', method: 'GET' });

  try {
    const url = new URL(request.url);
    const raw: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      if (v !== '') raw[k] = v;
    });
    const parsed = listQuerySchema.safeParse(raw);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'invalid query');
      return jsonResponse({ error: 'invalid_query', details: parsed.error.issues, requestId }, 400);
    }
    const { recentLimit } = parsed.data;

    const active = jobRepo().listActive();
    const recent = jobRepo().listRecent(recentLimit);
    // 05-09 Decision §2/§3: Pause retired — paused field permanently false
    // (kept on the wire for back-compat with any unmigrated consumer).
    return jsonResponse({ active, recent, paused: false, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/queue GET: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
