#!/usr/bin/env node
// 52-06: fetch the pinned ffmpeg from our mirror, check its sha256, unpack it.
//
//   node scripts/ffmpeg-fetch.js <dest> [btbn|nvenc] [--cache <dir>]
//
// Result: <dest>/bin/ffmpeg (+ ffprobe). The pins come from the Dockerfile in the working
// directory (scripts/ffmpeg-pins.js), so this fetches exactly what the image ships. Used by the
// CI job `ffmpeg-smoke` and by developers who want the production binary locally.
//
// The hash is checked BEFORE unpacking, and the unpacked tree is moved to <dest> only when it is
// complete: on any error nothing usable is left at <dest>.
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mirrorUrl, readPins } from './ffmpeg-pins.js';

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const RETRIES = 5;
// Override only for tests; default backs off 2, 4, 8, 16 s.
const retryDelayMs = () => Number(process.env.FFMPEG_FETCH_RETRY_DELAY_MS ?? 2000);

async function downloadOnce(url, file) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  renameSync(part, file);
}

/**
 * Streams url to file (written under a temporary name, renamed when complete). Retries network
 * errors and HTTP errors: a release asset that was uploaded seconds ago is not always served
 * yet (seen 2026-10-03, the mirror script's round trip got "fetch failed" right after the
 * upload). A wrong hash is never retried here; callers check it after the download.
 */
export async function download(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadOnce(url, file);
      return;
    } catch (err) {
      const cause = err.cause ? ` (${err.cause.code ?? err.cause.message ?? err.cause})` : '';
      if (attempt >= RETRIES)
        throw new Error(`${url}: ${err.message}${cause}, gave up after ${attempt} attempts`);
      console.error(`download ${url}: ${err.message}${cause}, retry ${attempt}/${RETRIES - 1}`);
      await new Promise((r) => setTimeout(r, retryDelayMs() * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Unpacks a release tarball (tar detects xz/gzip itself) and returns the directory that holds
 * the ffmpeg binary. BtbN ships <dir>/bin/ffmpeg, jellyfin ships ffmpeg flat at the top.
 */
export function unpack(tarball, into) {
  mkdirSync(into, { recursive: true });
  execFileSync('tar', ['-xf', tarball, '-C', into]);
  const candidates = [into, join(into, 'bin')];
  for (const entry of execFileSync('ls', ['-A', into], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)) {
    candidates.push(join(into, entry), join(into, entry, 'bin'));
  }
  const found = candidates.find((d) => existsSync(join(d, 'ffmpeg')));
  if (!found) throw new Error(`${tarball}: no ffmpeg binary inside`);
  return found;
}

export async function fetchPinned({ dest, kind = 'btbn', cache, dockerfile }) {
  const pins = readPins(readFileSync(dockerfile, 'utf8'));
  const pin = pins[kind];
  if (!pin) throw new Error(`unknown kind ${kind} (btbn|nvenc)`);

  const parent = dirname(resolve(dest));
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, '.ffmpeg-fetch-'));
  try {
    let tarball;
    if (cache) {
      mkdirSync(cache, { recursive: true });
      tarball = join(cache, pin.asset);
      if (existsSync(tarball) && sha256File(tarball) !== pin.sha256) rmSync(tarball);
      if (!existsSync(tarball)) await download(mirrorUrl(pin), tarball);
    } else {
      tarball = join(work, pin.asset);
      await download(mirrorUrl(pin), tarball);
    }

    const actual = sha256File(tarball);
    if (actual !== pin.sha256) {
      if (cache) rmSync(tarball, { force: true });
      throw new Error(`${pin.asset}: sha256 mismatch, expected ${pin.sha256}, got ${actual}`);
    }

    const binDir = unpack(tarball, join(work, 'unpacked'));
    const out = join(work, 'out');
    mkdirSync(join(out, 'bin'), { recursive: true });
    for (const b of ['ffmpeg', 'ffprobe']) {
      if (existsSync(join(binDir, b))) renameSync(join(binDir, b), join(out, 'bin', b));
    }
    rmSync(dest, { recursive: true, force: true });
    renameSync(out, dest);
    return { pin, binDir: join(dest, 'bin') };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main(argv) {
  const args = [...argv];
  let cache;
  const ci = args.indexOf('--cache');
  if (ci >= 0) {
    cache = args[ci + 1];
    args.splice(ci, 2);
  }
  const [dest, kind = 'btbn'] = args;
  if (!dest) throw new Error('usage: ffmpeg-fetch.js <dest> [btbn|nvenc] [--cache <dir>]');
  const { pin, binDir } = await fetchPinned({
    dest,
    kind,
    cache,
    dockerfile: resolve(process.cwd(), 'Dockerfile'),
  });
  console.log(`ffmpeg-fetch: ${pin.asset} (sha256 ${pin.sha256}) -> ${binDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`ffmpeg-fetch: ${err.message}`);
    process.exit(1);
  });
}
