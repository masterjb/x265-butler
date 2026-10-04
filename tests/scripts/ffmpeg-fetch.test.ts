import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

/**
 * 52-06: scripts/ffmpeg-fetch.js fetches the pinned ffmpeg (CI job `ffmpeg-smoke`, developers).
 * It checks the sha256 BEFORE unpacking and only moves a complete result into place, so a
 * mismatch never leaves a binary behind that a later step could pick up.
 */

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'ffmpeg-fetch.js');
const BTBN_ASSET = 'ffmpeg-n9.0.2-22-g46d8f462ee-linux64-gpl-9.0.tar.xz';
const JF_ASSET = 'jellyfin-ffmpeg_7.1.4-3_portable_linux64-gpl.tar.xz';

let dir: string;
let server: Server;
let base: string;
let hits: string[];
let failFirst = 0;

function tarball(name: string, layout: 'btbn' | 'flat'): string {
  const root = mkdtempSync(join(dir, 'src-'));
  const inner = name.replace(/\.tar\.xz$/, '');
  const binDir = layout === 'btbn' ? join(root, inner, 'bin') : root;
  mkdirSync(binDir, { recursive: true });
  for (const b of ['ffmpeg', 'ffprobe']) {
    writeFileSync(join(binDir, b), `#!/bin/sh\necho ${b}-${layout}\n`);
    chmodSync(join(binDir, b), 0o755);
  }
  const out = join(dir, 'serve', name);
  execFileSync('tar', [
    '-czf',
    out,
    '-C',
    root,
    ...(layout === 'btbn' ? [inner] : ['ffmpeg', 'ffprobe']),
  ]);
  return out;
}

const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

function dockerfile(btbnSha: string, nvencSha: string) {
  return `ARG FFMPEG_MIRROR_TAG=ffmpeg-n9.0.2-22-g46d8f462ee
ARG FFMPEG_ASSET=${BTBN_ASSET}
ARG FFMPEG_SHA256=${btbnSha}
ARG FFMPEG_NVENC_MIRROR_TAG=jellyfin-ffmpeg-v7.1.4-3
ARG FFMPEG_NVENC_ASSET=${JF_ASSET}
ARG FFMPEG_NVENC_SHA256=${nvencSha}
`;
}

function run(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: join(dir, 'repo'),
      env: { ...process.env, FFMPEG_MIRROR_DOWNLOAD_BASE: base, FFMPEG_FETCH_RETRY_DELAY_MS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

describe('ffmpeg-fetch.js', () => {
  let btbnSha: string;
  let jfSha: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ffmpeg-fetch-'));
    mkdirSync(join(dir, 'serve'));
    mkdirSync(join(dir, 'repo'));
    btbnSha = sha(tarball(BTBN_ASSET, 'btbn'));
    jfSha = sha(tarball(JF_ASSET, 'flat'));
    hits = [];
    failFirst = 0;
    server = createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? '');
      hits.push(url);
      if (failFirst > 0) {
        failFirst--;
        res.statusCode = 404;
        res.end();
        return;
      }
      const file = join(dir, 'serve', url.split('/').pop() ?? '');
      if (!existsSync(file)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.end(readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('fetches the pinned btbn build into <dest>/bin with ffmpeg and ffprobe', async () => {
    writeFileSync(join(dir, 'repo', 'Dockerfile'), dockerfile(btbnSha, jfSha));
    const dest = join(dir, 'out');
    const r = await run([dest]);
    expect(r.status, r.stderr).toBe(0);
    expect(hits).toContain(`/ffmpeg-n9.0.2-22-g46d8f462ee/${BTBN_ASSET}`);
    for (const b of ['ffmpeg', 'ffprobe']) {
      expect(statSync(join(dest, 'bin', b)).mode & 0o111).not.toBe(0);
    }
    expect(execFileSync(join(dest, 'bin', 'ffmpeg'), { encoding: 'utf8' })).toContain(
      'ffmpeg-btbn',
    );
  });

  it('normalises the flat jellyfin layout to <dest>/bin', async () => {
    writeFileSync(join(dir, 'repo', 'Dockerfile'), dockerfile(btbnSha, jfSha));
    const dest = join(dir, 'out-nvenc');
    const r = await run([dest, 'nvenc']);
    expect(r.status, r.stderr).toBe(0);
    expect(execFileSync(join(dest, 'bin', 'ffmpeg'), { encoding: 'utf8' })).toContain(
      'ffmpeg-flat',
    );
  });

  it('refuses a hash mismatch, names both hashes and leaves nothing unpacked', async () => {
    const wrong = '0'.repeat(64);
    writeFileSync(join(dir, 'repo', 'Dockerfile'), dockerfile(wrong, jfSha));
    const dest = join(dir, 'out');
    const r = await run([dest]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(wrong);
    expect(r.stderr).toContain(btbnSha);
    expect(existsSync(join(dest, 'bin'))).toBe(false);
  });

  it('retries an asset that is not served yet (fresh upload) and then succeeds', async () => {
    writeFileSync(join(dir, 'repo', 'Dockerfile'), dockerfile(btbnSha, jfSha));
    failFirst = 2;
    const r = await run([join(dir, 'out')]);
    expect(r.status, r.stderr).toBe(0);
    expect(hits.length).toBe(3);
    expect(r.stderr).toMatch(/retry 1\/4/);
  });

  it('gives up after five attempts with the URL in the message', async () => {
    writeFileSync(join(dir, 'repo', 'Dockerfile'), dockerfile(btbnSha, jfSha));
    failFirst = 99;
    const r = await run([join(dir, 'out')]);
    expect(r.status).not.toBe(0);
    expect(hits.length).toBe(5);
    expect(r.stderr).toMatch(/gave up after 5 attempts/);
    failFirst = 0;
  });

  it('reuses a cached tarball with the right hash and refetches a corrupt one', async () => {
    writeFileSync(join(dir, 'repo', 'Dockerfile'), dockerfile(btbnSha, jfSha));
    const cache = join(dir, 'cache');
    mkdirSync(cache);
    let r = await run([join(dir, 'o1'), 'btbn', '--cache', cache]);
    expect(r.status, r.stderr).toBe(0);
    expect(hits.length).toBe(1);
    r = await run([join(dir, 'o2'), 'btbn', '--cache', cache]);
    expect(r.status, r.stderr).toBe(0);
    expect(hits.length).toBe(1); // served from cache
    writeFileSync(join(cache, BTBN_ASSET), 'corrupt');
    r = await run([join(dir, 'o3'), 'btbn', '--cache', cache]);
    expect(r.status, r.stderr).toBe(0);
    expect(hits.length).toBe(2); // corrupt cache entry was replaced
  });
});
