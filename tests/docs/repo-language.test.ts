// @vitest-environment node
// Everything written into the repository is English: docs, code comments, test titles and
// shell comments. Product translations under messages/ are the exception, and so is German used
// as data (locale assertions, umlaut fixtures), which is why only prose is scored: Markdown lines,
// comments and test titles, after removing inline code and quoted text.
//
// A line counts as German when it holds at least two different words from the list below. One
// word is not enough because a few of them double as names or abbreviations, and "die" is left
// out entirely because it is an English word.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  ROOT,
  gitRepoFiles,
  keepExisting,
  listRepoFiles,
  walkExtrasNotIgnored,
  walkRepo,
} from '../helpers/repo-files';

const GERMAN_WORDS = new Set([
  'aber',
  'alle',
  'auch',
  'auf',
  'beim',
  'bereits',
  'bleibt',
  'damit',
  'dann',
  'das',
  'dass',
  'dem',
  'den',
  'der',
  'diese',
  'dieser',
  'durch',
  'einem',
  'einen',
  'einer',
  'eines',
  'für',
  'immer',
  'ist',
  'jetzt',
  'kann',
  'kein',
  'keine',
  'keinen',
  'laut',
  'mit',
  'muss',
  'nach',
  'nicht',
  'noch',
  'nur',
  'ohne',
  'oder',
  'schon',
  'sich',
  'siehe',
  'sind',
  'soll',
  'sonst',
  'sowie',
  'statt',
  'über',
  'und',
  'unter',
  'vom',
  'weil',
  'wenn',
  'werden',
  'wie',
  'wird',
  'wurde',
  'zum',
  'zur',
  'zwischen',
]);

type Kind = 'markdown' | 'code' | 'hash' | 'sql' | 'css';

const KIND_BY_EXT: Record<string, Kind> = {
  '.md': 'markdown',
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.sh': 'hash',
  '.yml': 'hash',
  '.yaml': 'hash',
  '.sql': 'sql',
  '.css': 'css',
};

const EXCLUDED = (p: string) =>
  p.startsWith('messages/') || p.startsWith('tests/fixtures/') || p === 'package-lock.json';

export function kindOf(path: string): Kind | null {
  if (basename(path) === 'Dockerfile') return 'hash';
  return KIND_BY_EXT[extname(path)] ?? null;
}

/** Inline code and quoted passages are data, not prose. */
export function stripQuoted(text: string): string {
  return text
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .replace(/„[^“"]*[“"]/g, ' ')
    .replace(/“[^”]*”/g, ' ')
    .replace(/«[^»]*»/g, ' ');
}

export function germanWords(text: string): string[] {
  const words = stripQuoted(text)
    .toLowerCase()
    .split(/[^a-zäöüß]+/)
    .filter((w) => GERMAN_WORDS.has(w));
  return [...new Set(words)];
}

export const isGerman = (text: string) => germanWords(text).length >= 2;

const TITLE_PREFIX = /\b(?:describe|it|test)\b[\w.]*(?:\([^()]*\))?\(\s*$/;
const TITLE_AFTER_EACH = /^\s*\]\)\(\s*$/;
const HASH_COMMENT = /(?:^|\s)#(?![!{])(.*)$/;
// A slash after one of these starts a regex literal, otherwise it is a division.
const REGEX_CAN_FOLLOW = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/;

interface LexState {
  block: boolean;
  template: boolean;
  /** The previous line ended in a test function call whose title is on this line. */
  titleNext: boolean;
}

interface Lexed {
  comments: string[];
  /** String literals that are test titles. */
  titles: string[];
}

/** Index of the closing quote, or the line length when the literal runs past the line. */
function closingQuote(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === quote) return i;
  }
  return line.length;
}

function closingRegex(line: string, from: number): number {
  let inClass = false;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') i++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i;
  }
  return line.length;
}

/**
 * Splits one line of JS/TS/CSS into comments and test titles. String and regex literals are
 * skipped so that `//` or a quote inside them is not mistaken for a comment.
 */
