import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

export type FileEntry = {
  path: string;
  size: number;
  mtime: number;
};

export type WalkOptions = {
  extensions: string[];
  minSizeMb: number;
  maxDepth?: number;
};

const DEFAULT_MAX_DEPTH = 12;

function normalizeExtensions(extensions: string[]): Set<string> {
  return new Set(
    extensions.map((e) => e.toLowerCase().replace(/^\./, '')).filter((e) => e.length > 0),
  );
}

export async function* walkFiles(root: string, opts: WalkOptions): AsyncGenerator<FileEntry> {
  if (!path.isAbsolute(root)) {
    throw new Error(`walkFiles: root must be absolute, got: ${root}`);
  }
  let rootStat: fs.Stats;
  try {
    rootStat = await fs.promises.stat(root);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`walkFiles: root not accessible: ${root} (${cause})`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`walkFiles: root is not a directory: ${root}`);
  }

  const minBytes = opts.minSizeMb * 1024 * 1024;
  const allowedExts = normalizeExtensions(opts.extensions);
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  // audit-added S1: track visited inodes to break bind-mount / FUSE remount
  // loops that the symlink check does not catch.
  const visitedInodes = new Set<string>();

  yield* walkDir(root, 0, allowedExts, minBytes, maxDepth, visitedInodes);
}

async function* walkDir(
  dir: string,
  depth: number,
  allowedExts: Set<string>,
  minBytes: number,
  maxDepth: number,
  visitedInodes: Set<string>,
): AsyncGenerator<FileEntry> {
  if (depth > maxDepth) return;

  let dirStat: fs.Stats;
  try {
    dirStat = await fs.promises.stat(dir);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), dir },
      'walker: stat failed on directory',
    );
    return;
  }
  const inodeKey = `${dirStat.dev}:${dirStat.ino}`;
  if (visitedInodes.has(inodeKey)) {
    logger.warn(
      { dir, inodeKey },
      'walker: directory inode already visited (bind-mount loop?), skipping',
    );
    return;
  }
  visitedInodes.add(inodeKey);

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), dir },
      'walker: readdir failed, skipping directory',
    );
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      yield* walkDir(fullPath, depth + 1, allowedExts, minBytes, maxDepth, visitedInodes);
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '');
    if (!allowedExts.has(ext)) continue;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), file: fullPath },
        'walker: stat failed on file, skipping',
      );
      continue;
    }

    if (stat.size < minBytes) continue;

    yield {
      path: fullPath,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs / 1000),
    };
  }
}
