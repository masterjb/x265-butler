import path from 'node:path';
import { SHARE_TRASH_DIR, type TrashLocation } from '../encode/trash-defaults';

// Decides under which root the trash subtree of one original is built.
// Order: an explicit trash_path wins; otherwise the location setting decides
// between the share of the file and the cache path. A share that cannot be
// resolved falls back to the cache path so a commit never fails over it.

export type TrashRootSource = 'path' | 'share' | 'cache';

export interface TrashRootInput {
  trashPath: string | null | undefined;
  location: TrashLocation;
  stageRoot: string;
  sharePath: string | null | undefined;
}

export interface TrashRootResult {
  root: string;
  source: TrashRootSource;
  fallbackReason?: 'share_unresolved';
}

export function shareTrashRoot(sharePath: string): string {
  return path.join(sharePath, SHARE_TRASH_DIR);
}

export function resolveTrashRoot(input: TrashRootInput): TrashRootResult {
  if (input.trashPath && input.trashPath.trim() !== '') {
    return { root: input.trashPath, source: 'path' };
  }
  if (input.location === 'share') {
    const sp = input.sharePath;
    // '/' as a share would put the trash at the filesystem root; a relative
    // path is never a valid share. Both fall back.
    if (sp && path.isAbsolute(sp) && path.normalize(sp) !== '/') {
      return { root: shareTrashRoot(path.normalize(sp)), source: 'share' };
    }
    return { root: input.stageRoot, source: 'cache', fallbackReason: 'share_unresolved' };
  }
  return { root: input.stageRoot, source: 'cache' };
}