function lexLine(line: string, state: LexState, slashComments: boolean): Lexed {
  const out: Lexed = { comments: [], titles: [] };
  let masked = '';
  let i = 0;
  let firstToken = true;
  while (i < line.length) {
    if (state.block) {
      const end = line.indexOf('*/', i);
      out.comments.push(line.slice(i, end < 0 ? line.length : end));
      if (end < 0) return out;
      state.block = false;
      i = end + 2;
      masked += ' ';
      continue;
    }
    if (state.template) {
      const end = closingQuote(line, i, '`');
      if (end < line.length) state.template = false;
      masked += ' '.repeat(end + 1 - i);
      i = end + 1;
      firstToken = false;
      continue;
    }
    const c = line[i];
    const next = line[i + 1];
    if (c === '/' && next === '*') {
      state.block = true;
      i += 2;
      continue;
    }
    if (slashComments && c === '/' && next === '/') {
      out.comments.push(line.slice(i + 2));
      return out;
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = closingQuote(line, i + 1, c);
      const isTitle =
        (state.titleNext && firstToken) ||
        TITLE_PREFIX.test(masked) ||
        TITLE_AFTER_EACH.test(masked);
      if (isTitle) out.titles.push(line.slice(i + 1, end));
      state.titleNext = false;
      if (c === '`' && end === line.length) state.template = true;
      masked += c + ' '.repeat(Math.max(0, end - i - 1)) + c;
      i = end + 1;
      firstToken = false;
      continue;
    }
    if (slashComments && c === '/' && REGEX_CAN_FOLLOW.test(masked)) {
      const end = closingRegex(line, i + 1);
      masked += ' '.repeat(end + 1 - i);
      i = end + 1;
      firstToken = false;
      continue;
    }
    if (!/\s/.test(c)) firstToken = false;
    masked += c;
    i++;
  }
  state.titleNext = TITLE_PREFIX.test(masked);
  return out;
}

/** The prose of one file: [line number, text] pairs that get scored. */
export function proseLines(kind: Kind, source: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const state: LexState = { block: false, template: false, titleNext: false };
  source.split('\n').forEach((line, i) => {
    const n = i + 1;
    if (kind === 'markdown') {
      out.push([n, line]);
    } else if (kind === 'hash') {
      const m = HASH_COMMENT.exec(line);
      if (m) out.push([n, m[1]]);
    } else if (kind === 'sql') {
      const at = line.indexOf('--');
      if (at >= 0) out.push([n, line.slice(at + 2)]);
    } else {
      const lexed = lexLine(line, state, kind === 'code');
      for (const text of [...lexed.comments, ...lexed.titles]) out.push([n, text]);
    }
  });
  return out;
}

export function germanHits(path: string, source: string): string[] {
  const kind = kindOf(path);
  if (!kind) return [];
  return proseLines(kind, source)
    .filter(([, text]) => isGerman(text))
    .map(([n, text]) => `${path}:${n}: ${text.trim().slice(0, 120)}`);
}

/**
 * German that stays on purpose. Every entry names a file, a piece of the flagged line and why it
 * is not prose. An entry that no longer matches anything fails the stale check below.
 */
const ALLOWED: Array<{ file: string; contains: string; reason: string }> = [
  {
    file: 'design-system/pages/settings.md',
    contains: 'section.minSavings.description',
    reason: 'German locale copy in the DE column of the EN/DE string table',
  },
  {
    file: 'design-system/pages/settings.md',
    contains: 'field.minSavings.helper.template',
    reason: 'German locale copy in the DE column of the EN/DE string table',
  },
  {
    file: 'design-system/pages/settings.md',
    contains: 'validation.minSavingsRange',
    reason: 'German locale copy in the DE column of the EN/DE string table',
  },
];

const allowed = (hit: string) =>
  ALLOWED.some((a) => hit.startsWith(`${a.file}:`) && hit.includes(a.contains));

function scan(files: string[]): string[] {
  return files.flatMap((f) => {
    if (!kindOf(f)) return [];
    const buf = readFileSync(join(ROOT, f));
    if (buf.includes(0)) return [];
    return germanHits(f, buf.toString('utf8'));
  });
}

