import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nextPatch } from '../../scripts/renovate-bump-patch.js';

/**
 * Renovate runs scripts/renovate-bump-patch.js as a post-upgrade task (renovate.json) in its
 * checkout of dev: files already updated, nothing committed yet, HEAD = the base commit. The
 * task runs once per upgrade, so a group MR with several runtime dependencies calls it several
 * times. It must therefore set "base version + 1", never "current + 1".
 *
 * The CI test image (node:22-trixie-slim) has no git, so the checkout gets a stand-in `git` on
 * PATH that answers exactly the one call the script makes, `git show HEAD:package.json`, from
 * the stored base commit, and fails like git outside a repository otherwise.
 */

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'renovate-bump-patch.js');

const FAKE_GIT = `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const args = process.argv.slice(2);
try {
  if (args.join(' ') !== 'show HEAD:package.json') throw new Error('unsupported');
  process.stdout.write(readFileSync('.base-commit-package.json', 'utf8'));
} catch {
  process.stderr.write('fatal: not a git repository\\n');
  process.exit(128);
}
`;

/** Stand-in for `git commit`: what HEAD:package.json returns from now on. */
function commitBase(dir: string) {
  writeFileSync(join(dir, '.base-commit-package.json'), readFileSync(join(dir, 'package.json')));
}

function fakeGitBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'renovate-bump-bin-'));
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), FAKE_GIT);
  chmodSync(join(bin, 'git'), 0o755);
  return bin;
}
const BIN = fakeGitBin();

function writeRepo(dir: string, version: string) {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'x', version, dependencies: { a: '^1.0.0' } }, null, 2) + '\n',
  );
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify(
      { name: 'x', version, lockfileVersion: 3, packages: { '': { name: 'x', version } } },
      null,
      2,
    ) + '\n',
  );
}

function versions(dir: string) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  return { pkg: pkg.version, lock: lock.version, lockRoot: lock.packages[''].version, pkgObj: pkg };
}

function run(cwd: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}` },
  });
}

describe('nextPatch', () => {
  it('raises the third digit by one', () => {
    expect(nextPatch('2.49.5')).toBe('2.49.6');
  });
  it('carries no digit over (2.49.9 -> 2.49.10)', () => {
    expect(nextPatch('2.49.9')).toBe('2.49.10');
  });
  it('rejects anything that is not a plain X.Y.Z', () => {
    expect(() => nextPatch('2.49')).toThrow();
    expect(() => nextPatch('2.49.5-rc.1')).toThrow();
  });
});

describe('renovate-bump-patch.js in a Renovate-like checkout', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'renovate-bump-'));
    writeRepo(dir, '2.49.5');
    commitBase(dir);
    // Renovate's dependency change, uncommitted, as in the real checkout.
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    pkg.dependencies.a = '^1.1.0';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets base + 1 in package.json and both lockfile fields, keeps the dependency change', () => {
    const r = run(dir);
    expect(r.status, r.stderr).toBe(0);
    const v = versions(dir);
    expect(v).toMatchObject({ pkg: '2.49.6', lock: '2.49.6', lockRoot: '2.49.6' });
    expect(v.pkgObj.dependencies.a).toBe('^1.1.0');
  });

  it('is idempotent: a group MR calling it three times still ends at base + 1', () => {
    for (let i = 0; i < 3; i++) expect(run(dir).status).toBe(0);
    expect(versions(dir)).toMatchObject({ pkg: '2.49.6', lock: '2.49.6', lockRoot: '2.49.6' });
  });

  it('counts from the base commit, not from the working tree', () => {
    writeRepo(dir, '2.49.40'); // stray value in the working tree
    expect(run(dir).status).toBe(0);
    expect(versions(dir).pkg).toBe('2.49.6');
  });

  it('fails without a base commit and leaves the files untouched', () => {
    const bare = mkdtempSync(join(tmpdir(), 'renovate-bump-nogit-'));
    try {
      writeRepo(bare, '2.49.5');
      const r = run(bare);
      expect(r.status).not.toBe(0);
      expect(versions(bare).pkg).toBe('2.49.5');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('renovate.json wires the bump task', () => {
  const ROOT = resolve(__dirname, '..', '..');
  const config = JSON.parse(readFileSync(join(ROOT, 'renovate.json'), 'utf8')) as {
    packageRules: Array<Record<string, unknown> & { postUpgradeTasks?: { commands: string[] } }>;
  };
  const bumpRules = config.packageRules.filter((r) =>
    r.postUpgradeTasks?.commands.includes('node scripts/renovate-bump-patch.js'),
  );

  it('bumps for runtime dependencies/overrides, Dockerfile base images and lockfile maintenance', () => {
    const keys = bumpRules.map((r) =>
      JSON.stringify([r.matchManagers, r.matchDepTypes, r.matchUpdateTypes]),
    );
    expect(keys).toEqual([
      JSON.stringify([['npm'], ['dependencies', 'overrides'], undefined]),
      JSON.stringify([['dockerfile'], undefined, undefined]),
      JSON.stringify([undefined, undefined, ['lockFileMaintenance']]),
    ]);
  });

  it('runs per update and only writes package.json and package-lock.json', () => {
    for (const r of bumpRules) {
      expect(r.postUpgradeTasks).toEqual({
        commands: ['node scripts/renovate-bump-patch.js'],
        fileFilters: ['package.json', 'package-lock.json'],
        executionMode: 'update',
      });
    }
  });

  it('points at the script that exists in the repo', () => {
    expect(readFileSync(SCRIPT, 'utf8')).toContain('export function nextPatch');
  });
});
