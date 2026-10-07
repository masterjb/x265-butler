import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { fileRepo, jobRepo, settingRepo, shareRepo } from '@/src/lib/db';
import { runScan } from '@/src/lib/scan/orchestrator';
import { logger } from '@/src/lib/logger';
import { engineEvents } from '@/src/lib/encode';
import { queueCountsSnapshot } from '@/src/lib/queue/counts';
import { isAutoEncodeEnabled } from '@/src/lib/queue/auto-encode';
import { createScanEnqueueHook } from '@/src/lib/queue/scan-enqueue';

import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
// Shared single-flight gate, also used by /api/scan/estimate so
// operator-triggered parallel scan + estimate requests cannot corrupt
// walker counters. Identical 409 error-code on both routes.
import { acquireScanLock, releaseScanLock } from '@/src/lib/scan/scan-progress-flag';
// better-sqlite3 + child_process require Node APIs, NOT Edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    rootPath: z.string().optional(),
    minSizeMb: z.number().int().nonnegative().optional(),
    extensions: z.array(z.string()).min(1).optional(),
  })
  .strict();

// Every response (success + error) carries no-store + JSON.

export async function POST(request: Request): Promise<Response> {
  // requireAuth gate.
  const { denied } = await gateAuth(request);
  if (denied) return denied;

  // Correlation id surfaces in every response and log line.
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/scan' });

  // Strict Content-Type — reject non-application/json BEFORE body parse.
  // CSRF mitigation (forms cannot set this header).
  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type, rejecting with 415');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  // Shared lock. acquireScanLock is the atomic check+set.
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

    // scanRoot/minSizeMb/maxDepth defaults sourced
    // from shareRepo().listAll()[0] when present; falls back to legacy
    // hardcoded `/media` only when shares table is genuinely empty. The
    // per-share dispatch loop in src/lib/scan/orchestrator.ts iterates
    // shareRepo independently — these values feed the body.rootPath
    // path-traversal guard + observability `effectiveFilters` echo only.
    // settings.* still read for encoder (NOT for the 4 retired single-share
    // keys). The auto-enqueue gate below reads the auto_encode master switch;
    // the old after-scan key is retired (see app/api/settings/route.ts).
    const settings = settingRepo().getAll();
    const sharesForDefaults = shareRepo().listAll();
    const firstShare = sharesForDefaults[0];
    const scanRoot = firstShare?.path ?? '/media';

    // Path-traversal guard via path.resolve before prefix check.
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

    // Filter defaults sourced from shareRepo[0].
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

    // Echo the effective filters in the response for auditor
    // defensibility — caller sees exactly what ran without inferring from settings.
    const effectiveFilters = {
      resolvedRootPath: resolvedRoot,
      extensions,
      minSizeMb,
      maxDepth,
    };
    log.info({ effectiveFilters }, 'scan starting');

    // Inform audit trail when body.rootPath is silently ignored
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

    // Record enqueue-time intent from settings.encoder instead of hardcoding
    // 'libx265'. Orchestrator overwrites this with the RESOLVED encoder via
    // JobRepo.setEncoder BEFORE any ffmpeg spawn (orchestrator dispatch path).
    const encoderForEnqueue = settings.encoder ?? 'auto';
    const emitQueueUpdated = (): void => {
      try {
        // One listActive() pass yields all three numbers (queue/counts).
        const counts = queueCountsSnapshot(jobRepo());
        // paused is always false on this event (kept on the wire for back-compat).
        engineEvents.emit({
          type: 'queue.updated',
          activeJobs: counts.activeJobs,
          pendingJobs: counts.pendingJobs,
          encodingJobs: counts.encodingJobs,
          paused: false,
        });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'auto_enqueue: queue.updated emit failed',
        );
      }
    };
    // New files are queued while the scan runs; the sweep after the scan stays
    // as the net for the backlog and anything the hook skipped or capped.
    const scanEnqueue = createScanEnqueueHook({
      settingRepo,
      fileRepo,
      jobRepo,
      encoder: () => encoderForEnqueue,
      emitQueueUpdated,
      log,
    });

    const result = await runScan(
      {
        rootPath: resolvedRoot,
        extensions,
        minSizeMb,
        maxDepth,
      },
      fileRepo(),
      log, // requestId correlation
      scanEnqueue,
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

    const enqueuedDuringScan = scanEnqueue.enqueuedCount();
    let autoEnqueued = enqueuedDuringScan;
    if (isAutoEncodeEnabled(settingRepo())) {
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
      let enqueuedAfterScan = 0;
      for (const file of pending.rows) {
        try {
          // crf=null at auto-enqueue — orchestrator dispatch
          // resolves encoder + writes CRF via setCrf before spawn.
          const row = jRepo.enqueue(file.id, encoderForEnqueue, file.version, null);
          if (row) enqueuedAfterScan += 1;
        } catch (err) {
          log.warn(
            { fileId: file.id, err: err instanceof Error ? err.message : String(err) },
            'auto_enqueue: enqueue threw — skipping file',
          );
        }
      }
      autoEnqueued += enqueuedAfterScan;
      if (enqueuedAfterScan > 0) emitQueueUpdated();
      log.info(
        {
          action: 'auto_enqueue',
          enqueued: autoEnqueued,
          enqueuedDuringScan,
          cappedDuringScan: scanEnqueue.cappedCount(),
          totalPending: pending.rows.length,
        },
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
