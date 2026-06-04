import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb, settingRepo, shareRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';

import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
import { invalidateAuthSettingsCache } from '@/src/lib/auth/settings-cache';
import { clearAll as clearRateLimitBuckets } from '@/src/lib/auth/rate-limit';
// 16-01 audit-added M5: explicit notify-hook so the watcher lifecycle flips
// SYNCHRONOUSLY with the operator toggle (no polling, no cache delay). Gated
// strictly on key === 'autoScan.enabled'; non-autoScan settings unaffected.
import { restartWatcherService } from '@/src/lib/watch';
import { AUTOSCAN_RANGES } from '@/src/lib/watch/autoscan-ranges';
import { VALID_ENCODERS, VALID_PRESETS } from '@/components/bench/bench-constants';
import { PRESETS_BY_ENCODER } from '@/src/lib/encode/presets';
// 22-02 B (audit-revised M1): probeCachePoolWritable for PUT-side validation —
// NEVER mkdirs (idempotent endpoint contract); the mkdir+probe variant exported
// from staging is reserved for orchestrator dispatch self-heal.
import { probeCachePoolWritable, CachePoolUnavailableError } from '@/src/lib/encode/staging';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 05-02 audit S15: setting-change audit-trail events keyed to specific auth-keys.
const AUTH_KEY_EVENT: Record<string, string> = {
  auth_enabled: 'auth_enabled_changed',
  auth_trust_proxy_xff: 'auth_trust_proxy_xff_changed',
  bcrypt_cost: 'bcrypt_cost_changed',
  session_ttl_seconds: 'session_ttl_seconds_changed',
};
const AUTH_KEYS_REQUIRING_CACHE_INVALIDATION = new Set([
  'auth_enabled',
  'auth_trust_proxy_xff',
  'bcrypt_cost',
  'session_ttl_seconds',
]);

// 03-03 helper: positive-integer string in CRF range 0..51 (inclusive).
const crfString = z
  .string()
  .regex(/^\d+$/)
  .refine((v) => {
    const n = parseInt(v, 10);
    return n >= 0 && n <= 51;
  }, 'Must be 0-51');

