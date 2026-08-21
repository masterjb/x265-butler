// 50-02 Task 1 — the cover-extraction leaf: kill-switch resolver (AC-19), the
// exact extraction argv (AC-13), the never-throw failure matrix (AC-5 / AC-21),
// the on-disk-target rule (AC-11), the attach cap (AC-24) and cancel handling
// (AC-22).
//
// The child process is MOCKED, the filesystem is REAL: a fake spawn lets the
// test drive exit codes / timeouts / aborts deterministically, while the
// "did ffmpeg actually write something" half is asserted against a real tmpdir —
// that half is exactly where an over-mocked test would prove nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({
  spawn: vi.fn(),
  reniceChild: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: hoisted.spawn, default: { spawn: hoisted.spawn } }));
vi.mock('@/src/lib/encode/child-priority', () => ({
  reniceChild: hoisted.reniceChild,
  // resolveEncodeNice/isEncodeNiceDegraded are not used by cover-extract, but a
  // partial mock would break any future importer of this module graph.
  resolveEncodeNice: () => 19,
  isEncodeNiceDegraded: () => false,
}));

import {
  COVER_ATTACH_MAX,
  COVER_EXTRACT_TIMEOUT_MS,
  buildCoverExtractArgs,
  coverAttachEnabled,
  extractCovers,
  resolveCoverAttachEnabled,
  __forTests_resetCoverAttachCache,
} from '@/src/lib/encode/cover-extract';
import type { CoverStream } from '@/src/lib/encode/attached-pic';
import { logger } from '@/src/lib/logger';

class FakeChild extends EventEmitter {
  pid = 4242;
  stderr = new PassThrough();
  kill = vi.fn();
}

function newChild(): FakeChild {
  const c = new FakeChild();
  hoisted.spawn.mockReturnValueOnce(c);
  return c;
}

/** A cover descriptor as describeAttachedPictures would produce it. */
function coverStream(over: Partial<CoverStream> = {}): CoverStream {
  return {
    videoOrdinal: 1,
    codecName: 'mjpeg',
    media: { ext: 'jpg', mimetype: 'image/jpeg' },
    sourceFilename: 'cover.jpg',
    ...over,
  };
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

function warnsWithReason(log: ReturnType<typeof makeLog>, reason: string) {
  return log.warn.mock.calls.filter((c) => (c[0] as { reason?: string }).reason === reason);
}

const _origEnv = process.env.ENCODE_COVER_ATTACH_DISABLED;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'x265-cover-extract-'));
  hoisted.spawn.mockReset();
  hoisted.reniceChild.mockReset();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  if (_origEnv === undefined) delete process.env.ENCODE_COVER_ATTACH_DISABLED;
  else process.env.ENCODE_COVER_ATTACH_DISABLED = _origEnv;
  __forTests_resetCoverAttachCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── AC-19: the kill-switch follows the repo convention ────────────────────────
describe('resolveCoverAttachEnabled — AC-19 kill-switch convention', () => {
  it("ONLY exactly '1' disables the attach path", () => {
    expect(resolveCoverAttachEnabled('1')).toBe(false);
    expect(resolveCoverAttachEnabled(' 1 ')).toBe(false);
  });

  it('unset / 0 / true / junk all leave attaching ACTIVE', () => {
    for (const raw of [undefined, '', '   ', '0', 'true', 'TRUE', 'yes', 'disabled', '11', 'x']) {
      expect(resolveCoverAttachEnabled(raw)).toBe(true);
    }
  });
});

describe('coverAttachEnabled — AC-19 memoization + exactly one info line', () => {
  it('resolves once and logs cover_attach_resolved exactly once, at info', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger as never);
    delete process.env.ENCODE_COVER_ATTACH_DISABLED;
    expect(coverAttachEnabled()).toBe(true);
    expect(coverAttachEnabled()).toBe(true);
    expect(coverAttachEnabled()).toBe(true);
    const lines = infoSpy.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'cover_attach_resolved',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({ enabled: true, source: 'default', envRaw: null });
  });

  it('ENCODE_COVER_ATTACH_DISABLED=1 → enabled=false, source=env', () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger as never);
    process.env.ENCODE_COVER_ATTACH_DISABLED = '1';
    expect(coverAttachEnabled()).toBe(false);
    const lines = infoSpy.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'cover_attach_resolved',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({ enabled: false, source: 'env', envRaw: '1' });
  });
});

