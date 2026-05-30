// 11-01: Bench API — POST /api/bench (enqueue run), GET /api/bench (list recent)
import crypto from 'node:crypto';
import { z } from 'zod';
import { benchRunRepo } from '@/src/lib/db';
import { benchOrchestrator } from '@/src/lib/bench/orchestrator';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const enqueueSchema = z
  .object({
    mode: z.enum(['native-sweep', 'vmaf-anchored']),
    fileIds: z.array(z.number().int().positive()).min(1).max(50),
    matrix: z.record(z.string(), z.unknown()),
    sampleCount: z.number().int().min(1).max(10).optional(),
    sampleDurationSeconds: z.number().int().min(5).max(60).optional(),
    vmafModel: z.string().max(64).optional(),
  })
  .strict();

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).default(20),
    offset: z.coerce.number().int().nonnegative().default(0),
    // 12-04 audit M1: optional status filter (RunModePicker consumes completed-only)
    status: z.enum(['pending', 'running', 'complete', 'failed', 'cancelled']).optional(),
  })
  .strict();

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/bench', method: 'POST' });

  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  try {
    let bodyJson: unknown = {};
    const text = await request.text();
    if (text.trim().length > 0) {
      try {
        bodyJson = JSON.parse(text);
      } catch {
        return jsonResponse({ error: 'invalid_body', details: 'malformed JSON', requestId }, 400);
      }
    }

    const parsed = enqueueSchema.safeParse(bodyJson);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'body schema validation failed');
      return jsonResponse({ error: 'invalid_body', details: parsed.error.issues, requestId }, 400);
    }

    const { runId } = await benchOrchestrator().enqueueRun({
      mode: parsed.data.mode,
      fileIds: parsed.data.fileIds,
      matrix: parsed.data.matrix as never,
      sampleCount: parsed.data.sampleCount,
      sampleDurationSec: parsed.data.sampleDurationSeconds,
      vmafModel: parsed.data.vmafModel,
    });

    benchOrchestrator()
      .executeNextPending()
      .catch((err) =>
        log.error(
          { err: err instanceof Error ? err.stack : String(err) },
          'bench executeNextPending failed',
        ),
      );

    log.info({ action: 'bench_enqueue', runId }, 'bench run enqueued');
    return jsonResponse({ runId, requestId }, 201);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/bench POST: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}

export async function GET(request: Request): Promise<Response> {
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/bench', method: 'GET' });

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

    const { limit, offset, status } = parsed.data;
    const runs = benchRunRepo().listRecent(limit, offset, status);
    return jsonResponse({ runs, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/bench GET: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
