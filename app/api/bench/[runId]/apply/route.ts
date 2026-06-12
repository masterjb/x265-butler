// 11-03 → 13-01b T5: POST /api/bench/[runId]/apply — discriminated-union body.
//
//   Apply-mode  ({ comboId })  : write per-encoder defaults from a verified
//                                combo + snapshot prior settings into the 200
//                                response under `priorValues` (audit M2 ADDITIVE
//                                — all 5 existing fields preserved).
//   Restore-mode ({ priorValues }) : new branch — write the supplied priorValues
//                                back into settings; absent keys → settings.delete
//                                (audit M7 null-vs-absent semantic). Emits
//                                `bench.apply_defaults.undo` audit-log (SR5).
//
// Same route, two modes — 55 routes preserved (audit M6). PUT /api/settings is
// NOT used for restore because its zod-schema rejects `default_encoder` (key
// mismatch with apply-mode write target).

import crypto from 'node:crypto';
import { z } from 'zod';
import { benchRunRepo, benchComboRepo, settingRepo, getDb } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BODY_CAP = 2048;

// 13-01b T5 (audit M7): exact list of 9 keys covered by apply / restore.
// Schema-correct names: crf_libx265 / crf_nvenc / crf_qsv / crf_vaapi (NOT
// crf_hevc_nvenc which the draft plan misnamed). Absent in priorValues
// → restore deletes the row (preserves "original key was absent" state).
const SNAPSHOT_KEYS = [
  'default_encoder',
  'crf_libx265',
  'crf_nvenc',
  'crf_qsv',
  'crf_vaapi',
  'preset_libx265',
  'preset_nvenc',
  'preset_qsv',
  'preset_vaapi',
] as const;

type SnapshotKey = (typeof SNAPSHOT_KEYS)[number];

const ApplyBody = z
  .object({
    comboId: z.number().int().positive(),
  })
  .strict();

const PriorValuesSchema = z
  .object({
    default_encoder: z.string().optional(),
    crf_libx265: z.string().optional(),
    crf_nvenc: z.string().optional(),
    crf_qsv: z.string().optional(),
    crf_vaapi: z.string().optional(),
    preset_libx265: z.string().optional(),
    preset_nvenc: z.string().optional(),
    preset_qsv: z.string().optional(),
    preset_vaapi: z.string().optional(),
  })
  .strict();

const RestoreBody = z
  .object({
    priorValues: PriorValuesSchema,
  })
  .strict();

const BodySchema = z.union([ApplyBody, RestoreBody]);

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

function snapshotPriorValues(): Partial<Record<SnapshotKey, string>> {
  const settings = settingRepo();
  const snapshot: Partial<Record<SnapshotKey, string>> = {};
  for (const k of SNAPSHOT_KEYS) {
    const v = settings.get(k);
    if (v !== undefined) snapshot[k] = v;
  }
  return snapshot;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/bench/[runId]/apply', method: 'POST' });

  const { runId: rawId } = await params;
  const runId = parseRunId(rawId);
  if (!runId) return jsonResponse({ error: 'invalid_run_id', requestId }, 400);

  let parsed: z.infer<typeof BodySchema>;
  try {
    const body = await parseBody(request);
    parsed = BodySchema.parse(body);
  } catch (err) {
    return jsonResponse(
      { error: 'invalid_body', detail: err instanceof Error ? err.message : 'parse', requestId },
      400,
    );
  }

  const actor = auth.ok && auth.mode === 'authenticated' ? auth.username : 'disabled';

  // ── RESTORE-mode ────────────────────────────────────────────────────────
  if ('priorValues' in parsed) {
    try {
      const settings = settingRepo();
      const priorValues = parsed.priorValues;
      const db = getDb();
      const tx = db.transaction(() => {
        for (const k of SNAPSHOT_KEYS) {
          const v = priorValues[k];
          if (v !== undefined) {
            settings.set(k, v);
          } else {
            settings.delete(k);
          }
        }
      });
      tx();
      log.info(
        {
          audit: 'bench.apply_defaults.undo',
          runId,
          priorValues,
          actor,
        },
        'bench defaults undo applied',
      );
      return jsonResponse({ restored: true, restoredKeys: SNAPSHOT_KEYS.length, requestId }, 200);
    } catch (err) {
      log.error(
        {
          audit: 'bench.apply_defaults.undo_failed',
          runId,
          priorValues: parsed.priorValues,
          err: err instanceof Error ? err.stack : String(err),
        },
        'bench defaults undo failed',
      );
      return jsonResponse({ error: 'internal_error', requestId }, 500);
    }
  }

  // ── APPLY-mode (default 11-03 path) ────────────────────────────────────
  try {
    const run = benchRunRepo().findById(runId);
    if (!run) return jsonResponse({ error: 'run_not_found', requestId }, 404);

    const combo = benchComboRepo().findById(parsed.comboId);
    if (!combo || combo.run_id !== runId) {
      return jsonResponse({ error: 'combo_not_found', requestId }, 404);
    }
    if (combo.pass2_completed_at === null) {
      return jsonResponse({ error: 'not_verified', requestId }, 409);
    }

    const settings = settingRepo();
    const defaultEncoderKey = 'default_encoder';
    const crfKey = `crf_${combo.encoder}`;
    const presetKey = `preset_${combo.encoder}`;
    const targetEncoder = combo.encoder;
    const targetCrf = String(combo.native_quality_value);
    const targetPreset = combo.preset; // string | null

    // 13-01b T5 audit M2: snapshot 9 keys BEFORE any write so the response can
    // carry an additive `priorValues` field while preserving 11-03's 5-field
    // shape verbatim.
    const priorValues = snapshotPriorValues();

    // 11-03 SR8: idempotency pre-check — current settings already match target
    // → skip transaction + skip audit row entirely. Caller toast switches to
    // "no change" copy.
    const currentEncoder = settings.get(defaultEncoderKey);
    const currentCrf = settings.get(crfKey);
    const currentPreset = settings.get(presetKey);
    const presetEqualsTarget =
      targetPreset === null ? currentPreset === undefined : currentPreset === targetPreset;
    if (currentEncoder === targetEncoder && currentCrf === targetCrf && presetEqualsTarget) {
      return jsonResponse(
        {
          defaultEncoder: targetEncoder,
          crf: targetCrf,
          preset: targetPreset,
          idempotent: true,
          requestId,
          priorValues,
        },
        200,
      );
    }

    // 11-03 AC-5: atomic write via better-sqlite3 transaction.
    const db = getDb();
    const tx = db.transaction(() => {
      settings.set(defaultEncoderKey, targetEncoder);
      settings.set(crfKey, targetCrf);
      if (targetPreset !== null) {
        settings.set(presetKey, targetPreset);
      } else {
        settings.delete(presetKey); // SR1: stale-preset prevention when combo has no preset
      }
    });
    tx();

    const presetDeleted = targetPreset === null;
    log.info(
      {
        audit: 'bench.apply_defaults',
        runId,
        comboId: parsed.comboId,
        encoder: targetEncoder,
        crf: targetCrf,
        preset: targetPreset,
        presetDeleted,
        actor,
      },
      'bench defaults applied',
    );

    return jsonResponse(
      {
        defaultEncoder: targetEncoder,
        crf: targetCrf,
        preset: targetPreset,
        idempotent: false,
        requestId,
        priorValues,
      },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      'apply POST: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
