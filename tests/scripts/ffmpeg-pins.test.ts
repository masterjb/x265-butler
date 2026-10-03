import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  readPins,
  writePins,
  mirrorUrl,
  parseSha256Sums,
  buildStringOf,
  binaryEntryFromSums,
} from '../../scripts/ffmpeg-pins.js';

/**
 * 52-06: the Dockerfile is the single source of the ffmpeg pins (mirror release tag, asset name,
 * sha256 for each of the two binaries). Image build, CI fetch and the mirror script all read the
 * same six ARG lines, so they cannot drift apart.
 */

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'ffmpeg-pins.js');
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

const DOCKERFILE = `FROM debian:trixie-slim AS ffmpeg-bin
# ARG FFMPEG_ASSET=commented-out-must-be-ignored
ARG FFMPEG_MIRROR_TAG=ffmpeg-n9.0.2-22-g46d8f462ee
ARG FFMPEG_ASSET=ffmpeg-n9.0.2-22-g46d8f462ee-linux64-gpl-9.0.tar.xz
ARG FFMPEG_SHA256=${SHA_A}
RUN echo build

FROM debian:trixie-slim AS ffmpeg-nvenc-bin
ARG FFMPEG_NVENC_MIRROR_TAG=jellyfin-ffmpeg-v7.1.4-3
ARG FFMPEG_NVENC_ASSET=jellyfin-ffmpeg_7.1.4-3_portable_linux64-gpl.tar.xz
ARG FFMPEG_NVENC_SHA256=${SHA_B}
RUN echo nvenc
`;

function changedLines(a: string, b: string): number {
  const la = a.split('\n');
  const lb = b.split('\n');
  expect(lb.length).toBe(la.length);
  return la.filter((l, i) => l !== lb[i]).length;
}

describe('readPins', () => {
  it('reads both pins from the six ARG lines and ignores comments', () => {
    expect(readPins(DOCKERFILE)).toEqual({
      btbn: {
        tag: 'ffmpeg-n9.0.2-22-g46d8f462ee',
        asset: 'ffmpeg-n9.0.2-22-g46d8f462ee-linux64-gpl-9.0.tar.xz',
        sha256: SHA_A,
      },
      nvenc: {
        tag: 'jellyfin-ffmpeg-v7.1.4-3',
        asset: 'jellyfin-ffmpeg_7.1.4-3_portable_linux64-gpl.tar.xz',
        sha256: SHA_B,
      },
    });
  });

  it('names the ARG when one is missing', () => {
    const text = DOCKERFILE.replace(/^ARG FFMPEG_NVENC_ASSET=.*\n/m, '');
    expect(() => readPins(text)).toThrow(/FFMPEG_NVENC_ASSET/);
  });

  it('names the ARG when one is defined twice', () => {
    const text = DOCKERFILE + `ARG FFMPEG_SHA256=${SHA_C}\n`;
    expect(() => readPins(text)).toThrow(/FFMPEG_SHA256/);
  });

  it('rejects a sha256 that is not 64 lowercase hex characters', () => {
    const text = DOCKERFILE.replace(SHA_B, 'B'.repeat(64));
    expect(() => readPins(text)).toThrow(/FFMPEG_NVENC_SHA256/);
    expect(() => readPins(DOCKERFILE.replace(SHA_A, 'abc'))).toThrow(/FFMPEG_SHA256/);
  });

  it('reads the real Dockerfile of this repository', () => {
    const real = readFileSync(resolve(__dirname, '..', '..', 'Dockerfile'), 'utf8');
    const pins = readPins(real);
    expect(pins.btbn.asset).toMatch(/-linux64-gpl/);
    expect(pins.nvenc.asset).toMatch(/portable_linux64-gpl/);
  });
});

describe('writePins', () => {
  it('replaces exactly the six pin lines and keeps every other byte', () => {
    const next = writePins(DOCKERFILE, {
      btbn: { tag: 'ffmpeg-x', asset: 'ffmpeg-x-linux64-gpl.tar.xz', sha256: SHA_C },
      nvenc: {
        tag: 'jellyfin-ffmpeg-y',
        asset: 'jellyfin-ffmpeg_y_portable_linux64-gpl.tar.xz',
        sha256: SHA_A,
      },
    });
    expect(changedLines(DOCKERFILE, next)).toBe(6);
    expect(next).toContain('# ARG FFMPEG_ASSET=commented-out-must-be-ignored');
    expect(readPins(next).btbn.sha256).toBe(SHA_C);
    expect(readPins(next).nvenc.tag).toBe('jellyfin-ffmpeg-y');
  });

  it('writes only the three lines of one binary when given one', () => {
    const next = writePins(DOCKERFILE, {
      btbn: {
        tag: 'ffmpeg-N-126947-g45f3fecca9',
        asset: 'ffmpeg-N-126947-g45f3fecca9-linux64-gpl.tar.xz',
        sha256: SHA_C,
      },
    });
    expect(changedLines(DOCKERFILE, next)).toBe(3);
    expect(readPins(next).nvenc).toEqual(readPins(DOCKERFILE).nvenc);
  });

  it('refuses an invalid pin instead of writing it', () => {
    expect(() => writePins(DOCKERFILE, { btbn: { tag: 'x', asset: 'y', sha256: 'nope' } })).toThrow(
      /sha256/,
    );
  });
});

