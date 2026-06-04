// 05-03 T1.H: GET /api/logs/[jobId]/download — full plaintext download.
// Phase 5 Plan 05-03 (Logs Viewer) — AC-4 + audit M1, S4, S9.
//
// Security:
//   - requireAuth() FIRST (carry-forward 05-01 AC-10)
//   - jobId regex `^[a-zA-Z0-9_-]{1,64}$`
//   - audit M1: path.resolve + prefix-startsWith (defense-in-depth)
//
// Response invariants:
//   - 200 text/plain; charset=utf-8
//   - audit S9: BOTH `filename="..."` AND `filename*=UTF-8''<percent-encoded>` (RFC 5987)
//   - audit S4: pino info `log_download_attempt` BEFORE body stream starts
//   - body streamed via Response(ReadableStream) — never load >50 MB into memory

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { authGuard, requireAuth, withRenewCookie } from '@/src/lib/auth/require-auth';
import { extractIp, hashIp } from '@/src/lib/auth/rate-limit';
import { getCachedAuthSetting } from '@/src/lib/auth/settings-cache';
import { settingRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function safeJobLogPath(logsDir: string, jobId: string): string | null {
  const candidate = path.resolve(path.join(logsDir, `${jobId}.log`));
  const prefix = logsDir + path.sep;
  if (!candidate.startsWith(prefix)) return null;
  return candidate;
}

/**
 * audit S9: build RFC 5987-compliant Content-Disposition with BOTH legacy
 * `filename="..."` (ASCII) AND `filename*=UTF-8''<percent-encoded>`. JOB_ID_REGEX
 * only allows ASCII today, but standards-compliance is correct now to defend
 * against future regex-loosening that introduces non-ASCII names.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const auth = await requireAuth(request);
  const denied = authGuard(auth);
  if (denied) return denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/logs/[jobId]/download' });

  const { jobId } = await context.params;
  if (!JOB_ID_REGEX.test(jobId)) {
    return jsonResponse({ error_code: 'invalid_job_id', requestId }, 400);
  }

  const cachePoolPath = settingRepo().get('cache_pool_path') ?? '';
  if (!cachePoolPath) {
    return jsonResponse({ error_code: 'log_not_found', requestId }, 404);
  }
  const logsDir = path.resolve(cachePoolPath, 'logs');
  const filePath = safeJobLogPath(logsDir, jobId);
  if (!filePath) {
    log.warn({ jobId }, 'path containment check failed');
    return jsonResponse({ error_code: 'invalid_path', requestId }, 400);
  }

  let stat: import('fs').Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return jsonResponse({ error_code: 'log_not_found', requestId }, 404);
  }

  // audit S4: SOC 2 evidence — emit BEFORE response body starts streaming.
  const trustXff = getCachedAuthSetting('auth_trust_proxy_xff') === 'true';
  const ipHash = hashIp(extractIp(request, trustXff));
  log.info(
    {
      event: 'log_download_attempt',
      jobId,
      requestId,
      username: auth.ok ? auth.username : null,
      ip_hash: ipHash,
      fileSize: stat.size,
    },
    'log download started',
  );

  // Stream the file via a ReadableStream backed by fs.createReadStream — never
  // load the whole file into memory.
  const nodeStream = fs.createReadStream(filePath);
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk) => {
        controller.enqueue(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
      });
      nodeStream.on('end', () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      nodeStream.on('error', (err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'download stream errored',
        );
        try {
          controller.error(err);
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  const filename = `${jobId}.log`;
  const response = new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(stat.size),
      'Content-Disposition': contentDisposition(filename),
      'Cache-Control': 'no-store',
      'X-Request-Id': requestId,
    },
  });
  return withRenewCookie(response, auth);
}
