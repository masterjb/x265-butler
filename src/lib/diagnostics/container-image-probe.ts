// 22-00 IMP-11: container-image probe — OS + glibc + driver + ffmpeg snapshot.
//
// Boot-cached singleton; refresh via `GET /api/diagnostics?refresh=1`. All
// sub-probes run in parallel via Promise.allSettled — one slow probe never
// blocks others. execFile (NOT exec) + per-probe 1s timeout. Audit fixes:
//   SR1 — execFile + arg-array + timeout + allSettled
//   SR3 — pendingPromise concurrency-safe boot-cache (AC-10)
//   SR6 — per-failed-subprobe pino-debug emit with reason

import { execFile as defaultExecFile } from 'node:child_process';
import { promises as defaultFs } from 'node:fs';
import { promisify } from 'node:util';
import { logger as defaultLogger } from '@/src/lib/logger';
import type { ContainerImageBlock } from './types';

const PROBE_TIMEOUT_MS = 1000;
const INTEL_MEDIA_DRIVER_SO = '/usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so';

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

type ProbeReason = 'binary_missing' | 'timeout' | 'parse_failure' | 'permission_denied' | 'unknown';

export interface ContainerImageProbeDeps {
  execFile?: ExecFileFn;
  readFile?: typeof defaultFs.readFile;
  access?: typeof defaultFs.access;
  logger?: { debug: (payload: object, msg: string) => void };
}

const execFilePromise = promisify(defaultExecFile);

const defaultExecFileWrapper: ExecFileFn = async (file, args, options) => {
  const { stdout, stderr } = await execFilePromise(file, [...args], {
    timeout: options?.timeout ?? PROBE_TIMEOUT_MS,
    encoding: 'utf8',
  });
  return {
    stdout: String(stdout ?? ''),
    stderr: String(stderr ?? ''),
  };
};

// Module-scope boot-cache (AC-10 concurrency-safe via pendingPromise).
let cachedBlock: ContainerImageBlock | null = null;
let pendingPromise: Promise<ContainerImageBlock> | null = null;

export async function probeContainerImage(
  deps: ContainerImageProbeDeps = {},
): Promise<ContainerImageBlock> {
  if (cachedBlock) return cachedBlock;
  if (pendingPromise) return pendingPromise;
  pendingPromise = doProbe(deps)
    .then((block) => {
      cachedBlock = block;
      pendingPromise = null;
      return block;
    })
    .catch((err) => {
      pendingPromise = null;
      throw err;
    });
  return pendingPromise;
}

export function clearContainerImageCache(): void {
  cachedBlock = null;
  pendingPromise = null;
}

async function doProbe(deps: ContainerImageProbeDeps): Promise<ContainerImageBlock> {
  const execFile = deps.execFile ?? defaultExecFileWrapper;
  const readFile = deps.readFile ?? defaultFs.readFile;
  const access = deps.access ?? defaultFs.access;
  const logger = deps.logger ?? defaultLogger;

  const emitFailure = (subprobe: string, reason: ProbeReason): void => {
    logger.debug({ subprobe, reason }, 'container_image_probe_failed');
  };

  const results = await Promise.allSettled([
    probeOs(readFile, emitFailure),
    probeGlibc(execFile, emitFailure),
    probeIntelMediaDriver(execFile, access, emitFailure),
    probeLibPackage('libva2', execFile, emitFailure),
    probeLibPackage('libdrm2', execFile, emitFailure),
    // 23-00: oneVPL MFX GPU-runtime presence (root-cause surface for `MFX -9`).
    probeLibPackage('libmfx-gen1.2', execFile, emitFailure),
    probeLibPackage('libvpl2', execFile, emitFailure),
    probeLibPackage('libigfxcmrt7', execFile, emitFailure),
    probeFfmpeg(execFile, emitFailure),
  ]);

  const [
    osRes,
    glibcRes,
    intelRes,
    libvaRes,
    libdrmRes,
    libmfxGenRes,
    libvplRes,
    libigfxcmrtRes,
    ffmpegRes,
  ] = results;

  return {
    os: settled(osRes, { id: null, version: null, prettyName: null }),
    glibc: settled(glibcRes, { version: null }),
    drivers: {
      intelMediaDriver: settled(intelRes, { version: null, source: null }),
      libva: settled(libvaRes, { version: null }),
      libdrm: settled(libdrmRes, { version: null }),
      oneVpl: {
        libmfxGen1: settled(libmfxGenRes, { version: null }),
        libvpl: settled(libvplRes, { version: null }),
        libigfxcmrt: settled(libigfxcmrtRes, { version: null }),
      },
    },
    ffmpeg: settled(ffmpegRes, { configurationFlags: null, version: null }),
  };
}

