import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { fileRepo, jobRepo, settingRepo, shareRepo } from '@/src/lib/db';
import { runScan } from '@/src/lib/scan/orchestrator';
import { logger } from '@/src/lib/logger';
import { engineEvents } from '@/src/lib/encode';

import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
// 13-04 T3a: shared single-flight gate, also used by /api/scan/estimate so
// operator-triggered parallel scan + estimate requests cannot corrupt
// walker counters. Identical 409 error-code on both routes.
import { acquireScanLock, releaseScanLock } from '@/src/lib/scan/scan-progress-flag';
// 01-03: better-sqlite3 + child_process require Node APIs, NOT Edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    rootPath: z.string().optional(),
    minSizeMb: z.number().int().nonnegative().optional(),
    extensions: z.array(z.string()).min(1).optional(),
  })
  .strict();

// audit-added S6: every response (success + error) carries no-store + JSON.
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
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  // audit-added S7: correlation id surfaces in every response and log line.
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/scan' });

  // audit-added M5: strict Content-Type — reject non-application/json BEFORE
  // body parse. CSRF mitigation pre-Phase-5 (no auth yet).
  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type, rejecting with 415');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  // 13-04 T3a: shared lock. acquireScanLock is the atomic check+set.
  if (!acquireScanLock()) {
    log.warn('scan already in progress, rejecting with 409');
    return jsonResponse({ error: 'scan_in_progress', requestId }, 409);
  }

  try {
    // Parse body — empty body becomes {}.
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

    // 14-04 (Plan 14-04 Task 7): scanRoot/minSizeMb/maxDepth defaults sourced
    // from shareRepo().listAll()[0] when present; falls back to legacy
    // hardcoded `/media` only when shares table is genuinely empty. The
    // per-share dispatch loop in src/lib/scan/orchestrator.ts (14-02) iterates
    // shareRepo independently — these values feed the body.rootPath
    // path-traversal guard + observability `effectiveFilters` echo only.
    // settings.* still read for auto_enqueue_after_scan + encoder (NOT for
    // the 4 retired single-share keys).
    const settings = settingRepo().getAll();
    const sharesForDefaults = shareRepo().listAll();
    const firstShare = sharesForDefaults[0];
    const scanRoot = firstShare?.path ?? '/media';

    // audit-added M3: path-traversal guard via path.resolve before prefix check.
    // Without resolve, '/media/../etc' would slip past the startsWith check.
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

    // 14-04 (Plan 14-04 Task 7): filter defaults sourced from shareRepo[0].
    // body.* overrides remain authoritative for explicit operator-supplied
    // override callers. The per-share dispatch loop in orchestrator owns
    // per-share filters; these are observability defaults only.
    const extensions =
      body.extensions ??
      (firstShare?.extensions_csv ?? 'mp4,mkv,avi,mov,m4v,webm,ts,m2ts,wmv')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const minSizeMb = body.minSizeMb ?? firstShare?.min_size_mb ?? 50;
    const maxDepth = firstShare?.max_depth ?? 12;

    // audit-added S4: echo the effective filters in the response for auditor
    // defensibility — caller sees exactly what ran without inferring from settings.
    const effectiveFilters = {
      resolvedRootPath: resolvedRoot,
      extensions,
      minSizeMb,
      maxDepth,
    };
    log.info({ effectiveFilters }, 'scan starting');

    // audit-fix:SR2 — inform audit trail when body.rootPath is silently ignored
    // by multi-share dispatch. Caller-supplied override passed path-guard, but
    // orchestrator iterates shareRepo (opts.rootPath dead in multi-share mode).
    // shareRepo read at route-level here is the ONLY route-level concession;
    // count-only, no business logic.
    if (body.rootPath !== undefined) {
      const shareCount = shareRepo().listAll().length;
      if (shareCount > 0) {
        log.warn(
          {
            action: 'scan_rootpath_override_ignored',
            body_rootPath: body.rootPath,
            mode: 'multi-share',
            shareCount,
          },
          'body.rootPath override ignored — multi-share dispatch overrides opts.rootPath',
        );
      }
    }

    const result = await runScan(
      {
        rootPath: resolvedRoot,
        extensions,
        minSizeMb,
        maxDepth,
      },
      fileRepo(),
      log, // audit-fix:SR3 requestId correlation
    );
    log.info(
      {
        filesScanned: result.filesScanned,
        filesAdded: result.filesAdded,
        filesUpdated: result.filesUpdated,
        filesUnchanged: result.filesUnchanged,
        filesFailed: result.filesFailed,
        filesVanished: result.filesVanished,
        byShareCount: result.byShare?.length ?? 0,
        durationMs: result.durationMs,
      },
      'scan complete',
    );

    let autoEnqueued = 0;
    if (settings.auto_enqueue_after_scan === 'true') {
      const fRepo = fileRepo();
      const jRepo = jobRepo();
      const pending = fRepo.listPaginated({
        page: 1,
        size: 1000,
        sort: 'scanned',
        dir: 'desc',
        q: undefined,
        status: 'pending',
      });
      // audit-added M4 downstream (Plan 03-01): record enqueue-time intent
      // from settings.encoder instead of hardcoding 'libx265'. Orchestrator
      // overwrites this with the RESOLVED encoder via JobRepo.setEncoder
      // BEFORE any ffmpeg spawn (orchestrator dispatch path).
      const encoderForEnqueue = settings.encoder ?? 'auto';
      for (const file of pending.rows) {
        try {
          // 05-08 B4: crf=null at auto-enqueue — orchestrator dispatch
          // resolves encoder + writes CRF via setCrf before spawn.
          const row = jRepo.enqueue(file.id, encoderForEnqueue, file.version, null);
          if (row) autoEnqueued += 1;
        } catch (err) {
          log.warn(
            { fileId: file.id, err: err instanceof Error ? err.message : String(err) },
            'auto_enqueue: enqueue threw — skipping file',
          );
        }
      }
      if (autoEnqueued > 0) {
        try {
          const activeJobs = jRepo.listActive().length;
          const pendingJobs = jRepo.countByStatus('queued');
          // 05-09 Decision §2: Pause retired — paused permanently false on the wire.
          engineEvents.emit({
            type: 'queue.updated',
            activeJobs,
            pendingJobs,
            paused: false,
          });
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'auto_enqueue: queue.updated emit failed',
          );
        }
      }
      log.info(
        { action: 'auto_enqueue', enqueued: autoEnqueued, totalPending: pending.rows.length },
        'auto_enqueue complete',
      );
    }

    return jsonResponse({ ...result, requestId, effectiveFilters, autoEnqueued }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/scan: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  } finally {
    releaseScanLock();
  }
}
