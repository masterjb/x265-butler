// 41-01 reproduce-first (CARL): the iPhone 15 Pro `.MOV` → MKV operator failure.
// A blanket `-map 0` copies the source's DATA stream (Apple `mebx` timed
// metadata / mov `tmcd` timecode) into the Matroska mux; matroska refuses the
// header BEFORE frame 1 → `Only audio, video, and subtitles are supported for
// Matroska`, exit 234, `encoded 0 frames`. The whitelist `-map 0:v -map 0:a?
// -map 0:s? -map 0:t?` drops the data stream by omission and the encode succeeds.
//
// Runs against the REAL ffmpeg binary (precedent: real-ffmpeg-smoke.test.ts);
// the whole suite skips cleanly if ffmpeg/ffprobe are unavailable on the host.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgs } from '@/src/lib/encode/ffmpeg';

const toolsAvailable = (() => {
  try {
    execSync('which ffmpeg', { stdio: 'ignore' });
    execSync('which ffprobe', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let workDir = '';
let sourcePath = '';

// Build a synthetic .mov carrying a DATA stream (a `tmcd` timecode track,
// codec_type=data) alongside the video — the smallest input that reproduces a
// non-A/V/S stream the matroska muxer rejects.
function buildSource(): void {
  workDir = mkdtempSync(join(tmpdir(), 'x265-stream-repro-'));
  sourcePath = join(workDir, 'src.mov');
  const r = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=128x72:rate=5:duration=1',
      '-timecode',
      '00:00:00:00',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      sourcePath,
    ],
    { stdio: 'pipe', timeout: 30_000 },
  );
  expect(r.status, `source build failed: ${r.stderr?.toString().slice(-300)}`).toBe(0);
}

describe.skipIf(!toolsAvailable)('41-01 stream-mapping repro (real ffmpeg)', () => {
  beforeAll(() => {
    buildSource();
    // Sanity: the synthetic source actually carries a data stream.
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', sourcePath],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    expect(probe.stdout).toContain('data');
  });

  afterAll(() => {
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  it('RED: PRE-41 `-map 0` → MKV fails with the matroska header error (the captured bug)', () => {
    const out = join(workDir, 'pre.x265.mkv');
    // Hand-rolled PRE-41 arg shape (the bug). buildArgs no longer emits this for
    // mkv — this snapshot pins the EXACT operator failure.
    const args = [
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      sourcePath,
      '-c:v',
      'libx265',
      '-crf',
      '28',
      '-c:a',
      'copy',
      '-c:s',
      'copy',
      '-map',
      '0',
      '-map_metadata',
      '0',
      out,
    ];
    const r = spawnSync('ffmpeg', args, { stdio: 'pipe', timeout: 60_000 });
    const stderr = r.stderr?.toString() ?? '';
    expect(r.status, 'PRE-41 args should FAIL (matroska rejects the data stream)').not.toBe(0);
    expect(stderr).toContain('Only audio, video, and subtitles are supported for Matroska');
  });

  it('GREEN: POST-41 buildArgs whitelist → MKV exits 0 and encodes > 0 frames', () => {
    const out = join(workDir, 'post.x265.mkv');
    // Drive the REAL shipped builder — proves the mapping that ships, not a
    // hand-rolled argv. buildArgs returns args WITHOUT the binary.
    const args = buildArgs({
      input: sourcePath,
      output: out,
      crf: 28,
      preset: 'ultrafast',
      outputContainer: 'mkv',
    });
    // Guard: the shipped mkv args are the whitelist, not bare `-map 0`.
    expect(args).toContain('0:v');
    const mapZeroIdx = args.findIndex((a, i) => a === '-map' && args[i + 1] === '0');
    expect(mapZeroIdx, 'mkv buildArgs must NOT emit bare `-map 0`').toBe(-1);

    const r = spawnSync('ffmpeg', args, { stdio: 'pipe', timeout: 60_000 });
    expect(
      r.status,
      `POST-41 args should SUCCEED (stderr: ${r.stderr?.toString().slice(-300)})`,
    ).toBe(0);
    expect(statSync(out).size).toBeGreaterThan(0);
    const frames = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=nb_read_frames',
        '-of',
        'csv=p=0',
        out,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    expect(Number(frames.stdout.trim())).toBeGreaterThan(0);
  });
});
