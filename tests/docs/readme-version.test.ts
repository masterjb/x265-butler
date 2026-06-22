import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Drift-prevention test added in Phase 19 Plan 03 (Tag-Strategy-Simplification).
 *
 * Existing infrastructure (scripts/bump-version.js) auto-updates:
 *   package.json + version metadata + CHANGELOG.md + /api/health + frontend footer
 *
 * NOT auto-updated: README.md. Drift-evidence: README.md historically
 * shipped `:1.5.1` pin from M1-MVP through M2-P19 (over 11 months of
 * version-drift without operator-visible inconsistency).
 *
 * This test asserts README.md stays in sync with package.json at every
 * commit (not just at the automated version bump). CI gate: `npm test` runs
 * this in the standard test suite. Failure surfaces at PR-time.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const README_PATH = resolve(REPO_ROOT, 'README.md');
const PKG_PATH = resolve(REPO_ROOT, 'package.json');

function parseSemver(v: string): [number, number, number] {
  const parts = v.split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`malformed semver: ${v}`);
  }
  return [parts[0], parts[1], parts[2]];
}

function compareSemver(a: string, b: string): number {
  const [aMa, aMi, aPa] = parseSemver(a);
  const [bMa, bMi, bPa] = parseSemver(b);
  return aMa - bMa || aMi - bMi || aPa - bPa;
}

describe('README.md version-currency', () => {
  const readme = readFileSync(README_PATH, 'utf-8');
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8')) as { version: string };
  const currentVersion = pkg.version;
  const [currentMajor] = parseSemver(currentVersion);

  it(`every ghcr.io/masterjb/x265-butler:X.Y.Z literal has Major matching current (${currentMajor}.x.x)`, () => {
    const pinRegex = /ghcr\.io\/masterjb\/x265-butler:(\d+\.\d+\.\d+)/g;
    const violations: string[] = [];
    for (const match of readme.matchAll(pinRegex)) {
      const pinned = match[1];
      const [pinMajor] = parseSemver(pinned);
      if (pinMajor !== currentMajor) {
        violations.push(
          `README pins :${pinned} but current Major is ${currentMajor} (package.json ${currentVersion})`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it(`every "since vX.Y.Z" phrase references a version <= current (${currentVersion})`, () => {
    const sinceRegex = /since v(\d+\.\d+\.\d+)/g;
    const violations: string[] = [];
    for (const match of readme.matchAll(sinceRegex)) {
      const phrased = match[1];
      if (compareSemver(phrased, currentVersion) > 0) {
        violations.push(
          `README claims "since v${phrased}" but current is ${currentVersion} — future-version claim`,
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('does NOT contain the obsolete "do NOT use :latest" anti-recommendation (Plan 19-03 flipped strategy)', () => {
    // Pre-19-03: README said "do NOT use :latest or :1.x" (line 131-era).
    // Post-19-03: :latest is the RECOMMENDED auto-update tag (with warning blockquote
    // for operators preferring exact-pin stability). The anti-recommendation phrase
    // is incompatible with the new strategy.
    expect(
      readme,
      'README still contains anti-:latest recommendation incompatible with Plan 19-03 strategy',
    ).not.toMatch(/do NOT use\s+[`'"]?:latest/i);
  });

  it('mentions :latest at least 3 times (strategy-discoverability gate)', () => {
    // Post-19-03 README MUST surface :latest as a documented tag option in at least
    // 3 contexts: tag-list / warning / migration. Catches accidental removal of
    // the Docker Tag Strategy section by future edits.
    const matches = readme.match(/:latest/g) ?? [];
    expect(
      matches.length,
      `expected >=3 :latest mentions, found ${matches.length}`,
    ).toBeGreaterThanOrEqual(3);
  });
});