// ── AC-13: the extraction argv, token for token ───────────────────────────────
describe('buildCoverExtractArgs — AC-13', () => {
  it('is the exact measured token sequence (M-D)', () => {
    expect(buildCoverExtractArgs('/work/input', 1, '/work/cover0.jpg')).toEqual([
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      '/work/input',
      '-map',
      '0:v:1',
      '-c',
      'copy',
      '-frames:v',
      '1',
      '-f',
      'image2',
      '/work/cover0.jpg',
    ]);
  });

  it('the ordinal rides the -map value, never the input or the output path', () => {
    const args = buildCoverExtractArgs('/work/input', 3, '/work/cover0.png');
    expect(args[args.indexOf('-map') + 1]).toBe('0:v:3');
    // `-f image2` is explicit: M-Q proved the path suffix does NOT select the
    // muxer, so the suffix must come from the codec and the muxer from here.
    expect(args[args.indexOf('-f') + 1]).toBe('image2');
  });
});

// ── the happy path ────────────────────────────────────────────────────────────
describe('extractCovers — success', () => {
  it('extracts one cover, renices the child (AC-13) and returns the attachment', async () => {
    const log = makeLog();
    const child = newChild();
    const p = extractCovers('/work/input', workDir, [coverStream()], { log, jobId: 7 });

    expect(hoisted.spawn).toHaveBeenCalledTimes(1);
    expect(hoisted.spawn.mock.calls[0][1]).toEqual(
      buildCoverExtractArgs('/work/input', 1, join(workDir, 'cover0.jpg')),
    );
    // 38-01: renice happens on the spawned child, uniformly with every other
    // ffmpeg child the app starts.
    expect(hoisted.reniceChild).toHaveBeenCalledTimes(1);
    expect(hoisted.reniceChild.mock.calls[0][0]).toBe(child);

    writeFileSync(join(workDir, 'cover0.jpg'), 'JPEGDATA');
    child.emit('close', 0);

    await expect(p).resolves.toEqual([
      {
        path: join(workDir, 'cover0.jpg'),
        mimetype: 'image/jpeg',
        filename: 'cover.jpg',
      },
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('AC-12: without a source filename the tag falls back to cover<N>.<ext>', async () => {
    const log = makeLog();
    const child = newChild();
    const p = extractCovers('/work/input', workDir, [coverStream({ sourceFilename: null })], {
      log,
    });
    writeFileSync(join(workDir, 'cover0.jpg'), 'x');
    child.emit('close', 0);
    await expect(p).resolves.toEqual([
      { path: join(workDir, 'cover0.jpg'), mimetype: 'image/jpeg', filename: 'cover0.jpg' },
    ]);
  });

  it('AC-11: the on-disk target comes from position + codec, NEVER from source data', async () => {
    const log = makeLog();
    const child = newChild();
    // A FILENAME tag of '../../etc/passwd' sanitizes to 'passwd' for the TAG —
    // and must not influence the PATH at all.
    const p = extractCovers('/work/input', workDir, [coverStream({ sourceFilename: 'passwd' })], {
      log,
    });
    writeFileSync(join(workDir, 'cover0.jpg'), 'x');
    child.emit('close', 0);
    const [att] = await p;
    expect(att.path).toBe(join(workDir, 'cover0.jpg'));
    expect(att.path).not.toContain('passwd');
    expect(att.filename).toBe('passwd');
  });

  it('AC-4: two covers extract sequentially into distinct, non-colliding paths', async () => {
    const log = makeLog();
    const c0 = newChild();
    const c1 = newChild();
    const p = extractCovers(
      '/work/input',
      workDir,
      [
        coverStream({ videoOrdinal: 1, sourceFilename: 'cover.jpg' }),
        coverStream({
          videoOrdinal: 2,
          codecName: 'png',
          media: { ext: 'png', mimetype: 'image/png' },
          sourceFilename: 'small.png',
        }),
      ],
      { log },
    );

    // SEQUENTIAL: the second child is not spawned before the first has closed.
    expect(hoisted.spawn).toHaveBeenCalledTimes(1);
    writeFileSync(join(workDir, 'cover0.jpg'), 'a');
    c0.emit('close', 0);
    await vi.waitFor(() => expect(hoisted.spawn).toHaveBeenCalledTimes(2));
    writeFileSync(join(workDir, 'cover1.png'), 'b');
    c1.emit('close', 0);

    await expect(p).resolves.toEqual([
      { path: join(workDir, 'cover0.jpg'), mimetype: 'image/jpeg', filename: 'cover.jpg' },
      { path: join(workDir, 'cover1.png'), mimetype: 'image/png', filename: 'small.png' },
    ]);
  });

  it('an empty cover list spawns nothing', async () => {
    await expect(extractCovers('/work/input', workDir, [], { log: makeLog() })).resolves.toEqual(
      [],
    );
    expect(hoisted.spawn).not.toHaveBeenCalled();
  });
});

// ── AC-5 / AC-6 / AC-21: the failure matrix — never throws, always one warn ───
describe('extractCovers — failure matrix (AC-5 / AC-21)', () => {
  it('AC-6: an unsupported codec starts NO spawn and warns unsupported_codec', async () => {
    const log = makeLog();
    const p = extractCovers(
      '/work/input',
      workDir,
      [coverStream({ codecName: 'tiff', media: null })],
      { log, jobId: 9 },
    );
    await expect(p).resolves.toEqual([]);
    expect(hoisted.spawn).not.toHaveBeenCalled();
    const w = warnsWithReason(log, 'unsupported_codec');
    expect(w).toHaveLength(1);
    expect(w[0][0]).toMatchObject({
      action: 'cover_extract_failed',
      jobId: 9,
      videoOrdinal: 1,
      codecName: 'tiff',
    });
  });

  it('a non-zero exit drops the cover and warns exit_nonzero', async () => {
    const log = makeLog();
    const child = newChild();
    const p = extractCovers('/work/input', workDir, [coverStream()], { log, jobId: 3 });
    child.stderr.write('Stream map 0:v:1 matches no streams.\n');
    child.emit('close', 234);
    await expect(p).resolves.toEqual([]);
    const w = warnsWithReason(log, 'exit_nonzero');
    expect(w).toHaveLength(1);
    expect(w[0][0]).toMatchObject({ action: 'cover_extract_failed', jobId: 3, videoOrdinal: 1 });
  });

  it('a spawn THROW is caught and reported as spawn_failed', async () => {
    const log = makeLog();
    hoisted.spawn.mockImplementationOnce(() => {
      throw new Error('ENOENT ffmpeg');
    });
    await expect(extractCovers('/work/input', workDir, [coverStream()], { log })).resolves.toEqual(
      [],
    );
    expect(warnsWithReason(log, 'spawn_failed')).toHaveLength(1);
  });

  it("a child 'error' event is reported as spawn_failed", async () => {
    const log = makeLog();
    const child = newChild();
    const p = extractCovers('/work/input', workDir, [coverStream()], { log });
    child.emit('error', new Error('EACCES'));
    await expect(p).resolves.toEqual([]);
    expect(warnsWithReason(log, 'spawn_failed')).toHaveLength(1);
  });

  it('exit 0 but NO output file → missing_output', async () => {
    const log = makeLog();
    const child = newChild();
    const p = extractCovers('/work/input', workDir, [coverStream()], { log });
    child.emit('close', 0); // nothing was written
    await expect(p).resolves.toEqual([]);
    expect(warnsWithReason(log, 'missing_output')).toHaveLength(1);
  });

  it('exit 0 but a 0-BYTE output file → empty_output', async () => {
    const log = makeLog();
    const child = newChild();
    const p = extractCovers('/work/input', workDir, [coverStream()], { log });
    writeFileSync(join(workDir, 'cover0.jpg'), '');
    child.emit('close', 0);
    await expect(p).resolves.toEqual([]);
    expect(warnsWithReason(log, 'empty_output')).toHaveLength(1);
  });

  it('AC-13: a child that outlives COVER_EXTRACT_TIMEOUT_MS is SIGKILLed', async () => {
    vi.useFakeTimers();
    const log = makeLog();
    const child = newChild();
    const p = extractCovers('/work/input', workDir, [coverStream()], { log });

    await vi.advanceTimersByTimeAsync(COVER_EXTRACT_TIMEOUT_MS + 1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null);

    await expect(p).resolves.toEqual([]);
    const w = warnsWithReason(log, 'timeout');
    expect(w).toHaveLength(1);
  });

  it('one bad cover does not stop the good one behind it', async () => {
    const log = makeLog();
    const c0 = newChild();
    const c1 = newChild();
    const p = extractCovers(
      '/work/input',
      workDir,
      [coverStream({ videoOrdinal: 1 }), coverStream({ videoOrdinal: 2 })],
      { log },
    );
    c0.emit('close', 1);
    await vi.waitFor(() => expect(hoisted.spawn).toHaveBeenCalledTimes(2));
    writeFileSync(join(workDir, 'cover1.jpg'), 'ok');
    c1.emit('close', 0);
    const res = await p;
    expect(res).toHaveLength(1);
    expect(res[0].path).toBe(join(workDir, 'cover1.jpg'));
  });
});

// ── AC-22: cancel ─────────────────────────────────────────────────────────────
describe('extractCovers — cancel (AC-22)', () => {
  it('an abort during the extraction kills the child and unregisters the listener', async () => {
    const log = makeLog();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const child = newChild();
    const p = extractCovers('/work/input', workDir, [coverStream()], {
      log,
      signal: controller.signal,
    });

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(p).resolves.toEqual([]);
    // cropdetect pattern: the listener must be removed, or every cancelled job
    // leaks one listener on a signal that outlives the extraction.
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(warnsWithReason(log, 'aborted')).toHaveLength(1);
  });

  it('a signal that is ALREADY aborted spawns nothing at all', async () => {
    const log = makeLog();
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractCovers('/work/input', workDir, [coverStream()], { log, signal: controller.signal }),
    ).resolves.toEqual([]);
    expect(hoisted.spawn).not.toHaveBeenCalled();
    expect(warnsWithReason(log, 'aborted')).toHaveLength(1);
  });

  it('the listener is removed on the NORMAL path too (no leak per cover)', async () => {
    const log = makeLog();
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const child = newChild();
    const p = extractCovers('/work/input', workDir, [coverStream()], {
      log,
      signal: controller.signal,
    });
    writeFileSync(join(workDir, 'cover0.jpg'), 'x');
    child.emit('close', 0);
    await p;
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

// ── AC-24: the attach cap ─────────────────────────────────────────────────────
describe('extractCovers — COVER_ATTACH_MAX (AC-24 / E10)', () => {
  it('is 4 — the documented worst case is 4 × 30 s, not unbounded', () => {
    expect(COVER_ATTACH_MAX).toBe(4);
    expect(COVER_EXTRACT_TIMEOUT_MS).toBe(30_000);
  });

  it('spawns at most COVER_ATTACH_MAX children and warns cover_cap_exceeded once', async () => {
    const log = makeLog();
    const children = Array.from({ length: COVER_ATTACH_MAX + 3 }, () => newChild());
    const covers = Array.from({ length: COVER_ATTACH_MAX + 3 }, (_, i) =>
      coverStream({ videoOrdinal: i + 1 }),
    );
    const p = extractCovers('/work/input', workDir, covers, { log, jobId: 11 });

    for (let i = 0; i < COVER_ATTACH_MAX; i += 1) {
      await vi.waitFor(() => expect(hoisted.spawn).toHaveBeenCalledTimes(i + 1));
      writeFileSync(join(workDir, `cover${i}.jpg`), 'x');
      children[i].emit('close', 0);
    }

    const res = await p;
    expect(res).toHaveLength(COVER_ATTACH_MAX);
    expect(hoisted.spawn).toHaveBeenCalledTimes(COVER_ATTACH_MAX);
    const w = warnsWithReason(log, 'cover_cap_exceeded');
    expect(w).toHaveLength(1);
    expect(w[0][0]).toMatchObject({
      action: 'cover_extract_failed',
      jobId: 11,
      coverCount: COVER_ATTACH_MAX + 3,
      cap: COVER_ATTACH_MAX,
    });
  });

  it('exactly COVER_ATTACH_MAX covers do NOT trip the cap warn', async () => {
    const log = makeLog();
    const children = Array.from({ length: COVER_ATTACH_MAX }, () => newChild());
    const covers = Array.from({ length: COVER_ATTACH_MAX }, (_, i) =>
      coverStream({ videoOrdinal: i + 1 }),
    );
    const p = extractCovers('/work/input', workDir, covers, { log });
    for (let i = 0; i < COVER_ATTACH_MAX; i += 1) {
      await vi.waitFor(() => expect(hoisted.spawn).toHaveBeenCalledTimes(i + 1));
      writeFileSync(join(workDir, `cover${i}.jpg`), 'x');
      children[i].emit('close', 0);
    }
    await p;
    expect(warnsWithReason(log, 'cover_cap_exceeded')).toHaveLength(0);
  });
});
