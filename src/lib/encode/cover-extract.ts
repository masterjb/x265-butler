// Phase 50 Plan 50-02 — cover-art extraction leaf.
//
// WHY THIS EXISTS
// 49-01 stopped the job-kill (a 600x900 mjpeg cover pushed through the HEVC
// encoder) by stream-COPYING the cover. Measured (M-C, ffmpeg 6.1.1): the
// matroska muxer does NOT write the `attached_pic` disposition back, so the
// copied cover lands in the output as a SECOND REAL VIDEO TRACK — a 600x900
// mjpeg claiming 90000 fps. Reporter symptoms: VLC crashes, mpv stays black
// with sound. 50-02 takes the cover OUT of the video mapping (`-map -0:v:N`)
// and puts it back as a genuine Matroska `AttachedFile` (`-attach` + an
// INDEXED `-metadata:s:t:<n>`), which the demuxer then promotes back to
// `attached_pic=1` (M-E).
//
// The round trip needs the cover as a FILE on disk. That is this module: one
// `ffmpeg -map 0:v:N -c copy -frames:v 1 -f image2` spawn per cover, into the
// job's own workDir. Measured (M-D): the extract is BYTE-IDENTICAL to the
// source cover — no transcode, no quality loss.
//
// SHAPE: mirrors cropdetect.ts (spawn + reniceChild + abort listener with
// cleanup + settled guard) and frame-gate.ts (pure resolver + memoized accessor
// + test seam). It NEVER throws — a failed extraction drops that one cover and
// the encode continues (D4/AC-5). The pure half (`describeAttachedPictures`,
// `COVER_MEDIA_BY_CODEC`, `sanitizeAttachmentFilename`) stays in attached-pic.ts,
// which must remain free of fs/spawn/logger.
//
// THIS MODULE CAN KILL JOBS IF IT GETS THE ARGV WRONG, which is why it has a
// kill-switch at all (E1, against the 49-phase D6 pattern). Measured:
//   M-G — an `-attach` without `mimetype=`   ⇒ exit 234, 0-byte output
//   M-H — a WRONG `-metadata:s:t:<n>` index  ⇒ exit 234, 0-byte output
//   M-F — an UNINDEXED `-metadata:s:t`       ⇒ the source FONTS are renamed to
//         the cover's name and demux as three phantom `attached_pic` video
//         streams ("No JPEG data found in image")
// `ENCODE_COVER_ATTACH_DISABLED=1` therefore falls back to Opt B — the cover is
// DROPPED (still `-map -0:v:N`, but no `-attach`) — and NEVER back to the 49-01
// copy form, which is a measured-broken state, not a safe one.

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { logger as defaultLogger } from '../logger';
import { ffmpegBinary } from './ffmpeg-binary';
import { reniceChild } from './child-priority';
import type { CoverStream } from './attached-pic';

/**
 * E7: one cover is a single copied packet. 30 s is generous and mainly covers a
 * hanging FUSE/shfs source rather than a slow decode.
 */
export const COVER_EXTRACT_TIMEOUT_MS = 30_000;

/**
 * E10 (audit MH-2): hard cap on how many covers a single job may extract.
 *
 * The count comes from an UNTRUSTED media file and would otherwise drive an
 * unbounded number of sequential 30 s spawns on the critical job path, plus an
 * unbounded number of `-attach` arguments. Real sources carry one cover,
 * occasionally two (M-K/M-L). 4 is generous; the worst-case wall-clock surcharge
 * is 4 × 30 s = 2 min instead of unbounded.
 *
 * The cap lives HERE, in the leaf, not in the orchestrator — so no caller can
 * route around it.
 */
export const COVER_ATTACH_MAX = 4;

/** A successfully extracted cover, ready for `-attach`. */
export type CoverAttachment = Readonly<{
  /** Absolute path inside the job workDir. Built from ordinal + codec, never from source data. */
  path: string;
  /** From COVER_MEDIA_BY_CODEC — an `-attach` without this is exit 234 (M-G). */
  mimetype: string;
  /** The sanitized source name, or the `cover<N>.<ext>` fallback (E2/AC-12). */
  filename: string;
}>;

/**
 * Resolve ENCODE_COVER_ATTACH_DISABLED.
 *
 * Kill-switch convention (`*_DISABLED === '1'`), NOT the tuning-knob
 * reject-to-default shape: `=1` ⇒ attaching OFF. Anything else — unset, '0',
 * 'true', junk — leaves it ON. Precedent: resolveFrameGateEnabled (50-01),
 * resolveClosedGopEnabled (49-02).
 */
