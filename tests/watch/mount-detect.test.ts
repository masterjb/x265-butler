import { describe, it, expect, vi } from 'vitest';
import {
  detectMountMode,
  readMaxUserWatches,
  countCurrentInotifyWatches,
} from '@/src/lib/watch/mount-detect';

// Synthetic mountinfo fixture matching /proc/self/mountinfo format.
// Format: <id> <pid> <maj:min> <root> <mount> <opts> [- after fields] <fsType> <src> <super>
const MOUNTINFO_FIXTURE = [
  '21 1 0:18 / / rw,relatime - ext4 /dev/root rw',
  '52 21 0:50 / /mnt/user rw,relatime shared:1 - fuse.shfs shfs rw',
  '53 21 0:51 / /mnt/remote/nfs-share rw,relatime - nfs4 server:/export rw',
  '54 21 0:52 / /mnt/remote/cifs-share rw,relatime - cifs //server/share rw',
  '55 21 0:53 / /mnt/remote/smbfs-share rw,relatime - smbfs //srv/sm rw',
  '56 21 0:54 / /mnt/remote/nfs3-share rw,relatime - nfs server:/export rw',
  '57 21 0:55 / /mnt/extra rw,relatime - ext4 /dev/sdb1 rw',
].join('\n');

describe('detectMountMode', () => {
  it('returns polling-forced for fuse.shfs path', () => {
    expect(detectMountMode('/mnt/user/Media', MOUNTINFO_FIXTURE)).toBe('polling-forced');
  });

  it('returns polling-forced for nfs path', () => {
    expect(detectMountMode('/mnt/remote/nfs3-share/foo', MOUNTINFO_FIXTURE)).toBe('polling-forced');
  });

  it('returns polling-forced for nfs4 path', () => {
    expect(detectMountMode('/mnt/remote/nfs-share/dir', MOUNTINFO_FIXTURE)).toBe('polling-forced');
  });

  it('returns polling-forced for cifs path', () => {
    expect(detectMountMode('/mnt/remote/cifs-share', MOUNTINFO_FIXTURE)).toBe('polling-forced');
  });

  it('returns polling-forced for smbfs path', () => {
    expect(detectMountMode('/mnt/remote/smbfs-share/x', MOUNTINFO_FIXTURE)).toBe('polling-forced');
  });

  it('returns inotify for ext4 path', () => {
    expect(detectMountMode('/mnt/extra/Backups', MOUNTINFO_FIXTURE)).toBe('inotify');
  });

  it('longest-prefix-match wins (nested mount overrides root)', () => {
    // /mnt/user is shfs, /mnt/user is also under root '/' (ext4) — shfs wins
    expect(detectMountMode('/mnt/user', MOUNTINFO_FIXTURE)).toBe('polling-forced');
    // /mnt/extra is ext4 and also under root '/' (ext4) — ext4 stays inotify
    expect(detectMountMode('/mnt/extra', MOUNTINFO_FIXTURE)).toBe('inotify');
  });

  it('sub-path inherits parent mount mode', () => {
    expect(detectMountMode('/mnt/user/sub/dir/file.mkv', MOUNTINFO_FIXTURE)).toBe('polling-forced');
    expect(detectMountMode('/mnt/extra/sub/dir', MOUNTINFO_FIXTURE)).toBe('inotify');
  });

  it('falls back to inotify when /proc unreadable (no fixture)', () => {
    // Inject empty mountinfo — no entries match → inotify default.
    expect(detectMountMode('/anywhere', '')).toBe('inotify');
  });
});

describe('readMaxUserWatches', () => {
  it('parses int from sample text', () => {
    expect(readMaxUserWatches(() => '524288\n')).toBe(524288);
  });

  it('returns null when reader throws (ENOENT non-Linux)', () => {
    expect(
      readMaxUserWatches(() => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
  });
});

describe('countCurrentInotifyWatches', () => {
  it('counts FDs whose readlink target includes "inotify"', () => {
    const fds = ['0', '1', '2', '3', '4', '5'];
    const targets: Record<string, string> = {
      '0': '/dev/null',
      '1': 'pipe:[123]',
      '2': 'pipe:[124]',
      '3': 'anon_inode:[inotify]',
      '4': 'anon_inode:inotify',
      '5': 'socket:[42]',
    };
    const result = countCurrentInotifyWatches(
      () => fds,
      (fd) => targets[fd] ?? '',
    );
    expect(result).toBe(2);
  });

  it('returns null when readdir throws (EACCES)', () => {
    const readdir = vi.fn(() => {
      throw new Error('EACCES');
    });
    expect(countCurrentInotifyWatches(readdir)).toBeNull();
  });
});
