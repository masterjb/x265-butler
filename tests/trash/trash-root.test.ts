import { describe, it, expect } from 'vitest';
import { resolveTrashRoot } from '@/src/lib/trash/trash-root';

const stageRoot = '/cache/x265-butler';

describe('resolveTrashRoot', () => {
  it.each([
    // trash_path set wins over everything
    [
      { trashPath: '/mnt/disk1/trash', location: 'share', sharePath: '/media/Movies' },
      '/mnt/disk1/trash',
      'path',
    ],
    [
      { trashPath: '/mnt/disk1/trash', location: 'cache', sharePath: null },
      '/mnt/disk1/trash',
      'path',
    ],
    // share location with a resolvable share
    [
      { trashPath: '', location: 'share', sharePath: '/media/Movies' },
      '/media/Movies/.x265-butler-trash',
      'share',
    ],
    [
      { trashPath: null, location: 'share', sharePath: '/media/Movies/' },
      '/media/Movies/.x265-butler-trash',
      'share',
    ],
    [
      { trashPath: '   ', location: 'share', sharePath: '/media/Movies' },
      '/media/Movies/.x265-butler-trash',
      'share',
    ],
    // cache location ignores the share
    [{ trashPath: '', location: 'cache', sharePath: '/media/Movies' }, stageRoot, 'cache'],
  ] as const)('%o resolves to %s (%s)', (input, root, source) => {
    const r = resolveTrashRoot({ ...input, stageRoot });
    expect(r.root).toBe(root);
    expect(r.source).toBe(source);
    expect(r.fallbackReason).toBeUndefined();
  });

  it.each([
    ['no share', null],
    ['empty share path', ''],
    ['share at the filesystem root', '/'],
    ['relative share path', 'media/Movies'],
  ])('falls back to the cache path for %s', (_label, sharePath) => {
    const r = resolveTrashRoot({ trashPath: '', location: 'share', stageRoot, sharePath });
    expect(r).toEqual({ root: stageRoot, source: 'cache', fallbackReason: 'share_unresolved' });
  });
});
