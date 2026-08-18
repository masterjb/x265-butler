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

// 43-03 additive: standard VUI color tags surfaced from the existing
// -show_streams JSON (NO new ffprobe spawn). Each field is the verbatim ffprobe
// enum name (e.g. 'bt2020nc', 'smpte2084', 'arib-std-b67', 'tv', 'pc') or null
// when absent / "unknown" / "unspecified" / "reserved". The names match ffmpeg's
// flag enum names by the same-binary invariant (see normalizeColorValue), so they
// pass straight to -colorspace/-color_primaries/-color_trc/-color_range.
export type SourceColor = {
  space: string | null;
  primaries: string | null;
  transfer: string | null;
  range: string | null;
};

// 43-04 additive: HDR10 STATIC metadata surfaced from the SAME -show_streams
// `side_data_list` already in the probe output (NO new ffprobe spawn). Both
// fields are pre-formatted into the exact strings x265 consumes:
//   masterDisplay → `G(gx,gy)B(bx,by)R(rx,ry)WP(wpx,wpy)L(maxLum,minLum)`
//                    (x265/HandBrake mastering-display order — note G,B,R) or null
//   maxCll        → `${max_content},${max_average}` or null
// null when the source carries no HDR10 / SDR / a malformed side_data shape.
// libx265 emits these as `-x265-params master-display=…:max-cll=…`; the HW
// encoders (nvenc/qsv/vaapi) ignore them and ride ffmpeg's automatic
// AVFrame-side-data → SEI passthrough.
export type SourceHdr10 = {
  masterDisplay: string | null;
  maxCll: string | null;
};

export type ProbeResult = {
  codec: string;
  bitrate: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  container: string;
  // 43-03 additive: source VUI color tags (REQUIRED — all-null when unspecified).
  color: SourceColor;
  // 43-04 additive: source HDR10 static metadata (REQUIRED — both-null when the
  // source is SDR / carries no side_data_list / has a malformed shape).
  hdr10: SourceHdr10;
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

// 43-04 additive: one entry of the ffprobe `-show_streams` `side_data_list`.
// The HDR10 mastering-display + content-light entries carry these fields. The
// chroma coords + luminance arrive as "N/D" fraction STRINGS in canonical
// numerator units (red_x="35400/50000", max_luminance="10000000/10000"); the
// content-light values arrive as plain integers.
interface FfprobeSideData {
  side_data_type?: string;
  red_x?: string;
  red_y?: string;
  green_x?: string;
  green_y?: string;
  blue_x?: string;
  blue_y?: string;
  white_point_x?: string;
  white_point_y?: string;
  min_luminance?: string;
  max_luminance?: string;
  max_content?: number;
  max_average?: number;
}

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  // 43-03 additive: VUI color fields already present in -show_streams output.
  color_space?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_range?: string;
  // 43-04 additive: HDR10 static metadata lives in side_data_list (already in
  // -show_streams output → no new ffprobe arg).
  side_data_list?: FfprobeSideData[];
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

// 43-03: map an ffprobe color enum to a passthrough value or null. Absent / empty
// / the ffmpeg "no signal" sentinels ('unknown'/'unspecified'/'reserved'/'n/a')
// → null (no flag emitted downstream). Otherwise returns the value VERBATIM
// (original case preserved) — ffprobe enum names match ffmpeg flag enum names
// because the same binary produces and consumes them, so no translation map is
// needed (see SourceColor doc + 43-03 plan SR-1).
function normalizeColorValue(s: string | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const lc = trimmed.toLowerCase();
  if (lc === 'unknown' || lc === 'unspecified' || lc === 'reserved' || lc === 'n/a') {
    return null;
  }
  return trimmed;
}

// 43-04: parse an ffprobe "N/D" fraction string into round(N / D × unit), or
// null on absent / empty / "N/A" / non-numeric / D===0 / non-finite. Denominator-
// agnostic: "34000/50000" ×50000 = 34000; "10000000/10000" ×10000 = 10000000.
// audit-added S1: if the installed ffprobe instead emits a decimal ("0.708") or a
// different shape, the "/" split yields a non-finite parse → null → the HDR10
// feature SILENTLY no-ops for that source (NO garbage in argv — argv-safety holds).
export function fracToUnits(s: string | undefined, unit: number): number | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed || trimmed.toLowerCase() === 'n/a') return null;
  const slash = trimmed.indexOf('/');
  if (slash === -1) return null;
  const num = Number(trimmed.slice(0, slash));
  const den = Number(trimmed.slice(slash + 1));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const v = Math.round((num / den) * unit);
  return Number.isFinite(v) ? v : null;
}

