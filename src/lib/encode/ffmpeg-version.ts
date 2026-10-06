// ffmpeg version probe.
// Runs ONCE at server-init time (called from ensureServerInit). Result cached
// in globalThis so HMR survives. Fire-and-forget — does NOT block init flow.
// First /api/stats call may see null while probe is in flight; subsequent
// calls see the populated value. Avoids 5-second blocking on first dashboard
// load that would have happened with lazy-on-first-request probing.
//
// Leaf module — no imports from orchestrator/detection/ffmpeg to avoid
// circular dependencies.

import { spawn } from 'node:child_process';
import { ffmpegBinary, ffmpegBinaryFor } from './ffmpeg-binary';
import { reniceChild } from './child-priority';

const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_STDOUT_BYTES = 4096;

let _probeInFlight = false;

export function probeFfmpegVersionAtBoot(): void {
  // Idempotent: if cache already populated (string OR explicit null after a
  // failed probe), skip re-probing. If a probe is currently in flight, also
  // skip (fire-and-forget — boot races resolve to one probe per process).
  if (globalThis.__x265butler_ffmpeg_version !== undefined) return;
  if (_probeInFlight) return;
  _probeInFlight = true;
  void runProbe();
}

// Both binaries, so the shipped builds are identifiable (/api/health,
// diagnostics). The NVENC binary goes through ffmpegBinaryFor('nvenc') so
// FFMPEG_NVENC_PATH is honoured; missing (dev without image) ⇒ null.
async function runProbe(): Promise<void> {
  const [primary, nvenc] = await Promise.all([
    probeVersion(ffmpegBinary()),
    probeVersion(ffmpegBinaryFor('nvenc')),
  ]);
  globalThis.__x265butler_ffmpeg_version = primary;
  globalThis.__x265butler_ffmpeg_nvenc_version = nvenc;
  _probeInFlight = false;
}

function probeVersion(binary: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const child = spawn(binary, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    reniceChild(child); // Uniform priority coverage (cheap; never concurrent)
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > PROBE_MAX_STDOUT_BYTES) child.kill('SIGKILL');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      // First line: "ffmpeg version N.N.N ..."
      const line = stdout.split('\n')[0]?.trim() ?? '';
      const match = line.match(/^ffmpeg version (\S+)/);
      resolve(match?.[1] ?? null);
    });
  });
}

export function getFfmpegVersionCached(): string | null {
  return globalThis.__x265butler_ffmpeg_version ?? null;
}

export function getFfmpegNvencVersionCached(): string | null {
  return globalThis.__x265butler_ffmpeg_nvenc_version ?? null;
}

// Test-only — reset cache + in-flight flag.
export function __forTests_resetFfmpegVersionCache(): void {
  globalThis.__x265butler_ffmpeg_version = undefined;
  globalThis.__x265butler_ffmpeg_nvenc_version = undefined;
  _probeInFlight = false;
}
