// 04-01: sidecar JSON helpers — writeSidecar (atomic tmp+rename) +
// readSidecar (size-capped + schema-version-gated) + sweepSidecarTmpFiles
// (boot-time orphan cleanup after SIGKILL race).
//
// Research-driven (internal design notes): MKV tags alone
// are insufficient — stripped by HandBrake / Plex transcode / ffmpeg without
// `-map_metadata 0` / mkvmerge --no-global-tags. Sidecar JSON is the
// complementary file-traveling signal next to the encoded `.x265.mkv` output.
//
// Failure semantics: writeSidecar errors are caught + warn-logged + NEVER
// propagated. The DB content_hash remains the authoritative source of truth;
// a failed sidecar write is a convenience loss, not a correctness loss.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

// audit-added M4 (04-01): cap sidecar read at 64 KiB. Sidecars are typically
// <2 KB; anything larger is attacker-supplied or corrupt-tooling output.
// Without the cap, a hostile / pathological JSON file could memory-bomb the
// scan loop via fs.readFile on a multi-GB file.
const SIDECAR_READ_CAP_BYTES = 64 * 1024;

const SIDECAR_SUFFIX = '.x265-butler.json';
const SIDECAR_TMP_SUFFIX = '.x265-butler.json.tmp';

export type SidecarV1 = {
  schema: 'x265-butler/v1';
  processedBy: 'x265-butler';
  /** semver from package.json */
  version: string;
  /** GIT_HASH env or 'dev' fallback */
  gitHash: string;
  /** ISO-8601 UTC string from a single Date instance captured at commit step. */
  processedAt: string;
  source: { filename: string; contentHash: string; sizeBytes: number };
  output: { filename: string; contentHash: string; sizeBytes: number };
};

// 05-08 B4: V2 schema adds encoder + quality so the sidecar fully describes
// HOW a file was encoded (encoder + CRF/CQ/QP value). EncoderName uses the
// ffmpeg encoder names (libx265 / hevc_nvenc / hevc_vaapi / hevc_qsv) — mapped
// from the internal EncoderId via encoderNameFor() below.
export type EncoderName = 'libx265' | 'hevc_nvenc' | 'hevc_vaapi' | 'hevc_qsv';
export type QualityMode = 'crf' | 'cq' | 'qp';
export type Quality = { mode: QualityMode; value: number };

// 05-13: 3-bucket verdict outcome set. Additive optional field on SidecarV2
// envelope — pre-05-13 V2 readers omit it; 05-13 emissions always set it.
// NO schema bump to v3; the field is non-breaking.
export type SidecarOutcome = 'done-smaller' | 'done-larger' | 'done-not-worth';

export type SidecarV2 = Omit<SidecarV1, 'schema'> & {
  schema: 'x265-butler/v2';
  encoder: EncoderName;
  quality: Quality;
  // 05-13 additive: 3-bucket verdict at the orchestrator commit step. Skip-pipeline
  // step 3 reads this to short-circuit on prior-evaluation outcome at scan time.
  outcome?: SidecarOutcome;
};

// 10-01: SidecarV3 — full forensics envelope (rsync-survivable source-of-truth).
// encoder becomes a rich object (name + preset + ffmpegVersion) vs V2 string.
// outcome is REQUIRED (V2 had it optional). Lazy-upgrade: V3 written only at
// next encode commit-step; V1+V2 read paths preserved byte-identical.
export type SidecarEncoderRich = {
  name: EncoderName;
  preset: string;
  ffmpegVersion: string;
};

// 10-02 E-D3: per-stream audio transcode record for V3 sidecar forensics.
// Optional; present ONLY when audio auto-transcode activated (MP4 + incompatible
// stream). Back-compat: V3 readers must tolerate absence (existing 10-01 V3
// sidecars lack this field).
export type AudioTranscodeRecord = {
  sourceStreamIndex: number;
  fromCodec: string;
  toCodec: 'aac';
  bitrate: number;
};

// 10-03 E-D5: container fallback forensics — written when match-source dispatch
// flips from MP4 to MKV due to audio/subtitle incompatibility or ffprobe failure.
// Optional; absent when no fallback occurred. Back-compat: V3 readers tolerate absence.
export type ContainerFallbackRecord = {
  reason: 'audio' | 'subtitle' | 'preflight_unavailable';
  from: 'mp4';
  to: 'mkv';
};

