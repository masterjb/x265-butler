/*
 * 26-01 (F3): sidecar location mode — resolveSidecarTarget (pure resolver) +
 * writeSidecarResolved (mode-aware atomic write with central mkdir + soft-degrade).
 *
 * Mocks node:fs/promises (mirrors sidecar.test.ts) so mkdir/write/rename/unlink
 * are deterministic + CI-safe. Asserts:
 *   - off → null / no write (AC-2)
 *   - beside → sidecarPathFor, byte-identical, NO mkdir (AC-1 surface)
 *   - central → mirrored tree, recursive mkdir BEFORE rename (AC-3)
 *   - central mkdir failure soft-degrades (warn, never throws) (AC-3 / S3)
 *   - path-traversal guard rejects an escaping central target
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWriteFile, mockRename, mockUnlink, mockMkdir, mockLogger } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(),
  mockRename: vi.fn(),
  mockUnlink: vi.fn(),
  mockMkdir: vi.fn(),
  mockLogger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('node:fs', () => {
  const promises = {
    writeFile: mockWriteFile,
    rename: mockRename,
    unlink: mockUnlink,
    mkdir: mockMkdir,
    // unused by these tests but referenced at module load
    stat: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
  };
  return { promises, default: { promises } };
});

vi.mock('@/src/lib/logger', () => ({ logger: mockLogger }));

import {
  resolveSidecarTarget,
  writeSidecarResolved,
  sidecarPathFor,
  type SidecarV2,
} from '@/src/lib/encode/sidecar';

const PAYLOAD: SidecarV2 = {
  schema: 'x265-butler/v2',
  processedBy: 'x265-butler',
  version: '2.23.0',
  gitHash: 'deadbee',
  processedAt: '2026-06-01T00:00:00.000Z',
  source: { filename: 'x.mkv', contentHash: 'a'.repeat(64), sizeBytes: 100 },
  output: { filename: 'x.x265.mkv', contentHash: 'b'.repeat(64), sizeBytes: 50 },
  encoder: 'libx265',
  quality: { mode: 'crf', value: 23 },
  outcome: 'done-smaller',
};

const CENTRAL = '/config/x265-butler/sidecars/';

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('resolveSidecarTarget (26-01 F3)', () => {
  it('off → null (no write target)', () => {
    expect(resolveSidecarTarget('/media/movies/x.mkv', 'off', CENTRAL)).toBeNull();
  });

  it('beside → sidecarPathFor (byte-identical to pre-26-01)', () => {
    const target = '/media/movies/x.mkv';
    expect(resolveSidecarTarget(target, 'beside', CENTRAL)).toBe(sidecarPathFor(target));
    expect(resolveSidecarTarget(target, 'beside', CENTRAL)).toBe(
      '/media/movies/x.mkv.x265-butler.json',
    );
  });

  it('central → mirrored source-tree under centralRoot + suffix', () => {
    expect(resolveSidecarTarget('/media/movies/x.mkv', 'central', CENTRAL)).toBe(
      '/config/x265-butler/sidecars/media/movies/x.mkv.x265-butler.json',
    );
  });

  it('central strips ALL leading separators (no double-slash join)', () => {
    expect(resolveSidecarTarget('/media/x.mkv', 'central', CENTRAL)).toBe(
      '/config/x265-butler/sidecars/media/x.mkv.x265-butler.json',
    );
  });

  it('path-traversal guard: a ../-escaping target THROWS (defense-in-depth)', () => {
    // `/../../etc/passwd` → strip leading seps → `../../etc/passwd` → path.join
    // escapes centralRoot → the resolved-final-under-root invariant must fire.
    expect(() => resolveSidecarTarget('/../../etc/passwd', 'central', CENTRAL)).toThrow(
      /escapes root/,
    );
  });

  it('path-traversal guard: ../ that stays inside the root is allowed', () => {
    const r = resolveSidecarTarget('/media/../movies/x.mkv', 'central', CENTRAL);
    expect(r?.startsWith('/config/x265-butler/sidecars/')).toBe(true);
    expect(r).toBe('/config/x265-butler/sidecars/movies/x.mkv.x265-butler.json');
  });
});

describe('writeSidecarResolved (26-01 F3)', () => {
  it('off → NO fs write at all (AC-2)', async () => {
    await writeSidecarResolved('/media/movies/x.mkv', PAYLOAD, 'off', CENTRAL);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it('beside → tmp+rename to sidecarPathFor, NO mkdir (AC-1 surface)', async () => {
    await writeSidecarResolved('/media/movies/x.mkv', PAYLOAD, 'beside', CENTRAL);
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledWith(
      '/media/movies/x.mkv.x265-butler.json.tmp',
      expect.any(String),
    );
    expect(mockRename).toHaveBeenCalledWith(
      '/media/movies/x.mkv.x265-butler.json.tmp',
      '/media/movies/x.mkv.x265-butler.json',
    );
  });

  it('central → recursive mkdir of parent BEFORE the atomic tmp+rename (AC-3)', async () => {
    const order: string[] = [];
    mockMkdir.mockImplementation(async () => {
      order.push('mkdir');
    });
    mockWriteFile.mockImplementation(async () => {
      order.push('writeFile');
    });
    mockRename.mockImplementation(async () => {
      order.push('rename');
    });
    await writeSidecarResolved('/media/movies/x.mkv', PAYLOAD, 'central', CENTRAL);
    expect(mockMkdir).toHaveBeenCalledWith('/config/x265-butler/sidecars/media/movies', {
      recursive: true,
    });
    expect(mockRename).toHaveBeenCalledWith(
      '/config/x265-butler/sidecars/media/movies/x.mkv.x265-butler.json.tmp',
      '/config/x265-butler/sidecars/media/movies/x.mkv.x265-butler.json',
    );
    expect(order).toEqual(['mkdir', 'writeFile', 'rename']);
  });

  it('central mkdir failure soft-degrades (warn, NEVER throws) — S3', async () => {
    mockMkdir.mockRejectedValue(Object.assign(new Error('EROFS'), { code: 'EROFS' }));
    await expect(
      writeSidecarResolved('/media/movies/x.mkv', PAYLOAD, 'central', CENTRAL),
    ).resolves.toBeUndefined();
    expect(mockWriteFile).not.toHaveBeenCalled(); // mkdir threw before write
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'sidecar_write_failed', mode: 'central' }),
      expect.any(String),
    );
  });

  it('central rename failure soft-degrades + best-effort unlinks .tmp', async () => {
    mockRename.mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    await expect(
      writeSidecarResolved('/media/movies/x.mkv', PAYLOAD, 'central', CENTRAL),
    ).resolves.toBeUndefined();
    expect(mockUnlink).toHaveBeenCalledWith(
      '/config/x265-butler/sidecars/media/movies/x.mkv.x265-butler.json.tmp',
    );
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
