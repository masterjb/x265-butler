import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pickBtbnAsset } from '../../scripts/ffmpeg-mirror.js';
import { readPins } from '../../scripts/ffmpeg-pins.js';

/**
 * scripts/ffmpeg-mirror.js copies one upstream ffmpeg build into a release of the public
 * repository and pins it in the Dockerfile. It must only ever mirror what it has checked:
 * upstream checksum (BtbN), capabilities of the unpacked binary, and after the upload the bytes
 * the mirror actually serves. It never overwrites or deletes a release.
 *
 * Everything external is a stand-in: a local HTTP server plays GitHub (API, upstream downloads,
 * mirror downloads), a `gh` script on PATH records its calls and "publishes" uploads into the
 * directory the server serves, and the tarballs carry a fake `ffmpeg` shell script. The tarballs
 * are gzip (the CI test image has no xz); the script unpacks with `tar -xf`, which detects both.
 */

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'ffmpeg-mirror.js');
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'fixtures', 'btbn-release.json'), 'utf8'),
) as { assets: { name: string; browser_download_url: string }[] };

const SHA_OLD_B = 'b'.repeat(64);
const DOCKERFILE = `FROM debian:trixie-slim AS ffmpeg-bin
ARG FFMPEG_MIRROR_TAG=ffmpeg-old
ARG FFMPEG_ASSET=ffmpeg-old-linux64-gpl.tar.xz
ARG FFMPEG_SHA256=${'a'.repeat(64)}
FROM debian:trixie-slim AS ffmpeg-nvenc-bin
ARG FFMPEG_NVENC_MIRROR_TAG=jellyfin-ffmpeg-old
ARG FFMPEG_NVENC_ASSET=jellyfin-ffmpeg_old_portable_linux64-gpl.tar.xz
ARG FFMPEG_NVENC_SHA256=${SHA_OLD_B}
`;

describe('pickBtbnAsset', () => {
  it('picks exactly the linux64 gpl static build of the release branch', () => {
    expect(pickBtbnAsset(FIXTURE, 'n9.0').name).toBe(
      'ffmpeg-n9.0.2-22-g46d8f462ee-linux64-gpl-9.0.tar.xz',
    );
    expect(pickBtbnAsset(FIXTURE, 'n8.1').name).toBe(
      'ffmpeg-n8.1.3-14-g330caae0c1-linux64-gpl-8.1.tar.xz',
    );
  });

  it('picks the master build for the rollback pin', () => {
    expect(pickBtbnAsset(FIXTURE, 'master').name).toBe(
      'ffmpeg-N-127054-g9d3f0f2c58-linux64-gpl.tar.xz',
    );
  });

  it('fails when the branch has no matching asset', () => {
    expect(() => pickBtbnAsset(FIXTURE, 'n7.1')).toThrow(/n7\.1/);
  });

  it('fails on an ambiguous match instead of guessing', () => {
    const doubled = {
      assets: [
        ...FIXTURE.assets,
        { name: 'ffmpeg-n9.0.3-1-g0000000000-linux64-gpl-9.0.tar.xz', browser_download_url: 'x' },
      ],
    };
    expect(() => pickBtbnAsset(doubled, 'n9.0')).toThrow(/ambiguous|mehrdeutig/i);
  });
});

// ─────────────────────────── CLI ───────────────────────────

