// 05-04 T1.D: pure-module tests for src/lib/api/library-csv.ts.
// Phase 5 Plan 05-04 — AC-1 + AC-4.

import { describe, it, expect } from 'vitest';
import {
  BOM_BYTES,
  CRLF,
  CSV_HEADERS,
  buildExportFilename,
  contentDisposition,
  csvEscape,
  rowToCsvLine,
} from '@/src/lib/api/library-csv';
import type { FileRow } from '@/src/lib/db/schema';

const sampleRow: FileRow = {
  id: 1,
  path: '/media/movies/example.mp4',
  size_bytes: 100_000_000,
  mtime: 1_700_000_000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 5_000_000,
  duration_seconds: 7200,
  width: 1920,
  height: 1080,
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  status: 'pending',
  // 2026-04-28T13:45:09Z
  last_scanned_at: 1745847909,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_500,
  version: 0,
  container_override: null,
  share_id: null,
};

describe('csvEscape (RFC 4180 §2)', () => {
  it('returns empty string for null', () => {
    expect(csvEscape(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(csvEscape(undefined)).toBe('');
  });

  it('coerces numbers to plain strings, no quoting', () => {
    expect(csvEscape(0)).toBe('0');
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape(-1.5)).toBe('-1.5');
  });

  it('plain ASCII passes through unquoted', () => {
    expect(csvEscape('hello world')).toBe('hello world');
    expect(csvEscape('/media/movies/x.mp4')).toBe('/media/movies/x.mp4');
  });

  it('wraps in quotes when value contains a comma', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
  });

  it('wraps in quotes and doubles internal quotes', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('wraps in quotes when value contains CR', () => {
    expect(csvEscape('line1\rline2')).toBe('"line1\rline2"');
  });

  it('wraps in quotes when value contains LF', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('preserves non-ASCII (emoji + Cyrillic) verbatim', () => {
    expect(csvEscape('фильм 🎬.mp4')).toBe('фильм 🎬.mp4');
  });
});

// audit-added 05-06 / F-04-001: OWASP CSV Formula Injection guard.
// Spreadsheets evaluate cells whose first char is =, +, -, @, \t, \r as
// formulas. csvEscape MUST prefix string fields starting with one of these
// with a single-quote so the cell renders as literal text.
describe('csvEscape OWASP formula-injection guard (F-04-001)', () => {
  it("prefixes string starting with '=' with a single quote", () => {
    expect(csvEscape("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  it("prefixes string starting with '+' with a single quote", () => {
    expect(csvEscape('+1234567')).toBe("'+1234567");
  });

  it("prefixes string starting with '-' with a single quote", () => {
    expect(csvEscape('-Movie.mkv')).toBe("'-Movie.mkv");
  });

  it("prefixes string starting with '@' with a single quote", () => {
    expect(csvEscape('@admin')).toBe("'@admin");
  });

  it('prefixes string starting with TAB (\\t) with a single quote', () => {
    expect(csvEscape('\thidden')).toBe("'\thidden");
  });

  it('prefixes string starting with CR (\\r) with a single quote and quote-wraps for CR', () => {
    // CR also triggers RFC 4180 quote-wrap; the guarded form `'\r…` then gets wrapped.
    expect(csvEscape('\rsneaky')).toBe('"\'\rsneaky"');
  });

  it('formula-guards then RFC-4180-quote-wraps when value also contains a comma', () => {
    // input: `=HYPERLINK("attacker.example/x","click")`
    // guarded: `'=HYPERLINK("attacker.example/x","click")`
    // contains `,` and `"` → wrap in quotes + double internal quotes
    expect(csvEscape('=HYPERLINK("attacker.example/x","click")')).toBe(
      '"\'=HYPERLINK(""attacker.example/x"",""click"")"',
    );
  });

  it('does NOT formula-guard a numeric -1.5 (numbers are exempt)', () => {
    // numbers render as numbers in spreadsheets, never as formulas — the
    // existing `csvEscape(-1.5) === "-1.5"` invariant must hold.
    expect(csvEscape(-1.5)).toBe('-1.5');
  });

  it('does NOT formula-guard a string whose first char is safe even if it contains = mid-string', () => {
    // OWASP guidance: only LEADING danger chars trigger evaluation.
    expect(csvEscape('a=b')).toBe('a=b');
    expect(csvEscape('movie+sequel.mkv')).toBe('movie+sequel.mkv');
  });

  it('formula-guard is idempotent on already-guarded strings', () => {
    // First pass already produced "'=foo"; passing it through again must not double-prefix.
    // Leading char is `'` (apostrophe) — NOT in the danger set — so unchanged.
    expect(csvEscape("'=foo")).toBe("'=foo");
  });
});

describe('rowToCsvLine', () => {
  it('emits all 12 columns in CSV_HEADERS order', () => {
    // Use a row with a comma-free container so naive split(',') yields exactly
    // 12 fields (validating column-count invariant).
    const cleanRow = { ...sampleRow, container: 'mp4' };
    const line = rowToCsvLine(cleanRow);
    const fields = line.split(',');
    expect(fields).toHaveLength(CSV_HEADERS.length);
    expect(
      line.startsWith(
        '1,/media/movies/example.mp4,100000000,5000000,h264,7200,1920,1080,mp4,pending,',
      ),
    ).toBe(true);
    expect(line.endsWith(`,${'a'.repeat(64)}`)).toBe(true);
  });

  it('quotes container field that contains commas', () => {
    const line = rowToCsvLine(sampleRow);
    expect(line).toContain('"mov,mp4,m4a,3gp,3g2,mj2"');
  });

  it('emits last_scanned_at_iso parseable back to the source epoch', () => {
    const line = rowToCsvLine(sampleRow);
    // ISO appears as the 11th column. With one quoted-comma field (container)
    // simple split breaks; locate ISO via regex.
    const isoMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
    expect(isoMatch).not.toBeNull();
    const iso = isoMatch![1];
    expect(Math.floor(new Date(iso).getTime() / 1000)).toBe(sampleRow.last_scanned_at);
  });

  it('renders nullable columns as empty fields', () => {
    const nulled: FileRow = {
      ...sampleRow,
      codec: null,
      bitrate: null,
      duration_seconds: null,
      width: null,
      height: null,
      container: null,
    };
    const line = rowToCsvLine(nulled);
    // 6 leading non-null + 5 null + 1 ISO + 1 hash = 12 fields. Empty fields
    // appear as `,,`. Confirm by counting commas; null block in middle.
    expect(line).toContain(',,,,,'); // five consecutive empty fields between bitrate..container
  });

  it('escapes path containing comma + quote + emoji', () => {
    const tricky: FileRow = {
      ...sampleRow,
      path: '/media/тест,"weird" 🎬.mp4',
    };
    const line = rowToCsvLine(tricky);
    expect(line).toContain('"/media/тест,""weird"" 🎬.mp4"');
  });
});

describe('buildExportFilename', () => {
  const FIXED = new Date(Date.UTC(2026, 3, 28, 13, 45, 9));

  it('formats UTC timestamp with zero-padding', () => {
    // 2026-04-28T13:45:09.000Z
    const filename = buildExportFilename(FIXED);
    expect(filename).toBe('x265-butler-library-20260428-134509.csv');
  });

  it('zero-pads single-digit month/day/hour/min/sec', () => {
    const filename = buildExportFilename(new Date(Date.UTC(2026, 0, 1, 1, 2, 3)));
    expect(filename).toBe('x265-butler-library-20260101-010203.csv');
  });

  // 14-03 audit SR1: scope-aware filename for forensic / SOC 2 chain
  it("scope='all' explicitly is back-compat (same as single-arg call)", () => {
    expect(buildExportFilename(FIXED, { type: 'all' })).toBe(
      'x265-butler-library-20260428-134509.csv',
    );
  });

  it("scope='orphan' emits the share-orphan- segment", () => {
    expect(buildExportFilename(FIXED, { type: 'orphan' })).toBe(
      'x265-butler-library-share-orphan-20260428-134509.csv',
    );
  });

  it("scope='share' emits share-<id>-<slug(name)>- segment", () => {
    expect(buildExportFilename(FIXED, { type: 'share', id: 2, name: 'Movies' })).toBe(
      'x265-butler-library-share-2-movies-20260428-134509.csv',
    );
  });

  it("scope='share' slugifies non-ASCII / special chars to ASCII-only", () => {
    expect(
      buildExportFilename(FIXED, {
        type: 'share',
        id: 7,
        name: 'Family Photos & Vacation Videos',
      }),
    ).toBe('x265-butler-library-share-7-family-photos-vacation-videos-20260428-134509.csv');
  });

  it("scope='share' with name producing empty slug falls back to 'unknown'", () => {
    expect(buildExportFilename(FIXED, { type: 'share', id: 9, name: '!!!' })).toBe(
      'x265-butler-library-share-9-unknown-20260428-134509.csv',
    );
    expect(buildExportFilename(FIXED, { type: 'share', id: 9, name: '' })).toBe(
      'x265-butler-library-share-9-unknown-20260428-134509.csv',
    );
  });

  it("scope='share' truncates long slug to 32 chars max", () => {
    const longName = 'a'.repeat(80); // 80 → slug truncated to 32 a's
    const result = buildExportFilename(FIXED, { type: 'share', id: 3, name: longName });
    // share-3-<32×a>-timestamp
    expect(result).toBe(`x265-butler-library-share-3-${'a'.repeat(32)}-20260428-134509.csv`);
  });
});

describe('BOM_BYTES', () => {
  it('is exactly 3 bytes', () => {
    expect(BOM_BYTES.length).toBe(3);
  });

  it('matches UTF-8 BOM sequence EF BB BF', () => {
    expect(BOM_BYTES[0]).toBe(0xef);
    expect(BOM_BYTES[1]).toBe(0xbb);
    expect(BOM_BYTES[2]).toBe(0xbf);
  });
});

describe('CRLF', () => {
  it('is exactly \\r\\n', () => {
    expect(CRLF).toBe('\r\n');
  });
});

describe('contentDisposition (RFC 5987 dual-form)', () => {
  it('emits both legacy filename= and filename*=UTF-8 forms', () => {
    const cd = contentDisposition('x265-butler-library-20260428-134509.csv');
    expect(cd).toContain('filename="x265-butler-library-20260428-134509.csv"');
    expect(cd).toContain("filename*=UTF-8''x265-butler-library-20260428-134509.csv");
    expect(cd.startsWith('attachment;')).toBe(true);
  });

  it('replaces non-ASCII in legacy filename and percent-encodes in filename*', () => {
    const cd = contentDisposition('тест.csv');
    expect(cd).toContain('filename="____.csv"');
    expect(cd).toContain("filename*=UTF-8''%D1%82%D0%B5%D1%81%D1%82.csv");
  });
});

describe('CSV_HEADERS', () => {
  it('lists the 12 columns from AC-1 in order', () => {
    expect([...CSV_HEADERS]).toEqual([
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
    ]);
  });
});
