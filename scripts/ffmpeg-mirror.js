#!/usr/bin/env node
// Copy one upstream ffmpeg build into a release of our public repository and pin it.
//
//   node scripts/ffmpeg-mirror.js btbn <autobuild-tag> [--branch n9.0|master] [--no-pin]
//   node scripts/ffmpeg-mirror.js jellyfin <tag> [--no-pin]
//
// Why: BtbN deletes dated builds after a few weeks and `latest` changes daily (in v2.47.0 an
// unchecked master nightly shipped a broken muxer and could not be fetched again afterwards).
// Our mirror keeps every shipped build. Background and the update ritual:
// docs/dev/ffmpeg-supply-chain.md.
//
// Order of checks, each one aborts before anything is published:
//   1. upstream checksum (BtbN publishes checksums.sha256; jellyfin publishes none, so the hash
//      is recorded on first use and SOURCE.md says so)
//   2. capabilities of the unpacked binary (same list as the Dockerfile build asserts)
//   3. existing mirror release: same hash -> reuse, other hash or incomplete -> abort.
//      This script never overwrites or deletes a release.
//   4. after the upload, download through the mirror URL and compare the hash
//   5. only then write the pins into the Dockerfile (unless --no-pin)
//
// Uploads run through `gh` with the operator's own login; CI never writes to GitHub.
// FFMPEG_MIRROR_API_BASE / FFMPEG_MIRROR_DOWNLOAD_BASE / FFMPEG_SOURCE_BASE exist only so the
// tests can put a local HTTP server in place of GitHub.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  MIRROR_REPO,
  buildStringOf,
  mirrorDownloadBase,
  mirrorUrl,
  parseSha256Sums,
  writePins,
} from './ffmpeg-pins.js';
import { download, sha256File, unpack } from './ffmpeg-fetch.js';

const API = () => process.env.FFMPEG_MIRROR_API_BASE ?? 'https://api.github.com';
const SOURCE_BASE = () => process.env.FFMPEG_SOURCE_BASE ?? 'https://github.com';

// Keep in step with the build-time asserts in the Dockerfile.
const REQUIRED = {
  btbn: { encoders: ['libx265', 'hevc_qsv', 'hevc_vaapi'], filters: ['libvmaf', 'cropdetect'] },
  nvenc: { encoders: ['hevc_nvenc'], filters: [] },
};

const UPSTREAM_REPO = { btbn: 'BtbN/FFmpeg-Builds', nvenc: 'jellyfin/jellyfin-ffmpeg' };

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The linux64 GPL static build of one branch: `master` (ffmpeg-N-<n>-g<hash>-linux64-gpl.tar.xz)
 * or a release branch like `n9.0` (ffmpeg-n9.0.<x>[-<n>-g<hash>]-linux64-gpl-9.0.tar.xz).
 */
