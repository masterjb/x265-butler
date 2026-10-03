// 11-03 AC-4 + AC-4b: POST/DELETE /api/bench/[runId]/pass2 — full-file verify enqueue + cancel.

import crypto from 'node:crypto';
import { z } from 'zod';
import { benchRunRepo, benchComboRepo } from '@/src/lib/db';
import { benchOrchestrator } from '@/src/lib/bench/orchestrator';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BODY_CAP = 1024;

const BodySchema = z.object({ comboId: z.number().int().positive() });

function parseRunId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function parseBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > BODY_CAP) {
    throw new Error('body_too_large');
  }
  return JSON.parse(text);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/bench/[runId]/pass2', method: 'POST' });

  const { runId: rawId } = await params;
  const runId = parseRunId(rawId);
  if (!runId) return jsonResponse({ error: 'invalid_run_id', requestId }, 400);

  let parsed: { comboId: number };
  try {
    const body = await parseBody(request);
    parsed = BodySchema.parse(body);
  } catch (err) {
    return jsonResponse(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'parse', requestId },
      400,
    );
  }

  try {
    const run = benchRunRepo().findById(runId);
    if (!run) return jsonResponse({ error: 'run_not_found', requestId }, 404);
    if (run.status !== 'complete') {
      return jsonResponse({ error: 'run_not_completed', status: run.status, requestId }, 409);
    }

    const combo = benchComboRepo().findById(parsed.comboId);
    if (!combo || combo.run_id !== runId) {
      return jsonResponse({ error: 'combo_not_found', requestId }, 404);
    }
    if (combo.pass2_completed_at !== null) {
      return jsonResponse({ error: 'already_verified', requestId }, 409);
    }

    const startedAt = Date.now();

    // 11-03 audit M4: pino enqueue audit row BEFORE async kickoff so the row
    // lands even if the runFullFileVerify promise dies after request returns.
    log.info(
      {
        audit: 'bench.pass2_enqueue',
        runId,
        comboId: parsed.comboId,
        fileId: run.fileIds[0],
        actor: auth.ok && auth.mode === 'authenticated' ? auth.username : 'disabled',
        startedAt,
      },
      'pass2 enqueued',
    );

    // Pre-flight the busy lock by calling cancelPass2 would be wrong; instead
    // start runFullFileVerify and catch synchronous pass2_busy. The orchestrator
    // throws synchronously when its lock is already held — that's how we surface
    // 409 before returning 202.
    try {
      void benchOrchestrator()
        .runFullFileVerify(runId, parsed.comboId)
        .catch((err: unknown) => {
          // Errors after lock-acquisition are emitted via SSE bench.pass2_failed.
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'pass2 background run errored',
          );
        });
    } catch (err) {
      if (err instanceof Error && (err as Error & { code?: string }).code === 'pass2_busy') {
        return jsonResponse({ error: 'pass2_busy', requestId }, 409);
      }
      throw err;
    }

    return jsonResponse({ comboId: parsed.comboId, startedAt, requestId }, 202);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      'pass2 POST: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/bench/[runId]/pass2', method: 'DELETE' });

  const { runId: rawId } = await params;
  const runId = parseRunId(rawId);
  if (!runId) return jsonResponse({ error: 'invalid_run_id', requestId }, 400);

  let parsed: { comboId: number };
  try {
    const body = await parseBody(request);
    parsed = BodySchema.parse(body);
  } catch (err) {
    return jsonResponse(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'parse', requestId },
      400,
    );
  }

  try {
    const combo = benchComboRepo().findById(parsed.comboId);
    if (!combo || combo.run_id !== runId) {
      return jsonResponse({ error: 'combo_not_found', requestId }, 404);
    }

    try {
      benchOrchestrator().cancelPass2(runId, parsed.comboId);
    } catch (err) {
      if (err instanceof Error && (err as Error & { code?: string }).code === 'not_running') {
        return jsonResponse({ error: 'not_running', requestId }, 409);
      }
      throw err;
    }

    const cancelledAt = Date.now();
    log.info(
      {
        audit: 'bench.pass2_cancel',
        runId,
        comboId: parsed.comboId,
        actor: auth.ok && auth.mode === 'authenticated' ? auth.username : 'disabled',
        cancelledAt,
      },
      'pass2 cancelled by operator',
    );
    return jsonResponse({ comboId: parsed.comboId, cancelledAt, requestId }, 202);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      'pass2 DELETE: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
