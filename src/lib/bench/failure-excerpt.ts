// 52-05 (E6/E7): turn ffmpeg stderr into something a bench operator can act on.
// Pure leaf (no Node imports) so the bench page can parse run reasons client-side.
//
// Why not a plain tail: ffmpeg prints the actual cause once and then a cascade of
// follow-up errors. In the 2026-09-29 Befund the cause ("Driver does not support
// the required nvenc API version. Required: 13.1 Found: 13.0") sat ~1 KB before
// the end, so a 500-char tail kept only "Could not open encoder".

// Tier 1: lines that name a cause. Tier 2: generic failure lines, used only when
// no tier-1 line exists (they repeat once per ffmpeg thread and add noise).
const CAUSE_PATTERNS: readonly RegExp[] = [
  /Required: \S+ Found: \S+/,
  /does not support|not supported/i,
  /minimum required/i,
  /Unable to parse/i,
  /Error while opening encoder/i,
  /No such file or directory/i,
  /Cannot load/i,
  /Unknown encoder/i,
];
const GENERIC_PATTERNS: readonly RegExp[] = [/Invalid argument/i, /Conversion failed/i];

const THREAD_PREFIX = /^(?:\[[^\]]*\]\s*)+/;
const EXIT_PREFIX = /^ffmpeg bench-encode exited \S+:\s*/;

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function matchingLines(all: string[], patterns: readonly RegExp[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of all) {
    if (!patterns.some((p) => p.test(line))) continue;
    const key = line.replace(THREAD_PREFIX, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * Cause lines first, then as much of the tail as still fits into `max`.
 * Without any cause line this degrades to the old tail behaviour.
 */
export function summarizeFfmpegFailure(stderr: string, max = 500): string {
  const all = lines(stderr);
  const causes = matchingLines(all, CAUSE_PATTERNS);
  if (causes.length === 0) return stderr.slice(-max);

  const head = causes.join('\n');
  if (head.length >= max) return head.slice(0, max);

  const causeSet = new Set(causes);
  const rest = all.filter((l) => !causeSet.has(l)).join('\n');
  const budget = max - head.length - 1;
  return budget > 0 && rest.length > 0 ? `${head}\n${rest.slice(-budget)}` : head;
}

/**
 * One readable line for the run-level message: the first cause line, else the
 * first generic failure line, else the last non-empty line. Thread prefixes
 * (`[hevc_nvenc @ 0x…]`) and the `ffmpeg bench-encode exited N:` prefix go.
 */
export function pickFailureExcerpt(errorReason: string, max = 200): string {
  const all = lines(errorReason.replace(EXIT_PREFIX, ''));
  const pick =
    matchingLines(all, CAUSE_PATTERNS)[0] ??
    matchingLines(all, GENERIC_PATTERNS)[0] ??
    all[all.length - 1] ??
    '';
  return pick.replace(THREAD_PREFIX, '').slice(0, max);
}

const ALL_FAILED_PREFIX = 'all_combos_failed:';

export function formatAllCombosFailedReason(count: number, excerpt: string): string {
  return `${ALL_FAILED_PREFIX}${count}|${excerpt}`;
}

export type RunFailureReason =
  { kind: 'all_combos_failed'; count: number; excerpt: string } | { kind: 'raw'; text: string };

/** Splits at the FIRST `|` only: the excerpt itself may contain `|`. */
export function parseRunFailureReason(reason: string): RunFailureReason {
  if (!reason.startsWith(ALL_FAILED_PREFIX)) return { kind: 'raw', text: reason };
  const body = reason.slice(ALL_FAILED_PREFIX.length);
  const sep = body.indexOf('|');
  const countText = sep === -1 ? body : body.slice(0, sep);
  if (!/^\d+$/.test(countText)) return { kind: 'raw', text: reason };
  return {
    kind: 'all_combos_failed',
    count: Number(countText),
    excerpt: sep === -1 ? '' : body.slice(sep + 1),
  };
}
