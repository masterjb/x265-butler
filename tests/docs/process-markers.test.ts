// @vitest-environment node
// Source, docs and config carry no planning markers: no plan or step IDs ("22-01"), no
// acceptance-criterion numbers, no review shorthands, no "Phase 21" / "Plan 3" or issue-list
// IDs. They point at planning notes that live outside the repository, so for anyone reading the
// code they are dead text. A comment states the reason in words instead.
//
// Whole lines are scored, not only comments: text an operator sees (a copied diagnostics report,
// a log line) or a test title in a CI log counts as much as a comment. The check covers every
// hand-written part of the tree. Left out on purpose: generated files, product translations under
// messages/, hidden directories, and the two files that define the pattern, because their test
// data and examples are markers by design.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  ROOT,
  gitRepoFiles,
  keepExisting,
  listRepoFiles,
  walkExtrasNotIgnored,
  walkRepo,
} from '../helpers/repo-files';
import { markerHits } from '../helpers/process-markers';

const CLEANED_AREAS = [
  'src/',
  'lib/',
  'migrations/',
  'scripts/',
  'docs/dev/',
  'design-system/',
  'api/',
  'app/',
  'components/',
  'tests/',
  'i18n/',
  'public/',
  'unraid/',
  'docs/public/',
  'docs/release-notes/',
];

// The guard's own corpus and the pattern's documented examples are markers on purpose.
const PATTERN_FILES = new Set([
  'tests/docs/process-markers.test.ts',
  'tests/helpers/process-markers.ts',
]);

// At the top level only text files a person writes. Without git the tree is walked, and the walk
// also sees generated root files (next-env.d.ts, build info) that git ignores.
const ROOT_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.sh',
]);
const ROOT_NAMES = new Set([
  'Dockerfile',
  '.gitignore',
  '.trivyignore',
  '.prettierignore',
  '.dockerignore',
]);

// Generated files: CHANGELOG.md from commit subjects (the history stays as it is) and lockfiles.
const EXCLUDED = (p: string) =>
  p === 'CHANGELOG.md' || p.endsWith('package-lock.json') || p.startsWith('messages/');

const BINARY = /\.(png|jpe?g|gif|ico|webp|svg|woff2?|ttf|mp4|mkv)$/i;

// Hidden directories hold local output (release logs in scripts/.logs/, caches) that git ignores
// but the walk without git would read. None is tracked; the walk check below keeps it that way.
const IN_HIDDEN_DIR = /(^|\/)\.[^/]+\//;

export function inScope(path: string): boolean {
  if (EXCLUDED(path) || BINARY.test(path) || IN_HIDDEN_DIR.test(path)) return false;
  if (PATTERN_FILES.has(path)) return false;
  if (!path.includes('/')) {
    return ROOT_NAMES.has(path) || (ROOT_EXTENSIONS.has(extname(path)) && !path.endsWith('.d.ts'));
  }
  return CLEANED_AREAS.some((a) => path.startsWith(a));
}

/**
 * Lines that match the pattern but are data, not markers. Every entry names a file, a piece of
 * the flagged line and why it stays. An entry that no longer matches fails the stale check.
 */
const ALLOWED: Array<{ file: string; contains: string; reason: string }> = [
  {
    file: 'src/lib/db/repos/stats.ts',
    contains: '10-20 Mbps',
    reason: 'bitrate bucket label returned by the stats API and stored in no plan',
  },
  {
    file: 'api/openapi.yaml',
    contains: 'Integer 10-14',
    reason: 'value range of a request field in the API description',
  },
  {
    file: 'tests/scripts/bump-version-flow.test.ts',
    contains: String.raw`Release v1\.4\.2 — Phase 4 close \(sandbox-phase\)`,
    reason: 'tag message the release script builds from the planning manifest it still reads',
  },
  {
    file: 'tests/scripts/tag-msg-regen.test.ts',
    contains: String.raw`BODY<<Release v1\.4\.2 — Phase 4 close`,
    reason: 'tag message the release script builds from the planning manifest it still reads',
  },
  {
    file: 'tests/scripts/bump-version.test.ts',
    contains: 'Release v2.51.0 — Phase 53 close (release-tooling-hardening)',
    reason: 'tag message the release script builds from the planning manifest it still reads',
  },
  {
    file: 'tests/docs/repo-language.test.ts',
    contains: '11-06: shared shape für 8 Bench-Settings-Defaults',
    reason:
      'verbatim line of the language guard corpus, copied from the tree before it was cleaned',
  },
];

const allowed = (hit: string) =>
  ALLOWED.some((a) => hit.startsWith(`${a.file}:`) && hit.includes(a.contains));

function scan(files: string[]): string[] {
  return files.filter(inScope).flatMap((f) => {
    const buf = readFileSync(join(ROOT, f));
    if (buf.includes(0)) return [];
    return markerHits(f, buf.toString('utf8'));
  });
}

