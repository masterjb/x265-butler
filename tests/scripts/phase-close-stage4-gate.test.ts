// ISS-003 (2026-09-06): stage 4 of the phase-close orchestrator must not publish
// a snapshot whose curated changelog predates the tag — and the closing line must
// report what stage 4 ACTUALLY did.
//
// WHAT WENT WRONG. `publish-public.sh` exports `git archive HEAD` and curates the
// public README + CHANGELOG from docs/public/. When stage 4 runs, HEAD is the
// `chore(release)` commit: stage 3 has just written the release-note SCAFFOLDS
// (uncommitted, TODO-filled) and docs/public/CHANGELOG.md still ends at the
// PREVIOUS version. Publishing there force-pushes a public snapshot tagged vX.Y.Z
// whose changelog never mentions X.Y.Z.
//
// It never actually happened, for the wrong reason: those scaffolds made the tree
// dirty, publish-public's own pre-flight aborted, and stage 4 "failed" on EVERY
// close — doing the right thing while reporting a fault, then contradicting itself
// with `✓ … + public mirror published.` four lines below its own FAILED warning.
//
// Verified against history: at commit v2.48.0, docs/public/CHANGELOG.md carries
// `## [2.47.0]` and NOT `## [2.48.0]`. The gate added here would have deferred.
//
// These tests execute the REAL fragments out of the shell script rather than a
// transcription, so a future edit that drops them fails here.
//
// GIT-DEPENDENT CASES (2026-09-29): the gate itself runs `git show HEAD:…`, and
// the history case needs the v2.48.0 tag. The CI test image (node:22-trixie-slim)
// ships no git, and a depth-20 clone carries no old tags. Without git the gate
// errors and prints DEFER, so the two "must defer" cases would PASS for the wrong
// reason while "publishes" fails. They are skipped there instead, visibly, and
// run wherever git + history exist (locally, and before every phase close).

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', '00-phase-close.sh');
const source = readFileSync(SCRIPT, 'utf8');

const HAS_GIT = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ROOT }).status === 0;
const HAS_V248_TAG =
  HAS_GIT &&
  spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/v2.48.0'], { cwd: ROOT }).status ===
    0;

function bash(script: string): string {
  return execFileSync('bash', ['-c', script], { cwd: ROOT, encoding: 'utf8' });
}

/** Run the gate function lifted verbatim out of the script. */
function gateSaysPublish(tag: string): boolean {
  const out = bash(
    `eval "$(sed -n '/^curated_changelog_has_version() {/,/^}/p' scripts/00-phase-close.sh)"\n` +
      `BARE_VERSION="${tag.replace(/^v/, '')}"\n` +
      `if curated_changelog_has_version; then echo PUBLISH; else echo DEFER; fi`,
  );
  return out.trim() === 'PUBLISH';
}

/** Run the closing-line case block lifted verbatim out of the script. */
function closingLine(result: string): string {
  return bash(
    `TAG=v9.9.9\nPUBLISH_HELPER=scripts/publish-public.sh\nPUBLISH_RESULT=${result}\n` +
      `eval "$(sed -n '/^case "\\$PUBLISH_RESULT" in/,/^esac/p' scripts/00-phase-close.sh)"`,
  );
}

describe('ISS-003 — stage 4 publishes only a snapshot that describes the release', () => {
  it('the script parses', () => {
    expect(() => execFileSync('bash', ['-n', SCRIPT], { cwd: ROOT })).not.toThrow();
  });

  it.skipIf(!HAS_GIT)('defers when the curated changelog has no entry for the tag', () => {
    expect(gateSaysPublish('v2.99.0')).toBe(false);
  });

  it.skipIf(!HAS_GIT)('publishes once the curated changelog carries the version', () => {
    // 2.48.0 was written into docs/public/CHANGELOG.md after its tag; on HEAD it is there.
    expect(gateSaysPublish('v2.48.0')).toBe(true);
  });

  it.skipIf(!HAS_GIT)('does not match a version on a prefix (2.4 must not satisfy 2.48.0)', () => {
    expect(gateSaysPublish('v2.4')).toBe(false);
  });

  it.skipIf(!HAS_V248_TAG)(
    'would have deferred at the v2.48.0 tag — the case that motivated this',
    () => {
      const changelogAtTag = bash('git show v2.48.0:docs/public/CHANGELOG.md');
      expect(changelogAtTag).toContain('## [2.47.0]');
      expect(changelogAtTag).not.toContain('## [2.48.0]');
    },
  );

  it('checks HEAD, not the worktree — the snapshot is built from git archive HEAD', () => {
    expect(source).toContain('git -C "$REPO_ROOT" show "HEAD:docs/public/CHANGELOG.md"');
  });
});

describe('ISS-003 — the closing line reports the real outcome', () => {
  it('claims the mirror ONLY after an actual publish', () => {
    expect(closingLine('published')).toContain('public mirror published');
    for (const r of ['skipped-flag', 'skipped-premature', 'skipped-no-helper', 'failed']) {
      expect(closingLine(r), `${r} must not claim the mirror`).not.toContain(
        'public mirror published',
      );
    }
  });

  it('still states the release itself shipped in every non-publish outcome', () => {
    // Stage 4 is downstream distribution: its outcome must never read as a failed release.
    for (const r of ['skipped-premature', 'skipped-no-helper', 'failed']) {
      expect(closingLine(r), r).toMatch(/RELEASED: MR merged \+ tag pushed/);
    }
  });

  it('names the follow-up command whenever the mirror is outstanding', () => {
    for (const r of ['skipped-premature', 'skipped-no-helper', 'failed']) {
      expect(closingLine(r), r).toContain('NOT');
    }
    expect(closingLine('skipped-premature')).toContain('scripts/publish-public.sh');
  });
});
