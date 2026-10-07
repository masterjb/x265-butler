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
import { aggregateWarnings } from '@/src/lib/diagnostics/warnings-aggregator';

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
    // /config + /cache (exists); /media only via a share.
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.readable).toBe(true);
      expect(r.writable).toBe(true);
      expect(r.error).toBeUndefined();
    }
  });

  it('share /media ENOENT → entry has readable:false, writable:false, error:ENOENT', async () => {
    mockAccess.mockImplementation(async (p: string) => {
      if (p === '/media') throw errno('ENOENT');
    });
    mockListAll.mockReturnValue([shareRow(1, 'media-share', '/media')]);
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
    expect(paths).toEqual(['/cache', '/config']);
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
    expect(result.map((r) => r.path).sort()).toEqual(['/cache', '/config']);
  });

  it('extra share path included in probe', async () => {
    mockAccess.mockResolvedValue();
    mockListAll.mockReturnValue([shareRow(1, 'movies', '/mnt/user/Movies')]);
    const result = await probeMounts();
    expect(result.some((r) => r.path === '/mnt/user/Movies')).toBe(true);
  });
});

// Only mapped paths are probed. Static /media is gone (every configured
// share is probed dynamically; an unmapped /media without a share is no fault),
// /cache is probed only when it exists (the Cache Pool is optional).
describe('probeMounts — only mapped paths', () => {
  beforeEach(() => {
    mockAccess.mockReset();
    mockListAll.mockReset();
    mockListAll.mockReturnValue([]);
  });

  function warningsFor(result: Awaited<ReturnType<typeof probeMounts>>) {
    return aggregateWarnings({
      encoders: { warnings: [] },
      mountProbe: result,
      onboardingCompleted: true,
      hasShare: true,
    }).filter((w) => w.source === 'mount');
  }

  it('no share on /media → no /media entry and no mount warning', async () => {
    mockAccess.mockImplementation(async (p: string) => {
      if (p === '/media') throw errno('EACCES');
    });
    const result = await probeMounts();
    expect(result.find((r) => r.path === '/media')).toBeUndefined();
    expect(warningsFor(result).some((w) => w.message.includes('/media'))).toBe(false);
  });

  it('/cache ENOENT → no /cache entry and no mount:ENOENT warning', async () => {
    mockAccess.mockImplementation(async (p: string) => {
      if (p === '/cache') throw errno('ENOENT');
    });
    const result = await probeMounts();
    expect(result.find((r) => r.path === '/cache')).toBeUndefined();
    expect(warningsFor(result).some((w) => w.code === 'ENOENT')).toBe(false);
  });

  it('/cache exists but W_OK EACCES → error entry + error warning', async () => {
    const fs = await import('node:fs/promises');
    mockAccess.mockImplementation(async (p: string, mode?: number) => {
      if (p === '/cache' && mode === fs.constants.W_OK) throw errno('EACCES');
    });
    const result = await probeMounts();
    const cache = result.find((r) => r.path === '/cache');
    expect(cache).toEqual({ path: '/cache', readable: true, writable: false, error: 'EACCES' });
    const w = warningsFor(result).find((x) => x.message.includes('/cache'));
    expect(w?.severity).toBe('error');
  });

  it('/cache F_OK fails with non-ENOENT → still probed', async () => {
    mockAccess.mockImplementation(async (p: string) => {
      if (p === '/cache') throw errno('EACCES');
    });
    const result = await probeMounts();
    expect(result.find((r) => r.path === '/cache')?.error).toBe('EACCES');
  });

  it('share /library ENOENT → entry kept with error', async () => {
    mockAccess.mockImplementation(async (p: string) => {
      if (p === '/library') throw errno('ENOENT');
    });
    mockListAll.mockReturnValue([shareRow(1, 'Library', '/library')]);
    const result = await probeMounts();
    expect(result.find((r) => r.path === '/library')).toEqual({
      path: '/library',
      readable: false,
      writable: false,
      error: 'ENOENT',
    });
    expect(warningsFor(result).some((w) => w.message.includes('/library'))).toBe(true);
  });

  it('share /media ENOENT (placeholder, unmapped) → entry kept with error', async () => {
    mockAccess.mockImplementation(async (p: string) => {
      if (p === '/media') throw errno('ENOENT');
    });
    mockListAll.mockReturnValue([shareRow(1, 'Library', '/media')]);
    const result = await probeMounts();
    expect(result.find((r) => r.path === '/media')?.error).toBe('ENOENT');
  });

  it('/config EACCES → entry kept with error', async () => {
    const fs = await import('node:fs/promises');
    mockAccess.mockImplementation(async (p: string, mode?: number) => {
      if (p === '/config' && mode === fs.constants.W_OK) throw errno('EACCES');
    });
    const result = await probeMounts();
    expect(result.find((r) => r.path === '/config')?.error).toBe('EACCES');
  });
});