export function resolveCoverAttachEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim() !== '1';
}

let _enabledCache: boolean | undefined; // undefined = not yet resolved

/**
 * Memoized ENCODE_COVER_ATTACH_DISABLED accessor. Restart required to flip.
 *
 * Logged exactly ONCE at `info` — never `debug`: level 20 is dropped at the
 * instance gate BEFORE the multistream fan-out, so a debug line never reaches
 * the ring buffer and therefore never reaches the diagnostics copy-report
 * (the 22-01 → 38-02 dark-surface bug).
 *
 * LAZY like its house-style neighbours (frame-gate / keyframe / encode-nice):
 * the line appears on the first cover-bearing MKV encode after a restart, not
 * at boot.
 */
export function coverAttachEnabled(): boolean {
  if (_enabledCache === undefined) {
    const raw = process.env.ENCODE_COVER_ATTACH_DISABLED;
    _enabledCache = resolveCoverAttachEnabled(raw);
    const source = (raw ?? '').trim() === '' ? 'default' : 'env';
    defaultLogger.info(
      {
        action: 'cover_attach_resolved',
        enabled: _enabledCache,
        source,
        envRaw: raw ?? null,
      },
      'cover-extract: MKV cover-art attach resolved',
    );
  }
  return _enabledCache;
}

/** 50-02 test seam — never barrel-exported (consumed only by tests/encode/*). */
export function __forTests_resetCoverAttachCache(): void {
  _enabledCache = undefined;
}

/**
 * The extraction argv (AC-13), pure.
 *
 * `-c copy` + `-frames:v 1` + `-f image2` writes the cover packet VERBATIM
 * (M-D: byte-identical to the source). `-f image2` is explicit because the path
 * suffix must NOT be what selects the muxer — measured (M-Q), a png stream
 * written to a `.jpg` path stays a png, so the suffix has to come from
 * `codec_name` (it does, via COVER_MEDIA_BY_CODEC) and the muxer has to be
 * pinned here.
 */
export function buildCoverExtractArgs(
  input: string,
  videoOrdinal: number,
  outPath: string,
): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-y',
    '-i',
    input,
    '-map',
    `0:v:${videoOrdinal}`,
    '-c',
    'copy',
    '-frames:v',
    '1',
    '-f',
    'image2',
    outPath,
  ];
}

export type ExtractCoversDeps = {
  /** The job's AbortSignal — a cancel during extraction kills the child (AC-22). */
  signal?: AbortSignal;
  /** Test/observability seam — defaults to the app logger. */
  log?: Pick<typeof defaultLogger, 'info' | 'warn'>;
  /** Forensic context on every warn (AC-5). */
  jobId?: number | string;
};

/** Why a single cover did not make it into the output. Grep-able on the warn. */
type ExtractFailureReason =
  | 'unsupported_codec'
  | 'spawn_failed'
  | 'exit_nonzero'
  | 'timeout'
  | 'aborted'
  | 'missing_output'
  | 'empty_output';

// stderr is tiny here; cap defensively against a pathological producer.
const STDERR_CAP_BYTES = 16 * 1024;

type ExtractOnceOutcome =
  | { ok: true }
  | { ok: false; reason: ExtractFailureReason; detail: string };

function extractOne(
  input: string,
  videoOrdinal: number,
  outPath: string,
  signal: AbortSignal | undefined,
  log: Pick<typeof defaultLogger, 'info' | 'warn'>,
): Promise<ExtractOnceOutcome> {
  return new Promise<ExtractOnceOutcome>((resolve) => {
    if (signal?.aborted) {
      // Pre-aborted before spawn — no child to create, nothing to orphan.
      resolve({ ok: false, reason: 'aborted', detail: 'aborted before spawn' });
      return;
    }

    const args = buildCoverExtractArgs(input, videoOrdinal, outPath);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
      // 38-01: renice in the line straight after spawn — the x265/worker threads
      // inherit the priority only because they are created AFTER the renice.
      reniceChild(child, log);
    } catch (err) {
      resolve({
        ok: false,
        reason: 'spawn_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stderr = '';
    let settled = false;
    let timedOut = false;
    let abortListener: (() => void) | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // child may already be gone
      }
    }, COVER_EXTRACT_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timer);
      if (signal && abortListener) {
        try {
          signal.removeEventListener('abort', abortListener);
        } catch {
          // ignore
        }
      }
    };
    const done = (outcome: ExtractOnceOutcome): void => {
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
        done({ ok: false, reason: 'aborted', detail: 'job cancelled' });
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
      done({ ok: false, reason: 'spawn_failed', detail: err.message });
    });

    child.once('close', (code: number | null) => {
      if (timedOut) {
        done({
          ok: false,
          reason: 'timeout',
          detail: `killed after ${COVER_EXTRACT_TIMEOUT_MS}ms`,
        });
        return;
      }
      if (code !== 0) {
        done({ ok: false, reason: 'exit_nonzero', detail: `exit ${code}: ${stderr.slice(-300)}` });
        return;
      }
      done({ ok: true });
    });
  });
}