export type SidecarV3 = {
  schema: 'x265-butler/v3';
  processedBy: 'x265-butler';
  version: string;
  gitHash: string;
  processedAt: string;
  durationSec: number;
  source: {
    filename: string;
    contentHash: string;
    sizeBytes: number;
    codec: string;
    width: number;
    height: number;
    durationSec: number;
  };
  output: {
    filename: string;
    contentHash: string;
    sizeBytes: number;
  };
  savings: {
    bytes: number;
    ratio: number;
    thresholdUsed: number;
  };
  encoder: SidecarEncoderRich;
  quality: Quality;
  outcome: SidecarOutcome;
  // 10-02 E-D3: present only when audio auto-transcode activated for this encode.
  audioTranscode?: AudioTranscodeRecord[];
  // 10-03 E-D5: present only when match-source dispatch fell back mp4→mkv.
  containerFallback?: ContainerFallbackRecord;
};

export type SidecarPayload = SidecarV1 | SidecarV2 | SidecarV3;

function assertNever(x: never): never {
  throw new Error(`unexpected encoder: ${String(x)}`);
}

// 05-08 B4 (audit S3): exhaustive switch — adding a new EncoderName produces
// a TypeScript compile error here, not a runtime surprise.
export function qualityModeFor(encoder: EncoderName): QualityMode {
  switch (encoder) {
    case 'libx265':
      return 'crf';
    case 'hevc_nvenc':
      return 'cq';
    case 'hevc_qsv':
      return 'qp'; // libavutil exposes this as global_quality; we surface qp for sidecar consistency
    case 'hevc_vaapi':
      return 'qp';
    // prettier-ignore
    default: assertNever(encoder);
  }
}

// Map internal EncoderId (nvenc/qsv/vaapi/libx265) → ffmpeg-style EncoderName
// for sidecar payloads. Returns null when the input does not match a known id.
export function encoderNameFor(
  encoderId: 'nvenc' | 'qsv' | 'vaapi' | 'libx265' | string,
): EncoderName | null {
  switch (encoderId) {
    case 'libx265':
      return 'libx265';
    case 'nvenc':
      return 'hevc_nvenc';
    case 'qsv':
      return 'hevc_qsv';
    case 'vaapi':
      return 'hevc_vaapi';
    default:
      return null;
  }
}

export function sidecarPathFor(outputPath: string): string {
  return `${outputPath}${SIDECAR_SUFFIX}`;
}

/**
 * 05-13: source-side sidecar path helper. Functionally equivalent to
 * sidecarPathFor (same suffix), but semantically distinct for grep + reader
 * clarity at the orchestrator call site. The 05-13 sidecar-location pivot:
 *   - done-smaller verdict → sidecar at OUTPUT path (sidecarPathFor)
 *   - done-larger / done-not-worth verdict → sidecar at SOURCE path (sidecarPathForSource)
 * Output is discarded for the latter two; sidecar travels with the file that
 * stays on disk so skip-pipeline can short-circuit on next scan.
 */
export function sidecarPathForSource(sourcePath: string): string {
  return `${sourcePath}${SIDECAR_SUFFIX}`;
}

// 26-01 (F3): operator-configurable sidecar location.
//   off     → no sidecar written anywhere
//   beside  → next to the file (default; byte-identical to pre-26-01)
//   central → one mirrored source-tree under sidecar_central_path
export type SidecarMode = 'off' | 'beside' | 'central';

/**
 * 26-01 (F3): pure resolver mapping (targetPath, mode, centralRoot) → the FINAL
 * sidecar path (suffix already appended) OR `null` (= do not write).
 *   - off     → null
 *   - beside  → sidecarPathFor(targetPath) (today's behavior, byte-identical)
 *   - central → mirror the absolute targetPath under centralRoot, then append
 *     SIDECAR_SUFFIX. e.g. `/media/movies/x.mkv` + `/config/x265-butler/sidecars/`
 *     → `/config/x265-butler/sidecars/media/movies/x.mkv.x265-butler.json`.
 *
 * Defense-in-depth: the central result is resolved + asserted to stay under the
 * resolved centralRoot (path-traversal guard); a violation throws (caller's
 * soft-degrade envelope catches it — never propagates to the encode commit).
 */
