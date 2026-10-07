// GET /api/bench/recommendation — surface top-1-Quality CRF per encoder
// from the latest completed bench_run. Consumed by the Apply-from-Bench button
// (components/settings/apply-from-bench-button.tsx).
//
// Optional ?runId + ?mode query params (operator-control).
// Default behavior (both omitted): the latest completed run.
//
// Contract:
//   200 { runId, completedAt: non-null number, recommendations, requestId }
//   404 { error: 'no_completed_bench_run', requestId }   (no ?runId, no complete run)
//   404 { error: 'run_not_found', requestId }            (?runId given, row absent)
//   400 { error: 'run_not_complete', requestId }         (?runId given, status != complete)
//   400 { error: 'invalid_query', details, requestId }   (zod-issue forwarding)
//   401 { error_code: 'auth_required' }                  (shared requireAuth/authGuard)
//   500 { error: 'internal_error', requestId }
//
// Guarantees:
//   - requestId in EVERY response body (200/404/500) + log child — SOC2 reconstruction
//   - try/catch wrapper + structured error-log w/ stack — sibling-route parity
//   - tests: tests/api/bench-recommendation.test.ts
//   - findLatestComplete() single-row DB read — no bounded-scan cliff
//   - unknown-encoder log uses encoders plural matching helper return
//   - divergence sentinel surfaced as warn-log (data-integrity violation)
//   - completed_at narrowed from number|null → number defensively
//   - zod-issue forwarding for ?runId/?mode (sibling /api/bench parity)

import crypto from 'node:crypto';
import { z } from 'zod';
import { benchRunRepo, benchComboRepo } from '@/src/lib/db';
import { selectRecommendationsByEncoder } from '@/src/lib/bench';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { withRenewCookie } from '@/src/lib/auth/require-auth';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z
  .object({
    runId: z.coerce.number().int().positive().optional(),
    mode: z.enum(['quality', 'balanced', 'size']).optional().default('quality'),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/bench/recommendation', method: 'GET' });

  try {
    const url = new URL(request.url);
    const raw: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      if (v !== '') raw[k] = v;
    });
    const parsed = querySchema.safeParse(raw);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'invalid query');
      return withRenewCookie(
        jsonResponse({ error: 'invalid_query', details: parsed.error.issues, requestId }, 400),
        auth,
      );
    }

    const { runId: requestedRunId, mode } = parsed.data;

    let resolvedRun;
    if (requestedRunId != null) {
      const row = benchRunRepo().findById(requestedRunId);
      if (!row) {
        log.info({ event: 'recommendation_run_not_found', runId: requestedRunId });
        return withRenewCookie(jsonResponse({ error: 'run_not_found', requestId }, 404), auth);
      }
      if (row.status !== 'complete') {
        log.info({
          event: 'recommendation_run_not_complete',
          runId: requestedRunId,
          status: row.status,
        });
        return withRenewCookie(jsonResponse({ error: 'run_not_complete', requestId }, 400), auth);
      }
      resolvedRun = row;
    } else {
      const latestComplete = benchRunRepo().findLatestComplete();
      if (!latestComplete) {
        log.info({ event: 'recommendation_no_completed_run' });
        return withRenewCookie(
          jsonResponse({ error: 'no_completed_bench_run', requestId }, 404),
          auth,
        );
      }
      resolvedRun = latestComplete;
    }

    if (resolvedRun.completed_at === null) {
      log.warn({
        event: 'recommendation_integrity_violation',
        reason: 'status_complete_but_completed_at_null',
        runId: resolvedRun.id,
      });
      return withRenewCookie(jsonResponse({ error: 'internal_error', requestId }, 500), auth);
    }
    const completedAt: number = resolvedRun.completed_at;

    const combos = benchComboRepo().listByRun(resolvedRun.id);
    const { recommendations, unknownEncoders, divergences } = selectRecommendationsByEncoder(
      combos,
      mode,
    );

    if (unknownEncoders.length > 0) {
      log.debug({
        event: 'recommendation_unknown_encoder',
        encoders: unknownEncoders,
        comboCount: combos.length,
      });
    }

    if (divergences.length > 0) {
      log.warn({
        event: 'recommendation_duplicate_divergence',
        divergences,
        runId: resolvedRun.id,
      });
    }

    log.info({
      event: 'recommendation_served',
      runId: resolvedRun.id,
      mode,
      recommendationCount: Object.keys(recommendations).length,
    });

    return withRenewCookie(
      jsonResponse(
        {
          runId: resolvedRun.id,
          completedAt,
          recommendations,
          requestId,
        },
        200,
      ),
      auth,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/bench/recommendation GET: unexpected error',
    );
    return withRenewCookie(jsonResponse({ error: 'internal_error', requestId }, 500), auth);
  }
}
