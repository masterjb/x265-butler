// 05-14: output-container helper — single source of truth for the operator-
// selectable container format (MKV default, MP4 opt-in).
//
// Pure module: zero side effects, zero logger import, zero filesystem access.
// Consumed by:
//   - orchestrator.ts (dispatch boundary read + extension derivation)
//   - ffmpeg.ts        (muxer-args plumbing)
//   - skip/pipeline.ts (Step 1 generalized suffix gate)
//   - settings PUT    (zod enum)
//   - encoder-tab.tsx  (Select component options)
//
// Boundary: container-level only. Per-encoder argv recipes (libx265 / VAAPI /
// QSV) live in profiles.ts and stay container-agnostic — ffmpeg picks the
// muxer from the output-path extension; the muxer-args additions here are
// mostly format-level (e.g. `-movflags +faststart` for MP4 streaming).
//
// 31-01 CODEC-CONDITIONAL CAVEAT: `-tag:v hvc1` (MP4 only) is NOT a pure
// format flag — it is a CODEC fourcc. It is correct ONLY because buildArgs
// (ffmpeg.ts) always encodes an HEVC video stream (libx265 / hevc_nvenc /
// hevc_qsv / hevc_vaapi). Apple QuickTime/Photos refuse ffmpeg's default
// `hev1` fourcc; `hvc1` makes the file Apple-playable. Matroska ignores the
// codec fourcc, so MKV needs nothing. If a non-HEVC encode path is ever
// routed through buildArgs+mp4, the fourcc MUST be made codec-conditional —
// a static `hvc1` would mislabel/corrupt a non-HEVC stream. This precondition
// is enforced by the AC-3 HEVC-encoder-token assertion in ffmpeg.test.ts.

export const OUTPUT_CONTAINERS = ['mkv', 'mp4'] as const;
export type OutputContainer = (typeof OUTPUT_CONTAINERS)[number];

const OUTPUT_CONTAINERS_SET: ReadonlySet<string> = Object.freeze(new Set(OUTPUT_CONTAINERS));

export function isOutputContainer(v: unknown): v is OutputContainer {
  return typeof v === 'string' && OUTPUT_CONTAINERS_SET.has(v);
}

const EXTENSION_FOR: Readonly<Record<OutputContainer, '.x265.mkv' | '.x265.mp4'>> = Object.freeze({
  mkv: '.x265.mkv',
  mp4: '.x265.mp4',
});

export function extensionFor(c: OutputContainer): '.x265.mkv' | '.x265.mp4' {
  switch (c) {
    case 'mkv':
      return EXTENSION_FOR.mkv;
    case 'mp4':
      return EXTENSION_FOR.mp4;
    default:
      return assertNever(c);
  }
}

const MUXER_ARGS_MKV: readonly string[] = Object.freeze([]);
// 31-01: `-tag:v hvc1` couples to an HEVC video stream — see CODEC-CONDITIONAL
// CAVEAT in the module header. `-movflags +faststart` stays first (preserves
// its argv position → minimal diff); both are accepted in any order pre-output.
const MUXER_ARGS_MP4: readonly string[] = Object.freeze([
  '-movflags',
  '+faststart',
  '-tag:v',
  'hvc1',
]);

export function muxerArgsFor(c: OutputContainer): readonly string[] {
  switch (c) {
    case 'mkv':
      return MUXER_ARGS_MKV;
    case 'mp4':
      return MUXER_ARGS_MP4;
    default:
      return assertNever(c);
  }
}

export const X265_OUTPUT_EXTENSIONS = ['.x265.mkv', '.x265.mp4'] as const;

// Suffix-gate predicate for skip-pipeline Step 1. Pure string match — case-
// sensitive (matches 04-01 contract); rejects NUL-laced inputs defensively.
// Path-traversal validity is NOT this helper's concern; security boundary is
// upstream in the scanner / staging layer.
export function isX265OutputPath(filePath: unknown): boolean {
  if (typeof filePath !== 'string') return false;
  if (filePath.length === 0) return false;
  if (filePath.indexOf('\0') !== -1) return false;
  for (const ext of X265_OUTPUT_EXTENSIONS) {
    if (filePath.endsWith(ext)) return true;
  }
  return false;
}

function assertNever(x: never): never {
  throw new Error(`unreachable output-container value: ${String(x)}`);
}

// 05-15: setting-level superset of OutputContainer. The persisted setting can
// hold 'match-source' as a directive; the orchestrator resolves it to a
// concrete OutputContainer at the dispatch boundary before passing to runEncode.
export const OUTPUT_CONTAINER_SETTINGS = ['mkv', 'mp4', 'match-source'] as const;
export type OutputContainerSetting = (typeof OUTPUT_CONTAINER_SETTINGS)[number];

const OUTPUT_CONTAINER_SETTINGS_SET: ReadonlySet<string> = Object.freeze(
  new Set(OUTPUT_CONTAINER_SETTINGS),
);

export function isOutputContainerSetting(v: unknown): v is OutputContainerSetting {
  return typeof v === 'string' && OUTPUT_CONTAINER_SETTINGS_SET.has(v);
}

// 05-15: source-extension → container resolver for `match-source` setting.
// Pure: case-insensitive endsWith match against MP4_SOURCE_EXTS; defaults
// to 'mkv' for everything else (unknown extension / no extension /
// .mkv / .webm / .avi / .mov / .ts / …). NUL-laced inputs default to 'mkv'
// (defensive — no throw, no leak, deterministic).
const MP4_SOURCE_EXTS: ReadonlyArray<string> = Object.freeze(['.mp4', '.m4v']);

export function resolveContainerFromSource(filePath: unknown): OutputContainer {
  if (typeof filePath !== 'string') return 'mkv';
  if (filePath.length === 0) return 'mkv';
  if (filePath.indexOf('\0') !== -1) return 'mkv';
  const lower = filePath.toLowerCase();
  for (const ext of MP4_SOURCE_EXTS) {
    if (lower.endsWith(ext)) return 'mp4';
  }
  return 'mkv';
}