/**
 * Extract every attachable cover of `input` into `workDir`. NEVER throws, and
 * returns ONLY the successful extractions (AC-21) — the caller attaches exactly
 * what came back and drops the rest.
 *
 * Sequential on purpose: there are one or two covers, parallelism would buy
 * nothing and would make abort handling harder to reason about.
 */
export async function extractCovers(
  input: string,
  workDir: string,
  covers: ReadonlyArray<CoverStream>,
  deps: ExtractCoversDeps = {},
): Promise<CoverAttachment[]> {
  const log = deps.log ?? defaultLogger;
  const out: CoverAttachment[] = [];
  if (covers.length === 0) return out;

  // E10: cap FIRST, warn once, then work on the capped slice. The covers beyond
  // the cap are still removed from the video mapping by buildArgs (the caller
  // passes ALL cover ordinals there) — they are dropped, not smuggled back in.
  const capped = covers.slice(0, COVER_ATTACH_MAX);
  if (covers.length > COVER_ATTACH_MAX) {
    log.warn(
      {
        action: 'cover_extract_failed',
        reason: 'cover_cap_exceeded',
        jobId: deps.jobId,
        coverCount: covers.length,
        cap: COVER_ATTACH_MAX,
      },
      'cover art: more covers than the attach cap — the surplus is dropped',
    );
  }

  for (let i = 0; i < capped.length; i += 1) {
    const cover = capped[i];
    const media = cover.media;

    // E4: a cover whose codec is not in the attach table is DROPPED, never
    // guessed — a wrong/missing mimetype is exit 234 with a 0-byte output (M-G).
    if (media === null) {
      log.warn(
        {
          action: 'cover_extract_failed',
          reason: 'unsupported_codec',
          jobId: deps.jobId,
          videoOrdinal: cover.videoOrdinal,
          codecName: cover.codecName,
        },
        'cover art: unsupported codec — cover dropped instead of guessed',
      );
      continue;
    }

    // AC-11: the on-disk target is built from the cover's POSITION and its
    // CODEC. No segment of it ever comes from source data — a FILENAME tag of
    // '../../etc/passwd' cannot influence where we write. `i` is the dense
    // position in the cover list (not the video ordinal), so two covers can
    // never collide on one path.
    const outPath = path.join(workDir, `cover${i}.${media.ext}`);
    const fallbackName = `cover${i}.${media.ext}`;

    const outcome = await extractOne(input, cover.videoOrdinal, outPath, deps.signal, log);
    if (!outcome.ok) {
      log.warn(
        {
          action: 'cover_extract_failed',
          reason: outcome.reason,
          jobId: deps.jobId,
          videoOrdinal: cover.videoOrdinal,
          codecName: cover.codecName,
          detail: outcome.detail,
        },
        'cover art: extraction failed — cover dropped, encode continues',
      );
      continue;
    }

    // An exit-0 ffmpeg that wrote nothing is still a failed extraction: an
    // `-attach` on a 0-byte file is not something to hand the muxer.
    let size = -1;
    try {
      size = statSync(outPath).size;
    } catch (err) {
      log.warn(
        {
          action: 'cover_extract_failed',
          reason: 'missing_output',
          jobId: deps.jobId,
          videoOrdinal: cover.videoOrdinal,
          detail: err instanceof Error ? err.message : String(err),
        },
        'cover art: extraction produced no file — cover dropped, encode continues',
      );
      continue;
    }
    if (size <= 0) {
      log.warn(
        {
          action: 'cover_extract_failed',
          reason: 'empty_output',
          jobId: deps.jobId,
          videoOrdinal: cover.videoOrdinal,
          detail: 'output file is 0 bytes',
        },
        'cover art: extraction produced an empty file — cover dropped, encode continues',
      );
      continue;
    }

    out.push(
      Object.freeze({
        path: outPath,
        mimetype: media.mimetype,
        // E2/AC-12: the tag is the sanitized SOURCE name when there is one —
        // measured (M-J) the name does not influence `attached_pic` at all, so it
        // is pure operator information and should stay truthful.
        filename: cover.sourceFilename ?? fallbackName,
      }),
    );
  }

  return out;
}
