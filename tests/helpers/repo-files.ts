// The file list the repository guards scan. With git it is what git tracks plus untracked files
// that are not ignored, so a new file is checked before its first commit. Without git (the CI test
// image) the tree is walked instead: build output and caches are left out by name, and so is every
// hidden directory at the top level, because CI keeps its npm cache in `.npm/` inside the
// checkout. Each guard compares the walk against `git ls-files` locally, so a tracked hidden
// directory added later turns red there instead of going unscanned in CI.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = process.cwd();

const NOT_TRACKED = new Set(['node_modules', '.next', 'coverage', 'data', 'dist', 'test-results']);

/** `skip` is checked for directories too, so a skipped subtree is never read. */
export function walkRepo(skip: (rel: string) => boolean = () => false, rel = ''): string[] {
  return readdirSync(join(ROOT, rel), { withFileTypes: true }).flatMap((e) => {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (NOT_TRACKED.has(e.name) || skip(child)) return [];
      if (!rel && e.name.startsWith('.')) return [];
      return walkRepo(skip, child);
    }
    return e.isFile() ? [child] : [];
  });
}

export function gitRepoFiles(): string[] | null {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return git.status === 0 && git.stdout ? git.stdout.split('\0').filter(Boolean) : null;
}

/** Existing files only: git still lists a tracked file that was deleted in the working tree. */
export function keepExisting(files: string[], skip: (rel: string) => boolean = () => false) {
  return files.filter((p) => !skip(p) && existsSync(join(ROOT, p)));
}

export function listRepoFiles(skip: (rel: string) => boolean = () => false): string[] {
  return keepExisting(gitRepoFiles() ?? walkRepo(skip), skip);
}

/** Files the walk sees that git neither tracks nor reports as untracked-but-not-ignored. */
export function walkExtrasNotIgnored(fromGit: Set<string>, fromWalk: string[]): string[] {
  const extra = fromWalk.filter((f) => !fromGit.has(f));
  if (extra.length === 0) return [];
  const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: ROOT,
    input: extra.join('\n'),
    encoding: 'utf8',
  });
  const ignored = new Set(r.stdout.split('\n').filter(Boolean));
  return extra.filter((f) => !ignored.has(f));
}
