// Phase 35 Plan 35-01 — auto-crop / black-bar removal pre-pass.
//
// Two responsibilities, both PURE-input + soft-degrading (never throw to the
// caller — a detect failure must NEVER fail an encode):
//   1. parseCropGeometry — the shared normalizer for the operator `crop_override`
//      string AND for cropdetect's own stderr parse. Validates 4 integer fields,
//      positive even W/H, non-negative even X/Y (HEVC 4:2:0 needs even luma dims;
//      odd-but-parseable geometry would make the ffmpeg crop filter / x265 encode
//      FAIL at runtime → job dies → so odd dims are rejected here, audit SR-2).
//   2. detectCrop — a `cropdetect` ffmpeg pre-pass on a mid-file sample, parsing
//      the converged `crop=W:H:X:Y` from stderr.
//
// NOTE on the full-frame case (audit MH-1): cropdetect ALWAYS prints a `crop=`
// line — on a no-bars source it prints the FULL frame (`crop=W:H:0:0`), it does
// NOT omit the line. detectCrop returns that full-frame geometry verbatim; the
// MANDATORY full-frame drop (so no spurious no-op `-vf` is added on a no-bars
// file) happens in the orchestrator resolve against file.width/file.height,
// where the source dims are known. Keeping detectCrop a pure parser avoids
// guessing source dims here.
import { spawn } from 'node:child_process';
import { logger as defaultLogger } from '../logger';
import { ffmpegBinary } from './ffmpeg-binary';

// parseCropGeometry moved to the dep-free './crop-geometry' module (35-02) so the
// client formSchema can import it without bundling node:child_process. Re-exported
// here so every EXISTING importer (orchestrator.ts) keeps its import path UNCHANGED.
export { parseCropGeometry } from './crop-geometry';
import { parseCropGeometry } from './crop-geometry';

// Sample window. Module consts so a later plan can tune without touching logic.
// offset = a sane mid-file probe point; sampleDur = a window long enough for
// cropdetect's per-frame estimate to converge. A short source clamps the offset
// (SR-1) so the `-ss` seek never lands past EOF (which would yield an empty
// sample → silently-never-cropped).
export const CROPDETECT_SAMPLE_OFFSET_SECONDS = 60;
export const CROPDETECT_SAMPLE_DURATION_SECONDS = 20;

// cropdetect stderr is tiny; cap defensively against a pathological producer.
const STDERR_CAP_BYTES = 64 * 1024;

// Extract the LAST `crop=W:H:X:Y` token from a cropdetect stderr blob.
// cropdetect emits a converging series of estimates; the last one is the most
// settled. Returns the raw `W:H:X:Y` (un-normalized) or null when no line exists.
function lastCropToken(stderr: string): string | null {
  const matches = stderr.match(/crop=(-?\d+:-?\d+:-?\d+:-?\d+)/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1].slice('crop='.length);
}

export interface DetectCropDeps {
  // SR-1: known source duration clamps the seek offset so a short clip does not
  // seek past EOF. Undefined → use the default offset + the offset-0 retry.
  durationSeconds?: number;
  // SR-4: the production AbortSignal so a job-cancel during the detect pre-pass
  // kills the cropdetect child instead of orphaning it.
  signal?: AbortSignal;
  // Test/observability seam — defaults to the app logger.
  logger?: Pick<typeof defaultLogger, 'info' | 'warn'>;
}

// Discriminated sample outcome: distinguishes "ran but found no crop line"
// (retry-eligible) from "could not run" (spawn error / abort).
type SampleOutcome = { ok: true; crop: string | null } | { ok: false };

function sampleCropOnce(
  inputPath: string,
  offset: number,
  signal: AbortSignal | undefined,
  log: Pick<typeof defaultLogger, 'info' | 'warn'>,
): Promise<SampleOutcome> {
  return new Promise<SampleOutcome>((resolve) => {
    if (signal?.aborted) {
      // Pre-aborted before spawn — no child to create, nothing to orphan.
      resolve({ ok: false });
      return;
    }

    const args = [
      '-hide_banner',
      '-ss',
      String(offset),
      '-i',
      inputPath,
      '-t',
      String(CROPDETECT_SAMPLE_DURATION_SECONDS),
      '-vf',
      'cropdetect=round=2',
      '-an',
      '-f',
      'null',
      '-',
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      log.warn(
        {
          action: 'crop_detect_failed',
          inputPath,
          err: err instanceof Error ? err.message : String(err),
        },
        'cropdetect spawn failed — encoding uncropped',
      );
      resolve({ ok: false });
      return;
    }

    let stderr = '';
    let settled = false;
    let abortListener: (() => void) | null = null;

    const cleanup = (): void => {
      if (signal && abortListener) {
        try {
          signal.removeEventListener('abort', abortListener);
        } catch {
          // ignore
        }
      }
    };
    const done = (outcome: SampleOutcome): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    if (signal) {
      abortListener = (): void => {
        try {
          child.kill('SIGKILL');
        } catch {
          // child may already be gone
        }
        done({ ok: false });
      };
      signal.addEventListener('abort', abortListener);
    }

    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > STDERR_CAP_BYTES) stderr = stderr.slice(-STDERR_CAP_BYTES);
      });
    }

    child.on('error', (err: Error) => {
      log.warn(
        { action: 'crop_detect_failed', inputPath, err: err.message },
        'cropdetect spawn failed — encoding uncropped',
      );
      done({ ok: false });
    });

    child.once('close', (code: number | null) => {
      if (code !== 0) {
        log.warn(
          { action: 'crop_detect_failed', inputPath, exitCode: code },
          'cropdetect exited nonzero — encoding uncropped',
        );
        done({ ok: false });
        return;
      }
      done({ ok: true, crop: lastCropToken(stderr) });
    });
  });
}

/**
 * Run a cropdetect pre-pass on a sample of `inputPath` and return the normalized
 * `"W:H:X:Y"` geometry, or null when no usable crop was found / the probe failed.
 * NEVER throws.
 */
export async function detectCrop(
  inputPath: string,
  deps: DetectCropDeps = {},
): Promise<string | null> {
  const log = deps.logger ?? defaultLogger;
  const startMs = Date.now();

  // SR-1 offset clamp: a 40s clip → offset 4s, not 60s past EOF.
  const baseOffset =
    typeof deps.durationSeconds === 'number' && Number.isFinite(deps.durationSeconds)
      ? Math.max(
          0,
          Math.min(CROPDETECT_SAMPLE_OFFSET_SECONDS, Math.floor(deps.durationSeconds * 0.1)),
        )
      : CROPDETECT_SAMPLE_OFFSET_SECONDS;

  let outcome = await sampleCropOnce(inputPath, baseOffset, deps.signal, log);
  // SR-1 retry: a source-duration-unknown short file seeks past EOF → no crop
  // line → retry ONCE at offset 0 before giving up (only when not aborted).
  if (outcome.ok && outcome.crop === null && baseOffset > 0 && !deps.signal?.aborted) {
    outcome = await sampleCropOnce(inputPath, 0, deps.signal, log);
  }

  const raw = outcome.ok ? outcome.crop : null;
  const result = parseCropGeometry(raw);
  log.info(
    { action: 'crop_detect', inputPath, durationMs: Date.now() - startMs, result },
    'cropdetect pre-pass complete',
  );
  return result;
}