describe('scoring', () => {
  // Lines copied verbatim from the tree before it was translated.
  it.each([
    [
      'components/page-layout.tsx',
      '// Konsistenz. Source-of-truth für Page-Hierarchie laut MASTER §11.',
    ],
    ['components/page-layout.tsx', '  // Daten-Pane — volle Breite für alle Datenseiten.'],
    [
      'docs/dev/renovate.md',
      '  (400 min/Monat) trägt keinen zweiten. Ist das Kontingent leer, läuft der Bot nicht und alarmiert auch nicht.',
    ],
    [
      'docs/dev/cache-path.md',
      '**Code**zeilen (Kommentare zählen nicht — mehrere erklären das Gate selbst) und',
    ],
    [
      'docs/dev/logging.md',
      '**Der Schalter filtert auf `level === 25`, bewusst NICHT auf einer Action-Liste.**',
    ],
    [
      'components/bench/bench-defaults.ts',
      '// 11-06: shared shape für 8 Bench-Settings-Defaults zwischen',
    ],
    [
      'tests/components/settings/auto-scan-advanced.test.tsx',
      '  // Trigger ist die erste Region mit role="button" + advanced-section-title text.',
    ],
  ])('real German prose is flagged (%s)', (path, line) => {
    expect(germanHits(path, line)).toHaveLength(1);
  });

  it('English prose with quoted German UI copy is not flagged', () => {
    expect(isGerman('Empty state shows "Noch keine Jobs und nicht aktiv" with a helper.')).toBe(
      false,
    );
    expect(isGerman('The DE label reads „Läuft ab in 3 Tagen und mehr“ in the table.')).toBe(false);
  });

  it('a single homograph in English prose is not flagged', () => {
    expect(isGerman('Read the das-blog post before the release.')).toBe(false);
    expect(isGerman('The Den Haag mirror is slow.')).toBe(false);
    expect(isGerman('Released under the MIT license.')).toBe(false);
  });

  it('German string literals outside comments and titles are data', () => {
    const src = "const label = 'Bitte mindestens einen Encoder auswählen, wenn nicht anders';\n";
    expect(germanHits('components/x.tsx', src)).toEqual([]);
  });

  it('test titles are prose, including titles wrapped onto the next line and after .each', () => {
    const src = [
      "it('zeigt nichts an, wenn der Filter leer ist', () => {});",
      'describe(',
      "  'wird nicht geladen, wenn die Seite offen ist',",
      '  () => {},',
      ');',
      "it.each(['a'])('ist leer und nicht sichtbar %s', () => {});",
      "])('bleibt stehen, wenn nicht gesetzt', () => {});",
    ].join('\n');
    expect(germanHits('tests/x.test.ts', src).map((h) => h.split(':')[1])).toEqual([
      '1',
      '3',
      '6',
      '7',
    ]);
  });

  it('comments in shell, SQL, CSS and block comments are prose; URLs are not comments', () => {
    expect(germanHits('scripts/x.sh', '# wird nicht gelöscht, wenn leer')).toHaveLength(1);
    expect(
      germanHits('migrations/0001_x.sql', '-- Komplementär zu 0019 und nicht mehr'),
    ).toHaveLength(1);
    expect(germanHits('app/x.css', '/* nur für den Dark-Mode */')).toHaveLength(1);
    expect(germanHits('src/x.ts', '/**\n * Wird nicht gecacht, weil\n */')).toHaveLength(1);
    expect(germanHits('src/x.ts', "fetch('https://example.com/und/nicht/wenn');")).toEqual([]);
  });

  it('Markdown is scored line by line, code fences included', () => {
    const md = ['# Title', '```bash', '# wird nicht gesetzt, wenn leer', '```'].join('\n');
    expect(germanHits('docs/x.md', md)).toHaveLength(1);
  });
});

describe('allowlist', () => {
  it('every entry carries a reason', () => {
    expect(ALLOWED.filter((a) => a.reason.trim().length < 10)).toEqual([]);
  });

  it('every entry still matches a flagged line', () => {
    const hits = scan(listRepoFiles(EXCLUDED));
    expect(
      ALLOWED.filter(
        (a) => !hits.some((h) => h.startsWith(`${a.file}:`) && h.includes(a.contains)),
      ),
    ).toEqual([]);
  });
});

describe.skipIf(gitRepoFiles() === null)('the walk used without git matches git', () => {
  it('sees every file git lists and nothing git would not ignore', () => {
    const fromGit = new Set(keepExisting(gitRepoFiles() ?? [], EXCLUDED));
    const fromWalk = keepExisting(walkRepo(EXCLUDED), EXCLUDED);
    // Tracked hidden directories at the top level are not walked; none of them holds prose
    // this guard is meant for.
    const missing = [...fromGit].filter((f) => !fromWalk.includes(f) && !f.startsWith('.'));
    expect(missing).toEqual([]);
    expect(walkExtrasNotIgnored(fromGit, fromWalk)).toEqual([]);
  });
});

describe('the repository is written in English', () => {
  it('no doc, comment or test title is German prose', () => {
    const hits = scan(listRepoFiles(EXCLUDED)).filter((h) => !allowed(h));
    expect(hits.slice(0, 200)).toEqual([]);
  });
});