describe('pattern', () => {
  // Lines copied verbatim from the tree before it was cleaned, one or more per marker kind.
  it.each([
    ['Dockerfile', '# 45-01 DUAL-BINARY: a SECOND ffmpeg used ONLY for encoder=nvenc.'],
    ['app/x.tsx', '                surface; AC-4 / AC-7 boundary: ZERO behavioral change, native'],
    ['next.config.ts', '  // audit-added M1 (01-03): pin the tracing root to this project so the'],
    ['components/x.tsx', '            screen reader a dangling reference (audit MH-1).'],
    [
      'components/x.tsx',
      "            #auto-crop in a NEW tab (SR-2) so a mid-wizard click can't destroy",
    ],
    ['middleware.ts', '// Phase 21 Plan 21-03 audit-M1: x-pathname header injection.'],
    [
      'components/x.tsx',
      '        {/* 22-01 IMP-3 T0-decision D2=A: SlowQueries full-width row-list',
    ],
    [
      'src/lib/encode/cache-path-access.ts',
      '//   - ISS-001 (36-03): the 1h log-retention sweep skipped itself entirely.',
    ],
    ['Dockerfile', '# Phase 18 (v2.15.0+): VAAPI/QSV drivers baked in to close forum-feedback gap'],
    [
      'src/lib/watch/poll-interval.ts',
      '// scaling is NOT disabled on every existing install (audit M3 / AC-8).',
    ],
    [
      'components/app-shell/topbar.tsx',
      '            18-02 reorder: Cmd+K precedes the NotificationBell per operator-feedback. */}',
    ],
    [
      'components/library/file-detail-panel.tsx',
      '      confirmTimerRef.current = null; // 28-02 R8: dead-state hygiene after fire',
    ],
    [
      'src/lib/bench/vmaf.ts',
      '// 11-02-FIX: minimal -progress pipe:1 stdout parser for bench-channel.',
    ],
    [
      'components/bench/top3-cards.tsx',
      "  // 11-02-FIX-V2 UAT-003: sum of full-file sizes for the run's fileIds",
    ],
    ['next.config.ts', '  // crashes on first DB access. See 01-03-AUDIT.md §G1.'],
  ])('a marker is flagged (%s)', (path, line) => {
    expect(markerHits(path, line)).toHaveLength(1);
  });

  // Every acceptance-test ID in the tree sat next to a plan ID, so this line is built by hand: it
  // carries the test ID alone and proves that part of the pattern on its own.
  it('an acceptance-test ID alone is flagged (constructed line)', () => {
    expect(markerHits('src/x.ts', '  // per-phase progress callback (UAT-001).')).toHaveLength(1);
  });

  it.each([
    'Released as 2.51.4, tagged v2.46.0.',
    'Changed on 2026-10-06 at 14:30:00, ISO 2026-10-06T14:30:00Z.',
    'Commit 7c368e16 fixed it.',
    'x265, h264 and 1080p sources.',
    'Dolby Digital Plus (E-AC-3) audio is copied.',
    'Stage 4 runs after the phase close.',
    'Retries 3 times within 1-5 seconds.',
    'Plan the next release.',
    'The 2026-09 nightly broke playback.',
    'Released on 06-10-2026.',
    'Verified by a manual UAT on the dev container.',
  ])('ordinary text is not flagged: %s', (line) => {
    expect(markerHits('src/x.ts', line)).toEqual([]);
  });
});

describe('scope', () => {
  it('covers the cleaned areas and hand-written root files only', () => {
    expect(inScope('src/lib/x.ts')).toBe(true);
    expect(inScope('docs/dev/logging.md')).toBe(true);
    expect(inScope('app/api/settings/route.ts')).toBe(true);
    expect(inScope('components/settings/crf-card.tsx')).toBe(true);
    expect(inScope('tests/docs/process-markers.test.ts')).toBe(false);
    expect(inScope('tests/helpers/process-markers.ts')).toBe(false);
    expect(inScope('tests/encode/ffmpeg.test.ts')).toBe(true);
    expect(inScope('unraid/x265-butler.xml')).toBe(true);
    expect(inScope('docs/release-notes/LATEST.md')).toBe(true);
    expect(inScope('Dockerfile')).toBe(true);
    expect(inScope('.gitlab-ci.yml')).toBe(true);
    expect(inScope('next-env.d.ts')).toBe(false);
    expect(inScope('tsconfig.tsbuildinfo')).toBe(false);
    expect(inScope('CHANGELOG.md')).toBe(false);
    expect(inScope('package-lock.json')).toBe(false);
    expect(inScope('api/tools/package-lock.json')).toBe(false);
    expect(inScope('messages/de.json')).toBe(false);
    expect(inScope('docs/public/CHANGELOG.md')).toBe(true);
    expect(inScope('scripts/.logs/01-phase-close-merge-20260601T100823Z.log')).toBe(false);
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
  it('walk sees the same files as git', () => {
    const fromGit = keepExisting(gitRepoFiles() ?? [], EXCLUDED).filter(inScope);
    const fromWalk = keepExisting(walkRepo(EXCLUDED), EXCLUDED).filter(inScope);
    const walked = new Set(fromWalk);
    // Tracked hidden directories at the top level are not walked; none of them is in scope.
    expect(fromGit.filter((f) => !walked.has(f) && !f.startsWith('.'))).toEqual([]);
    expect(walkExtrasNotIgnored(new Set(fromGit), fromWalk)).toEqual([]);
    const trackedInHiddenDir = keepExisting(gitRepoFiles() ?? [], EXCLUDED).filter(
      (f) => IN_HIDDEN_DIR.test(f) && CLEANED_AREAS.some((area) => f.startsWith(area)),
    );
    expect(trackedInHiddenDir).toEqual([]);
  });
});

describe('the cleaned areas carry no process markers', () => {
  it('no process markers in cleaned areas', () => {
    const hits = scan(listRepoFiles(EXCLUDED)).filter((h) => !allowed(h));
    expect(hits.slice(0, 200)).toEqual([]);
  });
});
