// @vitest-environment node
// 52-06 (AC-6): the boot probe caches the build of BOTH ffmpeg binaries, so /api/health and the
// dashboard can name them without spawning per request. Before 52-06 only the BtbN primary was
// probed; the NVENC binary (jellyfin, 45-01 dual-binary) was identifiable nowhere.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('@/src/lib/encode/child-priority', () => ({ reniceChild: vi.fn() }));

import {
  probeFfmpegVersionAtBoot,
  getFfmpegVersionCached,
  getFfmpegNvencVersionCached,
  __forTests_resetFfmpegVersionCache,
} from '@/src/lib/encode/ffmpeg-version';

type Reply = { stdout?: string; code?: number; error?: NodeJS.ErrnoException };

function fakeChild(reply: Reply) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  setImmediate(() => {
    if (reply.error) {
      child.emit('error', reply.error);
      return;
    }
    if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout));
    child.emit('close', reply.code ?? 0);
  });
  return child;
}

function enoent(): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error('spawn ENOENT');
  e.code = 'ENOENT';
  return e;
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe('ffmpeg-version boot probe (52-06)', () => {
  const prevNvenc = process.env.FFMPEG_NVENC_PATH;
  const prevPrimary = process.env.FFMPEG_PATH;

  beforeEach(() => {
    __forTests_resetFfmpegVersionCache();
    spawnMock.mockReset();
    delete process.env.FFMPEG_NVENC_PATH;
    delete process.env.FFMPEG_PATH;
  });

  afterEach(() => {
    if (prevNvenc === undefined) delete process.env.FFMPEG_NVENC_PATH;
    else process.env.FFMPEG_NVENC_PATH = prevNvenc;
    if (prevPrimary === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = prevPrimary;
  });

  it('caches the build of both binaries', async () => {
    spawnMock.mockImplementation((bin: string) =>
      fakeChild({
        stdout:
          bin === 'ffmpeg-nvenc'
            ? 'ffmpeg version 7.1.4-Jellyfin Copyright (c) 2000-2026\n'
            : 'ffmpeg version n9.0.2-22-g46d8f462ee-20261001 Copyright (c) 2000-2026\n',
      }),
    );
    probeFfmpegVersionAtBoot();
    await settle();
    expect(spawnMock.mock.calls.map((c) => c[0]).sort()).toEqual(['ffmpeg', 'ffmpeg-nvenc']);
    expect(getFfmpegVersionCached()).toBe('n9.0.2-22-g46d8f462ee-20261001');
    expect(getFfmpegNvencVersionCached()).toBe('7.1.4-Jellyfin');
  });

  it('a missing NVENC binary yields null without touching the primary', async () => {
    spawnMock.mockImplementation((bin: string) =>
      bin === 'ffmpeg-nvenc'
        ? fakeChild({ error: enoent() })
        : fakeChild({ stdout: 'ffmpeg version 6.1.1 Copyright\n' }),
    );
    probeFfmpegVersionAtBoot();
    await settle();
    expect(getFfmpegVersionCached()).toBe('6.1.1');
    expect(getFfmpegNvencVersionCached()).toBeNull();
  });

  it('probes the NVENC binary through FFMPEG_NVENC_PATH', async () => {
    process.env.FFMPEG_NVENC_PATH = '/opt/x/ffmpeg-nvenc';
    spawnMock.mockImplementation(() => fakeChild({ stdout: 'ffmpeg version 7.1.4-Jellyfin\n' }));
    probeFfmpegVersionAtBoot();
    await settle();
    expect(spawnMock.mock.calls.map((c) => c[0])).toContain('/opt/x/ffmpeg-nvenc');
  });

  it('probes once per process (idempotent boot call)', async () => {
    spawnMock.mockImplementation(() => fakeChild({ stdout: 'ffmpeg version 6.1.1\n' }));
    probeFfmpegVersionAtBoot();
    probeFfmpegVersionAtBoot();
    await settle();
    probeFfmpegVersionAtBoot();
    await settle();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