describe('helpers', () => {
  it('mirrorUrl points at the public mirror repository', () => {
    expect(mirrorUrl({ tag: 't', asset: 'a.tar.xz' })).toBe(
      'https://github.com/masterjb/x265-butler/releases/download/t/a.tar.xz',
    );
  });

  it('buildStringOf extracts the ffmpeg build from both asset name styles', () => {
    expect(buildStringOf('ffmpeg-n9.0.2-22-g46d8f462ee-linux64-gpl-9.0.tar.xz')).toBe(
      'n9.0.2-22-g46d8f462ee',
    );
    expect(buildStringOf('ffmpeg-N-126947-g45f3fecca9-linux64-gpl.tar.xz')).toBe(
      'N-126947-g45f3fecca9',
    );
    expect(buildStringOf('jellyfin-ffmpeg_7.1.4-3_portable_linux64-gpl.tar.xz')).toBe('7.1.4-3');
  });

  it('parseSha256Sums reads `sha  name` lines', () => {
    expect(parseSha256Sums(`${SHA_A}  one.tar.xz\n${SHA_B} *two.tar.gz\n\n`)).toEqual({
      'one.tar.xz': SHA_A,
      'two.tar.gz': SHA_B,
    });
  });

  it('binaryEntryFromSums picks the binary tarball, not the source archive', () => {
    const sums = {
      'ffmpeg-N-126947-g45f3fecca9-linux64-gpl.tar.xz': SHA_A,
      'ffmpeg-source-45f3fecca9.tar.gz': SHA_B,
    };
    expect(binaryEntryFromSums(sums, 'btbn')).toEqual({
      asset: 'ffmpeg-N-126947-g45f3fecca9-linux64-gpl.tar.xz',
      sha256: SHA_A,
    });
    expect(() => binaryEntryFromSums(sums, 'nvenc')).toThrow();
  });
});

// AC-8: the way back. `set` writes a pin from a mirror release's SHA256SUMS, without touching
// upstream, so a rollback to the build that shipped before 52-06 is one command.
describe('ffmpeg-pins.js set (rollback path)', () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ffmpeg-pins-'));
    writeFileSync(join(dir, 'Dockerfile'), DOCKERFILE);
    server = createServer((req, res) => {
      if (req.url === '/ffmpeg-N-126947-g45f3fecca9/SHA256SUMS') {
        res.end(
          `${SHA_C}  ffmpeg-N-126947-g45f3fecca9-linux64-gpl.tar.xz\n${SHA_A}  ffmpeg-source-45f3fecca9.tar.gz\n`,
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  function run(args: string[]) {
    return new Promise<{ status: number | null; stderr: string }>((done) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], {
        cwd: dir,
        env: { ...process.env, FFMPEG_MIRROR_DOWNLOAD_BASE: base },
      });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += String(c)));
      child.on('close', (status) => done({ status, stderr }));
    });
  }

  it('writes the three btbn pins from the release SHA256SUMS', async () => {
    const r = await run(['set', 'btbn', 'ffmpeg-N-126947-g45f3fecca9']);
    expect(r.status, r.stderr).toBe(0);
    const next = readFileSync(join(dir, 'Dockerfile'), 'utf8');
    expect(changedLines(DOCKERFILE, next)).toBe(3);
    expect(readPins(next).btbn).toEqual({
      tag: 'ffmpeg-N-126947-g45f3fecca9',
      asset: 'ffmpeg-N-126947-g45f3fecca9-linux64-gpl.tar.xz',
      sha256: SHA_C,
    });
  });

  it('build prints the pinned build string (CI ffmpeg-smoke compares it with ffmpeg -version)', async () => {
    const out = await new Promise<string>((done) => {
      const child = spawn(process.execPath, [SCRIPT, 'build', 'btbn'], { cwd: dir });
      let o = '';
      child.stdout.on('data', (c) => (o += String(c)));
      child.on('close', () => done(o));
    });
    expect(out.trim()).toBe('n9.0.2-22-g46d8f462ee');
  });

  it('fails and leaves the Dockerfile alone when the release does not exist', async () => {
    const r = await run(['set', 'btbn', 'ffmpeg-does-not-exist']);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(dir, 'Dockerfile'), 'utf8')).toBe(DOCKERFILE);
  });
});