// audit-added S13: defense-in-depth max-length on string values.
const settingsSchema = z
  .object({
    // 14-04 (Plan 14-04 Task 5): scan_root / extensions / min_size_mb /
    // max_depth retired — multi-share via /api/shares CRUD replaces them.
    // Stale clients posting these keys → zod strict mode rejects unknown-key (400).
    // 24-03 (F2, AC-7): allow an empty string to CLEAR the override (revert to
    // DC-B auto-resolve). Non-empty values keep the existing absolute-path
    // contract; the PUT handler treats '' specially (delete the row, skip the
    // writability gate). whitespace-only is normalized to '' by the refine.
    cache_pool_path: z
      .string()
      .max(4096)
      .refine((v) => v.trim() === '' || v.startsWith('/'), {
        message: 'cache_pool_path must be an absolute path or empty (to auto-detect)',
      })
      .optional(),
    language: z.enum(['en', 'de']).optional(),
    theme_override: z.enum(['system', 'light', 'dark']).optional(),
    auto_enqueue_after_scan: z.enum(['true', 'false']).optional(),
    // 03-03: encoder selection + concurrency override + per-encoder CRF defaults.
    // Operator-pinned-but-currently-unavailable encoders are ALLOWED here
    // (deliberate GPU-swap-anticipation use case); orchestrator handles the
    // fallback at dispatch via 03-01 ENCODER_IDS validation. Concurrency capped
    // at '1'..'8' per Discovery typical range; >8 deferred D7.
    encoder: z.enum(['auto', 'nvenc', 'qsv', 'vaapi', 'libx265']).optional(),
    concurrency: z.enum(['auto', '1', '2', '3', '4', '5', '6', '7', '8']).optional(),
    crf_libx265: crfString.optional(),
    crf_nvenc: crfString.optional(),
    crf_qsv: crfString.optional(),
    crf_vaapi: crfString.optional(),
    // 12-03: per-encoder preset override. Catalog source-of-truth is
    // PRESETS_BY_ENCODER (P10-W9). Out-of-Catalog values produce 400 via
    // .strict() — atomic-failure: ZERO db-writes before zod-parse succeeds.
    preset_libx265: z
      .enum(PRESETS_BY_ENCODER.libx265 as unknown as readonly [string, ...string[]])
      .optional(),
    preset_nvenc: z
      .enum(PRESETS_BY_ENCODER.nvenc as unknown as readonly [string, ...string[]])
      .optional(),
    preset_qsv: z
      .enum(PRESETS_BY_ENCODER.qsv as unknown as readonly [string, ...string[]])
      .optional(),
    preset_vaapi: z
      .enum(PRESETS_BY_ENCODER.vaapi as unknown as readonly [string, ...string[]])
      .optional(),
    // 05-13: 3-bucket verdict threshold separating done-smaller from
    // done-not-worth (DB stores TEXT — already seeded by 0002:59).
    // Range 0..50 inclusive; out-of-range → 400 invalid_value.
    min_savings_percent: z
      .string()
      .regex(/^\d+$/, { message: 'min_savings_percent_invalid_format' })
      .refine(
        (v) => {
          const n = parseInt(v, 10);
          return n >= 0 && n <= 50;
        },
        { message: 'min_savings_percent_out_of_range' },
      )
      .optional(),
    // 05-bonus: encode-behavior toggles.
    delete_original_after_encode: z.enum(['true', 'false']).optional(),
    // Suffix: free-form 1..32 chars; no path separators (/ \) and no ASCII
    // control chars. Sanitizer in src/lib/encode/staging.ts auto-appends
    // `.mkv` if the input doesn't already end with it. Examples accepted:
    //   `.x265.mkv` (legacy full-replacement style)
    //   `_x265`     (label style — sanitizer appends `.mkv`)
    //   `-h265`     (label style)
    output_suffix: z
      .string()
      .min(1)
      .max(32)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^/\\\x00-\x1F\x7F]+$/, 'Must not contain path separators or control chars')
      .optional(),
    // 05-14: operator-selectable output container. 'mkv' (default) preserves
    // pre-05-14 behavior; 'mp4' opt-in trades subtitle/exotic-audio coverage
    // for broader-device playback. WEBM intentionally excluded (Q2=A).
    // 05-15: 'match-source' DWIM directive — orchestrator dispatch resolves
    // per source extension (.mp4/.m4v → MP4; everything else → MKV) with
    // auto-fallback to MKV on MP4-incompat.
    // Case-sensitive enum; zod's `.strict()` mode rejects unknown keys.
    output_container: z.enum(['mkv', 'mp4', 'match-source']).optional(),
    // 26-02 (F5): output strategy. 'suffix' (default via code-fallback) =
    // byte-identical to pre-26-02 (sibling at output_suffix path). 'replace' =
    // in-place (original → trash, encoded output renamed into original basename).
    // Enum-only (no path validation, unlike sidecar_central_path). NO default-seed —
    // the orchestrator applies `?? 'suffix'` so a fresh/upgraded install is unchanged.
    output_mode: z.enum(['suffix', 'replace']).optional(),
    // 26-01 (F3): sidecar location mode. 'beside' (default via code-fallback)
    // = byte-identical to pre-26-01; 'off' suppresses the sidecar write; 'central'
    // writes one mirrored tree under sidecar_central_path. NO default-seed — the
    // orchestrator applies `?? 'beside'` so a fresh/upgraded install is unchanged.
    sidecar_mode: z.enum(['off', 'beside', 'central']).optional(),
    // 26-01 (F3): central-mode sidecar root. Reuses the cache_pool_path SHAPE
    // (.max(4096) + absolute) but CRITICALLY drops its `v.trim()===''` empty-is-auto
    // escape (audit-M2): an empty string is NOT undefined, so the orchestrator
    // code-fallback `?? '/config/...'` would NOT fire → path.join('', 'media/..')
    // yields a CWD-relative tree. `.min(1)` rejects empty → 400 (AC-4). System-root
    // targets are rejected via isForbiddenCachePath in the PUT handler (audit-S2).
    sidecar_central_path: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => v.startsWith('/'), {
        message: 'sidecar_central_path must be an absolute path starting with /',
      })
      .optional(),
    // 05-02 audit S15: 4 auth-related keys exposed via PUT. session_secret +
    // password_pepper + auth_setup_completed are write-only (server-managed).
    auth_enabled: z.enum(['true', 'false']).optional(),
    session_ttl_seconds: z
      .string()
      .regex(/^\d+$/)
      .refine((v) => {
        const n = parseInt(v, 10);
        return n >= 3600 && n <= 2592000;
      }, 'Must be 3600..2592000 (1h..30d)')
      .optional(),
    auth_trust_proxy_xff: z.enum(['true', 'false']).optional(),
    bcrypt_cost: z
      .string()
      .regex(/^\d+$/)
      .refine((v) => {
        const n = parseInt(v, 10);
        return n >= 10 && n <= 14;
      }, 'Must be 10..14')
      .optional(),
    // 11-02: bench defaults surfaced via Settings → Bench tab (3 of 6 keys seeded by 0019).
    bench_sample_count: z
      .string()
      .regex(/^\d+$/)
      .refine((v) => {
        const n = parseInt(v, 10);
        return n >= 1 && n <= 10;
      }, 'Must be 1..10')
      .optional(),
    bench_sample_duration_seconds: z
      .string()
      .regex(/^\d+$/)
      .refine((v) => {
        const n = parseInt(v, 10);
        return n >= 5 && n <= 60;
      }, 'Must be 5..60')
      .optional(),
    bench_vmaf_model: z.string().min(1).max(64).optional(),
    // 11-06: bench default-matrix surfaced via Settings → Bench tab (8 of 8 keys now exposed).
    // Validators enforce: ordered vmaf-thresholds, encoder/preset whitelist via bench-constants.ts,
    // CRF/QP ≤ 63, no duplicates.
    bench_default_mode: z.enum(['native-sweep', 'vmaf-anchored']).optional(),
    bench_vmaf_buckets: z
      .string()
      .transform((v) => v.replace(/\s+/g, ''))
      .pipe(
        z
          .string()
          .regex(/^(100|\d{1,2})(,(100|\d{1,2})){2}$/, {
            message: 'vmaf_buckets must be exactly 3 comma-separated values 0-100 (e.g. 95,92,88)',
          })
          .refine(
            (v) => {
              const nums = v.split(',').map(Number);
              return nums.every((n, i) => i === 0 || nums[i - 1] > n);
            },
            { message: 'vmaf_buckets must be strictly descending (e.g. 95,92,88)' },
          ),
      )
      .optional(),
    bench_default_encoders: z
      .string()
      .min(1)
      .refine(
        (v) => {
          const parts = v.split(',');
          if (parts.length !== new Set(parts).size) return false;
          return parts.every((p) => (VALID_ENCODERS as readonly string[]).includes(p));
        },
        { message: 'encoders: non-empty unique CSV of [' + VALID_ENCODERS.join(',') + ']' },
      )
      .optional(),
    bench_default_presets: z
      .string()
      .min(1)
      .max(128)
      .refine(
        (v) => {
          const parts = v.split(',');
          if (parts.length !== new Set(parts).size) return false;
          return parts.every((p) => (VALID_PRESETS as readonly string[]).includes(p));
        },
        { message: 'presets: non-empty unique CSV from x265-preset whitelist' },
      )
      .optional(),
    bench_default_native_values: z
      .string()
      .min(1)
      .max(64)
      .regex(/^\d{1,2}(,\d{1,2})*$/)
      .refine(
        (v) => {
          const nums = v.split(',').map(Number);
          if (nums.length !== new Set(nums).size) return false;
          return nums.every((n) => n >= 0 && n <= 63);
        },
        { message: 'native_values: non-empty unique CSV of ints in [0,63]' },
      )
      .optional(),
    // 16-01 (audit-added M5): operator-facing auto-scan toggle. Setting key
    // is dotted ('autoScan.enabled') to keep parity with the watcher-internal
    // siblings (autoScan.reconcileIntervalH / .stabilityThreshold / .batchWindow
    // / .pollInterval). zod accepts dotted keys via bracketed object-literal
    // notation. Post-write hook restarts the watcher AFTER the DB commit.
    'autoScan.enabled': z.enum(['true', 'false']).optional(),
    // 16-02: 4 operator-tunable advanced auto-scan keys. Range-spec sourced
    // from src/lib/watch/autoscan-ranges.ts (M4 SSoT — UI imports same module
    // for min/max attrs). All keys optional; M5-hook below restarts watcher
    // on any autoScan.* mutation.
    'autoScan.bootScanOnStart': z.enum(['true', 'false']).optional(),
    'autoScan.stabilityThreshold': z
      .string()
      .regex(/^\d+$/, { message: 'autoScan.stabilityThreshold_invalid_format' })
      .refine(
        (v) => {
          const n = parseInt(v, 10);
          return (
            n >= AUTOSCAN_RANGES.stabilityThreshold.min &&
            n <= AUTOSCAN_RANGES.stabilityThreshold.max
          );
        },
        { message: 'autoScan.stabilityThreshold_out_of_range' },
      )
      .optional(),
    'autoScan.batchWindow': z
      .string()
      .regex(/^\d+$/, { message: 'autoScan.batchWindow_invalid_format' })
      .refine(
        (v) => {
          const n = parseInt(v, 10);
          return n >= AUTOSCAN_RANGES.batchWindow.min && n <= AUTOSCAN_RANGES.batchWindow.max;
        },
        { message: 'autoScan.batchWindow_out_of_range' },
      )
      .optional(),
    'autoScan.reconcileIntervalH': z
      .string()
      .regex(/^\d+(\.\d+)?$/, { message: 'autoScan.reconcileIntervalH_invalid_format' })
      .refine(
        (v) => {
          const n = parseFloat(v);
          return (
            n >= AUTOSCAN_RANGES.reconcileIntervalH.min &&
            n <= AUTOSCAN_RANGES.reconcileIntervalH.max
          );
        },
        { message: 'autoScan.reconcileIntervalH_out_of_range' },
      )
      .optional(),
  })
  .strict();

