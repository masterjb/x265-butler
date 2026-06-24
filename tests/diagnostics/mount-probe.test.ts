// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShareRow } from '@/src/lib/db/schema';

const { mockAccess, mockListAll } = vi.hoisted(() => ({
  mockAccess: vi.fn<(path: string, mode?: number) => Promise<void>>(),
  mockListAll: vi.fn<() => ShareRow[]>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: mockAccess,
    constants: actual.constants,
  };
});

vi.mock('@/src/lib/db', () => ({
  shareRepo: () => ({ listAll: mockListAll }),
}));

import { probeMounts } from '@/src/lib/diagnostics/mount-probe';

function shareRow(id: number, name: string, path: string): ShareRow {
  return {
    id,
    name,
    path,
    min_size_mb: 0,
    extensions_csv: 'mkv,mp4',
    max_depth: null,
    created_at: 0,
    updated_at: 0,
  } as ShareRow;
}

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('probeMounts', () => {
  beforeEach(() => {
    mockAccess.mockReset();
    mockListAll.mockReset();
    mockListAll.mockReturnValue([]);
  });

  it('all paths readable+writable → all entries OK with no error', async () => {
    mockAccess.mockResolvedValue();
    const result = await probeMounts();
    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r.readable).toBe(true);
      expect(r.writable).toBe(true);
      expect(r.error).toBeUndefined();
    }
  });

  it('/media ENOENT → entry has readable:false, writable:false, error:ENOENT', async () => {
    mockAccess.mockImplementation(async (p: string) => {
      if (p === '/media') throw errno('ENOENT');
    });
    const result = await probeMounts();
    const media = result.find((r) => r.path === '/media');
    expect(media).toBeDefined();
    expect(media?.readable).toBe(false);
    expect(media?.writable).toBe(false);
    expect(media?.error).toBe('ENOENT');
  });

  it('readable but not writable (EACCES on W_OK) → readable:true writable:false error:EACCES', async () => {
    const fs = await import('node:fs/promises');
    mockAccess.mockImplementation(async (p: string, mode?: number) => {
      if (p === '/cache' && mode === fs.constants.W_OK) throw errno('EACCES');
    });
    const result = await probeMounts();
    const cache = result.find((r) => r.path === '/cache');
    expect(cache?.readable).toBe(true);
    expect(cache?.writable).toBe(false);
    expect(cache?.error).toBe('EACCES');
  });

  it('shareRepo throws → static-only probe runs, dynamic set empty', async () => {
    mockAccess.mockResolvedValue();
    mockListAll.mockImplementation(() => {
      throw new Error('db unavailable');
    });
    const result = await probeMounts();
    const paths = result.map((r) => r.path).sort();
    expect(paths).toEqual(['/cache', '/config', '/media']);
  });

  it('share rootPath /media (duplicate) → only one entry', async () => {
    mockAccess.mockResolvedValue();
    mockListAll.mockReturnValue([shareRow(1, 'media-share', '/media')]);
    const result = await probeMounts();
    expect(result.filter((r) => r.path === '/media')).toHaveLength(1);
  });

  it('empty share list → static-only probe', async () => {
    mockAccess.mockResolvedValue();
    mockListAll.mockReturnValue([]);
    const result = await probeMounts();
    expect(result.map((r) => r.path).sort()).toEqual(['/cache', '/config', '/media']);
  });

  it('extra share path included in probe', async () => {
    mockAccess.mockResolvedValue();
    mockListAll.mockReturnValue([shareRow(1, 'movies', '/mnt/user/Movies')]);
    const result = await probeMounts();
    expect(result.some((r) => r.path === '/mnt/user/Movies')).toBe(true);
  });
});
