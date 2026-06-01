// 05-09: POST /api/queue/[jobId]/skip — single-job hard-cancel + file→pending.
// Replaces the 05-08 B1 hard-cancel-with-re-queue mechanic forward (Option B
// chosen 2026-04-29 after critical evaluation of A/B/C/D — User-intent shifted
// from "Stop preserves intent and queue resumes" to "Skip = throw this away,
// I'll trigger again if I really want it").
import crypto from 'node:crypto';
import { z } from 'zod';
import { jobRepo } from '@/src/lib/db';
import { skipActive } from '@/src/lib/encode';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({}).strict();

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const __auth = await requireAuth(request);
  if (!__auth.ok) return authGuard(__auth)!;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/queue/[jobId]/skip' });

  // Audit M6 (16KB Content-Length cap — Phase 5 SOC-2 hardening parity with
  // 05-01 audit M-pattern).
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader && parseInt(contentLengthHeader, 10) > 16384) {
    return jsonResponse({ error: 'body_too_large', requestId }, 413);
  }

  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type, rejecting with 415');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  try {
    const { jobId: jobIdStr } = await context.params;
    const jobId = Number.parseInt(jobIdStr, 10);
    if (!Number.isFinite(jobId) || jobId <= 0 || String(jobId) !== jobIdStr) {
      log.warn({ jobIdStr }, 'invalid jobId in path');
      return jsonResponse({ error: 'invalid_job_id', jobIdStr, requestId }, 400);
    }

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
    const parsed = bodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'body schema validation failed');
      return jsonResponse({ error: 'invalid_body', details: parsed.error.issues, requestId }, 400);
    }

    const jobRow = jobRepo().findById(jobId);
    if (!jobRow) {
      log.warn({ jobId }, 'job_not_found');
      return jsonResponse({ error: 'job_not_found', jobId, requestId }, 404);
    }

    const actorId =
      __auth.mode === 'authenticated' ? (__auth.username ?? 'auth_disabled') : 'auth_disabled';

    const result = await skipActive(jobId, actorId);

    log.info(
      {
        action: 'job_skipped',
        jobId,
        fileId: jobRow.file_id,
        actorId,
        prevStatus: result.prevStatus,
        alreadyTerminal: result.alreadyTerminal,
      },
      'skip request handled',
    );
    return jsonResponse(
      {
        skipped: true,
        jobId,
        jobStatus: result.prevStatus,
        alreadyTerminal: result.alreadyTerminal,
        requestId,
      },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/queue/[jobId]/skip: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