// 43-04: find the "Mastering display metadata" side_data and format the x265
// mastering-display string. The 8 chroma coords use unit 50000, the 2 luminance
// values unit 10000. If ANY of the 10 fields is null → return null (no partial
// master-display — AC-3). Output order is x265/HandBrake canonical: G,B,R,WP,L.
function formatMasterDisplay(list: FfprobeSideData[] | undefined): string | null {
  const sd = (list ?? []).find((e) => e.side_data_type === 'Mastering display metadata');
  if (!sd) return null;
  const gx = fracToUnits(sd.green_x, 50000);
  const gy = fracToUnits(sd.green_y, 50000);
  const bx = fracToUnits(sd.blue_x, 50000);
  const by = fracToUnits(sd.blue_y, 50000);
  const rx = fracToUnits(sd.red_x, 50000);
  const ry = fracToUnits(sd.red_y, 50000);
  const wpx = fracToUnits(sd.white_point_x, 50000);
  const wpy = fracToUnits(sd.white_point_y, 50000);
  const maxLum = fracToUnits(sd.max_luminance, 10000);
  const minLum = fracToUnits(sd.min_luminance, 10000);
  if (
    gx === null ||
    gy === null ||
    bx === null ||
    by === null ||
    rx === null ||
    ry === null ||
    wpx === null ||
    wpy === null ||
    maxLum === null ||
    minLum === null
  ) {
    return null;
  }
  return `G(${gx},${gy})B(${bx},${by})R(${rx},${ry})WP(${wpx},${wpy})L(${maxLum},${minLum})`;
}

// 43-04: find the "Content light level metadata" side_data and format max-cll.
// max_content is the required field; max_average defaults to 0 when absent.
function formatMaxCll(list: FfprobeSideData[] | undefined): string | null {
  const sd = (list ?? []).find((e) => e.side_data_type === 'Content light level metadata');
  if (!sd) return null;
  if (typeof sd.max_content !== 'number' || !Number.isFinite(sd.max_content)) return null;
  const avg =
    typeof sd.max_average === 'number' && Number.isFinite(sd.max_average) ? sd.max_average : 0;
  return `${sd.max_content},${avg}`;
}

// 43-04: extract both HDR10 static-metadata strings from the video stream's
// side_data_list. Frame-only HDR10 sources (metadata absent from -show_streams,
// rare for STATIC metadata) are an accepted D1=A gap — no -show_frames fallback.
export function extractHdr10(stream: FfprobeStream): SourceHdr10 {
  return {
    masterDisplay: formatMasterDisplay(stream.side_data_list),
    maxCll: formatMaxCll(stream.side_data_list),
  };
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
        // 43-03: surface the source VUI color tags from the same video stream
        // (no extra ffprobe call). All-null when unspecified — byte-identical
        // downstream because buildArgs only emits a flag for a non-null field.
        color: {
          space: normalizeColorValue(videoStream.color_space),
          primaries: normalizeColorValue(videoStream.color_primaries),
          transfer: normalizeColorValue(videoStream.color_transfer),
          range: normalizeColorValue(videoStream.color_range),
        },
        // 43-04: HDR10 static metadata from the same video stream's side_data_list
        // (no extra ffprobe call). both-null when SDR / absent / malformed —
        // byte-identical downstream because the libx265 builder only emits
        // master-display/max-cll for a non-null field.
        hdr10: extractHdr10(videoStream),
        streams,
      });
    });
  });
}