const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.GH_STUB_STATE, 'utf8'));
const tag = args[2];
if (args[0] === 'release' && args[1] === 'view') {
  if (!state.releases[tag]) { process.stderr.write('release not found\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ assets: state.releases[tag].map((name) => ({ name })) }));
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'create') {
  const dir = path.join(process.env.GH_STUB_SERVE, tag);
  fs.mkdirSync(dir, { recursive: true });
  const files = args.slice(3).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').match(/^--(repo|title|notes-file)$/));
  for (const f of files) {
    const target = path.join(dir, path.basename(f));
    if (process.env.GH_STUB_CORRUPT === '1' && !f.endsWith('SHA256SUMS') && !f.endsWith('.md')) fs.writeFileSync(target, 'tampered');
    else fs.copyFileSync(f, target);
  }
  state.releases[tag] = files.map((f) => path.basename(f));
  fs.writeFileSync(process.env.GH_STUB_STATE, JSON.stringify(state));
  process.exit(0);
}
process.stderr.write('unsupported gh call\\n');
process.exit(2);
`;

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fakeFfmpeg(versionLine: string, encoders: string[], filters: string[]): string {
  return `#!/bin/sh
case "$*" in
  *-version*) echo "${versionLine}"; echo "configuration: --enable-gpl";;
  *-encoders*) ${encoders.map((e) => `echo " V..... ${e}  x"`).join('; ') || 'true'};;
  *-filters*) ${filters.map((f) => `echo " .. ${f}  V->V  x"`).join('; ') || 'true'};;
