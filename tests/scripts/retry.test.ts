import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * scripts/retry.sh wraps `crane copy` in the CI job `mirror-gitlab` (v2.50.0 mirror broke off
 * mid-upload). It must stop at the first success, give up after N attempts with the command's
 * own exit code, and run in plain POSIX sh (alpine has no bash).
 */

const ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'retry.sh');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'retry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A command that fails `failures` times with `code`, then succeeds; counts its calls. */
function flaky(failures: number, code = 7): { cmd: string; calls: () => number } {
  const counter = join(dir, 'calls');
  const cmd = join(dir, 'flaky.sh');
  writeFileSync(
    cmd,
    `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0)\nn=$((n + 1))\necho "$n" > "${counter}"\n[ "$n" -gt ${failures} ] && exit 0\nexit ${code}\n`,
    { mode: 0o755 },
  );
  return {
    cmd,
    calls: () => (existsSync(counter) ? Number(readFileSync(counter, 'utf8').trim()) : 0),
  };
}

function run(args: string[]) {
  return spawnSync('sh', [SCRIPT, ...args], {
    env: { ...process.env, RETRY_DELAY: '0' },
    encoding: 'utf8',
  });
}

describe('scripts/retry.sh', () => {
  it('runs the command once when it succeeds', () => {
    const f = flaky(0);
    const r = run(['3', f.cmd]);
    expect(r.status).toBe(0);
    expect(f.calls()).toBe(1);
  });

  it('retries until the command succeeds within the limit', () => {
    const f = flaky(2);
    const r = run(['3', f.cmd]);
    expect(r.status).toBe(0);
    expect(f.calls()).toBe(3);
    expect(r.stderr).toContain('attempt 1/3 failed (exit 7)');
    expect(r.stderr).toContain('attempt 2/3 failed (exit 7)');
  });

  it('gives up after the limit with the command exit code', () => {
    const f = flaky(5, 42);
    const r = run(['3', f.cmd]);
    expect(r.status).toBe(42);
    expect(f.calls()).toBe(3);
    expect(r.stderr).toContain('attempt 3/3 failed (exit 42), giving up');
  });

  it('passes arguments through unchanged', () => {
    const out = join(dir, 'args');
    const r = run(['1', 'sh', '-c', `printf '%s|' "$@" > "${out}"`, 'x', 'a b', 'c']);
    expect(r.status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('a b|c|');
  });

  it.each([[[]], [['3']], [['0', 'true']], [['x', 'true']]])(
    'rejects bad usage %j with exit 2 without running anything',
    (args) => {
      const r = run(args as string[]);
      expect(r.status).toBe(2);
    },
  );

  it('is wired into mirror-gitlab around crane copy with 3 attempts', () => {
    const ci = readFileSync(join(ROOT, '.gitlab-ci.yml'), 'utf8');
    const job = ci.slice(ci.indexOf('\nmirror-gitlab:'), ci.indexOf('\nbuild-image-dev:'));
    expect(job).toMatch(
      /sh scripts\/retry\.sh 3 crane copy "\$GHCR_IMAGE:\$VER" "\$CI_REGISTRY_IMAGE:\$VER"/,
    );
    expect(job).not.toMatch(/^\s*crane copy /m);
  });
});
