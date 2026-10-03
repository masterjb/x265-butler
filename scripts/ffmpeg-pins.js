#!/usr/bin/env node
// 52-06: the ffmpeg pins. The Dockerfile is their single source: six ARG lines name, for each of
// the two binaries (BtbN primary, jellyfin NVENC), the release in our mirror, the asset in it and
// its sha256. The image build, the CI job `ffmpeg-smoke` (scripts/ffmpeg-fetch.js) and the
// mirror script (scripts/ffmpeg-mirror.js) all read and write these lines through this module.
//
// CLI (the way back, docs/dev/ffmpeg-supply-chain.md):
//   node scripts/ffmpeg-pins.js set <btbn|nvenc> <mirror-release-tag>
//   node scripts/ffmpeg-pins.js build <btbn|nvenc>   (prints the pinned build string)
// writes the three pins of one binary from that mirror release's SHA256SUMS. It never talks to
// upstream, so a rollback works even after BtbN has deleted the build.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const MIRROR_REPO = 'masterjb/x265-butler';

export const PIN_ARGS = {
  btbn: { tag: 'FFMPEG_MIRROR_TAG', asset: 'FFMPEG_ASSET', sha256: 'FFMPEG_SHA256' },
  nvenc: {
    tag: 'FFMPEG_NVENC_MIRROR_TAG',
    asset: 'FFMPEG_NVENC_ASSET',
    sha256: 'FFMPEG_NVENC_SHA256',
  },
};

const SHA256 = /^[0-9a-f]{64}$/;
const VALUE = /^[A-Za-z0-9._+-]+$/;

// Patterns of the binary tarball per kind; the mirror release also holds SHA256SUMS, SOURCE.md
// and (btbn) the FFmpeg source archive.
const BINARY_ASSET = {
  btbn: /^ffmpeg-(.+?)-linux64-gpl(?:-[0-9.]+)?\.tar\.xz$/,
  nvenc: /^jellyfin-ffmpeg_(.+?)_portable_linux64-gpl\.tar\.xz$/,
};

function argLine(name) {
  return new RegExp(`^ARG ${name}=(.*)$`);
}

function validate(kind, field, name, value) {
  if (field === 'sha256') {
    if (!SHA256.test(value))
      throw new Error(`${name}: sha256 must be 64 lowercase hex characters, got "${value}"`);
  } else if (!VALUE.test(value)) {
    throw new Error(`${name}: invalid ${kind} ${field} "${value}"`);
  }
}

/** @typedef {{ tag: string, asset: string, sha256: string }} Pin */

/**
 * @param {string} text Dockerfile content
 * @returns {{ btbn: Pin, nvenc: Pin }}
 */
export function readPins(text) {
  const lines = text.split('\n');
  /** @type {Record<string, Record<string, string>>} */
  const pins = {};
  for (const [kind, fields] of Object.entries(PIN_ARGS)) {
    pins[kind] = {};
    for (const [field, name] of Object.entries(fields)) {
      const re = argLine(name);
      const hits = lines.map((l) => re.exec(l.trim())).filter(Boolean);
      if (hits.length === 0) throw new Error(`Dockerfile: ARG ${name} is missing`);
      if (hits.length > 1)
        throw new Error(`Dockerfile: ARG ${name} is defined ${hits.length} times`);
      const value = hits[0][1].trim();
      validate(kind, field, name, value);
      pins[kind][field] = value;
    }
  }
  return /** @type {{ btbn: Pin, nvenc: Pin }} */ (/** @type {unknown} */ (pins));
}

/**
 * Replaces the pin lines of the given binaries; every other line stays byte-identical.
 * @param {string} text
 * @param {{ btbn?: Pin, nvenc?: Pin }} pins
 */
export function writePins(text, pins) {
  readPins(text); // the file must be well-formed before we touch it
  const lines = text.split('\n');
  for (const [kind, pin] of Object.entries(pins)) {
    if (!pin) continue;
    const fields = PIN_ARGS[kind];
    if (!fields) throw new Error(`unknown pin kind ${kind}`);
    for (const [field, name] of Object.entries(fields)) {
      validate(kind, field, name, pin[field]);
      const re = argLine(name);
      const i = lines.findIndex((l) => re.test(l.trim()));
      lines[i] = lines[i].replace(/=.*$/, `=${pin[field]}`);
    }
  }
  return lines.join('\n');
}

export function mirrorDownloadBase() {
  // Override only for tests (local HTTP server in place of GitHub).
  return (
    process.env.FFMPEG_MIRROR_DOWNLOAD_BASE ?? `https://github.com/${MIRROR_REPO}/releases/download`
  );
}

/** @param {{tag:string, asset:string}} pin */
export function mirrorUrl(pin) {
  return `${mirrorDownloadBase()}/${pin.tag}/${pin.asset}`;
}

/** Build string as ffmpeg reports it, from the asset name. */
export function buildStringOf(asset) {
  for (const re of Object.values(BINARY_ASSET)) {
    const m = re.exec(asset);
    if (m) return m[1];
  }
  throw new Error(`cannot derive a build string from asset ${asset}`);
}

/** Parses `sha256sum` output (`<sha>  <name>` or `<sha> *<name>`). */
export function parseSha256Sums(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m) out[m[2]] = m[1];
  }
  return out;
}

export function binaryEntryFromSums(sums, kind) {
  const re = BINARY_ASSET[kind];
  const hits = Object.entries(sums).filter(([name]) => re.test(name));
  if (hits.length !== 1) {
    throw new Error(`SHA256SUMS: expected exactly one ${kind} binary, found ${hits.length}`);
  }
  return { asset: hits[0][0], sha256: hits[0][1] };
}

async function setFromMirror(kind, tag) {
  if (!PIN_ARGS[kind])
    throw new Error(`usage: ffmpeg-pins.js set <btbn|nvenc> <mirror-release-tag>`);
  const url = `${mirrorDownloadBase()}/${tag}/SHA256SUMS`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const entry = binaryEntryFromSums(parseSha256Sums(await res.text()), kind);
  const path = resolve(process.cwd(), 'Dockerfile');
  const next = writePins(readFileSync(path, 'utf8'), { [kind]: { tag, ...entry } });
  writeFileSync(path, next);
  console.log(`ffmpeg-pins: ${kind} -> ${tag} (${entry.asset}, sha256 ${entry.sha256})`);
}

async function main(argv) {
  const [cmd, kind, tag] = argv;
  if (cmd === 'set' && kind && tag) return setFromMirror(kind, tag);
  if (cmd === 'build' && PIN_ARGS[kind]) {
    // CI job `ffmpeg-smoke`: the build string `ffmpeg -version` must report for this pin.
    console.log(
      buildStringOf(
        readPins(readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8'))[kind].asset,
      ),
    );
    return;
  }
  if (cmd === 'show') {
    console.log(
      JSON.stringify(readPins(readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8')), null, 2),
    );
    return;
  }
  throw new Error(
    'usage: ffmpeg-pins.js set <btbn|nvenc> <mirror-release-tag> | build <btbn|nvenc> | show',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`ffmpeg-pins: ${err.message}`);
    process.exit(1);
  });
}
