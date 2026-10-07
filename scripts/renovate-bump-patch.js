#!/usr/bin/env node
// Renovate post-upgrade task (renovate.json): raise the third version digit by one in
// package.json and package-lock.json when an update changes what ships in the image.
//
// Renovate runs it in its checkout of dev with the update applied but not committed, so HEAD
// is the base commit. It runs once per upgrade (a group MR may call it several times), hence
// it always writes "base version + 1" read from HEAD, never "current + 1". Allowed in the bot
// via allowedCommands in MisterJB/renovate-bot config.js. Background: docs/dev/renovate.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const SEMVER_TRIPLE = /^(\d+)\.(\d+)\.(\d+)$/;

/** @param {string} version */
export function nextPatch(version) {
  const m = SEMVER_TRIPLE.exec(version);
  if (!m) throw new Error(`not a plain X.Y.Z version: ${version}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function main() {
  const cwd = process.cwd();
  const base = JSON.parse(
    execFileSync('git', ['show', 'HEAD:package.json'], { cwd, encoding: 'utf8' }),
  ).version;
  const next = nextPatch(base);

  const pkgPath = resolve(cwd, 'package.json');
  const lockPath = resolve(cwd, 'package-lock.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  pkg.version = next;
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  console.log(`renovate-bump-patch: ${base} -> ${next}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
