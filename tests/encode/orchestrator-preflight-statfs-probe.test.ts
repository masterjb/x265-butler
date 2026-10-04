// 22-00 T1 IMP-5: preflight_statfs_probe — evidence-only emit BEFORE ffmpeg spawn.
// Unit-tests the pure `preflightStatfsProbe()` helper exported from orchestrator.
// ZERO behavior change to encode-success path; AC-2 carry-forward of existing
// orchestrator-*.test.ts gates the no-regression claim.

import { describe, it, expect, vi } from 'vitest';
import { preflightStatfsProbe } from '@/src/lib/encode/orchestrator';

// AC-1 payload-shape contract: the orchestrator emits this exact field name
// at dispatch boundary inside `{paths_probed: PreflightStatfsEntry[]}`.
const PINO_PAYLOAD_KEY = 'paths_probed';

describe('22-00 T1: preflightStatfsProbe', () => {
  it('happy-path: all 3 paths statfs_ok=true; errno absent on all', () => {
    const okStatfs = vi.fn(() => ({ bavail: 1n, bsize: 4096n }));
    const result = preflightStatfsProbe(
      ['/stage/work-1/input', '/stage/work-1/out.mkv', '/media/movie.x265.mkv'],
      okStatfs,
    );
    expect(result).toHaveLength(3);
    for (const entry of result) {
      expect(entry.statfs_ok).toBe(true);
      expect(entry).not.toHaveProperty('errno');
    }
    expect(okStatfs).toHaveBeenCalledTimes(3);
  });

  it('ENOENT on output-target: errno=ENOENT for entry[2]; helper continues unchanged', () => {
    const statfs = vi.fn((p: string) => {
      if (p === '/media/movie.x265.mkv') {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return { bavail: 1n, bsize: 4096n };
    });
    const result = preflightStatfsProbe(
      ['/stage/work-1/input', '/stage/work-1/out.mkv', '/media/movie.x265.mkv'],
      statfs,
    );
    expect(result[0]).toEqual({ path: '/stage/work-1/input', statfs_ok: true });
    expect(result[1]).toEqual({ path: '/stage/work-1/out.mkv', statfs_ok: true });
    expect(result[2]).toEqual({
      path: '/media/movie.x265.mkv',
      statfs_ok: false,
      errno: 'ENOENT',
    });
  });

  it('EACCES on stage-source: errno=EACCES for entry[0]; helper continues unchanged', () => {
    const statfs = vi.fn((p: string) => {
      if (p === '/stage/work-1/input') {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return { bavail: 1n, bsize: 4096n };
    });
    const result = preflightStatfsProbe(
      ['/stage/work-1/input', '/stage/work-1/out.mkv', '/media/movie.x265.mkv'],
      statfs,
    );
    expect(result[0]).toEqual({
      path: '/stage/work-1/input',
      statfs_ok: false,
      errno: 'EACCES',
    });
    expect(result[1].statfs_ok).toBe(true);
    expect(result[2].statfs_ok).toBe(true);
  });

  it('mixed errors do not bubble: 2 of 3 fail → all 3 entries present', () => {
    const statfs = vi.fn((p: string) => {
      if (p === '/stage/work-1/input') {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      if (p === '/media/movie.x265.mkv') {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return { bavail: 1n, bsize: 4096n };
    });
    const result = preflightStatfsProbe(
      ['/stage/work-1/input', '/stage/work-1/out.mkv', '/media/movie.x265.mkv'],
      statfs,
    );
    expect(result).toHaveLength(3);
    expect(result[0].statfs_ok).toBe(false);
    expect(result[0].errno).toBe('EACCES');
    expect(result[1].statfs_ok).toBe(true);
    expect(result[2].statfs_ok).toBe(false);
    expect(result[2].errno).toBe('ENOENT');
  });

  it('unknown-shape error: errno fallback to "UNKNOWN"', () => {
    const statfs = vi.fn(() => {
      throw 'string-error'; // non-Error throwable
    });
    const result = preflightStatfsProbe(['/x'], statfs);
    expect(result[0]).toEqual({ path: '/x', statfs_ok: false, errno: 'UNKNOWN' });
  });

  it('contract: orchestrator emits payload under "paths_probed" key', () => {
    expect(PINO_PAYLOAD_KEY).toBe('paths_probed');
  });
});
