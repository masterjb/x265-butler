// Phase 13 Plan 13-04 Task 3c — POST /api/scan/estimate
//
// Read-only Dry-Run / Estimate-Mode endpoint. Mirrors /api/scan envelope
// (auth + zod body + path-traversal + 415/409/400/404/422/500 error-codes
// + requestId + no-store + JSON content-type) but writes ZERO to DB,
// ZERO sidecars, ZERO queue. Aggregates per-file ffprobe + savings
// projection over the same walker + skip pipeline as the real scan.
//
// Audit notes (13-04 AUDIT 2026-05-14):
//   M4+M5 — encoder resolution. Mirror /api/scan's `settings.encoder ?? 'auto'`
//           default. When 'auto' (or unknown), call detectEncoders() and use
//           activeFromAuto. On detection-reject, fallback to 'libx265' and
//           emit warn `action: 'estimate_encoder_fallback'`. Without this,
//           `c.encoder === 'auto'` matches ZERO bench combos and silently
//           regresses bench-augmented path for unconfigured operators.
//   SR1 — SOC2 audit-trail. estimate_started log BEFORE engine run so a
//         mid-request crash leaves a forensic anchor; estimate_complete
//         log carries the full enriched field-list (rootPath, file counts,
//         skip-buckets, savings.{source,projectedBytes,runId}, encodeTime
//         {seconds,source}, durationMs, truncated) for parity with /api/scan.
//   SR4 — AbortSignal threading. Engine breaks walker loop on
//         request.signal.aborted within ≤1 file-iteration so the shared
//         scan-lock releases promptly via the finally block.
//   SR5 — truncated flag echoed in response when ESTIMATE_MAX_FILES cap hit.

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import {
  fileRepo,
  blocklistRepo,
  benchRunRepo,
  benchComboRepo,
  settingRepo,
  shareRepo,
} from '@/src/lib/db';
import { runEstimate } from '@/src/lib/scan/estimate-engine';
import { detectEncoders } from '@/src/lib/encode/detection';
import { ENCODER_IDS, type EncoderId } from '@/src/lib/encode/profiles';
import { logger } from '@/src/lib/logger';
import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
import { acquireScanLock, releaseScanLock } from '@/src/lib/scan/scan-progress-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    rootPath: z.string().optional(),
    minSizeMb: z.number().int().nonnegative().optional(),
    extensions: z.array(z.string()).min(1).optional(),
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

function isEncoderId(s: string): s is EncoderId {
  return (ENCODER_IDS as readonly string[]).includes(s);
}

type RouteLogger = { warn: (obj: unknown, msg: string) => void };

async function resolveEncoder(raw: string | undefined, log: RouteLogger): Promise<EncoderId> {
  if (raw && raw !== 'auto' && isEncoderId(raw)) return raw;
  // 'auto' or invalid → probe.
  try {
    const detection = await detectEncoders();
    return detection.activeFromAuto;
  } catch (err) {
    log.warn(
      {
        action: 'estimate_encoder_fallback',
        err: err instanceof Error ? err.message : String(err),
      },
      'estimate: detectEncoders rejected — falling back to libx265',
    );
    return 'libx265';
  }
}

export async function POST(request: Request): Promise<Response> {
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/scan/estimate' });

  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type, rejecting with 415');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  if (!acquireScanLock()) {
    log.warn('scan or estimate already in progress, rejecting with 409');
    return jsonResponse({ error: 'scan_in_progress', requestId }, 409);
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

    const parsed = bodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'body schema validation failed');
      return jsonResponse({ error: 'invalid_body', details: parsed.error.issues, requestId }, 400);
    }
    const body = parsed.data;

    // 14-04 (Plan 14-04 Task 7): scanRoot + filter defaults sourced from
    // shareRepo().listAll()[0] when present; body.* overrides remain
    // authoritative. settings.encoder still read for resolveEncoder.
    const settings = settingRepo().getAll();
    const firstShare = shareRepo().listAll()[0];
    const scanRoot = firstShare?.path ?? '/media';

    const rootPathInput = body.rootPath ?? scanRoot;
    if (!path.isAbsolute(rootPathInput)) {
      log.warn({ rootPath: rootPathInput }, 'rootPath not absolute');
      return jsonResponse({ error: 'root_outside_scope', requestId }, 400);
    }
    const resolvedRoot = path.resolve(rootPathInput);
    if (resolvedRoot !== scanRoot && !resolvedRoot.startsWith(scanRoot + path.sep)) {
      log.warn({ resolvedRoot, scanRoot }, 'rootPath escapes scan_root');
      return jsonResponse({ error: 'root_outside_scope', requestId }, 400);
    }

    let stat;
    try {
      stat = await fs.stat(resolvedRoot);
    } catch {
      return jsonResponse({ error: 'root_not_found', requestId }, 404);
    }
    if (!stat.isDirectory()) {
      return jsonResponse({ error: 'root_not_directory', requestId }, 422);
    }

    const extensions =
      body.extensions ??
      (firstShare?.extensions_csv ?? 'mp4,mkv,avi,mov,m4v,webm,ts,m2ts,wmv')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const minSizeMb = body.minSizeMb ?? firstShare?.min_size_mb ?? 50;
    const maxDepth = firstShare?.max_depth ?? 12;

    // M4+M5 — resolve to a concrete EncoderId BEFORE engine runs so
    // bench-combo filter + naive-table lookup both see a typed value.
    const resolvedEncoder = await resolveEncoder(settings.encoder, log);

    const effectiveFilters = {
      resolvedRootPath: resolvedRoot,
      extensions,
      minSizeMb,
      maxDepth,
      encoder: resolvedEncoder,
    };

    // SR1 — log BEFORE engine starts so a crash mid-walk still leaves a trail.
    log.info(
      { action: 'estimate_started', rootPath: resolvedRoot, encoder: resolvedEncoder },
      'estimate starting',
    );

    const result = await runEstimate(
      {
        rootPath: resolvedRoot,
        extensions,
        minSizeMb,
        maxDepth,
        encoder: resolvedEncoder,
        signal: request.signal,
      },
      {
        fileRepo: fileRepo(),
        blocklistRepo: blocklistRepo(),
        benchRunRepo: benchRunRepo(),
        benchComboRepo: benchComboRepo(),
      },
    );

    // SR1 — enriched complete-log for SOC2 forensic-reconstruction parity.
    log.info(
      {
        action: 'estimate_complete',
        rootPath: resolvedRoot,
        filesScanned: result.filesScanned,
        filesEligible: result.filesEligible,
        skipBuckets: result.skipBuckets,
        savings: {
          source: result.savings.source,
          projectedBytes: result.savings.projectedBytes,
          runId: result.savings.runId,
        },
        encodeTime: { seconds: result.encodeTime.seconds, source: result.encodeTime.source },
        durationMs: result.durationMs,
        truncated: result.truncated,
      },
      'estimate complete',
    );

    return jsonResponse(
      {
        filesScanned: result.filesScanned,
        filesEligible: result.filesEligible,
        skipBuckets: result.skipBuckets,
        savings: result.savings,
        encodeTime: result.encodeTime,
        effectiveFilters,
        durationMs: result.durationMs,
        truncated: result.truncated,
        requestId,
      },
      200,
    );
  } catch (err) {
    log.error(
      {
        action: 'estimate_failed',
        err: err instanceof Error ? err.stack : String(err),
      },
      '/api/scan/estimate: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  } finally {
    releaseScanLock();
  }
}
