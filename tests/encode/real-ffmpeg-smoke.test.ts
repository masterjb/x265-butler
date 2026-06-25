import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeAudioStreams } from '@/src/lib/encode/audio-compat';
import { buildEncodeArgs } from '@/src/lib/encode/profiles';

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