esac
`;
}

/** Builds a gzip tarball laid out like the upstream asset. Returns its path. */
function makeTarball(
  work: string,
  name: string,
  layout: 'btbn' | 'flat',
  ffmpegScript: string,
): string {
  const root = mkdtempSync(join(work, 'tar-'));
  const top = layout === 'btbn' ? join(root, name.replace(/\.tar\.xz$/, ''), 'bin') : root;
  mkdirSync(top, { recursive: true });
  writeFileSync(join(top, 'ffmpeg'), ffmpegScript);
  chmodSync(join(top, 'ffmpeg'), 0o755);
  writeFileSync(join(top, 'ffprobe'), '#!/bin/sh\necho ffprobe\n');
  chmodSync(join(top, 'ffprobe'), 0o755);
  const out = join(work, name);
  const entries = layout === 'btbn' ? [name.replace(/\.tar\.xz$/, '')] : ['ffmpeg', 'ffprobe'];
  execFileSync('tar', ['-czf', out, '-C', root, ...entries]);
  return out;
}

const BTBN_ASSET = 'ffmpeg-n9.0.2-22-g46d8f462ee-linux64-gpl-9.0.tar.xz';
const BTBN_BUILD = 'n9.0.2-22-g46d8f462ee';
const BTBN_MIRROR_TAG = `ffmpeg-${BTBN_BUILD}`;
const JF_ASSET = 'jellyfin-ffmpeg_7.1.4-3_portable_linux64-gpl.tar.xz';
const JF_MIRROR_TAG = 'jellyfin-ffmpeg-v7.1.4-3';
const FULL_COMMIT = '46d8f462ee' + '0'.repeat(30);

const BTBN_OK = fakeFfmpeg(
  `ffmpeg version ${BTBN_BUILD}-20261001 Copyright (c) 2000-2026 the FFmpeg developers`,
  ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_vaapi'],
  ['libvmaf', 'cropdetect'],
);
const BTBN_NO_VMAF = fakeFfmpeg(
  `ffmpeg version ${BTBN_BUILD}-20261001 Copyright`,
  ['libx265', 'hevc_qsv', 'hevc_vaapi'],
  ['cropdetect'],
);
const JF_OK = fakeFfmpeg('ffmpeg version 7.1.4-Jellyfin Copyright', ['hevc_nvenc', 'libx265'], []);

interface Env {
  dir: string;
  work: string;
  serve: string;
  upstream: string;
  log: string;
  state: string;
  bin: string;
  base: string;
  server: Server;
}

let env: Env;

async function setup(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-mirror-'));
  const work = join(dir, 'work');
  const serve = join(dir, 'serve'); // mirror downloads: /mirror/<tag>/<asset>
  const upstream = join(dir, 'upstream'); // upstream downloads: /up/<name>
  const bin = join(dir, 'bin');
  for (const d of [work, serve, upstream, bin, join(dir, 'repo')])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, 'repo', 'Dockerfile'), DOCKERFILE);
  const log = join(dir, 'gh.log');
  const state = join(dir, 'gh-state.json');
  writeFileSync(log, '');
  writeFileSync(state, JSON.stringify({ releases: {} }));
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'gh'), 0o755);

  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '');
    const send = (file: string) => {
      if (!existsSync(file)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.end(readFileSync(file));
    };
    if (url.startsWith('/api/repos/FFmpeg/FFmpeg/commits/')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sha: FULL_COMMIT }));
      return;
    }
    if (url.startsWith('/api/repos/')) {
      const file = join(upstream, `${url.replace(/[^a-zA-Z0-9.-]/g, '_')}.json`);
      send(file);
      return;
    }
    if (url.startsWith('/up/')) return send(join(upstream, url.slice(4)));
    if (url.startsWith('/mirror/')) return send(join(serve, url.slice(8)));
    if (url.startsWith('/src/FFmpeg/FFmpeg/archive/')) {
      res.end('fake source archive');
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { dir, work, serve, upstream, log, state, bin, base, server };
}

/** Puts an upstream release JSON + its assets on the fake server. */
function publishUpstream(
  repo: string,
  tag: string,
  assets: { name: string; file?: string; content?: string }[],
) {
  const json = {
    tag_name: tag,
    assets: assets.map((a) => ({
      name: a.name,
      browser_download_url: `${env.base}/up/${a.name}`,
    })),
  };
  for (const a of assets) {
    if (a.file) copyFileSync(a.file, join(env.upstream, a.name));
    else writeFileSync(join(env.upstream, a.name), a.content ?? '');
  }
  const key = `/api/repos/${repo}/releases/tags/${tag}`.replace(/[^a-zA-Z0-9.-]/g, '_');
  writeFileSync(join(env.upstream, `${key}.json`), JSON.stringify(json));
}

function btbnUpstream(script = BTBN_OK, checksums?: (sha: string) => string) {
  const tar = makeTarball(env.work, BTBN_ASSET, 'btbn', script);
  const sha = sha256(tar);
  publishUpstream('BtbN/FFmpeg-Builds', 'autobuild-2026-10-01-13-06', [
    { name: BTBN_ASSET, file: tar },
    { name: 'ffmpeg-n9.0.2-22-g46d8f462ee-linux64-lgpl-9.0.tar.xz', content: 'lgpl' },
    {
      name: 'checksums.sha256',
      content: checksums
        ? checksums(sha)
        : `${sha}  ${BTBN_ASSET}\n${'d'.repeat(64)}  other.tar.xz\n`,
    },
  ]);
  return sha;
}

function run(args: string[], extra: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: join(env.dir, 'repo'),
      env: {
        ...process.env,
        PATH: `${env.bin}:${process.env.PATH}`,
        GH_STUB_LOG: env.log,
        GH_STUB_STATE: env.state,
        GH_STUB_SERVE: env.serve,
        FFMPEG_MIRROR_API_BASE: `${env.base}/api`,
        FFMPEG_MIRROR_DOWNLOAD_BASE: `${env.base}/mirror`,
        FFMPEG_SOURCE_BASE: `${env.base}/src`,
        FFMPEG_FETCH_RETRY_DELAY_MS: '1',
        ...extra,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

function ghCalls(): string[][] {
  return readFileSync(env.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function dockerfile(): string {
  return readFileSync(join(env.dir, 'repo', 'Dockerfile'), 'utf8');
}

function seedMirrorRelease(tag: string, files: Record<string, string>) {
  mkdirSync(join(env.serve, tag), { recursive: true });
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(env.serve, tag, name), content);
  const st = JSON.parse(readFileSync(env.state, 'utf8'));
  st.releases[tag] = Object.keys(files);
  writeFileSync(env.state, JSON.stringify(st));
}

describe('ffmpeg-mirror.js (CLI)', () => {
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => {
    await new Promise<void>((r) => env.server.close(() => r()));
    rmSync(env.dir, { recursive: true, force: true });
  });

  it('mirrors a checked BtbN build and pins it', async () => {
    const sha = btbnUpstream();
    const r = await run(['btbn', 'autobuild-2026-10-01-13-06', '--branch', 'n9.0']);
    expect(r.status, r.stderr).toBe(0);

    const create = ghCalls().find((c) => c[1] === 'create')!;
    expect(create.slice(0, 3)).toEqual(['release', 'create', BTBN_MIRROR_TAG]);
    expect(create).toContain('--latest=false');
    expect(create.join(' ')).toContain('masterjb/x265-butler');
    const uploaded = readFileSync(join(env.state), 'utf8');
    for (const name of [BTBN_ASSET, 'SHA256SUMS', 'SOURCE.md', 'ffmpeg-source-46d8f462ee.tar.gz']) {
      expect(uploaded).toContain(name);
    }
    const sums = readFileSync(join(env.serve, BTBN_MIRROR_TAG, 'SHA256SUMS'), 'utf8');
    expect(sums).toContain(`${sha}  ${BTBN_ASSET}`);
    const source = readFileSync(join(env.serve, BTBN_MIRROR_TAG, 'SOURCE.md'), 'utf8');
    expect(source).toContain(BTBN_BUILD);
    expect(source).toContain('autobuild-2026-10-01-13-06');
    expect(source).toContain(FULL_COMMIT);
    expect(source).toMatch(/GPL/);

    expect(readPins(dockerfile()).btbn).toEqual({
      tag: BTBN_MIRROR_TAG,
      asset: BTBN_ASSET,
      sha256: sha,
    });
    expect(readPins(dockerfile()).nvenc.sha256).toBe(SHA_OLD_B);
  });

  it('refuses a build that lacks a required capability, before any gh release call', async () => {
    btbnUpstream(BTBN_NO_VMAF);
    const r = await run(['btbn', 'autobuild-2026-10-01-13-06', '--branch', 'n9.0']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/libvmaf/);
    expect(ghCalls().filter((c) => c[0] === 'release')).toEqual([]);
    expect(dockerfile()).toBe(DOCKERFILE);
  });

  it('refuses when the upstream checksum does not match', async () => {
    btbnUpstream(BTBN_OK, () => `${'e'.repeat(64)}  ${BTBN_ASSET}\n`);
    const r = await run(['btbn', 'autobuild-2026-10-01-13-06', '--branch', 'n9.0']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/checksum/i);
    expect(ghCalls().filter((c) => c[0] === 'release')).toEqual([]);
    expect(dockerfile()).toBe(DOCKERFILE);
  });

  it('refuses when upstream lists no checksum for the asset', async () => {
    btbnUpstream(BTBN_OK, () => `${'e'.repeat(64)}  something-else.tar.xz\n`);
    const r = await run(['btbn', 'autobuild-2026-10-01-13-06', '--branch', 'n9.0']);
    expect(r.status).not.toBe(0);
    expect(ghCalls().filter((c) => c[0] === 'release')).toEqual([]);
  });

  it('is idempotent: an existing release with the same hash is not uploaded again', async () => {
    const sha = btbnUpstream();
    seedMirrorRelease(BTBN_MIRROR_TAG, {
      [BTBN_ASSET]: readFileSync(join(env.upstream, BTBN_ASSET)).toString('latin1'),
      SHA256SUMS: `${sha}  ${BTBN_ASSET}\n`,
      'SOURCE.md': 'x',
      'ffmpeg-source-46d8f462ee.tar.gz': 'x',
    });
    // the tarball bytes must survive the seed unchanged for the round trip
    copyFileSync(join(env.upstream, BTBN_ASSET), join(env.serve, BTBN_MIRROR_TAG, BTBN_ASSET));
    const r = await run(['btbn', 'autobuild-2026-10-01-13-06', '--branch', 'n9.0']);
    expect(r.status, r.stderr).toBe(0);
    expect(ghCalls().some((c) => c[1] === 'create' || c[1] === 'upload')).toBe(false);
    expect(readPins(dockerfile()).btbn.sha256).toBe(sha);
  });

  it('never overwrites: an existing release with another hash aborts', async () => {
    btbnUpstream();
    seedMirrorRelease(BTBN_MIRROR_TAG, {
      [BTBN_ASSET]: 'other bytes',
      SHA256SUMS: `${'f'.repeat(64)}  ${BTBN_ASSET}\n`,
      'SOURCE.md': 'x',
      'ffmpeg-source-46d8f462ee.tar.gz': 'x',
    });
    const r = await run(['btbn', 'autobuild-2026-10-01-13-06', '--branch', 'n9.0']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/differ|anderer|overwrite/i);
    expect(ghCalls().some((c) => c[1] === 'create' || c[1] === 'upload' || c[1] === 'delete')).toBe(
      false,
    );
    expect(dockerfile()).toBe(DOCKERFILE);
  });

  it('stops on an incomplete release left by an aborted upload, and deletes nothing', async () => {
    btbnUpstream();
    seedMirrorRelease(BTBN_MIRROR_TAG, { 'SOURCE.md': 'x' });
    const r = await run(['btbn', 'autobuild-2026-10-01-13-06', '--branch', 'n9.0']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/incomplete|unvollständig/i);
    expect(ghCalls().some((c) => c[1] === 'delete')).toBe(false);
    expect(dockerfile()).toBe(DOCKERFILE);
  });

  it('does not pin when the mirror serves different bytes than were uploaded', async () => {
    btbnUpstream();
    const r = await run(['btbn', 'autobuild-2026-10-01-13-06', '--branch', 'n9.0'], {
      GH_STUB_CORRUPT: '1',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/round.?trip|mirror/i);
    expect(dockerfile()).toBe(DOCKERFILE);
  });

  it('--no-pin creates the release but leaves the Dockerfile alone (rollback release)', async () => {
    btbnUpstream();
    const r = await run(['btbn', 'autobuild-2026-10-01-13-06', '--branch', 'n9.0', '--no-pin']);
    expect(r.status, r.stderr).toBe(0);
    expect(ghCalls().some((c) => c[1] === 'create')).toBe(true);
    expect(dockerfile()).toBe(DOCKERFILE);
  });

  it('mirrors the jellyfin build, names trust on first use, pins nvenc only', async () => {
    const tar = makeTarball(env.work, JF_ASSET, 'flat', JF_OK);
    publishUpstream('jellyfin/jellyfin-ffmpeg', 'v7.1.4-3', [{ name: JF_ASSET, file: tar }]);
    const r = await run(['jellyfin', 'v7.1.4-3']);
    expect(r.status, r.stderr).toBe(0);
    const source = readFileSync(join(env.serve, JF_MIRROR_TAG, 'SOURCE.md'), 'utf8');
    expect(source).toMatch(/trust on first use/i);
    const pins = readPins(dockerfile());
    expect(pins.nvenc).toEqual({ tag: JF_MIRROR_TAG, asset: JF_ASSET, sha256: sha256(tar) });
    expect(pins.btbn.tag).toBe('ffmpeg-old');
    expect(basename(tar)).toBe(JF_ASSET);
  });

  it('refuses a jellyfin build without hevc_nvenc', async () => {
    const tar = makeTarball(
      env.work,
      JF_ASSET,
      'flat',
      fakeFfmpeg('ffmpeg version 7.1.4-Jellyfin', ['libx265'], []),
    );
    publishUpstream('jellyfin/jellyfin-ffmpeg', 'v7.1.4-3', [{ name: JF_ASSET, file: tar }]);
    const r = await run(['jellyfin', 'v7.1.4-3']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/hevc_nvenc/);
    expect(ghCalls().filter((c) => c[0] === 'release')).toEqual([]);
  });
});