// Reject cache_pool_path values that share a prefix with system roots commonly
// used for read-only or stateful directories — preserves operator from
// foot-shooting (e.g. /etc, /proc, / itself).
const FORBIDDEN_CACHE_PREFIXES = ['/etc', '/proc', '/sys', '/dev', '/boot'];
function isForbiddenCachePath(p: string): boolean {
  const norm = p.replace(/\/+$/, '');
  if (norm === '' || norm === '/') return true;
  return FORBIDDEN_CACHE_PREFIXES.some((bad) => norm === bad || norm.startsWith(`${bad}/`));
}

const bodySchema = z
  .object({
    settings: settingsSchema,
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

export async function GET(request: Request): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/settings' });
  try {
    const settings = settingRepo().getAll();
    return jsonResponse({ settings, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/settings GET: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}

export async function PUT(request: Request): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/settings' });

  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type, rejecting with 415');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  let bodyJson: unknown;
  try {
    const text = await request.text();
    bodyJson = text.trim().length > 0 ? JSON.parse(text) : {};
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'invalid JSON body');
    return jsonResponse({ error: 'invalid_body', details: 'malformed JSON', requestId }, 400);
  }

  const parsed = bodySchema.safeParse(bodyJson);
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues }, 'body schema validation failed');
    return jsonResponse({ error: 'invalid_body', details: parsed.error.issues, requestId }, 400);
  }
  const updates = parsed.data.settings;

  // 24-03 (F2, AC-7): normalize a whitespace-only override to the empty-string
  // clear sentinel so the truthy-guarded validation gates below (nested /
  // forbidden / writable) treat it as "unset" and skip. An empty cache_pool_path
  // means "delete the row, revert to DC-B auto-resolve".
  if (typeof updates.cache_pool_path === 'string' && updates.cache_pool_path.trim() === '') {
    updates.cache_pool_path = '';
  }
  const clearCachePath = updates.cache_pool_path === '';

  try {
    const repo = settingRepo();
    const db = getDb();

    // 16-01 audit-added M5: settings-PUT does NOT currently expose autoScan.enabled
    // through the zod schema (it lives outside the operator-facing settings UI shape,
    // set internally by service.ts default-seed + the AutoScan toggle below). When a
    // future surface extends the schema with this key, the post-write hook below
    // fires restartWatcherService() AFTER the DB commit — see audit-added block after
    // the writeAll transaction.

    // 14-04 (Plan 14-04 Task 5, audit-fix M4 / AC-24): cache_pool_path must
    // not equal nor be nested within any share.path. Rationale: cache pool
    // nested under a share-root would route encode outputs back into the scan
    // tree, where the next scan would re-detect them as new files. Check
    // against the MERGED state (current + updates) so a partial PUT can't
    // sneak past by changing only one of the two surfaces.
    const mergedSnapshot = repo.getAll();
    const effectiveCachePath = updates.cache_pool_path ?? mergedSnapshot.cache_pool_path;
    if (effectiveCachePath) {
      const normalizedCache = effectiveCachePath.replace(/\/+$/, '') || '/';
      const conflict = shareRepo()
        .listAll()
        .find((s) => {
          const sp = s.path === '/' ? '/' : s.path.replace(/\/+$/, '');
          return sp === normalizedCache || normalizedCache.startsWith(sp + '/') || sp === '/';
        });
      if (conflict) {
        log.warn(
          {
            action: 'settings_change_rejected',
            field: 'cache_pool_path',
            code: 'nested_under_share',
            cachePath: effectiveCachePath,
            requestId,
            conflictingShareName: conflict.name,
            conflictingSharePath: conflict.path,
          },
          'cache_pool_path collides with share — rejecting',
        );
        return jsonResponse(
          {
            error: 'validation_failed',
            fieldErrors: {
              cache_pool_path: 'cache_pool_path_nested_under_share',
            },
            conflictingShareName: conflict.name,
            requestId,
          },
          400,
        );
      }
    }
    if (updates.cache_pool_path && isForbiddenCachePath(updates.cache_pool_path)) {
      log.warn(
        {
          action: 'settings_change_rejected',
          field: 'cache_pool_path',
          code: 'forbidden_prefix',
          cachePath: updates.cache_pool_path,
          requestId,
        },
        'forbidden cache_pool_path prefix',
      );
      return jsonResponse({ error: 'forbidden_cache_path', requestId }, 400);
    }

    // 26-01 (F3, audit-S2): central writes a real on-disk tree → same foot-gun
    // surface as cache_pool_path. Reuse isForbiddenCachePath (do NOT duplicate the
    // prefix list) so /, /etc, /proc, /sys, /dev, /boot (+ sub-paths) → 400.
    if (updates.sidecar_central_path && isForbiddenCachePath(updates.sidecar_central_path)) {
      log.warn(
        {
          action: 'settings_change_rejected',
          field: 'sidecar_central_path',
          code: 'forbidden_prefix',
          sidecarCentralPath: updates.sidecar_central_path,
          requestId,
        },
        'forbidden sidecar_central_path prefix',
      );
      return jsonResponse({ error: 'forbidden_sidecar_central_path', requestId }, 400);
    }

    // 22-02 B (audit-revised): writability gate using probeCachePoolWritable
    // (probe-only — per audit M1, validation MUST be side-effect-free;
    // probeCachePoolWritable does writefile-probe ONLY, never mkdirs).
    // Precedence: nested-under-share → forbidden-prefix → not-writable.
    // audit-added M4: emit `settings_change_rejected` pino-warn for SOC-2 / config-rejection audit-trail.
    if (updates.cache_pool_path) {
      try {
        probeCachePoolWritable(updates.cache_pool_path);
      } catch (err) {
        if (err instanceof CachePoolUnavailableError) {
          log.warn(
            {
              action: 'settings_change_rejected',
              field: 'cache_pool_path',
              code: err.code,
              cachePath: updates.cache_pool_path,
              requestId,
            },
            'cache_pool_path not writable — rejecting',
          );
          return jsonResponse(
            {
              error: 'validation_failed',
              fieldErrors: {
                cache_pool_path: 'cache_pool_path_not_writable',
              },
              code: err.code,
              requestId,
            },
            400,
          );
        }
        // Shape errors (assertValidStageRoot string-typed throws) are already
        // covered by zod schema (.min(1).max(4096).startsWith('/')) — re-rethrow
        // defensively so an unexpected error type does not get swallowed.
        throw err;
      }
    }

    // audit-added M6: emit one structured info line per changed key BEFORE
    // writing — the DB does not retain a history table in 01-04, so the
    // structured-log audit trail is the source of truth for incident
    // reconstruction (`grep settings_change log.json | jq`).
    const oldValues: Record<string, string | undefined> = {};
    for (const key of Object.keys(updates)) {
      oldValues[key] = repo.get(key);
    }

    // audit-added: atomic transaction across all key updates so a partial
    // failure rolls back. better-sqlite3's `db.transaction(fn)` wraps the
    // function in BEGIN/COMMIT (or ROLLBACK on throw).
    const writeAll = db.transaction((entries: [string, string][]) => {
      for (const [k, v] of entries) {
        repo.set(k, v);
      }
    });

    // 24-03 (AC-7): exclude a cleared cache_pool_path from the set-entries — it
    // is row-DELETED below, never stored as the empty string (so the resolver's
    // unset-branch fires on the next read).
    const entries: [string, string][] = Object.entries(updates)
      .filter(([k, v]) => !(k === 'cache_pool_path' && v === ''))
      .map(([k, v]) => [k, String(v)]);
    writeAll(entries);

    // 24-03 (AC-7): clear-to-unset — delete the row + emit the settings_change
    // audit-trail line (mirror the per-key log shape; the entries-loop below
    // skips it since it is no longer in `entries`).
    if (clearCachePath) {
      repo.delete('cache_pool_path');
      log.info(
        {
          requestId,
          key: 'cache_pool_path',
          oldValue: oldValues['cache_pool_path'] ?? null,
          newValue: null,
          action: 'settings_change',
        },
        'settings_change: cache_pool_path cleared (revert to auto-resolve)',
      );
    }

    let touchedAuthCacheKey = false;
    let touchedXffKey = false;
    const actorUsername = __auth.ok && __auth.mode === 'authenticated' ? __auth.username : null;
    for (const [k, v] of entries) {
      const oldValue = oldValues[k] ?? null;
      log.info(
        {
          requestId,
          key: k,
          oldValue,
          newValue: v,
          action: 'settings_change',
        },
        'settings_change',
      );
      // 05-02 audit S15: emit specific auth-key audit-trail event when value changed.
      // S6: skip on no-op write (oldValue === newValue).
      const authEvent = AUTH_KEY_EVENT[k];
      if (authEvent && oldValue !== v) {
        log.info(
          {
            event: authEvent,
            from: oldValue,
            to: v,
            requestId,
            username: actorUsername,
          },
          authEvent,
        );
      }
      // 05-14 audit-added (G2; APPLY-time spec-patch — pino structured event in
      // place of SQL audit_log row). Emitted ONLY on real value change so an
      // idempotent re-save (oldValue === newValue) does NOT duplicate the
      // event. 400 rejection paths never reach this loop, so no event fires
      // for invalid values either. Field shape mirrors AC-3 payload contract:
      // { key, oldValue, newValue, actorId } (actorId resolves to authenticated
      // username; null for unauthenticated single-user mode).
      if (k === 'output_container' && oldValue !== v) {
        log.info(
          {
            action: 'setting_changed',
            key: 'output_container',
            oldValue,
            newValue: v,
            actorId: actorUsername,
            requestId,
          },
          'setting_changed: output_container',
        );
      }
      if (AUTH_KEYS_REQUIRING_CACHE_INVALIDATION.has(k)) {
        touchedAuthCacheKey = true;
      }
      if (k === 'auth_trust_proxy_xff' && oldValue !== v) {
        touchedXffKey = true;
      }
    }

    // 05-02 audit S11: invalidate auth settings cache when any of the 4
    // PUT-exposed auth keys changed. (3 write-only keys — session_secret,
    // password_pepper, auth_setup_completed — never enter PUT.)
    if (touchedAuthCacheKey) {
      invalidateAuthSettingsCache();
    }
    // 05-02 audit S8: clear rate-limit buckets when XFF-trust toggle changed —
    // old buckets are keyed by previous IP-resolution scheme.
    if (touchedXffKey) {
      const evicted = clearRateLimitBuckets();
      log.info(
        {
          event: 'auth_rate_limit_cleared_on_xff_toggle',
          evicted,
          requestId,
          username: __auth.ok && __auth.mode === 'authenticated' ? __auth.username : null,
        },
        'auth_rate_limit_cleared_on_xff_toggle',
      );
    }

    // 16-02 (audit-added M1 + M5 generalization): post-write watcher-restart
    // hook now fires on ANY autoScan.* setting change (boot-toggle, stability,
    // batchWindow, reconcileIntervalH, enabled). BEFORE the restart-call and
    // AFTER successful DB commit, emit ONE structured audit-log line carrying
    // the ordered list of {key, oldValue, newValue} — forensics survive even
    // if restartWatcherService throws (audit-log emits before try/catch).
    // Non-autoScan keys mutated in the same PUT are NOT enumerated (AC-7
    // scope discipline).
    const autoScanKeys = Object.keys(updates).filter((k) => k.startsWith('autoScan.'));
    if (autoScanKeys.length > 0) {
      const changes = autoScanKeys.map((key) => ({
        key,
        oldValue: oldValues[key] ?? null,
        newValue: (updates as Record<string, string | undefined>)[key] ?? null,
      }));
      log.info({ action: 'auto_scan_setting_changed', changes }, 'auto-scan settings mutated');
      try {
        await restartWatcherService(log);
      } catch (err) {
        log.error(
          {
            err: err instanceof Error ? err.stack : String(err),
            action: 'auto_scan_restart_failed',
          },
          'restartWatcherService threw — setting persisted, watcher state may lag',
        );
      }
    }

    const merged = repo.getAll();
    return jsonResponse({ settings: merged, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/settings PUT: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
