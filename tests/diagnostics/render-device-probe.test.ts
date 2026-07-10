// @vitest-environment node
// 23-02 T1 — render-device probe unit coverage (AC-1 + AC-2 + AC-3).
// Deps-injected; NO real /dev/dri, NO process.getgroups()/getgid() side-effects.

import { describe, it, expect, vi } from 'vitest';
import { constants } from 'node:fs';
import {
  probeRenderDevices,
  groupFixRelevant,
  type RenderDeviceProbeDeps,
} from '@/src/lib/diagnostics/render-device-probe';
import type { RenderDeviceProbe } from '@/src/lib/diagnostics/types';

const ETC_GROUP = 'root:x:0:\nvideo:x:44:\nrender:x:105:appuser\nappuser:x:1000:\n';

function mkReaddir(names: string[] | Error) {
  return vi.fn(async (dir: unknown) => {
    expect(dir).toBe('/dev/dri');
    if (names instanceof Error) throw names;
    return names as never;
  });
}

function mkStat(gidByPath: Record<string, number | Error>) {
  return vi.fn(async (path: unknown) => {
    const v = gidByPath[String(path)];
    if (v === undefined) {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: ${String(path)}`);
      err.code = 'ENOENT';
      throw err;
    }
    if (v instanceof Error) throw v;
    return { gid: v } as never;
  });
}

// access resolves unless the (path, mode) pair is in the denied set.
function mkAccess(denied: Array<[string, number]> = []) {
  return vi.fn(async (path: unknown, mode: unknown) => {
    const hit = denied.some(([p, m]) => p === String(path) && m === Number(mode));
    if (hit) {
      const err: NodeJS.ErrnoException = new Error(`EACCES: ${String(path)}`);
      err.code = 'EACCES';
      throw err;
    }
  });
}

function mkReadFile(content: string | Error) {
  return vi.fn(async () => {
    if (content instanceof Error) throw content;
    return content as never;
  });
}

function baseDeps(over: Partial<RenderDeviceProbeDeps> = {}): RenderDeviceProbeDeps {
  return {
    readdir: mkReaddir(['renderD128', 'renderD129']) as never,
    stat: mkStat({ '/dev/dri/renderD128': 105, '/dev/dri/renderD129': 105 }) as never,
    access: mkAccess() as never,
    getgroups: () => [44, 105],
    getgid: () => 1000,
    readFile: mkReadFile(ETC_GROUP) as never,
    ...over,
  };
}

describe('probeRenderDevices', () => {
  it('lists each renderD node with full evidence; gid in groups → inRenderGroup + groupName', async () => {
    const out = await probeRenderDevices(baseDeps());
    expect(out).toHaveLength(2);
    expect(out.map((d) => d.path)).toEqual(['/dev/dri/renderD128', '/dev/dri/renderD129']);
    const d = out[0];
    expect(d).toMatchObject({
      path: '/dev/dri/renderD128',
      exists: true,
      gid: 105,
      groupName: 'render',
      processGroups: [44, 105],
      processGid: 1000,
      inRenderGroup: true,
      readable: true,
      writable: true,
    });
    expect(d.error).toBeUndefined();
  });

  it('gid NOT in groups AND ≠ getgid → inRenderGroup false', async () => {
    const out = await probeRenderDevices(baseDeps({ getgroups: () => [44], getgid: () => 1000 }));
    expect(out[0].inRenderGroup).toBe(false);
    // group name still resolves from /etc/group regardless of membership
    expect(out[0].groupName).toBe('render');
  });

  it('gid === getgid but NOT in getgroups → inRenderGroup true (PGID path, audit M1)', async () => {
    const out = await probeRenderDevices(baseDeps({ getgroups: () => [44], getgid: () => 105 }));
    expect(out[0].inRenderGroup).toBe(true);
  });

  it('gid in getgroups but ≠ getgid → inRenderGroup true (supplementary path)', async () => {
    const out = await probeRenderDevices(
      baseDeps({ getgroups: () => [44, 105], getgid: () => 1000 }),
    );
    expect(out[0].inRenderGroup).toBe(true);
  });

  it('readdir ENOENT → [] (no /dev/dri, no throw)', async () => {
    const enoent: NodeJS.ErrnoException = new Error('ENOENT');
    enoent.code = 'ENOENT';
    const out = await probeRenderDevices(baseDeps({ readdir: mkReaddir(enoent) as never }));
    expect(out).toEqual([]);
  });

  it('stat throws on one node → that entry error-flagged, sibling resolves', async () => {
    const eacces: NodeJS.ErrnoException = new Error('EACCES');
    eacces.code = 'EACCES';
    const out = await probeRenderDevices(
      baseDeps({
        stat: mkStat({
          '/dev/dri/renderD128': eacces,
          '/dev/dri/renderD129': 105,
        }) as never,
      }),
    );
    expect(out[0]).toMatchObject({
      path: '/dev/dri/renderD128',
      exists: false,
      gid: null,
      groupName: null,
      inRenderGroup: false,
      readable: false,
      writable: false,
      error: 'EACCES',
    });
    // sibling still fully resolves
    expect(out[1]).toMatchObject({ exists: true, gid: 105, inRenderGroup: true });
  });

  it('/etc/group readFile throws → groupName null, gid still present', async () => {
    const out = await probeRenderDevices(
      baseDeps({ readFile: mkReadFile(new Error('boom')) as never }),
    );
    expect(out[0].gid).toBe(105);
    expect(out[0].groupName).toBeNull();
    expect(out[0].inRenderGroup).toBe(true); // membership independent of name
  });

  it('getgroups unavailable (non-POSIX) → processGroups [] + inRenderGroup false', async () => {
    // Simulate a non-POSIX host: process.getgroups absent AND no dep override.
    const orig = process.getgroups;
    delete process.getgroups; // non-POSIX simulation (getgroups is optional on Process)
    try {
      const out = await probeRenderDevices(baseDeps({ getgroups: undefined, getgid: () => 1000 }));
      expect(out[0].processGroups).toEqual([]);
      expect(out[0].inRenderGroup).toBe(false);
    } finally {
      process.getgroups = orig;
    }
  });

  it('getgid unavailable (non-POSIX) → processGid null + inRenderGroup falls back to supplementary-only (audit M1/SR1)', async () => {
    const orig = process.getgid;
    delete process.getgid; // non-POSIX simulation (getgid is optional on Process)
    try {
      // supplementary contains 105 → still true via supplementary path
      const supp = await probeRenderDevices(
        baseDeps({ getgid: undefined, getgroups: () => [105] }),
      );
      expect(supp[0].processGid).toBeNull();
      expect(supp[0].inRenderGroup).toBe(true);
      // supplementary does NOT contain 105 → false (no PGID to fall back to)
      const none = await probeRenderDevices(baseDeps({ getgid: undefined, getgroups: () => [44] }));
      expect(none[0].processGid).toBeNull();
      expect(none[0].inRenderGroup).toBe(false);
    } finally {
      process.getgid = orig;
    }
  });

  it('W_OK denied but R_OK ok → readable:true writable:false', async () => {
    const out = await probeRenderDevices(
      baseDeps({
        access: mkAccess([['/dev/dri/renderD128', constants.W_OK]]) as never,
      }),
    );
    expect(out[0].readable).toBe(true);
    expect(out[0].writable).toBe(false);
    // sibling node unaffected
    expect(out[1].writable).toBe(true);
  });
});

// 29-02 T1 — groupFixRelevant predicate truth table (AC-1).
describe('groupFixRelevant', () => {
  function mk(over: Partial<RenderDeviceProbe>): RenderDeviceProbe {
    return {
      path: '/dev/dri/renderD128',
      exists: true,
      gid: 105,
      groupName: 'render',
      processGroups: [44, 105],
      processGid: 1000,
      inRenderGroup: true,
      readable: true,
      writable: true,
      ...over,
    };
  }

  it('exists:false → false (non-existent device is never a group-fix candidate)', () => {
    expect(groupFixRelevant(mk({ exists: false, readable: false, writable: false }))).toBe(false);
  });

  it('readable:true writable:true → false, regardless of inRenderGroup (rasalf)', () => {
    expect(groupFixRelevant(mk({ inRenderGroup: true }))).toBe(false);
    expect(groupFixRelevant(mk({ inRenderGroup: false }))).toBe(false);
  });

  it('readable:true writable:false → true', () => {
    expect(groupFixRelevant(mk({ writable: false }))).toBe(true);
  });

  it('readable:false writable:true → true', () => {
    expect(groupFixRelevant(mk({ readable: false }))).toBe(true);
  });

  it('readable:false writable:false → true', () => {
    expect(groupFixRelevant(mk({ readable: false, writable: false }))).toBe(true);
  });
});
