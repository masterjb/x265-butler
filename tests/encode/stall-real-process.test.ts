// @vitest-environment node
// The stall watchdog ends a real child process. FFMPEG_PATH points at a small
// shell script that never reports progress: one sleeps, the other ignores
// SIGTERM so the forced kill after the grace period has to take over. No
// hardware and no real ffmpeg are involved.

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEncode } from '@/src/lib/encode/ffmpeg';
import { createStallWatchdog } from '@/src/lib/encode/stall-watchdog';

const dir = mkdtempSync(join(tmpdir(), 'stall-proc-'));
const origPath = process.env.FFMPEG_PATH;

function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const sleeper = script('sleeper.sh', 'echo "$$" > "$0.pid"\nexec sleep 600');
const stubborn = script(
  'stubborn.sh',
  'echo "$$" > "$0.pid"\ntrap "" TERM\nwhile true; do sleep 1; done',
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runUntilStalled(bin: string): Promise<{ err: unknown; pid: number }> {
  process.env.FFMPEG_PATH = bin;
  const controller = new AbortController();
  const watchdog = createStallWatchdog({
    timeoutMs: 1_000,
    checkEveryMs: 100,
    onStall: () => controller.abort(),
  });
  let err: unknown = null;
  try {
    await runEncode({
      input: join(dir, 'input'),
      output: join(dir, 'out.mkv'),
      crf: 23,
      signal: controller.signal,
      onProgress: (ev) => watchdog.observe(ev.outTimeMs),
    });
  } catch (e) {
    err = e;
  } finally {
    watchdog.stop();
  }
  const { readFileSync } = await import('node:fs');
  const pid = Number(readFileSync(`${bin}.pid`, 'utf8').trim());
  return { err, pid };
}

afterEach(() => {
  if (origPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = origPath;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('stall watchdog against a real process', () => {
  it('a silent process is terminated and the encode rejects as aborted', async () => {
    const { err, pid } = await runUntilStalled(sleeper);
    expect((err as Error)?.name).toBe('AbortError');
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it('a process that ignores SIGTERM is killed after the grace period', async () => {
    const { err, pid } = await runUntilStalled(stubborn);
    expect((err as Error)?.name).toBe('AbortError');
    expect(alive(pid)).toBe(false);
  }, 20_000);
});