export function resolveSidecarTarget(
  targetPath: string,
  mode: SidecarMode,
  centralRoot: string,
): string | null {
  if (mode === 'off') return null;
  if (mode === 'beside') return sidecarPathFor(targetPath);
  // central: mirror the absolute target under centralRoot.
  const stripped = targetPath.replace(/^[/\\]+/, '');
  const mirrored = path.join(centralRoot, stripped);
  const finalPath = `${mirrored}${SIDECAR_SUFFIX}`;
  // path-traversal guard (mirror assertValidStageRoot style): the resolved
  // final path MUST stay under the resolved centralRoot.
  const resolvedRoot = path.resolve(centralRoot);
  const resolvedFinal = path.resolve(finalPath);
  if (resolvedFinal !== resolvedRoot && !resolvedFinal.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(
      `resolveSidecarTarget: central target escapes root (${resolvedFinal} not under ${resolvedRoot})`,
    );
  }
  return finalPath;
}

/**
 * 26-01 (F3): mode-aware atomic sidecar write. Resolves the final target via
 * resolveSidecarTarget; `null` (off) returns early with NO write. For `central`
 * the parent tree is created recursively (`fs.mkdir(recursive)`) BEFORE the
 * atomic tmp+rename. The mkdir sits INSIDE the same try as the write (audit-S3):
 * a mkdir failure (ENOSPC / EACCES on /config / EROFS) soft-degrades through the
 * identical warn-never-throw path as a rename failure. Failure semantics match
 * writeSidecar: warn-log `sidecar_write_failed`, best-effort unlink the .tmp,
 * NEVER propagate (DB content_hash stays authoritative).
 */
export async function writeSidecarResolved(
  targetPath: string,
  payload: SidecarPayload,
  mode: SidecarMode,
  centralRoot: string,
): Promise<void> {
  let finalPath: string | null;
  try {
    finalPath = resolveSidecarTarget(targetPath, mode, centralRoot);
  } catch (err) {
    // traversal-guard throw — soft-degrade (never propagate to encode commit).
    logger.warn(
      {
        action: 'sidecar_write_failed',
        targetPath,
        mode,
        err: err instanceof Error ? err.message : String(err),
      },
      'sidecar target resolution failed — DB content_hash remains authoritative',
    );
    return;
  }
  if (finalPath === null) return; // off — no write (AC-2)

  const tmp = `${finalPath}.tmp`;
  try {
    // audit-S3: mkdir INSIDE the try so a mkdir failure soft-degrades identically.
    if (mode === 'central') {
      await fs.mkdir(path.dirname(finalPath), { recursive: true });
    }
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fs.rename(tmp, finalPath);
  } catch (err) {
    logger.warn(
      {
        action: 'sidecar_write_failed',
        targetPath,
        mode,
        finalPath,
        err: err instanceof Error ? err.message : String(err),
      },
      'sidecar write failed — DB content_hash remains authoritative',
    );
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore — tmp may not exist if mkdir/writeFile failed pre-create
    }
  }
}

/**
 * Atomic write: writeFile to .tmp, then rename to final. On failure, log warn
 * + best-effort unlink the .tmp; NEVER propagate the error to the caller.
 *
 * 05-08 B4: production callers emit SidecarV2 going forward; legacy V1 writes
 * are reserved for the pre-0012 fallback in selfHealSidecar (when DB row has
 * no encoder/crf for a legacy job).
 */