function settled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function classifyError(err: unknown): ProbeReason {
  if (!err || typeof err !== 'object') return 'unknown';
  const e = err as { code?: unknown; signal?: unknown; killed?: unknown };
  if (e.killed === true || e.signal === 'SIGTERM') return 'timeout';
  if (typeof e.code === 'string') {
    if (e.code === 'ENOENT') return 'binary_missing';
    if (e.code === 'EACCES' || e.code === 'EPERM') return 'permission_denied';
  }
  return 'unknown';
}

async function probeOs(
  readFile: typeof defaultFs.readFile,
  emit: (sub: string, reason: ProbeReason) => void,
): Promise<ContainerImageBlock['os']> {
  try {
    const raw = await readFile('/etc/os-release', 'utf8');
    return {
      id: extractOsReleaseField(raw, 'ID'),
      version: extractOsReleaseField(raw, 'VERSION_ID'),
      prettyName: extractOsReleaseField(raw, 'PRETTY_NAME'),
    };
  } catch (err) {
    emit('os', classifyError(err));
    throw err;
  }
}

function extractOsReleaseField(raw: string, key: string): string | null {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const m = raw.match(re);
  if (!m) return null;
  let val = m[1].trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return val.length > 0 ? val : null;
}

async function probeGlibc(
  execFile: ExecFileFn,
  emit: (sub: string, reason: ProbeReason) => void,
): Promise<ContainerImageBlock['glibc']> {
  try {
    const { stdout } = await execFile('ldd', ['--version'], { timeout: PROBE_TIMEOUT_MS });
    const firstLine = stdout.split('\n')[0] ?? '';
    const tokens = firstLine.trim().split(/\s+/);
    const version = tokens.length > 0 ? tokens[tokens.length - 1] : null;
    return { version: version && /^\d/.test(version) ? version : null };
  } catch (err) {
    emit('glibc', classifyError(err));
    throw err;
  }
}

async function probeIntelMediaDriver(
  execFile: ExecFileFn,
  access: typeof defaultFs.access,
  emit: (sub: string, reason: ProbeReason) => void,
): Promise<ContainerImageBlock['drivers']['intelMediaDriver']> {
  // Step 1: try vainfo on the standard render node.
  try {
    const { stdout } = await execFile(
      'vainfo',
      ['--display', 'drm', '--device', '/dev/dri/renderD128'],
      { timeout: PROBE_TIMEOUT_MS },
    );
    const m = stdout.match(/Driver version:\s*(.+)/);
    if (m) return { version: m[1].trim(), source: 'vainfo' };
  } catch (err) {
    emit('intelMediaDriver:vainfo', classifyError(err));
  }
  // Step 2: fall back to checking the iHD .so presence.
  try {
    await access(INTEL_MEDIA_DRIVER_SO);
    return { version: null, source: 'so-symlink' };
  } catch (err) {
    emit('intelMediaDriver:so-symlink', classifyError(err));
  }
  return { version: null, source: null };
}

async function probeLibPackage(
  pkg: string,
  execFile: ExecFileFn,
  emit: (sub: string, reason: ProbeReason) => void,
): Promise<{ version: string | null }> {
  try {
    const { stdout } = await execFile('dpkg-query', ['-W', '-f=${Version}', pkg], {
      timeout: PROBE_TIMEOUT_MS,
    });
    const trimmed = stdout.trim();
    return { version: trimmed.length > 0 ? trimmed : null };
  } catch (err) {
    emit(pkg, classifyError(err));
    throw err;
  }
}

async function probeFfmpeg(
  execFile: ExecFileFn,
  emit: (sub: string, reason: ProbeReason) => void,
): Promise<ContainerImageBlock['ffmpeg']> {
  try {
    const { stdout } = await execFile('ffmpeg', ['-version'], { timeout: PROBE_TIMEOUT_MS });
    const lines = stdout.split('\n');
    const versionLine = lines[0] ?? '';
    const versionMatch = versionLine.match(/^ffmpeg version (\S+)/);
    const version = versionMatch ? versionMatch[1] : null;
    let configurationFlags: string[] | null = null;
    for (const line of lines.slice(0, 5)) {
      const cfg = line.match(/^\s*configuration:\s*(.+)$/);
      if (cfg) {
        configurationFlags = cfg[1].trim().split(/\s+/);
        break;
      }
    }
    return { version, configurationFlags };
  } catch (err) {
    emit('ffmpeg', classifyError(err));
    throw err;
  }
}