export function pickBtbnAsset(release, branch) {
  const re =
    branch === 'master'
      ? /^ffmpeg-N-\d+-g[0-9a-f]+-linux64-gpl\.tar\.xz$/
      : new RegExp(
          `^ffmpeg-${escapeRe(branch)}(?:\\.\\d+)*(?:-\\d+-g[0-9a-f]+)?-linux64-gpl-${escapeRe(branch.replace(/^n/, ''))}\\.tar\\.xz$`,
        );
  const hits = (release.assets ?? []).filter((a) => re.test(a.name));
  if (hits.length === 0)
    throw new Error(
      `no linux64 gpl asset for branch ${branch} in ${release.tag_name ?? 'release'}`,
    );
  if (hits.length > 1) {
    throw new Error(
      `ambiguous: ${hits.length} assets match branch ${branch}: ${hits.map((a) => a.name).join(', ')}`,
    );
  }
  return hits[0];
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function checkCapabilities(ffmpeg, kind, build) {
  const run = (arg) => execFileSync(ffmpeg, ['-hide_banner', arg], { encoding: 'utf8' });
  const version = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split('\n')[0];
  const expected = kind === 'btbn' ? build : build.split('-')[0];
  if (!version.startsWith('ffmpeg version ') || !version.includes(expected)) {
    throw new Error(`unpacked ffmpeg reports "${version}", expected build ${expected}`);
  }
  const encoders = run('-encoders');
  const filters = run('-filters');
  const missing = [
    ...REQUIRED[kind].encoders.filter((e) => !new RegExp(`\\s${escapeRe(e)}\\s`).test(encoders)),
    ...REQUIRED[kind].filters.filter((f) => !new RegExp(`\\s${escapeRe(f)}\\s`).test(filters)),
  ];
  if (missing.length)
    throw new Error(`build ${build} lacks required capabilities: ${missing.join(', ')}`);
  return version;
}

/** @returns {string[] | null} asset names of an existing mirror release, null if absent */
function existingRelease(tag) {
  const r = spawnSync('gh', ['release', 'view', tag, '--repo', MIRROR_REPO, '--json', 'assets'], {
    encoding: 'utf8',
  });
  if (r.status === 0) return JSON.parse(r.stdout).assets.map((a) => a.name);
  if (/not found/i.test(r.stderr)) return null;
  throw new Error(`gh release view ${tag}: ${r.stderr.trim() || `exit ${r.status}`}`);
}

function sourceMd({
  kind,
  build,
  upstreamTag,
  asset,
  sha,
  upstreamChecksum,
  commit,
  sourceArchive,
  versionLine,
}) {
  const lines = [
    `# ffmpeg ${build}`,
    '',
    `Mirrored unchanged for x265-butler so every released image can be rebuilt with exactly this binary.`,
    '',
    `- Build: \`${build}\` (\`${versionLine}\`)`,
    `- Asset: \`${asset}\``,
    `- sha256: \`${sha}\``,
  ];
  if (kind === 'btbn') {
    lines.push(
      `- Upstream: https://github.com/BtbN/FFmpeg-Builds/releases/tag/${upstreamTag}`,
      `- Upstream checksum: matches \`checksums.sha256\` of that release (${upstreamChecksum})`,
      `- FFmpeg source: commit \`${commit}\`, https://github.com/FFmpeg/FFmpeg/tree/${commit}, archive \`${sourceArchive}\` in this release`,
      `- Build scripts: https://github.com/BtbN/FFmpeg-Builds`,
    );
  } else {
    lines.push(
      `- Upstream: https://github.com/jellyfin/jellyfin-ffmpeg/releases/tag/${upstreamTag}`,
      `- Upstream checksum: none published. The sha256 above was recorded when this build was first mirrored (trust on first use).`,
      `- Source: https://github.com/jellyfin/jellyfin-ffmpeg/tree/${upstreamTag}`,
    );
  }
  lines.push(
    '',
    'License: GPL-3.0-or-later, see LICENSE in the tarball and https://www.gnu.org/licenses/gpl-3.0.html',
    '',
  );
  return lines.join('\n');
}

async function mirror({ kind, upstreamTag, branch, pin }) {
  const work = mkdtempSync(join(tmpdir(), 'ffmpeg-mirror-'));
  try {
    const release = await getJson(
      `${API()}/repos/${UPSTREAM_REPO[kind]}/releases/tags/${upstreamTag}`,
    );
    const assetName =
      kind === 'btbn'
        ? pickBtbnAsset(release, branch).name
        : `jellyfin-ffmpeg_${upstreamTag.replace(/^v/, '')}_portable_linux64-gpl.tar.xz`;
    const upstreamAsset = release.assets.find((a) => a.name === assetName);
    if (!upstreamAsset) throw new Error(`${upstreamTag}: asset ${assetName} not found`);
    const build = buildStringOf(assetName);
    const tag = kind === 'btbn' ? `ffmpeg-${build}` : `jellyfin-ffmpeg-${upstreamTag}`;

    // 1. download + upstream checksum
    const tarball = join(work, assetName);
    await download(upstreamAsset.browser_download_url, tarball);
    const sha = sha256File(tarball);
    let upstreamChecksum = 'n/a';
    if (kind === 'btbn') {
      const sumsAsset = release.assets.find((a) => a.name === 'checksums.sha256');
      if (!sumsAsset)
        throw new Error(`${upstreamTag}: no checksums.sha256 in the upstream release`);
      const listed = parseSha256Sums(await getText(sumsAsset.browser_download_url))[assetName];
      if (!listed) throw new Error(`upstream checksums.sha256 lists no checksum for ${assetName}`);
      if (listed !== sha)
        throw new Error(
          `upstream checksum mismatch for ${assetName}: listed ${listed}, downloaded ${sha}`,
        );
      upstreamChecksum = listed;
    }

    // 2. capabilities
    const binDir = unpack(tarball, join(work, 'unpacked'));
    const versionLine = checkCapabilities(join(binDir, 'ffmpeg'), kind, build);

    // 3. existing release
    const commitShort = kind === 'btbn' ? /-g([0-9a-f]+)$/.exec(build)?.[1] : undefined;
    const sourceArchive = commitShort ? `ffmpeg-source-${commitShort}.tar.gz` : undefined;
    const expected = [
      assetName,
      'SHA256SUMS',
      'SOURCE.md',
      ...(sourceArchive ? [sourceArchive] : []),
    ];
    const present = existingRelease(tag);
    if (present) {
      const missing = expected.filter((n) => !present.includes(n));
      if (missing.length) {
        throw new Error(
          `mirror release ${tag} exists but is incomplete (missing ${missing.join(', ')}); ` +
            `probably an aborted upload. Check it on GitHub and delete it by hand, this script deletes nothing.`,
        );
      }
      const mirrored = parseSha256Sums(await getText(`${mirrorDownloadBase()}/${tag}/SHA256SUMS`))[
        assetName
      ];
      if (mirrored !== sha) {
        throw new Error(
          `mirror release ${tag} holds a different ${assetName} (sha256 ${mirrored}, upstream now ${sha}); will not overwrite`,
        );
      }
      console.log(`ffmpeg-mirror: ${tag} already mirrored with the same sha256, nothing uploaded`);
    } else {
      const files = [tarball];
      let commit;
      if (commitShort) {
        commit = (await getJson(`${API()}/repos/FFmpeg/FFmpeg/commits/${commitShort}`)).sha;
        const src = join(work, sourceArchive);
        await download(`${SOURCE_BASE()}/FFmpeg/FFmpeg/archive/${commit}.tar.gz`, src);
        files.push(src);
      }
      const sums = files.map((f) => `${sha256File(f)}  ${f.split('/').pop()}`).join('\n') + '\n';
      writeFileSync(join(work, 'SHA256SUMS'), sums);
      writeFileSync(
        join(work, 'SOURCE.md'),
        sourceMd({
          kind,
          build,
          upstreamTag,
          asset: assetName,
          sha,
          upstreamChecksum,
          commit,
          sourceArchive,
          versionLine,
        }),
      );
      files.push(join(work, 'SHA256SUMS'), join(work, 'SOURCE.md'));
      const r = spawnSync(
        'gh',
        [
          'release',
          'create',
          tag,
          '--repo',
          MIRROR_REPO,
          '--title',
          `ffmpeg ${build} (mirror)`,
          '--notes-file',
          join(work, 'SOURCE.md'),
          '--latest=false',
          ...files,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] },
      );
      if (r.status !== 0)
        throw new Error(`gh release create ${tag}: ${r.stderr?.trim() || `exit ${r.status}`}`);
      console.log(`ffmpeg-mirror: created ${MIRROR_REPO} release ${tag}`);
    }

    // 4. round trip through the mirror URL
    const pinValue = { tag, asset: assetName, sha256: sha };
    const back = join(work, 'roundtrip');
    await download(mirrorUrl(pinValue), back);
    const served = sha256File(back);
    if (served !== sha)
      throw new Error(
        `round trip: mirror serves sha256 ${served} for ${assetName}, expected ${sha}`,
      );

    // 5. pin
    if (pin) {
      const path = resolve(process.cwd(), 'Dockerfile');
      writeFileSync(path, writePins(readFileSync(path, 'utf8'), { [kind]: pinValue }));
      console.log(`ffmpeg-mirror: pinned ${kind} -> ${tag} (${assetName}, sha256 ${sha})`);
    } else {
      console.log(
        `ffmpeg-mirror: --no-pin, Dockerfile unchanged (pin later: node scripts/ffmpeg-pins.js set ${kind} ${tag})`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const branch = take('--branch') ?? 'n9.0';
  const noPin = args.includes('--no-pin');
  const rest = args.filter((a) => a !== '--no-pin');
  const [which, upstreamTag] = rest;
  const kind = which === 'btbn' ? 'btbn' : which === 'jellyfin' ? 'nvenc' : undefined;
  if (!kind || !upstreamTag) {
    throw new Error(
      'usage: ffmpeg-mirror.js btbn <autobuild-tag> [--branch n9.0|master] [--no-pin] | jellyfin <tag> [--no-pin]',
    );
  }
  return { kind, upstreamTag, branch, pin: !noPin };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => mirror(parseArgs(process.argv.slice(2))))
    .catch((err) => {
      console.error(`ffmpeg-mirror: ${err.message}`);
      process.exit(1);
    });
}