export async function writeSidecar(outputPath: string, payload: SidecarPayload): Promise<void> {
  const target = sidecarPathFor(outputPath);
  const tmp = `${target}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fs.rename(tmp, target);
  } catch (err) {
    logger.warn(
      {
        action: 'sidecar_write_failed',
        outputPath,
        err: err instanceof Error ? err.message : String(err),
      },
      'sidecar write failed — DB content_hash remains authoritative',
    );
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore — tmp may not exist if writeFile itself failed pre-create
    }
  }
}

/**
 * Read + size-cap + schema-version gate. Returns null on missing, oversize,
 * unparseable JSON, or unknown schema. Defensive: refuses tag-spoofed sidecars
 * (processedBy field guard).
 *
 * 05-08 B4: accepts both V1 and V2 schemas. V2 payloads carry encoder +
 * quality fields; reader validates the discriminated shape (encoder enum,
 * quality.mode enum, integer quality.value in 0..51) and rejects malformed V2
 * payloads with `null` (AC-11). V1 stays valid as-is for backwards-compat.
 */
export async function readSidecar(targetPath: string): Promise<SidecarPayload | null> {
  const sidecarPath = sidecarPathFor(targetPath);

  // audit-added M4: stat first, reject if size exceeds cap.
  try {
    const stat = await fs.stat(sidecarPath);
    if (stat.size > SIDECAR_READ_CAP_BYTES) {
      logger.warn(
        {
          action: 'sidecar_oversize_rejected',
          sidecarPath,
          sizeBytes: stat.size,
          capBytes: SIDECAR_READ_CAP_BYTES,
        },
        'sidecar exceeds size cap — falling through to DB hash',
      );
      return null;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null; // common — no log
    logger.warn(
      { action: 'sidecar_stat_failed', sidecarPath, err: code ?? String(err) },
      'sidecar stat failed — falling through to DB hash',
    );
    return null;
  }

  let raw: string;
  try {
    raw = await fs.readFile(sidecarPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    logger.warn(
      { action: 'sidecar_read_failed', sidecarPath, err: code ?? String(err) },
      'sidecar read failed — falling through to DB hash',
    );
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SidecarPayload>;
    if (
      parsed.schema !== 'x265-butler/v1' &&
      parsed.schema !== 'x265-butler/v2' &&
      parsed.schema !== 'x265-butler/v3'
    )
      return null;
    if (parsed.processedBy !== 'x265-butler') return null;
    if (!parsed.source?.contentHash) return null;
    if (parsed.schema === 'x265-butler/v2') {
      // 05-08 B4 (audit S2): malformed-V2 rejection. A V2 sidecar that lacks
      // encoder + quality (or carries an out-of-range quality.value) is an
      // attacker-supplied or tooling-bug payload — refuse it so the scan-time
      // skip-pipeline cannot be poisoned by a self-named-V2 file.
      const v2 = parsed as Partial<SidecarV2>;
      const validEncoders: ReadonlyArray<EncoderName> = [
        'libx265',
        'hevc_nvenc',
        'hevc_vaapi',
        'hevc_qsv',
      ];
      const validModes: ReadonlyArray<QualityMode> = ['crf', 'cq', 'qp'];
      if (!v2.encoder || !validEncoders.includes(v2.encoder)) return null;
      if (!v2.quality || !validModes.includes(v2.quality.mode)) return null;
      if (typeof v2.quality.value !== 'number' || !Number.isInteger(v2.quality.value)) return null;
      if (v2.quality.value < 0 || v2.quality.value > 51) return null;
      // 05-13 audit S1: outcome field — soft-degrade on malformed value.
      // Rationale: rejecting whole payload on a single malformed optional
      // field would spike false-negative-skip rate when the rest of the V2
      // payload is valid (encoder/quality/source/output structurally sound).
      // Required V2 fields above STILL strict-reject (B4 audit S2 contract).
      if (v2.outcome !== undefined) {
        const validOutcomes: ReadonlyArray<SidecarOutcome> = [
          'done-smaller',
          'done-larger',
          'done-not-worth',
        ];
        if (
          typeof v2.outcome !== 'string' ||
          !validOutcomes.includes(v2.outcome as SidecarOutcome)
        ) {
          logger.warn(
            {
              action: 'sidecar_outcome_malformed',
              sidecarPath,
              originalValue: v2.outcome,
            },
            'sidecar outcome field malformed — stripped to undefined; payload accepted',
          );
          v2.outcome = undefined;
        }
      }
    } else if (parsed.schema === 'x265-butler/v3') {
      // 10-01: strict V3 validation. All fields required; malformed → null
      // (tag-spoof defense per V2 audit S2 contract; SOC-2 forensic integrity).
      const v3 = parsed as Partial<SidecarV3>;
      const validEncoders: ReadonlyArray<EncoderName> = [
        'libx265',
        'hevc_nvenc',
        'hevc_vaapi',
        'hevc_qsv',
      ];
      const validOutcomes: ReadonlyArray<SidecarOutcome> = [
        'done-smaller',
        'done-larger',
        'done-not-worth',
      ];
      const validModes: ReadonlyArray<QualityMode> = ['crf', 'cq', 'qp'];
      // SR4: processedAt must be parseable ISO-8601 UTC (forensic timestamp integrity)
      if (
        typeof v3.processedAt !== 'string' ||
        Number.isNaN(Date.parse(v3.processedAt)) ||
        !v3.processedAt.endsWith('Z')
      )
        return null;
      // top-level durationSec
      if (typeof v3.durationSec !== 'number') return null;
      // outcome REQUIRED in V3
      if (typeof v3.outcome !== 'string' || !validOutcomes.includes(v3.outcome as SidecarOutcome))
        return null;
      // encoder must be object with valid name, non-empty preset, non-empty ffmpegVersion
      if (
        !v3.encoder ||
        typeof v3.encoder !== 'object' ||
        !validEncoders.includes((v3.encoder as { name?: unknown }).name as EncoderName) ||
        typeof (v3.encoder as { preset?: unknown }).preset !== 'string' ||
        !(v3.encoder as { preset: string }).preset ||
        typeof (v3.encoder as { ffmpegVersion?: unknown }).ffmpegVersion !== 'string' ||
        !(v3.encoder as { ffmpegVersion: string }).ffmpegVersion
      )
        return null;
      // quality
      if (!v3.quality || !validModes.includes(v3.quality.mode)) return null;
      if (typeof v3.quality.value !== 'number' || !Number.isInteger(v3.quality.value)) return null;
      if (v3.quality.value < 0 || v3.quality.value > 51) return null;
      // source: all 7 required fields including codec, width, height, durationSec
      const src = v3.source as Partial<SidecarV3['source']> | undefined;
      if (!src) return null;
      if (typeof src.filename !== 'string' || !src.filename) return null;
      if (typeof src.sizeBytes !== 'number') return null;
      if (typeof src.codec !== 'string' || !src.codec) return null;
      if (typeof src.width !== 'number') return null;
      if (typeof src.height !== 'number') return null;
      if (typeof src.durationSec !== 'number') return null;
      // SR3: contentHash must be 64 lowercase hex chars (SHA-256 format)
      const hexRx = /^[0-9a-f]{64}$/i;
      if (typeof src.contentHash !== 'string' || !hexRx.test(src.contentHash)) return null;
      // output: 3 required fields
      const out = v3.output as Partial<SidecarV3['output']> | undefined;
      if (!out) return null;
      if (typeof out.filename !== 'string' || !out.filename) return null;
      if (typeof out.sizeBytes !== 'number') return null;
      // SR3: output.contentHash also must be 64 hex chars
      if (typeof out.contentHash !== 'string' || !hexRx.test(out.contentHash)) return null;
      // savings: all 3 fields
      const sav = v3.savings as Partial<SidecarV3['savings']> | undefined;
      if (!sav) return null;
      if (typeof sav.bytes !== 'number') return null;
      if (typeof sav.ratio !== 'number') return null;
      if (typeof sav.thresholdUsed !== 'number') return null;
      // 10-02 E-D3: audioTranscode optional — when present validate each record
      const at = (v3 as { audioTranscode?: unknown }).audioTranscode;
      if (at !== undefined) {
        if (!Array.isArray(at)) return null;
        for (const rec of at as unknown[]) {
          if (typeof rec !== 'object' || rec === null) return null;
          const r = rec as Record<string, unknown>;
          if (typeof r.fromCodec !== 'string' || !r.fromCodec) return null;
          if (r.toCodec !== 'aac') return null;
          if (typeof r.bitrate !== 'number' || !Number.isInteger(r.bitrate) || r.bitrate <= 0)
            return null;
          if (
            typeof r.sourceStreamIndex !== 'number' ||
            !Number.isInteger(r.sourceStreamIndex) ||
            r.sourceStreamIndex < 0
          )
            return null;
        }
      }
      // 10-03 E-D5: containerFallback optional — when present validate all 3 fields.
      // Malformed (wrong enum, missing sub-field, wrong type) → return null (strict-reject).
      const cf = (v3 as { containerFallback?: unknown }).containerFallback;
      if (cf !== undefined) {
        if (typeof cf !== 'object' || cf === null) return null;
        const c = cf as Record<string, unknown>;
        const validReasons: readonly string[] = ['audio', 'subtitle', 'preflight_unavailable'];
        if (!validReasons.includes(c.reason as string)) return null;
        if (c.from !== 'mp4') return null;
        if (c.to !== 'mkv') return null;
      }
    }
    return parsed as SidecarPayload;
  } catch {
    return null;
  }
}

/**
 * 04-03 additive: scan-time sidecar self-heal.
 *
 * Idempotent helper: if a sidecar already exists at <filePath>.x265-butler.json
 * AND its source.contentHash matches the supplied payload's source.contentHash,
 * returns { healed: false, reason: 'already_present' } without writing.
 *
 * Otherwise writes via writeSidecar (atomic tmp+rename). writeSidecar internally
 * catches errors + warn-logs; on its rejection here we return { healed: false,
 * reason: 'write_failed' } and do NOT propagate (DB content_hash authoritative).
 *
 * Per research §6 RULE: NEVER touch the MKV body during self-heal — sidecar
 * write only. Pre-encode source info is unrecoverable post-02-02 trash; the
 * caller passes a payload whose source + output describe the current file
 * (audit M1: payload semantics documented at scan/orchestrator call site).
 *
 * 05-08 B4: payload widened to `SidecarPayload` (V1 OR V2). Callers building
 * from a post-0012 DB row pass V2 (encoder + quality from job.encoder + job.crf).
 * Pre-0012 legacy rows lack `crf` — caller passes V1 to leave a V1 sidecar in
 * place rather than emit a malformed V2 with synthesized quality values.
 */
export async function selfHealSidecar(
  filePath: string,
  payload: SidecarPayload,
): Promise<{ healed: boolean; reason?: 'already_present' | 'write_failed' }> {
  const existing = await readSidecar(filePath);
  if (
    existing &&
    existing.source.contentHash.toLowerCase() === payload.source.contentHash.toLowerCase()
  ) {
    return { healed: false, reason: 'already_present' };
  }

  try {
    await writeSidecar(filePath, payload);
  } catch {
    return { healed: false, reason: 'write_failed' };
  }

  logger.info(
    {
      action: 'sidecar_self_healed',
      filePath,
      sourceContentHash: payload.source.contentHash,
    },
    'sidecar self-healed at scan time',
  );
  return { healed: true };
}

/**
 * audit-added M5 (04-01): boot-time orphan sweep. Globs `**\/*.x265-butler.json.tmp`
 * under rootPath and unlinks each. Defends against SIGKILL race during the
 * writeSidecar atomic step (process killed between fs.writeFile and fs.rename
 * leaves a dangling .tmp file). Cumulative-disk-leak prevention.
 *
 * Implementation note: uses fs.opendir + recursive walk rather than glob libs
 * to keep zero new dependencies. Errors during sweep are warn-logged but do
 * NOT throw — boot must never block on cleanup.
 */
export async function sweepSidecarTmpFiles(
  rootPath: string,
): Promise<{ swept: number; failed: number }> {
  let swept = 0;
  let failed = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT / EACCES on subdirs — skip silently (operator scan_root may
      // legitimately point at a path with restricted subtrees).
      if (code === 'ENOENT' || code === 'EACCES') return;
      failed += 1;
      logger.warn(
        { action: 'sidecar_tmp_sweep_readdir_failed', dir, err: code ?? String(err) },
        'sweep: readdir failed — continuing',
      );
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(SIDECAR_TMP_SUFFIX)) {
        try {
          await fs.unlink(full);
          swept += 1;
        } catch (err) {
          failed += 1;
          logger.warn(
            {
              action: 'sidecar_tmp_unlink_failed',
              path: full,
              err: err instanceof Error ? err.message : String(err),
            },
            'sweep: unlink failed — continuing',
          );
        }
      }
    }
  }

  await walk(rootPath);
  if (swept > 0 || failed > 0) {
    logger.info(
      { action: 'sidecar_tmp_swept', rootPath, swept, failed },
      'sidecar tmp orphan sweep complete',
    );
  }
  return { swept, failed };
}
