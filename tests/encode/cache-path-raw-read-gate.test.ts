// ISS-002 (2026-09-06): repo gate — no NEW raw `cache_pool_path` reads.
//
// WHY A GATE AND NOT JUST A FIX.
// This bug class has now shipped twice from the same root shape: a caller reads
// the setting RAW, gets '' on every install that never set an override (the
// default since 24-03 DC-B, and every upgrader after the 36-03 legacy-row
// migration), and takes a "nothing configured" branch — while the encoder is
// writing to the auto-resolved root all along.
//   ISS-001 (36-03) — the 1h log-retention sweep skipped itself.
//   ISS-002         — GET /api/logs/[jobId] and .../download answered 404
//                     log_not_found for every job, for nearly every install.
// Fixing the call sites does not stop the third one. Removing the raw read as
// an available shape does. Read through src/lib/encode/cache-path-access.ts.
//
// This gate counts a PRE-EXISTING pattern and only ever shrinks; it does not
// count anything this change introduced (the accessor addresses the setting
// through a named constant, so it is not a match).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'app', 'components'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage']);

// A raw read of the setting, in any of the shapes the codebase uses to reach a
// repo: `settingRepo().get('cache_pool_path')`, `settings.get("cache_pool_path")`, …
const RAW_READ = /\.get\(\s*['"]cache_pool_path['"]\s*\)/;

/**
 * Every file allowed to hold a raw read, with the reason. An entry here is a
 * decision, not a parking spot — a reviewer who cannot restate the reason
 * should be moving the call onto the accessor instead of extending this list.
 */
const ALLOWLIST: Record<string, string> = {
  'src/lib/diagnostics/aggregator.ts':
    'DELIBERATELY raw. `settingValue` is the diagnostics field that reports whether an ' +
    'operator override EXISTS; resolving it would erase the very distinction the field ' +
    'carries. The resolved path travels beside it in the same payload.',
  'src/lib/encode/orchestrator.ts':
    'The dispatch chokepoint (24-03 F2). It resolves INLINE on the same line and must keep ' +
    'reading through its injectable `deps.settingRepo()` — routing it via the accessor would ' +
    'take the seam the orchestrator tests depend on.',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function codeLinesOf(file: string): { line: number; text: string }[] {
  // Comments are prose ABOUT the pattern — several of them exist on purpose to
  // explain this very gate. Only executable lines count.
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    });
}

function findRawReads(): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      for (const { line, text } of codeLinesOf(file)) {
        if (RAW_READ.test(text)) hits.push({ file: rel, line, text: text.trim() });
      }
    }
  }
  return hits;
}

describe('ISS-002 gate — cache_pool_path is read in exactly one place', () => {
  it('has no raw read outside the documented allowlist', () => {
    const offenders = findRawReads().filter((h) => !(h.file in ALLOWLIST));
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Raw cache_pool_path read(s) found:\n` +
            offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n') +
            `\n\nAn UNSET setting is the DEFAULT, not an error state. Read through ` +
            `readEffectiveCachePathCached() / readEffectiveCachePathFresh() in ` +
            `src/lib/encode/cache-path-access.ts, or add this file to ALLOWLIST in ` +
            `${relative(ROOT, __filename)} WITH the reason.`,
    ).toEqual([]);
  });

  it('carries no stale allowlist entry', () => {
    // An allowlist that outlives its reason quietly re-opens the hole for the
    // next file that gets added next to a "known exception".
    const withRawRead = new Set(findRawReads().map((h) => h.file));
    const stale = Object.keys(ALLOWLIST).filter((f) => !withRawRead.has(f));
    expect(
      stale,
      `Allowlist entries no longer holding a raw read — delete them: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('the two ISS-002 log routes resolve through the accessor', () => {
    // The regression that started this: both routes 404'd before touching disk.
    for (const rel of ['app/api/logs/[jobId]/route.ts', 'app/api/logs/[jobId]/download/route.ts']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} must resolve the logs dir via the shared resolver`).toContain(
        'resolveJobLogsDir',
      );
    }
  });
});
