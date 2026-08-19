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
describe.skipIf(!ffmpegAvailable)('49-01 attached-pic cover art — real ffmpeg', () => {
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
    const out = join(workDir, 'case1.mkv');
    const args = buildArgs({
      input: coverSource,
      output: out,
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mkv',
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
    const out = join(workDir, 'case2.mkv');
    const args = buildArgs({
      input: coverSource,
      output: out,
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mkv',
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
    const out = join(workDir, 'case3.mkv');
    const args = buildArgs({
      input: coverSource,
      output: out,
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mkv',
      crop: CROP,
      attachedPicVideoOrdinals: [1],
      // encodedVideoOrdinals deliberately omitted
    });
    expect(args).toContain('-vf');

    const r = sh('ffmpeg', args);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('streamcopy');
  });

  it('AC-16 — mkv output DROPS the attached_pic disposition, mp4 KEEPS it', () => {
    const mkvOut = join(workDir, 'ac16.mkv');
    const mkvArgs = buildArgs({
      input: coverSource,
      output: mkvOut,
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mkv',
      attachedPicVideoOrdinals: [1],
      encodedVideoOrdinals: [0],
    });
    expect(sh('ffmpeg', mkvArgs).status).toBe(0);
    const mkvCover = probeStreams(mkvOut).filter((s) => s.codec_type === 'video')[1];
    // The matroska muxer writes it as a plain video track — the disposition is
    // gone. This is the documented behaviour change for the release note.
    expect(mkvCover.disposition?.attached_pic).toBe(0);
    // …but the tags survive, which is what isAttachedPictureStream falls back to
    // so a SECOND encode over our own output is not fatal again.
    const tags = mkvCover.tags ?? {};
    const upper = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toUpperCase(), v]));
    expect(upper.MIMETYPE).toBe('image/jpeg');
    expect(mkvCover.codec_name).toBe('mjpeg');

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
    const out = join(workDir, 'ac14.mkv');
    const args = buildArgs({
      input: coverSource,
      output: out,
      crf: 30,
      encoder: 'libx265',
      preset: 'ultrafast',
      outputContainer: 'mkv',
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
