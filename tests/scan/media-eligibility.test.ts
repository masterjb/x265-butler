// 50-03 Task 1 — the media-eligibility leaf.
//
// This is the module that stops the app from feeding on its own output. The
// tests here are table-driven on purpose: every surface (walker, watcher,
// ingest, orphan sweep) resolves "is this a medium?" through these functions,
// so a regression here is a regression everywhere.
//
// The two load-bearing tests are NOT the tables:
//   - AC-13 runs the REAL walker over a fixture tree and compares its output
//     against `hasAllowedExtension`. That is the drift guard; a re-typed copy
//     of the walker expression would only prove the copy matches itself.
//   - AC-9 imports `ONBOARDING_DEFAULT_EXT_CSV` from the route that a fresh
//     install actually writes into `shares.extensions_csv`, instead of typing
//     the list a fifth time.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    telemetry: vi.fn(),
    child: vi.fn(),
  },
}));
vi.mock('@/src/lib/logger', () => ({ logger: mockLogger }));

// AC-9 imports the onboarding ROUTE for its constant. The route drags the db
// singletons + server-init through its import graph; stub them so this unit
// test stays a unit test.
vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ get: () => undefined, set: () => {} }),
  shareRepo: () => ({ listAll: () => [], getById: () => undefined }),
}));
vi.mock('@/src/lib/server-init', () => ({ ensureServerInit: async () => {} }));

import {
  DEFAULT_MEDIA_EXTENSIONS,
  normalizeExtensions,
  parseExtensionCsv,
  resolveAllowedExtensions,
  hasAllowedExtension,
  isSidecarPath,
  SIDECAR_IGNORE_RE,
  resolveIngestFilterEnabled,
  ingestFilterEnabled,
  __resetIngestFilterMemoForTests,
} from '@/src/lib/scan/media-eligibility';
import { walkFiles } from '@/src/lib/scan/walker';
import {
  sidecarPathFor,
  sidecarPathForSource,
  SIDECAR_SUFFIX,
  SIDECAR_TMP_SUFFIX,
} from '@/src/lib/encode/sidecar';
import { ONBOARDING_DEFAULT_EXT_CSV } from '@/app/api/onboarding/complete/route';

beforeEach(() => {
  __resetIngestFilterMemoForTests();
  delete process.env.WATCH_INGEST_FILTER_DISABLED;
});

afterEach(() => {
  __resetIngestFilterMemoForTests();
  delete process.env.WATCH_INGEST_FILTER_DISABLED;
});

// ────────────────────────────────────────────────────────────────────────────
// normalizeExtensions — body moved out of walker.ts (E5), semantics frozen
// ────────────────────────────────────────────────────────────────────────────

