import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  default: { spawn: spawnMock },
}));

import { detectCrop } from '@/src/lib/encode/cropdetect';
// parseCropGeometry moved to crop-geometry.ts (35-02) — its dedicated parse tests
// live in tests/encode/crop-geometry.test.ts. cropdetect keeps the detect tests.

class FakeChild extends EventEmitter {
  stderr = new EventEmitter() as EventEmitter & { setEncoding?: (enc: string) => void };
  kill = vi.fn();
  constructor() {
    super();
    this.stderr.setEncoding = () => {};
  }
}

const silentLogger = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  spawnMock.mockReset();
  silentLogger.info.mockReset();
  silentLogger.warn.mockReset();
});

// Drive a FakeChild: emit converging cropdetect stderr lines then close.
function emitAndClose(child: FakeChild, stderrChunks: string[], code = 0): void {
  for (const c of stderrChunks) child.stderr.emit('data', c);
  child.emit('close', code);
}

// Let pending microtasks settle so detectCrop's awaited retry can spawn the
// SECOND child before the test emits its events on it.
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('detectCrop', () => {
  it('returns the LAST converging crop= line', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = detectCrop('/v.mkv', { logger: silentLogger });
    emitAndClose(child, [
      '[Parsed_cropdetect] crop=1920:802:0:138\n',
      '[Parsed_cropdetect] crop=1920:800:0:140\n',
    ]);
    expect(await p).toBe('1920:800:0:140');
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('returns a full-frame crop verbatim (NOT dropped here — the orchestrator drops it)', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = detectCrop('/v.mkv', { durationSeconds: 7200, logger: silentLogger });
    emitAndClose(child, ['crop=1920:1080:0:0\n']);
    expect(await p).toBe('1920:1080:0:0');
  });

  it('returns null when stderr has no crop line (after offset-0 retry)', async () => {
    const c1 = new FakeChild();
    const c2 = new FakeChild();
    spawnMock.mockReturnValueOnce(c1).mockReturnValueOnce(c2);
    const p = detectCrop('/v.mkv', { logger: silentLogger });
    emitAndClose(c1, ['no crop here\n']);
    await flush();
    emitAndClose(c2, ['still nothing\n']);
    expect(await p).toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('SR-1: no-crop first sample, then crop on the offset-0 retry → returned', async () => {
    const c1 = new FakeChild();
    const c2 = new FakeChild();
    spawnMock.mockReturnValueOnce(c1).mockReturnValueOnce(c2);
    const p = detectCrop('/short.mkv', { logger: silentLogger });
    emitAndClose(c1, ['frame=0\n']); // seek past EOF: empty
    await flush();
    emitAndClose(c2, ['crop=1280:536:0:92\n']);
    expect(await p).toBe('1280:536:0:92');
    // retry happened at offset 0
    expect(spawnMock.mock.calls[1][1]).toEqual(expect.arrayContaining(['-ss', '0']));
  });

  it('SR-1: known short duration clamps the seek offset (40s clip → 4s)', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = detectCrop('/clip.mkv', { durationSeconds: 40, logger: silentLogger });
    emitAndClose(child, ['crop=1920:800:0:140\n']);
    await p;
    const args = spawnMock.mock.calls[0][1] as string[];
    const ssIdx = args.indexOf('-ss');
    expect(args[ssIdx + 1]).toBe('4');
  });

  it('returns null and does not throw on spawn error (no retry — ok:false)', async () => {
    const c1 = new FakeChild();
    spawnMock.mockReturnValueOnce(c1);
    const p = detectCrop('/v.mkv', { logger: silentLogger });
    c1.emit('error', new Error('ENOENT'));
    await expect(p).resolves.toBeNull();
    expect(silentLogger.warn).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('returns null on nonzero exit (no retry — ok:false)', async () => {
    const c1 = new FakeChild();
    spawnMock.mockReturnValueOnce(c1);
    const p = detectCrop('/v.mkv', { logger: silentLogger });
    c1.emit('close', 1);
    await expect(p).resolves.toBeNull();
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('SR-4: a pre-aborted signal short-circuits without spawning and returns null', async () => {
    const controller = new AbortController();
    controller.abort();
    const p = detectCrop('/v.mkv', { signal: controller.signal, logger: silentLogger });
    await expect(p).resolves.toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('SR-4: an abort mid-detect kills the child and returns null', async () => {
    const controller = new AbortController();
    const child = new FakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = detectCrop('/v.mkv', { signal: controller.signal, logger: silentLogger });
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(p).resolves.toBeNull();
  });
});
