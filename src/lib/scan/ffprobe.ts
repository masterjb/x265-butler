import { spawn } from 'node:child_process';
import { logger } from '../logger';
import { ffprobeBinary } from '../encode/ffmpeg-binary';

// 05-14 additive: minimal per-stream descriptor needed by output-container
// compat helpers (subtitle-compat.ts + audio-compat.ts). codec_name is
// optional because ffprobe occasionally omits it for unrecognized codecs;
// callers must skip such streams defensively.
export type ProbeStream = {
  index: number;
  codec_type: string;
  codec_name?: string;
  // 10-02 E-D3: audio channel count — used for channel-aware AAC bitrate
  // selection in assertAudioStreams auto-transcode path (SR1: ≤2ch→192k, >2ch→256k).
  channels?: number;
};

export type ProbeResult = {
  codec: string;
  bitrate: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  container: string;
  // 04-01 additive: container-level metadata tags (UPPER_SNAKE_CASE normalized
  // for ffprobe v<5 portability — ffprobe v<5 lowercases Matroska tag keys; v>=5
  // preserves case; we always uppercase at the read site so consumers can
  // compare case-insensitively without per-call normalization).
  tags: Record<string, string>;
  // 05-14 additive: full stream list passed through verbatim (index +
  // codec_type + codec_name only). Optional so existing test fixtures and
  // pre-05-14 ProbeResult literals stay valid; consumers default to `[]`.
  streams?: ProbeStream[];
};

export type ProbeOptions = {
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
// audit-added S2: byte caps prevent memory DoS from pathological ffprobe output.
const STDOUT_CAP_BYTES = 10 * 1024 * 1024; // 10 MiB
const STDERR_TAIL_BYTES = 8 * 1024; // 8 KiB

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
}

interface FfprobeFormat {
  bit_rate?: string;
  duration?: string;
  format_name?: string;
  // 04-01: container-level free-form key/value tags. Matroska muxer writes
  // SimpleTag elements at file (TargetTypeValue 50) scope here.
  tags?: Record<string, string>;
}

// 04-01 audit (research §6.2): normalize all keys to UPPER_SNAKE_CASE for
// ffprobe v<5 portability. ffprobe v<5 may lowercase Matroska tag keys; v>=5
// preserves case as written. Always uppercase at the read site.
function normalizeTags(raw: Record<string, string> | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k.toUpperCase()] = String(v);
  }
  return out;
}

interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

function safeParseInt(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function safeParseFloat(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export async function ffprobe(
  filePath: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ProbeResult | null>((resolve) => {
    const args = [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    const child = spawn(ffprobeBinary(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let timedOut = false;
    let stdoutCapped = false;
    let resolved = false;

    const safeResolve = (v: ProbeResult | null): void => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // child may already be gone — ignore
      }
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutCapped) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > STDOUT_CAP_BYTES) {
          stdoutCapped = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          return;
        }
        stdoutChunks.push(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        // Sliding window: only keep the tail of stderr.
        stderrTail = Buffer.concat([stderrTail, chunk]);
        if (stderrTail.length > STDERR_TAIL_BYTES) {
          stderrTail = stderrTail.subarray(stderrTail.length - STDERR_TAIL_BYTES);
        }
      });
    }

    child.on('error', (err) => {
      // spawn itself failed (e.g. ENOENT for the ffprobe binary).
      clearTimeout(timeout);
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), filePath },
        'ffprobe: spawn failed',
      );
      safeResolve(null);
    });

    // audit-added M2: resolve only on `close` — even after kill on
    // timeout/cap, the kernel reaps the child and emits close. Awaiting
    // close here prevents zombie accumulation.
    child.once('close', (code) => {
      clearTimeout(timeout);

      if (timedOut) {
        logger.warn({ filePath, timeoutMs }, 'ffprobe: timeout, killed');
        safeResolve(null);
        return;
      }
      if (stdoutCapped) {
        logger.warn(
          { filePath, capBytes: STDOUT_CAP_BYTES },
          'ffprobe: stdout exceeded cap, killed',
        );
        safeResolve(null);
        return;
      }
      if (code !== 0) {
        logger.warn(
          { filePath, code, stderr: stderrTail.toString('utf8') },
          'ffprobe: non-zero exit',
        );
        safeResolve(null);
        return;
      }

      const stdoutStr = Buffer.concat(stdoutChunks).toString('utf8');
      let parsed: FfprobeJson;
      try {
        parsed = JSON.parse(stdoutStr) as FfprobeJson;
      } catch (err) {
        logger.warn(
          { filePath, err: err instanceof Error ? err.message : String(err) },
          'ffprobe: JSON parse failed',
        );
        safeResolve(null);
        return;
      }

      const videoStream = (parsed.streams ?? []).find((s) => s.codec_type === 'video');
      if (!videoStream || !videoStream.codec_name) {
        logger.warn({ filePath }, 'ffprobe: no video stream');
        safeResolve(null);
        return;
      }

      const format = parsed.format ?? {};
      // 05-14 additive: pass through stream list verbatim so output-container
      // compat helpers (subtitle-compat.ts + audio-compat.ts) can inspect
      // codec_type + codec_name without re-parsing ffprobe output.
      const streams: ProbeStream[] = (parsed.streams ?? []).map((s, idx) => ({
        index: typeof s.index === 'number' ? s.index : idx,
        codec_type: typeof s.codec_type === 'string' ? s.codec_type : 'unknown',
        codec_name: typeof s.codec_name === 'string' ? s.codec_name : undefined,
        channels: typeof s.channels === 'number' ? s.channels : undefined,
      }));
      safeResolve({
        codec: videoStream.codec_name,
        bitrate: safeParseInt(format.bit_rate),
        durationSeconds: safeParseFloat(format.duration),
        width: typeof videoStream.width === 'number' ? videoStream.width : null,
        height: typeof videoStream.height === 'number' ? videoStream.height : null,
        container: format.format_name ?? '',
        tags: normalizeTags(format.tags),
        streams,
      });
    });
  });
}
