import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb, settingRepo, userRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { clampBcryptCost, hashPassword, validatePasswordComplexity } from '@/src/lib/auth/password';
import { invalidateAuthSettingsCache } from '@/src/lib/auth/settings-cache';
import { isUniqueConstraintError } from '@/src/lib/db/repos/user';

// 05-01 Task 2 — POST /api/auth/setup. First-time single-user setup.
//
// audit M3: setup TOCTOU race fix via db.transaction(). Re-check inside TX +
//   SQLITE_CONSTRAINT_UNIQUE → 409 setup_already_completed.
// audit S1: pepper generated atomically with session_secret in same TX.
// audit S2: validatePasswordComplexity rejects all-numeric / single-class.
// audit S8: setup runs in any auth_enabled state — gated only on auth_setup_completed.
// audit S13: bcrypt_cost setting clamped to [10, 14] at hashPassword call site.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BODY_CAP_BYTES = 16 * 1024;

const bodySchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(12).max(256),
});

function jsonResponse(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((v, k) => headers.append(k, v));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export async function POST(req: Request): Promise<Response> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/auth/setup' });

  // 415 Content-Type gate.
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) {
    return jsonResponse({ error_code: 'unsupported_media_type', requestId }, 415);
  }

  // 16KB body cap.
  const contentLengthRaw = req.headers.get('content-length');
  const contentLength = contentLengthRaw ? parseInt(contentLengthRaw, 10) : 0;
  if (Number.isFinite(contentLength) && contentLength > BODY_CAP_BYTES) {
    log.warn(
      { event: 'auth_setup_body_too_large', contentLength, cap: BODY_CAP_BYTES },
      'POST body exceeds size cap',
    );
    return jsonResponse({ error_code: 'body_too_large', requestId }, 413);
  }

  let body: unknown;
  try {
    const text = await req.text();
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    return jsonResponse({ error_code: 'invalid_json', requestId }, 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const usernameIssue = issues.find((i) => i.path[0] === 'username');
    const passwordIssue = issues.find((i) => i.path[0] === 'password');
    let error_code: string = 'invalid_body';
    if (usernameIssue) {
      if (usernameIssue.code === 'too_small') error_code = 'username_too_short';
      else if (usernameIssue.code === 'too_big') error_code = 'username_too_long';
      else error_code = 'username_invalid_chars';
    } else if (passwordIssue) {
      if (passwordIssue.code === 'too_small') error_code = 'password_too_short';
      else if (passwordIssue.code === 'too_big') error_code = 'password_too_long';
    }
    return jsonResponse({ error_code, details: issues, requestId }, 400);
  }

  const { username, password } = parsed.data;

  // audit S2: complexity rules beyond min length.
  const complexity = validatePasswordComplexity(password);
  if (!complexity.ok) {
    return jsonResponse(
      { error_code: complexity.error_code ?? 'password_too_weak', requestId },
      400,
    );
  }

  // Two-gate setup detection (defense-in-depth).
  const settings = settingRepo();
  const setupCompleted = settings.get('auth_setup_completed') === 'true';
  const userCount = userRepo().count();
  if (setupCompleted || userCount > 0) {
    return jsonResponse({ error_code: 'setup_already_completed', requestId }, 409);
  }

  // Generate pepper + secret BEFORE the TX (crypto.randomBytes is sync but
  // bcryptjs.hash is async; better-sqlite3 transactions can't span an `await`).
  const pepper = crypto.randomBytes(32).toString('hex');
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const cost = clampBcryptCost(settings.get('bcrypt_cost'));

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password, pepper, cost);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      'auth setup: hashPassword threw',
    );
    return jsonResponse({ error_code: 'internal_error', requestId }, 500);
  }

  // audit M3: wrap synchronous writes in db.transaction().
  // Re-check the gate INSIDE the TX (concurrent winner may have set the flag
  // between the optimistic check and this point).
  const db = getDb();
  let createdUserId: number;
  try {
    const tx = db.transaction(() => {
      const recheck = settings.get('auth_setup_completed') === 'true';
      if (recheck || userRepo().count() > 0) {
        const e = new Error('setup_race_lost') as Error & { code: string };
        e.code = 'SETUP_RACE_LOST';
        throw e;
      }
      settings.set('password_pepper', pepper);
      const row = userRepo().create({ username, password_hash: passwordHash });
      settings.set('session_secret', sessionSecret);
      settings.set('auth_setup_completed', 'true');
      createdUserId = row.id;
    });
    tx();
  } catch (err) {
    invalidateAuthSettingsCache();
    if ((err as { code?: string }).code === 'SETUP_RACE_LOST' || isUniqueConstraintError(err)) {
      return jsonResponse({ error_code: 'setup_already_completed', requestId }, 409);
    }
    log.error({ err: err instanceof Error ? err.stack : String(err) }, 'auth setup: TX threw');
    return jsonResponse({ error_code: 'internal_error', requestId }, 500);
  }
  invalidateAuthSettingsCache();

  log.info(
    { event: 'auth_setup_completed_first_time', username },
    'first-time auth setup completed',
  );

  return jsonResponse({ userId: createdUserId!, username, requestId }, 201);
}
