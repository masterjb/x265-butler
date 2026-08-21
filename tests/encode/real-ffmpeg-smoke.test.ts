import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeAudioStreams } from '@/src/lib/encode/audio-compat';
import { buildEncodeArgs } from '@/src/lib/encode/profiles';
import { buildArgs } from '@/src/lib/encode/ffmpeg';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { __forTests_resetKeyframeCache } from '@/src/lib/encode/keyframe';
// 50-01 (AC-17): the frame gate proven EXECUTED against a real file, not argv-side.
import { ffprobe, countVideoPackets, parseFrameRate } from '@/src/lib/scan/ffprobe';
import { evaluateFrameGate } from '@/src/lib/encode/frame-gate';
// 50-02: the FULL production chain is exercised — probe → describe → extract →
// buildArgs → ffmpeg. Rebuilding any of these by hand in the test would prove
// something other than what ships.
import {
  analyzeAttachedPictures,
  countAttachmentStreams,
  describeAttachedPictures,
  COVER_MEDIA_BY_CODEC,
} from '@/src/lib/encode/attached-pic';
import { extractCovers } from '@/src/lib/encode/cover-extract';
import { mkdirSync, writeFileSync } from 'node:fs';
// 50-06 (AC-2): the REAL diagnostics arg-builder — the claim is about what the
// SHIPPED argv makes ffmpeg encode, so a hand-built argv would prove nothing.
import { buildTestEncodeArgs } from '@/src/lib/diagnostics/test-encode';

const FIXTURE = join(process.cwd(), 'tests/fixtures/sample-1sec.mp4');

