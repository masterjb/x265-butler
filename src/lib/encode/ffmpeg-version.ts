// 03-04 audit M3: ffmpeg version probe.
// Runs ONCE at server-init time (called from ensureServerInit). Result cached
// in globalThis so HMR survives. Fire-and-forget — does NOT block init flow.
// First /api/stats call may see null while probe is in flight; subsequent
// calls see the populated value. Avoids 5-second blocking on first dashboard
// load that would have happened with lazy-on-first-request probing.
//
// Leaf module — no imports from orchestrator/detection/ffmpeg to avoid
// circular dependencies.

import { spawn } from 'node:child_process';
import { ffmpegBinary } from './ffmpeg-binary';

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

async function runProbe(): Promise<void> {
  const result = await new Promise<string | null>((resolve) => {
    const child = spawn(ffmpegBinary(), ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
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
  globalThis.__x265butler_ffmpeg_version = result;
  _probeInFlight = false;
}

export function getFfmpegVersionCached(): string | null {
  return globalThis.__x265butler_ffmpeg_version ?? null;
}

// Test-only — reset cache + in-flight flag.
export function __forTests_resetFfmpegVersionCache(): void {
  globalThis.__x265butler_ffmpeg_version = undefined;
  _probeInFlight = false;
}
