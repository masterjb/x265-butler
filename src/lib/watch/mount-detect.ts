// Phase 16-01 T1: mount-mode detection + inotify-budget probes.
//
// AC-5: shfs/NFS/SMB → polling-forced. Detection parses /proc/self/mountinfo
// longest-prefix-match against the share path, then maps filesystem-type to
// inotify (safe) or polling-forced (shfs/nfs*/cifs/smbfs).
//
// AC-11: max_user_watches preflight + current-budget probe for /api/health.

import fs from 'node:fs';
import type { PollingMode } from './types';

const FORCED_POLLING_FS_TYPES = new Set(['fuse.shfs', 'nfs', 'nfs4', 'cifs', 'smbfs']);

interface MountEntry {
  mountPoint: string;
  fsType: string;
}

function parseMountinfo(raw: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const parts = line.split(' ');
    // /proc/self/mountinfo format:
    //   <id> <pid> <maj:min> <root> <mount-point> <opts> [<fields>...] - <fsType> <source> <super-opts>
    // The separator '-' marks the boundary between optional fields and fsType.
    const dashIdx = parts.indexOf('-');
    if (dashIdx < 0 || dashIdx + 1 >= parts.length) continue;
    const mountPoint = parts[4];
    const fsType = parts[dashIdx + 1];
    if (!mountPoint || !fsType) continue;
    out.push({ mountPoint, fsType });
  }
  return out;
}

export function detectMountMode(absPath: string, mountinfo?: string): PollingMode {
  let raw = mountinfo;
  if (raw === undefined) {
    try {
      raw = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    } catch {
      return 'inotify';
    }
  }
  const entries = parseMountinfo(raw);
  let bestMatch: MountEntry | null = null;
  for (const e of entries) {
    if (e.mountPoint === absPath || absPath === e.mountPoint) {
      if (!bestMatch || e.mountPoint.length > bestMatch.mountPoint.length) bestMatch = e;
      continue;
    }
    const prefix = e.mountPoint === '/' ? '/' : e.mountPoint + '/';
    if (absPath.startsWith(prefix)) {
      if (!bestMatch || e.mountPoint.length > bestMatch.mountPoint.length) bestMatch = e;
    }
  }
  if (!bestMatch) return 'inotify';
  return FORCED_POLLING_FS_TYPES.has(bestMatch.fsType) ? 'polling-forced' : 'inotify';
}

export function readMaxUserWatches(reader: () => string = defaultReader): number | null {
  try {
    const raw = reader();
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function defaultReader(): string {
  return fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8');
}

// Best-effort: count process FDs that resolve to anon_inode:[inotify].
// Returns null on permission errors (non-Linux dev, sandbox).
export function countCurrentInotifyWatches(
  readdir: () => string[] = () => fs.readdirSync('/proc/self/fd'),
  readlink: (fd: string) => string = (fd) => fs.readlinkSync(`/proc/self/fd/${fd}`),
): number | null {
  let fds: string[];
  try {
    fds = readdir();
  } catch {
    return null;
  }
  let count = 0;
  for (const fd of fds) {
    try {
      const target = readlink(fd);
      if (target.includes('inotify')) count++;
    } catch {
      // skip transient FD races
    }
  }
  return count;
}