describe('normalizeExtensions', () => {
  const cases: Array<{ name: string; input: string[]; expected: string[] }> = [
    { name: 'strips a leading dot', input: ['.mkv', '.mp4'], expected: ['mkv', 'mp4'] },
    { name: 'lower-cases', input: ['MKV', 'Mp4', 'M2TS'], expected: ['mkv', 'mp4', 'm2ts'] },
    { name: 'drops empty strings', input: ['mkv', '', '.'], expected: ['mkv'] },
    { name: 'de-duplicates', input: ['mkv', '.MKV', 'mkv'], expected: ['mkv'] },
    { name: 'empty input → empty set', input: [], expected: [] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect([...normalizeExtensions(c.input)].sort()).toEqual([...c.expected].sort());
    });
  }

  it('accepts the readonly DEFAULT_MEDIA_EXTENSIONS without a copy', () => {
    expect(normalizeExtensions(DEFAULT_MEDIA_EXTENSIONS).has('mkv')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseExtensionCsv — PURE, no fallback (the walker needs raw semantics)
// ────────────────────────────────────────────────────────────────────────────

describe('parseExtensionCsv', () => {
  const cases: Array<{ name: string; input: string; expected: string[] }> = [
    { name: 'plain csv', input: 'mkv,mp4', expected: ['mkv', 'mp4'] },
    { name: 'tolerates spaces around commas', input: ' mkv , mp4 ', expected: ['mkv', 'mp4'] },
    { name: 'tolerates a trailing comma', input: 'mkv,mp4,', expected: ['mkv', 'mp4'] },
    { name: 'tolerates leading dots', input: '.mkv,.mp4', expected: ['mkv', 'mp4'] },
    { name: 'empty string → EMPTY set (no fallback here)', input: '', expected: [] },
    { name: 'pure whitespace → EMPTY set', input: '   ', expected: [] },
    { name: 'commas only → EMPTY set', input: ',,,', expected: [] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect([...parseExtensionCsv(c.input)].sort()).toEqual([...c.expected].sort());
    });
  }

  it('does NOT trim inner whitespace away as a token (" mkv " normalizes)', () => {
    // normalizeExtensions lower-cases + strips the leading dot but does NOT trim,
    // so the trimming must happen on the split — pinned here because a share CSV
    // written by hand routinely carries spaces.
    expect(parseExtensionCsv('mkv, mp4').has('mp4')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-19 — resolveAllowedExtensions: an empty allowlist is a MISCONFIGURATION
// ────────────────────────────────────────────────────────────────────────────

describe('resolveAllowedExtensions (AC-19 — empty allowlist never means "reject all")', () => {
  const fallbackCases: Array<{ name: string; input: string | null | undefined }> = [
    { name: 'empty string', input: '' },
    { name: 'pure whitespace', input: '   ' },
    { name: 'commas only', input: ',,,' },
    { name: 'null', input: null },
    { name: 'undefined', input: undefined },
  ];
  for (const c of fallbackCases) {
    it(`${c.name} → DEFAULT_MEDIA_EXTENSIONS + fellBack:true`, () => {
      const res = resolveAllowedExtensions(c.input);
      expect(res.fellBack).toBe(true);
      expect([...res.set].sort()).toEqual(
        [...normalizeExtensions(DEFAULT_MEDIA_EXTENSIONS)].sort(),
      );
      // the point of the fallback: a real medium still gets through
      expect(hasAllowedExtension('/mnt/media/film.mkv', res.set)).toBe(true);
    });
  }

  it('a real csv is used verbatim and does NOT fall back', () => {
    const res = resolveAllowedExtensions('mkv');
    expect(res.fellBack).toBe(false);
    expect([...res.set]).toEqual(['mkv']);
    expect(hasAllowedExtension('/mnt/media/film.mp4', res.set)).toBe(false);
  });

  it('never returns an empty set', () => {
    for (const input of ['', '   ', ',,,', null, undefined, 'mkv']) {
      expect(resolveAllowedExtensions(input).set.size).toBeGreaterThan(0);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// hasAllowedExtension
// ────────────────────────────────────────────────────────────────────────────

describe('hasAllowedExtension', () => {
  const allowed = normalizeExtensions(['mkv', 'mp4']);
  const cases: Array<{ name: string; input: string; expected: boolean }> = [
    { name: 'plain match', input: '/m/film.mkv', expected: true },
    { name: 'upper-case extension matches', input: '/m/film.MKV', expected: true },
    { name: 'multiple dots — only the LAST segment counts', input: '/m/a.b.mkv', expected: true },
    { name: 'wrong extension', input: '/m/poster.jpg', expected: false },
    { name: 'no extension at all', input: '/m/README', expected: false },
    { name: 'dotfile is NOT an extension match', input: '/m/.mkv', expected: false },
    { name: 'a dot in a DIRECTORY name does not leak in', input: '/m.mkv/README', expected: false },
    { name: 'sidecar json', input: '/m/film.mkv.x265-butler.json', expected: false },
  ];
  for (const c of cases) {
    it(`${c.name} → ${c.expected}`, () => {
      expect(hasAllowedExtension(c.input, allowed)).toBe(c.expected);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// AC-16 — the sidecar matcher is built FROM sidecar.ts, not from a re-typed
// literal. The proof is that it matches what the real helpers PRODUCE.
// ────────────────────────────────────────────────────────────────────────────

describe('isSidecarPath / SIDECAR_IGNORE_RE (AC-16)', () => {
  it('matches what sidecarPathFor() produces for an output file', () => {
    expect(isSidecarPath(sidecarPathFor('/mnt/media/film.x265.mkv'))).toBe(true);
  });

  it('matches what sidecarPathForSource() produces for a source file', () => {
    expect(isSidecarPath(sidecarPathForSource('/mnt/media/film.mkv'))).toBe(true);
  });

  it('matches the .tmp form left behind by an aborted atomic write', () => {
    expect(isSidecarPath(`/mnt/media/film.mkv${SIDECAR_TMP_SUFFIX}`)).toBe(true);
  });

  it('does NOT match a merely similar-looking name', () => {
    expect(isSidecarPath(`/mnt/media/film${SIDECAR_SUFFIX}x`)).toBe(false);
    expect(isSidecarPath('/mnt/media/film.json')).toBe(false);
    expect(isSidecarPath('/mnt/media/film.mkv')).toBe(false);
  });

  it('is stateless across calls (no /g flag on the shared RegExp)', () => {
    const p = sidecarPathFor('/mnt/media/film.mkv');
    expect(SIDECAR_IGNORE_RE.test(p)).toBe(true);
    expect(SIDECAR_IGNORE_RE.test(p)).toBe(true);
    expect(SIDECAR_IGNORE_RE.test(p)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-12 — the kill-switch resolver is PURE and memoized
// ────────────────────────────────────────────────────────────────────────────

describe('resolveIngestFilterEnabled (AC-12)', () => {
  it('unset → enabled:true, source:default', () => {
    expect(resolveIngestFilterEnabled()).toEqual({ enabled: true, source: 'default' });
  });

  it("exactly '1' → enabled:false, source:env", () => {
    process.env.WATCH_INGEST_FILTER_DISABLED = '1';
    expect(resolveIngestFilterEnabled()).toEqual({ enabled: false, source: 'env' });
    expect(ingestFilterEnabled()).toBe(false);
  });

  const nonDisabling = ['', '0', 'true', 'yes', ' 1', '1 ', '11'];
  for (const raw of nonDisabling) {
    it(`${JSON.stringify(raw)} → enabled:true, source:env (only an exact '1' disables)`, () => {
      process.env.WATCH_INGEST_FILTER_DISABLED = raw;
      expect(resolveIngestFilterEnabled()).toEqual({ enabled: true, source: 'env' });
    });
  }

  it('is memoized — a later env change is NOT observed (restart required)', () => {
    expect(resolveIngestFilterEnabled().enabled).toBe(true);
    process.env.WATCH_INGEST_FILTER_DISABLED = '1';
    expect(resolveIngestFilterEnabled()).toEqual({ enabled: true, source: 'default' });
    expect(ingestFilterEnabled()).toBe(true);
  });

  it('emits NO log line of its own — it takes no logger', () => {
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    resolveIngestFilterEnabled();
    resolveIngestFilterEnabled();
    expect(mockLogger.info).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(resolveIngestFilterEnabled.length).toBe(0);
  });

  it('the __reset companion actually clears the memo', () => {
    expect(resolveIngestFilterEnabled().enabled).toBe(true);
    process.env.WATCH_INGEST_FILTER_DISABLED = '1';
    __resetIngestFilterMemoForTests();
    expect(resolveIngestFilterEnabled().enabled).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-13 — ONE predicate: the REAL walker and hasAllowedExtension agree.
//
// Deliberately not a re-typed copy of walker.ts:278 — that would only prove the
// copy matches itself. This runs walkFiles over a fixture tree and compares.
// ────────────────────────────────────────────────────────────────────────────

describe('AC-13 — walker predicate and watch predicate cannot drift', () => {
  let root: string;

  const TABLE = [
    'film.mkv',
    'film.MKV',
    'clip.mp4',
    'poster.jpg',
    'movie.nfo',
    'subs.srt',
    'film.mkv.x265-butler.json',
    'film.mkv.x265-butler.json.tmp',
    'README',
    'archive.tar.gz',
    'show.m2ts',
    'weird.MoV',
  ];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'x265b-media-elig-'));
    for (const name of TABLE) {
      fs.writeFileSync(path.join(root, name), Buffer.alloc(2 * 1024 * 1024));
    }
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('walkFiles yields EXACTLY the entries hasAllowedExtension accepts', async () => {
    const csv = 'mkv,mp4,mov,m2ts';
    const allowed = parseExtensionCsv(csv);

    const walked: string[] = [];
    for await (const entry of walkFiles(root, {
      extensions: csv.split(','),
      minSizeMb: 0,
    })) {
      walked.push(path.basename(entry.path));
    }

    const predicted = TABLE.filter((n) => hasAllowedExtension(path.join(root, n), allowed));

    expect(walked.sort()).toEqual(predicted.sort());
    // sanity: the table is not trivially all-or-nothing
    expect(predicted.length).toBeGreaterThan(0);
    expect(predicted.length).toBeLessThan(TABLE.length);
    // the two files this plan exists for are on the REJECT side
    expect(predicted).not.toContain('film.mkv.x265-butler.json');
    expect(predicted).not.toContain('poster.jpg');
  });

  it('agrees with the walker for the DEFAULT list too', async () => {
    const allowed = normalizeExtensions(DEFAULT_MEDIA_EXTENSIONS);

    const walked: string[] = [];
    for await (const entry of walkFiles(root, {
      extensions: [...DEFAULT_MEDIA_EXTENSIONS],
      minSizeMb: 0,
    })) {
      walked.push(path.basename(entry.path));
    }

    const predicted = TABLE.filter((n) => hasAllowedExtension(path.join(root, n), allowed));
    expect(walked.sort()).toEqual(predicted.sort());
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-9 (half) — the default list is value-equal to the LIVING onboarding source
// ────────────────────────────────────────────────────────────────────────────

describe('AC-9 — DEFAULT_MEDIA_EXTENSIONS vs ONBOARDING_DEFAULT_EXT_CSV', () => {
  it('is value-equal to what a fresh install writes into shares.extensions_csv', () => {
    // Imported, not re-typed: this is the anchor that NOTICES drift. The old
    // candidate anchor (migrations/0001_initial.sql:35) is deleted by
    // migrations/0027 and could therefore never change again (audit-added M6).
    expect(DEFAULT_MEDIA_EXTENSIONS.join(',')).toBe(ONBOARDING_DEFAULT_EXT_CSV);
  });

  it('resolves to the same SET through parseExtensionCsv', () => {
    expect([...parseExtensionCsv(ONBOARDING_DEFAULT_EXT_CSV)].sort()).toEqual(
      [...normalizeExtensions(DEFAULT_MEDIA_EXTENSIONS)].sort(),
    );
  });
});