const ffmpegAvailable = (() => {
  try {
    execSync('which ffmpeg', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function encodeAndVerify(output: string, audioArgs: string[]): void {
  const base = buildEncodeArgs({
    encoder: 'libx265',
    crf: 28,
    preset: 'medium',
    input: FIXTURE,
    output,
  });
  // Replace -c:a copy with caller-supplied audio args
  const caIdx = base.indexOf('-c:a');
  if (caIdx !== -1) {
    base.splice(caIdx, 2, ...audioArgs);
  }
  const result = spawnSync('ffmpeg', base, { stdio: 'pipe', timeout: 30_000 });
  expect(
    result.status,
    `ffmpeg exited non-zero (stderr: ${result.stderr?.toString().slice(-200)})`,
  ).toBe(0);
  expect(statSync(output).size).toBeGreaterThan(0);
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'csv=p=0',
      output,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  expect(probe.stdout.trim()).toBe('hevc');
}

describe.skipIf(!ffmpegAvailable)('real-ffmpeg integration smoke', () => {
  it('libx265 → mkv, copy-compat audio: exit 0, hevc output', () => {
    const out = join(tmpdir(), `smoke-${Date.now()}-mkv-copy.mkv`);
    encodeAndVerify(out, ['-c:a', 'copy']);
  });

  it('libx265 → mp4, copy-compat audio: exit 0, hevc output', () => {
    const out = join(tmpdir(), `smoke-${Date.now()}-mp4-copy.mp4`);
    encodeAndVerify(out, ['-c:a', 'copy']);
  });

  it('libx265 → mkv, auto-transcode-incompat audio path: exit 0, hevc output', () => {
    const out = join(tmpdir(), `smoke-${Date.now()}-mkv-aac.mkv`);
    encodeAndVerify(out, ['-c:a', 'aac', '-b:a', '192k']);
  });

  it('libx265 → mp4, auto-transcode-incompat audio path: exit 0, hevc output', () => {
    const out = join(tmpdir(), `smoke-${Date.now()}-mp4-aac.mp4`);
    encodeAndVerify(out, ['-c:a', 'aac', '-b:a', '192k']);
  });

  it('mp4 + fail-fast-incompat: analyzeAudioStreams returns fail_fast, no ffmpeg spawn', () => {
    const mockProbe = {
      streams: [{ codec_type: 'audio', codec_name: 'truehd', channels: 8 }],
    };
    // @ts-expect-error — minimal probe stub for unit-level audio analysis check
    const result = analyzeAudioStreams(mockProbe, 'mp4', { autoTranscode: false });
    expect(result.outcome).toBe('fail_fast');
    if (result.outcome === 'fail_fast') {
      expect(result.droppedCodecs).toContain('truehd');
    }
  });

  it('mkv + fail-fast-incompat audio source: analyzeAudioStreams returns compatible (mkv accepts all audio), encodes successfully', () => {
    const mockProbe = {
      streams: [{ codec_type: 'audio', codec_name: 'truehd', channels: 8 }],
    };
    // @ts-expect-error — minimal probe stub
    const result = analyzeAudioStreams(mockProbe, 'mkv');
    expect(result.outcome).toBe('compatible');
    const out = join(tmpdir(), `smoke-${Date.now()}-mkv-fallback.mkv`);
    encodeAndVerify(out, ['-c:a', 'copy']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-01 (AC-13 / AC-16): embedded cover art, EXECUTED against real ffmpeg.
//
// WHY THIS RUNS FOR REAL AND IS NOT AN ARGV ASSERTION: the failure this guards
// against is invisible in an argv. `-vf crop=… -c:v libx265 … -c:v:1 copy` is a
// perfectly plausible argv and still dies when ffmpeg OPENS the output. The
// CONTEXT rule "everything provable before ship must be provable as an argv
// assertion" covers the HARDWARE paths (qsv/vaapi/nvenc need real GPUs) — this
// failure class reproduces with libx265 on any host, CI included.
// ─────────────────────────────────────────────────────────────────────────────
// 50-02 RE-ANCHORED THIS BLOCK TO MP4. The copy form 49-01 introduced survives
// exactly where the muxer keeps the disposition — mp4. On mkv the very same argv
// produced a second REAL video track (measured again as M-C: 600x900 mjpeg
// claiming 90000 fps; VLC crashes, mpv black with sound), so mkv moved to
// unmap + re-attach and is asserted in the 50-02 block further down. Leaving
// these cases on the mkv default would mean executing the defect and calling it
// a contract.
describe.skipIf(!ffmpegAvailable)('49-01 attached-pic cover art (mp4) — real ffmpeg', () => {
  // A crop the tiny 64x64 fixture tolerates. NOTE: some geometries (e.g.
  // 48x32, 48x64) make THIS ffmpeg build (6.1.1, Ubuntu) abort inside libx265
  // with "corrupted size vs. prev_size" — reproducible WITHOUT any cover and
  // WITHOUT 49-01, i.e. an unrelated upstream/glibc issue. 64:48 is clean.
  const CROP = '64:48:0:0';

  let workDir: string;
  let coverSource: string;

  function sh(bin: string, args: string[]) {
    return spawnSync(bin, args, { stdio: 'pipe', encoding: 'utf8', timeout: 60_000 });
  }

  // Fixture is BUILT AT RUNTIME — no binary blob enters the repo.
  function makeCoverSource(): string {
    const cover = join(workDir, 'cover.jpg');
    const out = join(workDir, 'src.mkv');
    const c = sh('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=600x900:d=1',
      '-frames:v',
      '1',
      '-pix_fmt',
      'yuvj444p',
      cover,
    ]);
    expect(c.status, `cover build failed: ${c.stderr}`).toBe(0);
    const m = sh('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      FIXTURE,
      '-c',
      'copy',
      '-attach',
      cover,
      '-metadata:s:t',
      'mimetype=image/jpeg',
      '-metadata:s:t',
      'filename=cover.jpg',
      out,
    ]);
    expect(m.status, `cover mux failed: ${m.stderr}`).toBe(0);
    return out;
  }

  function probeStreams(file: string): Array<{
    index: number;
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    disposition?: Record<string, number>;
    tags?: Record<string, string>;
  }> {
    const r = sh('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]);
    expect(r.status, `ffprobe failed: ${r.stderr}`).toBe(0);
    return JSON.parse(r.stdout).streams;
  }

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'x265-cover-'));
    coverSource = makeCoverSource();
    // The matroska DEMUXER turns the image AttachedFile into a VIDEO stream with
    // the attached_pic disposition — which is exactly why the 41-01 `-map 0:t?`
    // attachment branch does NOT catch it, and why this plan exists at all.
    const src = probeStreams(coverSource);
    const videoStreams = src.filter((s) => s.codec_type === 'video');
    expect(videoStreams).toHaveLength(2);
    expect(videoStreams[1].disposition?.attached_pic).toBe(1);
    expect(videoStreams[1].codec_name).toBe('mjpeg');
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('case 1 — cover WITHOUT crop: exit 0, video encoded to hevc, cover untouched', () => {
    const out = join(workDir, 'case1.mp4');
    const args = buildArgs({
      input: coverSource,
      output: out,
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mp4',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });
    const r = sh('ffmpeg', args);
    expect(r.status, `ffmpeg failed: ${r.stderr?.slice(-600)}`).toBe(0);

    const streams = probeStreams(out);
    const videos = streams.filter((s) => s.codec_type === 'video');
    expect(videos[0].codec_name).toBe('hevc');
    expect(videos[1].codec_name).toBe('mjpeg');
    expect(videos[1].width).toBe(600);
    expect(videos[1].height).toBe(900);
  });

  it('case 2 — cover WITH crop: exit 0 (the case that dies without the filter narrowing)', () => {
    const out = join(workDir, 'case2.mp4');
    const args = buildArgs({
      input: coverSource,
      output: out,
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mp4',
      crop: CROP,
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });
    // the narrowed specifier is what makes this survive
    expect(args).not.toContain('-vf');
    expect(args).toContain('-filter:v:0');

    const r = sh('ffmpeg', args);
    expect(r.status, `ffmpeg failed: ${r.stderr?.slice(-600)}`).toBe(0);
    expect(r.stderr).not.toContain('streamcopy');

    const videos = probeStreams(out).filter((s) => s.codec_type === 'video');
    expect(videos[0].codec_name).toBe('hevc');
    expect(videos[0].width).toBe(64);
    expect(videos[0].height).toBe(48);
    // the cover is NOT cropped — it kept its own geometry
    expect(videos[1].width).toBe(600);
    expect(videos[1].height).toBe(900);
  });

  it('case 3 — NEGATIVE CONTROL: bare -vf + a copied stream still dies', () => {
    // Setting attachedPicVideoOrdinals WITHOUT encodedVideoOrdinals is exactly
    // the coupling violation EncodeOptions warns about: the filter stays bare and
    // matches the copied cover. This case FREEZES the ffmpeg semantics the whole
    // narrowing rests on — if a future ffmpeg stops rejecting this, the test goes
    // red and the narrowing gets re-evaluated instead of quietly rotting.
    const out = join(workDir, 'case3.mp4');
    const args = buildArgs({
      input: coverSource,
      output: out,
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mp4',
      crop: CROP,
      attachedPicVideoOrdinals: [1],
      // encodedVideoOrdinals deliberately omitted
    });
    expect(args).toContain('-vf');

    const r = sh('ffmpeg', args);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('streamcopy');
  });

  // 50-02: 49-01's AC-16 asserted BOTH halves of the muxer asymmetry — mkv drops
  // the disposition, mp4 keeps it. The mkv half described the DEFECT (the cover
  // arriving as a plain second video track), and 50-02 removed the argv that
  // produced it, so that half now lives on as the motivation in the 50-02 block:
  // '50-02 cover art as a real MKV AttachedFile' asserts the REPLACEMENT. What
  // survives here unchanged is the mp4 half — the reason mp4 was never touched.
  it('AC-16 — the mp4 muxer KEEPS attached_pic on the copied cover (why mp4 stays 49-01)', () => {
    const mp4Out = join(workDir, 'ac16.mp4');
    const mp4Args = buildArgs({
      input: coverSource,
      output: mp4Out,
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mp4',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });
    expect(sh('ffmpeg', mp4Args).status).toBe(0);
    const mp4Cover = probeStreams(mp4Out).filter((s) => s.codec_type === 'video')[1];
    expect(mp4Cover.disposition?.attached_pic).toBe(1);
    expect(mp4Cover.codec_name).toBe('mjpeg');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-02 (AC-11 / AC-12 / AC-13 / AC-14 / AC-17, plus AC-8 executed): forced
// keyframes and the closed-GOP IDR pin, PROVEN BY RUNNING FFMPEG.
//
// WHY THIS CANNOT BE AN ARGV ASSERTION: an argv can show `-force_key_frames` and
// `open-gop=0` and still produce the wrong bitstream. Measured (M2): the interval
// token ALONE yields the right keyframe TIMES but open CRA frames — 1 IDR + 5 CRA
// — and CRA + RASL leading pictures IS the "block garbage over the picture"
// symptom. Only the NAL-unit types out of the raw bitstream can tell the two
// apart, so this suite decodes them.
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!ffmpegAvailable)('49-02 forced keyframes + closed GOP — real ffmpeg', () => {
  // HEVC NAL unit types (H.265 Table 7-1).
  const IDR_W_RADL = 19;
  const IDR_N_LP = 20;
  const CRA_NUT = 21;

  // CLIP LENGTH IS LOAD-BEARING, not arbitrary. The ffmpeg CLI default is
  // gop_size = 250 FRAMES (M1). At 24 fps that is 10.417 s, so a 12 s clip
  // (288 frames) contains exactly TWO encoder-native keyframes — frame 0 and
  // frame 250 — which gives the pre-49 baseline case a CRA count of 1. Margin: 1.
  // A 10 s clip would yield CRA = 0 and that case would fail for a reason that has
  // nothing to do with this change, so the ≥2-keyframe assertion below turns a
  // too-short fixture into a legible failure instead of a confusing "cra is 0".
  const CLIP_SEC = 12;
  const FPS = 24;
  const DEFAULT_GOP_FRAMES = 250;
  // AC-17 needs a clip LONGER than the encoder default GOP twice over so the
  // capped spacing is visible as spacing, not as a single keyframe.
  const LONG_CLIP_SEC = 26;

  let workDir = '';
  let clip12 = '';
  let clip26 = '';
  let coverSource = '';

  const _origInterval = process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
  const _origClosedGop = process.env.ENCODE_CLOSED_GOP_DISABLED;

  function run(bin: string, args: string[]) {
    return spawnSync(bin, args, { stdio: 'pipe', encoding: 'utf8', timeout: 120_000 });
  }

  /** Put the two levers in a defined state and drop the memoized resolvers. */
  function levers(intervalSec: string | null, closedGopDisabled: boolean): void {
    if (intervalSec === null) delete process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
    else process.env.ENCODE_KEYFRAME_INTERVAL_SEC = intervalSec;
    if (closedGopDisabled) process.env.ENCODE_CLOSED_GOP_DISABLED = '1';
    else delete process.env.ENCODE_CLOSED_GOP_DISABLED;
    __forTests_resetKeyframeCache();
  }

  function makeClip(seconds: number, name: string): string {
    const out = join(workDir, name);
    const r = run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=320x240:rate=${FPS}:duration=${seconds}`,
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      out,
    ]);
    expect(r.status, `clip build failed: ${r.stderr?.slice(-400)}`).toBe(0);
    return out;
  }

  /**
   * Keyframe timestamps from a PACKET dump.
   *
   * Deliberately NOT `-show_entries frame=key_frame,pts_time`: there the
   * `key_frame` column lands in the MIDDLE of the CSV row, so the obvious
   * `grep ",1$"` can never match, and without `-skip_frame nokey` ffprobe decodes
   * every single frame. Those two mistakes are what invalidated the reporter's own
   * measurement — this helper exists so the project never repeats them.
   */
  function keyframeTimes(file: string): number[] {
    const r = run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,flags',
      '-of',
      'csv=p=0',
      file,
    ]);
    expect(r.status, `ffprobe failed: ${r.stderr?.slice(-300)}`).toBe(0);
    return r.stdout
      .trim()
      .split('\n')
      .map((line) => line.split(','))
      .filter((fields) => (fields[1] ?? '').includes('K'))
      .map((fields) => Number(fields[0]))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  }

  /** NAL-unit-type histogram of the raw HEVC bitstream behind an mkv/mp4. */
  function hevcNalCounts(file: string): Record<number, number> {
    const raw = join(workDir, `raw-${Math.abs(hashName(file))}.hevc`);
    const r = run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      file,
      '-c:v',
      'copy',
      '-an',
      '-bsf:v',
      'hevc_mp4toannexb',
      '-f',
      'hevc',
      raw,
    ]);
    expect(r.status, `annexb extract failed: ${r.stderr?.slice(-300)}`).toBe(0);
    const buf = readFileSync(raw);
    const counts: Record<number, number> = {};
    for (let i = 0; i + 3 < buf.length; i += 1) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
        const type = (buf[i + 3] >> 1) & 0x3f;
        counts[type] = (counts[type] ?? 0) + 1;
      }
    }
    return counts;
  }

  function hashName(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  function idrCount(c: Record<number, number>): number {
    return (c[IDR_W_RADL] ?? 0) + (c[IDR_N_LP] ?? 0);
  }

  function encodeWithBuildArgs(source: string, out: string, extra: object = {}): void {
    const args = buildArgs({
      input: source,
      output: out,
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mkv',
      ...extra,
    });
    const r = run('ffmpeg', args);
    expect(r.status, `ffmpeg failed: ${r.stderr?.slice(-600)}`).toBe(0);
  }

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'x265-keyframe-'));
    clip12 = makeClip(CLIP_SEC, 'clip12.mkv');
    clip26 = makeClip(LONG_CLIP_SEC, 'clip26.mkv');

    // AC-14 source: the 12 s clip plus a REAL attached_pic cover (49-01 fixture
    // pattern — the matroska demuxer turns the AttachedFile into a video stream
    // carrying the attached_pic disposition).
    const cover = join(workDir, 'cover.jpg');
    const c = run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=600x900:d=1',
      '-frames:v',
      '1',
      '-pix_fmt',
      'yuvj444p',
      cover,
    ]);
    expect(c.status, `cover build failed: ${c.stderr}`).toBe(0);
    coverSource = join(workDir, 'cover-src.mkv');
    const m = run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      clip12,
      '-c',
      'copy',
      '-attach',
      cover,
      '-metadata:s:t',
      'mimetype=image/jpeg',
      '-metadata:s:t',
      'filename=cover.jpg',
      coverSource,
    ]);
    expect(m.status, `cover mux failed: ${m.stderr}`).toBe(0);
  });

  afterAll(() => {
    // Restore even if a test threw — the resolvers are memoized per process.
    if (_origInterval === undefined) delete process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
    else process.env.ENCODE_KEYFRAME_INTERVAL_SEC = _origInterval;
    if (_origClosedGop === undefined) delete process.env.ENCODE_CLOSED_GOP_DISABLED;
    else process.env.ENCODE_CLOSED_GOP_DISABLED = _origClosedGop;
    __forTests_resetKeyframeCache();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('AC-11 + AC-12: interval 2 s ⇒ keyframes at 0,2,4,6,8,10 AND every one is an IDR (CRA 0)', () => {
    levers('2', false);
    const out = join(workDir, 'ac11.mkv');
    encodeWithBuildArgs(clip12, out);

    // AC-11: real spacing, tolerance one frame duration.
    const times = keyframeTimes(out);
    const tolerance = 1 / FPS;
    expect(times.length).toBeGreaterThanOrEqual(6);
    for (const [i, expected] of [0, 2, 4, 6, 8, 10].entries()) {
      expect(Math.abs(times[i] - expected)).toBeLessThanOrEqual(tolerance);
    }

    // AC-12: the keyframes are IDR, not CRA.
    const counts = hevcNalCounts(out);
    expect(counts[CRA_NUT] ?? 0).toBe(0);
    expect(idrCount(counts)).toBe(times.length);
    // MEASURED NOTE: only IDR_N_LP (20) ever appears with this x265 build —
    // IDR_W_RADL (19) is practically dead. The assertion stays an OR anyway: a
    // different x265 build is allowed to emit 19, and narrowing to 20 would make
    // the gate fragile for no gain.
    expect(counts[IDR_N_LP] ?? 0).toBeGreaterThan(0);
  });

  it('AC-13: NEGATIVE CONTROL — ENCODE_CLOSED_GOP_DISABLED=1 ⇒ CRA > 0 (the pin is load-bearing)', () => {
    levers('2', true);
    const out = join(workDir, 'ac13.mkv');
    encodeWithBuildArgs(clip12, out);

    // Same spacing — the interval lever is untouched by the IDR kill-switch.
    expect(keyframeTimes(out).length).toBeGreaterThanOrEqual(6);
    const counts = hevcNalCounts(out);
    // Without the pin the forced keyframes come back as OPEN CRA frames. This is
    // what proves AC-12 measures the pin and not a coincidence.
    expect(counts[CRA_NUT] ?? 0).toBeGreaterThan(0);
  });

  it('AC-14: cover art ⇒ argv carries the NARROWED specifier, exit 0, cover copied untouched', () => {
    levers('2', false);
    // 50-02: mp4 — the ordinal narrowing lives on the COPY path, and after 50-02
    // that path is mp4-only (E3). The mkv branch emits the bare token on purpose.
    const out = join(workDir, 'ac14.mp4');
    const args = buildArgs({
      input: coverSource,
      output: out,
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mp4',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });

    // The AC asserts the FORM in the argv, deliberately — see the note below.
    expect(args).toContain('-force_key_frames:v:0');
    expect(args).not.toContain('-force_key_frames');

    const r = run('ffmpeg', args);
    expect(r.status, `ffmpeg failed: ${r.stderr?.slice(-600)}`).toBe(0);

    const probe = run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', out]);
    expect(probe.status).toBe(0);
    const videos = (
      JSON.parse(probe.stdout).streams as Array<{
        codec_type: string;
        codec_name: string;
        width?: number;
        height?: number;
      }>
    ).filter((s) => s.codec_type === 'video');
    expect(videos[0].codec_name).toBe('hevc');
    expect(videos[1].codec_name).toBe('mjpeg');
    expect(videos[1].width).toBe(600);
    expect(videos[1].height).toBe(900);

    // ⚠ READ THIS BEFORE CITING THIS TEST AS PROOF OF NECESSITY. Measured (M5a,
    // executed): the BARE `-force_key_frames` token also exits 0 here with the
    // cover unchanged, in mkv AND mp4 — ffmpeg treats it as a silent no-op on a
    // stream-copied stream, unlike `-vf`, which aborts with "Filtering and
    // streamcopy cannot be used together". So this case is CLASS CONSISTENCY with
    // the other three global video specifiers, NOT a bug fix, and "exit 0 + cover
    // intact" alone would not discriminate between the two forms. That is exactly
    // why the argv-form assertions above are the discriminating part of this test.
  });

  it('AC-8 EXECUTED: both levers off ⇒ the pre-49 bitstream is reproducible (CRA > 0, encoder-default spacing)', () => {
    levers('0', true);
    const out = join(workDir, 'ac8.mkv');
    encodeWithBuildArgs(clip12, out);

    const times = keyframeTimes(out);
    // ARITHMETIC BEHIND THE FIXTURE LENGTH: gop_size default 250 frames / 24 fps
    // = 10.417 s, and 12 s = 288 frames, so exactly TWO keyframes fit — frame 0
    // and frame 250 — giving CRA exactly 1. Margin 1. This assertion fires FIRST
    // so a shortened fixture fails with "expected >= 2 keyframes" instead of the
    // misleading "cra is 0".
    expect(
      times.length,
      `fixture too short: a ${CLIP_SEC}s @${FPS}fps clip must contain >= 2 encoder-native keyframes (default GOP ${DEFAULT_GOP_FRAMES} frames)`,
    ).toBeGreaterThanOrEqual(2);
    expect(Math.abs(times[1] - DEFAULT_GOP_FRAMES / FPS)).toBeLessThanOrEqual(1 / FPS);

    const counts = hevcNalCounts(out);
    expect(counts[CRA_NUT] ?? 0).toBeGreaterThan(0);
  });

  it('AC-17: interval 60 is capped by the encoder default GOP — value verbatim, EFFECT min(interval, GOP)', () => {
    levers('60', false);
    const out = join(workDir, 'ac17.mkv');
    encodeWithBuildArgs(clip26, out);

    // The resolved VALUE is 60 verbatim and the argv says so…
    const args = buildArgs({
      input: clip26,
      output: join(workDir, 'ac17-argv.mkv'),
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mkv',
    });
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe('expr:gte(t,n_forced*60)');

    // …but the OBSERVABLE spacing is the untouched gop_size=250 default, NOT 60 s.
    // 49-02 does not change gop_size, so values above ~10 s are without effect.
    const times = keyframeTimes(out);
    expect(times.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(times[1] - DEFAULT_GOP_FRAMES / FPS)).toBeLessThanOrEqual(1 / FPS);
    expect(Math.abs(times[2] - (2 * DEFAULT_GOP_FRAMES) / FPS)).toBeLessThanOrEqual(1 / FPS);

    // POSITIVE FINDING from the same run: open-gop=0 makes the ENCODER-NATIVE
    // keyframes IDR too, so closed-GOP holds even above the interval.
    expect(hevcNalCounts(out)[CRA_NUT] ?? 0).toBe(0);
  });
});

// ── 50-01 (AC-17): the frame gate against REAL ffmpeg output ──────────────────
//
// M-A rebuilt with ffmpeg: the video ends early while the audio runs the full
// length — exactly the shape of the reporter's 17-of-371 722 job, and the only
// reproduction possible without Intel hardware.

describe.skipIf(!ffmpegAvailable)('50-01 output frame gate — real ffmpeg (AC-17)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'x265-frame-gate-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Video of `videoSeconds`, audio always 30 s — collapse form when they differ. */
  function buildFixture(out: string, videoSeconds: number): void {
    const r = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostats',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc=size=320x240:rate=24:duration=${videoSeconds}`,
        '-f',
        'lavfi',
        '-i',
        'sine=duration=30',
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-crf',
        '30',
        '-c:a',
        'aac',
        out,
      ],
      { stdio: 'pipe', timeout: 120_000 },
    );
    expect(r.status, `ffmpeg exited non-zero (stderr: ${r.stderr?.toString().slice(-300)})`).toBe(
      0,
    );
    expect(statSync(out).size).toBeGreaterThan(0);
  }

  /** The raw ffprobe field, so parseFrameRate is exercised on real output. */
  function rawAvgFrameRate(file: string): string {
    const r = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=avg_frame_rate',
        '-of',
        'csv=p=0',
        file,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    return r.stdout.trim();
  }

  it('AC-17: the M-A collapse form (video ends early, audio runs on) rips the gate', async () => {
    const out = join(dir, 'collapse.mkv');
    buildFixture(out, 0.708);

    // M-A, measured: avg_frame_rate does NOT collapse with the stream — the
    // Matroska track header still says 24/1 with only 17 packets present. That
    // is why the gate needs a counted second number.
    const raw = rawAvgFrameRate(out);
    const fps = parseFrameRate(raw);
    expect(fps).toBeCloseTo(24, 3);

    const probe = await ffprobe(out);
    expect(probe).not.toBeNull();
    const packets = await countVideoPackets(out, { videoOrdinal: 0 });
    expect(packets).not.toBeNull();
    // ~17 real packets against ~720 expected — four orders off the threshold.
    expect(packets!).toBeLessThan(60);
    expect(probe!.durationSeconds!).toBeGreaterThan(29);

    const verdict = evaluateFrameGate({
      durationSeconds: probe!.durationSeconds,
      avgFrameRate: probe!.streams?.find((s) => s.codec_type === 'video')?.avgFrameRate,
      actualPackets: packets,
    });
    expect(verdict.kind).toBe('fail');
  }, 120_000);

  it('AC-17: the same source encoded completely passes the gate', async () => {
    const out = join(dir, 'complete.mkv');
    buildFixture(out, 30);

    const probe = await ffprobe(out);
    expect(probe).not.toBeNull();
    const packets = await countVideoPackets(out, { videoOrdinal: 0 });
    expect(packets!).toBeGreaterThan(700);

    const verdict = evaluateFrameGate({
      durationSeconds: probe!.durationSeconds,
      avgFrameRate: probe!.streams?.find((s) => s.codec_type === 'video')?.avgFrameRate,
      actualPackets: packets,
    });
    expect(verdict.kind).toBe('pass');
  }, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// 50-02 (AC-1 / AC-2 / AC-4 / AC-10 / AC-15 / AC-16 / AC-26 / AC-28): cover art
// as a REAL matroska AttachedFile, proven by running the whole chain.
//
// WHY THIS CANNOT BE AN ARGV ASSERTION: every failure mode here lives in the
// MUXER and the DEMUXER, not in the argument vector. `-attach x.jpg
// -metadata:s:t:2 mimetype=image/jpeg` is a perfectly plausible argv that
// (a) exits 234 with a 0-byte file if the index is wrong (M-H), (b) renames the
// source fonts and manufactures phantom video streams if the specifier is
// unindexed (M-F), and (c) produces an output whose cover is a second REAL video
// track if you copy instead of attach (M-C, the v2.46.0 defect). Only a probe of
// a produced file tells those apart.
//
// The chain below is the PRODUCTION one: real ffprobe → describeAttachedPictures
// → the real extractCovers spawn → buildArgs → ffmpeg. Nothing is reconstructed.
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!ffmpegAvailable)(
  '50-02 cover art as a real MKV AttachedFile — real ffmpeg',
  () => {
    const CROP = '64:48:0:0';

    let workDir: string;
    let coverJpg: string;
    let coverPng: string;
    let srcA: string; // one mjpeg cover + TWO fonts  (the M-E shape)
    let srcB: string; // mjpeg + png cover + ONE font (the M-K/M-L shape)
    let srcV246: string; // the v2.46.0 output shape: cover as a plain video track
    let srcOrdinal0: string; // cover FIRST among the video streams (AC-28)

    function sh(bin: string, args: string[]) {
      return spawnSync(bin, args, { stdio: 'pipe', encoding: 'utf8', timeout: 120_000 });
    }

    function probeStreams(file: string): Array<{
      index: number;
      codec_type: string;
      codec_name?: string;
      width?: number;
      height?: number;
      disposition?: Record<string, number>;
      tags?: Record<string, string>;
    }> {
      const r = sh('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]);
      expect(r.status, `ffprobe failed: ${r.stderr}`).toBe(0);
      return JSON.parse(r.stdout).streams;
    }

    function upperTags(s: { tags?: Record<string, string> }): Record<string, string> {
      return Object.fromEntries(
        Object.entries(s.tags ?? {}).map(([k, v]) => [k.toUpperCase(), v]),
      ) as Record<string, string>;
    }

    /** Build a single-frame image of the requested extension. */
    function makeImage(name: string, size = '600x900'): string {
      const out = join(workDir, name);
      const r = sh('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=red:size=${size}:d=1`,
        '-frames:v',
        '1',
        out,
      ]);
      expect(r.status, `image build failed (${name}): ${r.stderr}`).toBe(0);
      return out;
    }

    /** Mux FIXTURE + a list of attachments (in order) into an mkv. */
    function makeSource(name: string, attachments: Array<[string, string, string]>): string {
      const out = join(workDir, name);
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', FIXTURE, '-c', 'copy'];
      attachments.forEach(([file, mimetype, filename], i) => {
        args.push(
          '-attach',
          file,
          `-metadata:s:t:${i}`,
          `mimetype=${mimetype}`,
          `-metadata:s:t:${i}`,
          `filename=${filename}`,
        );
      });
      args.push(out);
      const r = sh('ffmpeg', args);
      expect(r.status, `source mux failed (${name}): ${r.stderr}`).toBe(0);
      return out;
    }

    /**
     * THE PRODUCTION CHAIN, end to end. Returns the argv actually executed so a
     * test can assert the form AND the produced file in one place.
     */
    async function encode50_02(
      src: string,
      outName: string,
      extra: { crop?: string } = {},
    ): Promise<{ out: string; args: string[]; stderr: string }> {
      const probe = await ffprobe(src);
      expect(probe, `ffprobe returned null for ${src}`).not.toBeNull();
      const analysis = analyzeAttachedPictures(probe!);
      const covers = describeAttachedPictures(probe!);
      // Each call gets its own extraction dir — cover0.<ext> is per JOB in
      // production, and two tests sharing one dir would hide a path collision.
      const stage = join(workDir, `stage-${outName}`);
      mkdirSync(stage, { recursive: true });
      const attachments = await extractCovers(src, stage, covers, {});

      const out = join(workDir, outName);
      const args = buildArgs({
        input: src,
        output: out,
        crf: 30,
        encoder: 'libx265',
        preset: 'ultrafast',
        outputContainer: 'mkv',
        crop: extra.crop,
        attachedPicVideoOrdinals: analysis.videoOrdinals,
        encodedVideoOrdinals: analysis.encodedVideoOrdinals,
        coverAttachments: attachments,
        sourceAttachmentCount: countAttachmentStreams(probe!),
      });
      const r = sh('ffmpeg', args);
      expect(r.status, `ffmpeg failed: ${r.stderr?.slice(-800)}`).toBe(0);
      expect(statSync(out).size).toBeGreaterThan(0);
      return { out, args, stderr: r.stderr ?? '' };
    }

    beforeAll(() => {
      workDir = mkdtempSync(join(tmpdir(), 'x265-50-02-'));
      coverJpg = makeImage('cover.jpg');
      coverPng = makeImage('cover.png', '300x300');
      const f1 = join(workDir, 'f1.ttf');
      const f2 = join(workDir, 'f2.ttf');
      writeFileSync(f1, 'FONTDATA1');
      writeFileSync(f2, 'FONTDATA2');

      srcA = makeSource('srcA.mkv', [
        [coverJpg, 'image/jpeg', 'cover.jpg'],
        [f1, 'application/x-truetype-font', 'f1.ttf'],
        [f2, 'application/x-truetype-font', 'f2.ttf'],
      ]);
      srcB = makeSource('srcB.mkv', [
        [coverJpg, 'image/jpeg', 'cover.jpg'],
        [coverPng, 'image/png', 'small.png'],
        [f1, 'application/x-truetype-font', 'f1.ttf'],
      ]);

      // The premise, re-measured: the matroska DEMUXER promotes an image
      // AttachedFile to a VIDEO stream carrying attached_pic — which is why
      // `-map 0:t?` never caught it and why this plan exists.
      const a = probeStreams(srcA);
      expect(a.filter((s) => s.codec_type === 'video')).toHaveLength(2);
      expect(a.filter((s) => s.codec_type === 'video')[1].disposition?.attached_pic).toBe(1);
      expect(a.filter((s) => s.codec_type === 'attachment')).toHaveLength(2);

      // The v2.46.0 shape, produced with the ARGV v2.46.0 actually shipped (the
      // 49-01 copy form). buildArgs can no longer emit it on mkv, so it is written
      // out by hand HERE — that is the point: this is the file already sitting in
      // an operator's library, and AC-16 is about healing it.
      srcV246 = join(workDir, 'v246.mkv');
      const v246 = sh('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        srcA,
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-crf',
        '30',
        '-c:v:1',
        'copy',
        '-c:a',
        'copy',
        '-c:s',
        'copy',
        '-map',
        '0:v',
        '-map',
        '0:a?',
        '-map',
        '0:s?',
        '-map',
        '0:t?',
        srcV246,
      ]);
      expect(v246.status, `v2.46.0 fixture build failed: ${v246.stderr}`).toBe(0);

      // AC-28: a source whose cover is the FIRST video stream. Same shape a
      // v2.46.0 mp4-sourced output carries; recognised by 49-01 branch (b).
      srcOrdinal0 = join(workDir, 'ordinal0.mkv');
      const o0 = sh('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        coverJpg,
        '-i',
        FIXTURE,
        '-map',
        '0:v',
        '-map',
        '1:v',
        '-map',
        '1:a?',
        '-c',
        'copy',
        '-metadata:s:v:0',
        'mimetype=image/jpeg',
        '-metadata:s:v:0',
        'filename=cover.jpg',
        srcOrdinal0,
      ]);
      expect(o0.status, `ordinal-0 fixture build failed: ${o0.stderr}`).toBe(0);
    });

    afterAll(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    // ── AC-1 + AC-2 ────────────────────────────────────────────────────────────
    it('AC-1/AC-2: one real video track, cover as attached_pic=1, both fonts untouched', async () => {
      const { out, args } = await encode50_02(srcA, 'ac1.mkv');

      // the argv form that produced it (M-E)
      expect(args).toContain('-0:v:1');
      expect(args).toContain('-attach');
      expect(args).toContain('-metadata:s:t:2');
      expect(args).not.toContain('-metadata:s:t');

      const streams = probeStreams(out);
      const videos = streams.filter((s) => s.codec_type === 'video');
      const realVideos = videos.filter((s) => s.disposition?.attached_pic !== 1);
      expect(realVideos).toHaveLength(1);
      expect(realVideos[0].codec_name).toBe('hevc');

      const cover = videos.find((s) => s.disposition?.attached_pic === 1);
      expect(cover, 'the cover did not come back as an attached picture').toBeDefined();
      expect(cover!.codec_name).toBe('mjpeg');
      expect(upperTags(cover!).FILENAME).toBe('cover.jpg');
      expect(upperTags(cover!).MIMETYPE).toBe('image/jpeg');

      // AC-2: the fonts. M-F would have renamed BOTH to cover.jpg and turned them
      // into phantom video streams — this is the assertion that catches it.
      const fonts = streams.filter((s) => s.codec_type === 'attachment');
      expect(fonts).toHaveLength(2);
      expect(fonts.map((f) => upperTags(f).MIMETYPE)).toEqual([
        'application/x-truetype-font',
        'application/x-truetype-font',
      ]);
      expect(fonts.map((f) => upperTags(f).FILENAME)).toEqual(['f1.ttf', 'f2.ttf']);
      expect(videos).toHaveLength(2); // exactly one real + exactly one cover
    });

    // ── AC-10 ──────────────────────────────────────────────────────────────────
    it('AC-10: with a crop the specifiers stand BARE — video cropped, cover untouched', async () => {
      const { out, args } = await encode50_02(srcA, 'ac10.mkv', { crop: CROP });

      // E3/M-O: no narrowing anywhere on this path.
      expect(args).toContain('-vf');
      expect(args[args.indexOf('-vf') + 1]).toBe(`crop=${CROP}`);
      expect(args.some((t) => /^-filter:v:\d+$/.test(t))).toBe(false);
      expect(args.some((t) => /^-force_key_frames:v:\d+$/.test(t))).toBe(false);
      expect(args.some((t) => /^-c:v:\d+$/.test(t))).toBe(false);

      const videos = probeStreams(out).filter((s) => s.codec_type === 'video');
      const real = videos.find((s) => s.disposition?.attached_pic !== 1)!;
      const cover = videos.find((s) => s.disposition?.attached_pic === 1)!;
      expect(real.width).toBe(64);
      expect(real.height).toBe(48);
      // The cover keeps its OWN geometry — it never went through the filter.
      expect(cover.width).toBe(600);
      expect(cover.height).toBe(900);
    });

    // ── AC-4 ───────────────────────────────────────────────────────────────────
    it('AC-4: two covers ⇒ two attach blocks, both back as attached_pic with own mimetypes', async () => {
      const { out, args } = await encode50_02(srcB, 'ac4.mkv');

      expect(args.filter((t) => t === '-attach')).toHaveLength(2);
      // ONE source attachment (the font) ⇒ the base index is 1, not 0.
      expect(args).toContain('-metadata:s:t:1');
      expect(args).toContain('-metadata:s:t:2');

      const streams = probeStreams(out);
      const covers = streams.filter(
        (s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1,
      );
      expect(covers).toHaveLength(2);
      expect(covers.map((c) => upperTags(c).MIMETYPE).sort()).toEqual(['image/jpeg', 'image/png']);
      expect(covers.map((c) => upperTags(c).FILENAME).sort()).toEqual(['cover.jpg', 'small.png']);
      // the font survived, with its own mimetype
      const fonts = streams.filter((s) => s.codec_type === 'attachment');
      expect(fonts).toHaveLength(1);
      expect(upperTags(fonts[0]).MIMETYPE).toBe('application/x-truetype-font');
    });

    // ── AC-15 ──────────────────────────────────────────────────────────────────
    it('AC-15: re-encoding our OWN output keeps exactly one video track + one cover', async () => {
      const first = await encode50_02(srcA, 'ac15-first.mkv');
      const second = await encode50_02(first.out, 'ac15-second.mkv');

      const streams = probeStreams(second.out);
      const videos = streams.filter((s) => s.codec_type === 'video');
      expect(videos.filter((s) => s.disposition?.attached_pic !== 1)).toHaveLength(1);
      expect(videos.filter((s) => s.disposition?.attached_pic === 1)).toHaveLength(1);
      expect(streams.filter((s) => s.codec_type === 'attachment')).toHaveLength(2);
      // 49-01 branch (a) fired: the source cover already carried attached_pic.
      expect(second.args).toContain('-0:v:1');
    });

    // ── AC-16 ──────────────────────────────────────────────────────────────────
    it('AC-16: a v2.46.0 output (cover as a plain video track) is HEALED on re-encode', async () => {
      // the premise: the shipped v2.46.0 form really does carry two real video tracks
      const before = probeStreams(srcV246).filter((s) => s.codec_type === 'video');
      expect(before).toHaveLength(2);
      expect(before[1].codec_name).toBe('mjpeg');
      expect(before[1].disposition?.attached_pic ?? 0).toBe(0); // NOT a cover any more
      expect(upperTags(before[1]).MIMETYPE).toBe('image/jpeg'); // …only the tag identifies it

      const { out } = await encode50_02(srcV246, 'ac16.mkv');
      const videos = probeStreams(out).filter((s) => s.codec_type === 'video');
      expect(videos.filter((s) => s.disposition?.attached_pic !== 1)).toHaveLength(1);
      const cover = videos.find((s) => s.disposition?.attached_pic === 1);
      expect(cover, '49-01 branch (b) failed to recognise the v2.46.0 cover').toBeDefined();
      expect(upperTags(cover!).MIMETYPE).toBe('image/jpeg');
    });

    // ── AC-28 ──────────────────────────────────────────────────────────────────
    it('AC-28: a cover at video ordinal 0 is unmapped, and nothing is narrowed', async () => {
      const { out, args } = await encode50_02(srcOrdinal0, 'ac28.mkv', { crop: CROP });

      expect(args).toContain('-0:v:0');
      // THE reason E3 dropped the narrowing: `-filter:v:1` would address an output
      // ordinal that no longer exists once ordinal 0 is unmapped, and the crop
      // would fall away SILENTLY.
      expect(args.some((t) => /^-filter:v:\d+$/.test(t))).toBe(false);
      expect(args).toContain('-vf');

      const videos = probeStreams(out).filter((s) => s.codec_type === 'video');
      expect(videos.filter((s) => s.disposition?.attached_pic !== 1)).toHaveLength(1);
      expect(videos.filter((s) => s.disposition?.attached_pic === 1)).toHaveLength(1);
      // the crop really applied to the real track
      expect(videos.find((s) => s.disposition?.attached_pic !== 1)!.width).toBe(64);
    });

    // ── the negative controls: WHY the implementation looks the way it does ────
    it('NEGATIVE CONTROL M-F: an UNINDEXED -metadata:s:t destroys the fonts', async () => {
      const probe = await ffprobe(srcA);
      const stage = join(workDir, 'stage-mf');
      mkdirSync(stage, { recursive: true });
      const [att] = await extractCovers(srcA, stage, describeAttachedPictures(probe!), {});
      const out = join(workDir, 'mf.mkv');

      const r = sh('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        srcA,
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-crf',
        '30',
        '-c:a',
        'copy',
        '-map',
        '0:v',
        '-map',
        '-0:v:1',
        '-map',
        '0:a?',
        '-map',
        '0:t?',
        '-attach',
        att.path,
        '-metadata:s:t', // ← the defect: NO index
        'mimetype=image/jpeg',
        '-metadata:s:t',
        'filename=cover.jpg',
        out,
      ]);
      expect(r.status).toBe(0); // it does not even fail — it silently corrupts

      const streams = probeStreams(out);
      // Every attachment was relabelled image/jpeg + cover.jpg, so the demuxer
      // turns the FONTS into phantom attached_pic video streams. THIS is what the
      // indexed specifier prevents, and why the bare form is never emitted.
      const phantoms = streams.filter(
        (s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1,
      );
      expect(phantoms.length).toBeGreaterThan(1);
      expect(streams.filter((s) => s.codec_type === 'attachment')).toHaveLength(0);
    });

    it('NEGATIVE CONTROL M-G: an -attach without a mimetype is exit 234 + a 0-byte file', async () => {
      const probe = await ffprobe(srcA);
      const stage = join(workDir, 'stage-mg');
      mkdirSync(stage, { recursive: true });
      const [att] = await extractCovers(srcA, stage, describeAttachedPictures(probe!), {});
      const out = join(workDir, 'mg.mkv');

      const r = sh('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        srcA,
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-crf',
        '30',
        '-c:a',
        'copy',
        '-map',
        '0:v',
        '-map',
        '-0:v:1',
        '-map',
        '0:a?',
        '-map',
        '0:t?',
        '-attach',
        att.path, // ← the defect: no mimetype= tag at all
        out,
      ]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('no mimetype tag');
      // This is the failure class the kill-switch exists for (E1).
      expect(statSync(out).size).toBe(0);
    });

    // ── AC-26 / E11: every shipped codec is round-trip MEASURED ────────────────
    //
    // MEASURED, ffmpeg 6.1.1: the matroska demuxer promotes an image AttachedFile
    // back to an `attached_pic` VIDEO stream for mjpeg / png / gif — and NOT for
    // webp / bmp, which stay ordinary attachment streams carrying the right
    // mimetype. Both outcomes are acceptable (the cover survives either way, and
    // an ordinary AttachedFile beats dropping it); neither may be exit 234 or a
    // 0-byte file. The test NAME carries the measured answer so the file states
    // the truth rather than the hope.
    describe('AC-26/E11 — the attach round trip, per shipped codec', () => {
      const cases: Array<{ codec: string; ext: string; mimetype: string; promoted: boolean }> = [
        { codec: 'mjpeg', ext: 'jpg', mimetype: 'image/jpeg', promoted: true },
        { codec: 'png', ext: 'png', mimetype: 'image/png', promoted: true },
        { codec: 'gif', ext: 'gif', mimetype: 'image/gif', promoted: true },
        { codec: 'webp', ext: 'webp', mimetype: 'image/webp', promoted: false },
        { codec: 'bmp', ext: 'bmp', mimetype: 'image/bmp', promoted: false },
      ];

      it('the table under test IS the shipped table (no untested key can appear)', () => {
        expect(cases.map((c) => c.codec).sort()).toEqual(Object.keys(COVER_MEDIA_BY_CODEC).sort());
        for (const c of cases) {
          expect(COVER_MEDIA_BY_CODEC[c.codec]).toEqual({ ext: c.ext, mimetype: c.mimetype });
        }
      });

      it.each(cases)(
        '$codec → $mimetype: comes back as $promoted ? attached_pic : an ordinary AttachedFile',
        ({ codec, ext, mimetype, promoted }) => {
          const img = makeImage(`rt-${codec}.${ext}`, '120x120');
          const out = makeSource(`rt-${codec}.mkv`, [[img, mimetype, `cover.${ext}`]]);
          expect(statSync(out).size).toBeGreaterThan(0);

          const streams = probeStreams(out);
          const asCover = streams.find(
            (s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1,
          );
          const asAttachment = streams.find((s) => s.codec_type === 'attachment');

          if (promoted) {
            expect(asCover, `${codec} was expected to come back as attached_pic`).toBeDefined();
            expect(asCover!.codec_name).toBe(codec);
            expect(upperTags(asCover!).MIMETYPE).toBe(mimetype);
          } else {
            // NOT a defect — the cover survives as a plain AttachedFile with the
            // correct mimetype. Documented as such in CLAUDE.md.
            expect(asCover).toBeUndefined();
            expect(asAttachment, `${codec} lost its attachment entirely`).toBeDefined();
            expect(upperTags(asAttachment!).MIMETYPE).toBe(mimetype);
            expect(upperTags(asAttachment!).FILENAME).toBe(`cover.${ext}`);
          }
        },
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Phase 50 Plan 50-06 (AC-2) — the /diagnostics test encode feeds 4:2:0 YUV.
//
// This is the KERNEL of the plan, and it is only provable by running ffmpeg: the
// claim is not about which tokens are emitted but about which pixel format the
// encoder actually receives. Measured locally (ffmpeg 6.1.1 / x265 3.5): the
// pre-50-06 argv makes libx265 encode `gbrp` — RGB planar 4:4:4 — a format no
// real source ever has and one an x265 build without 4:4:4 support cannot even
// open. The argv comes from the REAL builder; hand-rolling it here would prove
// something other than what ships (50-02 rule).
//
// The negative control is produced by REWRITING the built argv's lavfi token,
// never by a builder flag that switches the filter off — such a flag would be a
// kill-switch through the back door and contradicts this plan's D6 decision.
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!ffmpegAvailable)('50-06 test-encode input pixel format — real ffmpeg', () => {
  /** The `Stream #0:0: Video: hevc, <fmt>` the encoder reports on stderr. */
  function encodedPixelFormat(args: string[]): { fmt: string; status: number } {
    const verbose = args.map((a) => (a === 'info' ? 'verbose' : a));
    const res = spawnSync('ffmpeg', verbose, { encoding: 'utf8' });
    const line = (res.stderr ?? '').split('\n').find((l) => /Stream #0:0.*Video: hevc/.test(l));
    expect(line, `no encoded hevc stream line in stderr:\n${res.stderr}`).toBeDefined();
    const m = /Video: hevc[^,]*,\s*(?:\d+ reference frames?,\s*)?([a-z0-9]+)/.exec(line!);
    expect(m, `could not parse the pixel format out of: ${line}`).not.toBeNull();
    return { fmt: m![1], status: res.status ?? -1 };
  }

  const shipped = buildTestEncodeArgs({ encoder: 'libx265', crf: 28, preset: 'ultrafast' });

  // The v2.46.4 argv, reconstructed by removing exactly the token this plan added.
  const preFix = shipped.map((t) =>
    t.startsWith('testsrc=') ? t.replace(',format=yuv420p', '') : t,
  );

  it('the negative control really is the pre-50-06 form (one token differs)', () => {
    expect(preFix).not.toEqual(shipped);
    expect(preFix.filter((t, i) => t !== shipped[i])).toHaveLength(1);
    expect(preFix.some((t) => t.includes('format='))).toBe(false);
  });

  it('AC-2 (RED): WITHOUT the filter libx265 encodes gbrp — RGB 4:4:4', () => {
    const { fmt, status } = encodedPixelFormat(preFix);
    expect(status).toBe(0);
    expect(fmt).toBe('gbrp');
  });

  it('AC-2 (GREEN): WITH the filter libx265 encodes yuv420p', () => {
    const { fmt, status } = encodedPixelFormat(shipped);
    expect(status).toBe(0);
    expect(fmt).toBe('yuv420p');
  });

  it('AC-8: force_10bit reaches 10-bit while the INPUT graph stays 8-bit', () => {
    const args = buildTestEncodeArgs({
      encoder: 'libx265',
      crf: 28,
      preset: 'ultrafast',
      tenBit: true,
    });
    expect(args[args.indexOf('-i') + 1]).toContain('format=yuv420p');
    const { fmt, status } = encodedPixelFormat(args);
    expect(status).toBe(0);
    expect(fmt).toBe('yuv420p10le');
  });

  it('AC-9: the keyframe token is accepted in the -f null envelope', () => {
    const args = buildTestEncodeArgs({
      encoder: 'libx265',
      crf: 28,
      preset: 'ultrafast',
      keyframeIntervalSec: 5,
      forceIdr: true,
    });
    expect(args).toContain('-force_key_frames');
    const res = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
  });
});
