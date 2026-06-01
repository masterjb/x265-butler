// 23-02 — pure render-node permission probe over `/dev/dri/renderD*`.
//
// Evidence-only surface: reports, per render node, the host-GID owning the
// device, the container process's primary + supplementary groups, whether the
// process is a member (PGID or supplementary), the resolved group name, and
// readable/writable from the container's point of view. NO AggregatedWarning
// is emitted (D2=A) — this pairs with the 23-01 stderr hint that fires on an
// actual test-encode failure.
//
// Deps-injectable (mirrors container-image-probe.ts ergonomics) but with NO
// boot-cache — render-node permissions can change across restarts, so probe
// fresh each call. Never throws upward: the array is the only output.

import { promises as defaultFs, constants } from 'node:fs';
import type { RenderDeviceProbe } from './types';

const DRI_DIR = '/dev/dri';

export interface RenderDeviceProbeDeps {
  readdir?: typeof defaultFs.readdir;
  stat?: typeof defaultFs.stat; // .gid
  access?: typeof defaultFs.access; // R_OK / W_OK
  getgroups?: () => number[];
  getgid?: () => number; // primary/effective gid (PGID fix-path)
  readFile?: typeof defaultFs.readFile; // /etc/group
}

export async function probeRenderDevices(
  deps: RenderDeviceProbeDeps = {},
): Promise<RenderDeviceProbe[]> {
  const readdir = deps.readdir ?? defaultFs.readdir;
  const stat = deps.stat ?? defaultFs.stat;
  const access = deps.access ?? defaultFs.access;
  const readFile = deps.readFile ?? defaultFs.readFile;

  // 1. Enumerate renderD* nodes. No /dev/dri → nothing to probe (AC-2).
  let names: string[];
  try {
    const entries = await readdir(DRI_DIR);
    names = entries
      .map((e) => String(e))
      .filter((e) => e.startsWith('renderD'))
      .sort();
  } catch {
    return [];
  }

  // 2. Process supplementary groups — POSIX-only; [] on non-POSIX (AC-2).
  const processGroups = resolveProcessGroups(deps.getgroups);

  // 2b. Process primary/effective gid — POSIX-only; null on non-POSIX (AC-2).
  // glibc getgroups() is NOT guaranteed to include the primary gid, so the
  // canonical unRAID fix `PGID=<render-gid>` must be checked independently.
  const processGid = resolveProcessGid(deps.getgid);

  // 3. Parse /etc/group once → Map<gid, name>. Failure → empty map (AC-3).
  const gidMap = await parseEtcGroup(readFile);

  // 4. Per node, isolated try/catch — one bad node never aborts the rest.
  return Promise.all(
    names.map((name) =>
      probeNode(`${DRI_DIR}/${name}`, { stat, access }, processGroups, processGid, gidMap),
    ),
  );
}

function resolveProcessGroups(override?: () => number[]): number[] {
  if (override) return override();
  if (typeof process.getgroups === 'function') return process.getgroups();
  return [];
}

function resolveProcessGid(override?: () => number): number | null {
  if (override) return override();
  if (typeof process.getgid === 'function') return process.getgid();
  return null;
}

async function parseEtcGroup(readFile: typeof defaultFs.readFile): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const raw = await readFile('/etc/group', 'utf8');
    for (const line of String(raw).split('\n')) {
      // format: name:passwd:gid:members
      const cols = line.split(':');
      if (cols.length < 3) continue;
      const gid = Number.parseInt(cols[2], 10);
      if (Number.isInteger(gid) && cols[0].length > 0) {
        if (!map.has(gid)) map.set(gid, cols[0]);
      }
    }
  } catch {
    // empty map → groupName falls back to null (AC-3)
  }
  return map;
}

async function probeNode(
  path: string,
  io: { stat: typeof defaultFs.stat; access: typeof defaultFs.access },
  processGroups: number[],
  processGid: number | null,
  gidMap: Map<number, string>,
): Promise<RenderDeviceProbe> {
  let gid: number | null = null;
  try {
    const st = await io.stat(path);
    gid = st.gid;
  } catch (err) {
    return {
      path,
      exists: false,
      gid: null,
      groupName: null,
      processGroups,
      processGid,
      inRenderGroup: false,
      readable: false,
      writable: false,
      error: errCode(err),
    };
  }

  const readable = await canAccess(io.access, path, constants.R_OK);
  const writable = await canAccess(io.access, path, constants.W_OK);
  const inRenderGroup = gid !== null && (processGroups.includes(gid) || processGid === gid);
  const groupName = gid !== null ? (gidMap.get(gid) ?? null) : null;

  return {
    path,
    exists: true,
    gid,
    groupName,
    processGroups,
    processGid,
    inRenderGroup,
    readable,
    writable,
  };
}

async function canAccess(
  access: typeof defaultFs.access,
  path: string,
  mode: number,
): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

function errCode(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return 'UNKNOWN';
}
