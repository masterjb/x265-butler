// 46-02 (D2) — NVIDIA GPU model + driver probe.
//
// Runs `nvidia-smi --query-gpu=name,driver_version --format=csv,noheader,nounits`
// and surfaces the GPU name + driver on the diagnostics payload as the top-level
// `nvidiaGpu` block — the analog of the 23-05 `cpu` capability line. Motivation:
// every nvenc report to date is guesswork on the exact card (diagnostics captures
// the CPU model/microarch but only `/dev/nvidia*` device-node PRESENCE, never the
// model/driver). A GPU-name row lets the 46-01 pre-Maxwell-2 verdict be
// evidence-checked instead of hedged.
//
// Boot-cached (GPU model/driver is immutable at runtime) using the EXACT
// container-image-probe / cpu-capability mechanism: module-scope `cachedBlock` +
// a `pendingPromise` concurrency guard so concurrent cold-cache callers spawn
// nvidia-smi ONCE (AC-6). execFile (NOT exec) + arg-array + timeout — mirrors
// container-image-probe ergonomics. Never throws upward: any failure classifies
// to a distinct `source` with `gpus: []` (AC-2/AC-3) so GET /api/diagnostics
// stays 200.

import { execFile as defaultExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger as defaultLogger } from '@/src/lib/logger';
import type { NvidiaGpu, NvidiaGpuBlock, NvidiaGpuSource } from './types';

// nvidia-smi cold-invocation initializes NVML (loads the driver handle,
// enumerates GPUs); on a busy or multi-GPU host that init routinely exceeds 1s,
// whereas the container-image dpkg-query/ldd probes (1s cap) are near-instant. A
// 1s cap would spuriously classify a HEALTHY real NVIDIA host as `timeout` → the
// GPU-name row silently blanks on exactly the population this feature targets
// (real NVIDIA HW we cannot repro locally). Hence 3s (MH-1).
// TODO(defer): env-tunable NVIDIA_SMI_PROBE_TIMEOUT_MS if operator evidence shows 3s is still too tight.
const PROBE_TIMEOUT_MS = 3000;

const NVIDIA_SMI_ARGS = [
  '--query-gpu=name,driver_version',
  '--format=csv,noheader,nounits',
] as const;

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface NvidiaGpuDeps {
  execFile?: ExecFileFn;
  logger?: { info: (payload: object, msg: string) => void };
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

// Module-scope boot-cache (AC-6 concurrency-safe via pendingPromise).
let cachedBlock: NvidiaGpuBlock | null = null;
let pendingPromise: Promise<NvidiaGpuBlock> | null = null;

// Fresh, uncached probe. NEVER throws upward (AC-2/AC-3). Emits exactly ONE
// info-level `nvidia_gpu_probe_resolved` line per fresh probe (AC-7).
export async function probeNvidiaGpu(deps: NvidiaGpuDeps = {}): Promise<NvidiaGpuBlock> {
  const execFile = deps.execFile ?? defaultExecFileWrapper;
  const logger = deps.logger ?? defaultLogger;

  const block = await runProbe(execFile);

  // One resolved-once log at the point the FRESH probe completes — info level,
  // so it reaches the ring-buffer (≥ `telemetry` (25) does; `debug` (20) does
  // not — the 22-01→38-02 dark-surface lesson; tier table in
  // src/lib/logger.ts). source + count only; NEVER the GPU name (kept to the
  // payload surface). Fires per fresh probe, not per cached read.
  logger.info({ source: block.source, gpuCount: block.gpus.length }, 'nvidia_gpu_probe_resolved');
  return block;
}

async function runProbe(execFile: ExecFileFn): Promise<NvidiaGpuBlock> {
  let stdout: string;
  try {
    ({ stdout } = await execFile('nvidia-smi', NVIDIA_SMI_ARGS, { timeout: PROBE_TIMEOUT_MS }));
  } catch (err) {
    return { source: classifyError(err), gpus: [] };
  }
  const gpus = parseGpuLines(stdout);
  return { source: gpus.length > 0 ? 'present' : 'no_gpu', gpus };
}

// Per-line: strip a trailing CR (Node stdout can carry `\r\n`; a stray `\r`
// would otherwise ride along in driverVersion), trim, split on the FIRST ', '
// (the csv separator — name carries no comma, driver never does). A line
// yielding <2 fields or an empty name is skipped, not fatal (AC-1, SR-3).
function parseGpuLines(stdout: string): NvidiaGpu[] {
  const gpus: NvidiaGpu[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line.length === 0) continue;
    const sep = line.indexOf(', ');
    if (sep === -1) continue;
    const name = line.slice(0, sep).trim();
    const driverVersion = line.slice(sep + 2).trim();
    if (name.length === 0 || driverVersion.length === 0) continue;
    gpus.push({ name, driverVersion });
  }
  return gpus;
}

// ENOENT → binary_missing (the common no-toolkit host, Dockerfile:104 default);
// killed / SIGTERM / "timed out" → timeout; everything else → error. Mirrors
// probeNvenc's ENOENT/EXIT_NONZERO/NO_GPU cause discrimination in detection.ts.
function classifyError(err: unknown): NvidiaGpuSource {
  if (!err || typeof err !== 'object') return 'error';
  const e = err as { code?: unknown; signal?: unknown; killed?: unknown; message?: unknown };
  if (e.code === 'ENOENT') return 'binary_missing';
  if (e.killed === true || e.signal === 'SIGTERM') return 'timeout';
  if (typeof e.message === 'string' && /timed out/i.test(e.message)) return 'timeout';
  return 'error';
}

// Boot-cached probe (AC-6 — single nvidia-smi spawn under concurrent cold-cache
// callers). Reuses the container-image-probe/cpu-capability pendingPromise pattern.
export async function getNvidiaGpu(deps: NvidiaGpuDeps = {}): Promise<NvidiaGpuBlock> {
  if (cachedBlock) return cachedBlock;
  if (pendingPromise) return pendingPromise;
  pendingPromise = probeNvidiaGpu(deps)
    .then((block) => {
      cachedBlock = block;
      pendingPromise = null;
      return block;
    })
    .catch((err) => {
      // probeNvidiaGpu never throws, but keep the cache consistent if it did.
      pendingPromise = null;
      throw err;
    });
  return pendingPromise;
}

// Public cache invalidate — wired into GET /api/diagnostics?refresh=1 (AC-6).
export function clearNvidiaGpuCache(): void {
  cachedBlock = null;
  pendingPromise = null;
}

// Test-only cache reset alias. NOT barrelled.
export function __forTests_resetNvidiaGpuCache(): void {
  clearNvidiaGpuCache();
}

export { PROBE_TIMEOUT_MS as NVIDIA_SMI_PROBE_TIMEOUT_MS };
