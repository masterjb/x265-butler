// 10-03 G4: Docker libvmaf bake-in smoke — verifies the BtbN static ffmpeg
// binary shipped in the runtime image has libvmaf compiled in (no apt package,
// no separate model file — built into the binary by the BtbN GPL build).
//
// Skip contract:
//   - !dockerAvailable  → docker daemon not reachable (dev without docker)
//   - !imageAvailable   → image not yet built (dev without docker build)
//
// CI usage: build the image first, then set DOCKER_SMOKE_IMAGE=<tag>.
//   docker build --target ffmpeg-bin -t x265-butler-ffmpeg-smoke:latest .
//   DOCKER_SMOKE_IMAGE=x265-butler-ffmpeg-smoke:latest npm test

import { describe, it, expect } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';

const IMAGE_TAG = process.env.DOCKER_SMOKE_IMAGE ?? 'x265-butler-ffmpeg-smoke:latest';

const dockerAvailable = (() => {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
})();

const imageAvailable = (() => {
  if (!dockerAvailable) return false;
  try {
    execSync(`docker image inspect ${IMAGE_TAG}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const canRun = dockerAvailable && imageAvailable;

function dockerRun(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('docker', ['run', '--rm', IMAGE_TAG, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: 'pipe',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe.skipIf(!canRun)('Docker libvmaf build smoke (10-03 G4)', () => {
  it('test_docker_ffmpeg_binary_exits_zero_on_version_flag', () => {
    const { status } = dockerRun(['/opt/ffmpeg/bin/ffmpeg', '-version']);
    expect(status).toBe(0);
  });

  it('test_docker_ffmpeg_version_output_includes_libvmaf_in_configuration', () => {
    const { stdout, stderr } = dockerRun(['/opt/ffmpeg/bin/ffmpeg', '-version']);
    const combined = stdout + stderr;
    expect(combined).toMatch(/libvmaf/i);
  });

  it('test_docker_ffmpeg_filters_lists_libvmaf_filter', () => {
    const { stdout, stderr, status } = dockerRun(['/opt/ffmpeg/bin/ffmpeg', '-filters']);
    expect(status).toBe(0);
    const combined = stdout + stderr;
    expect(combined).toMatch(/libvmaf/i);
  });

  it('test_docker_image_uncompressed_size_below_1200000000_bytes', () => {
    const raw = execSync(`docker image inspect ${IMAGE_TAG} --format='{{.Size}}'`, {
      encoding: 'utf8',
      timeout: 10_000,
    })
      .trim()
      .replace(/'/g, '');
    const sizeBytes = parseInt(raw, 10);
    // BtbN static binary: ~1.07 GB uncompressed (≈580 MB compressed pull).
    // Limit raised from 800 MB to 1.2 GB post-10-03 (AC-4 size deviation accepted).
    expect(sizeBytes).toBeLessThan(1_200_000_000);
  });

  it('test_docker_ffmpeg_libvmaf_filter_runs_on_synthetic_input_without_error', () => {
    // Compute VMAF on identical reference/distorted synthetic frames (1 frame, 64x64).
    // Identical input → VMAF score near 100, but we only care about exit 0.
    const { status, stderr } = dockerRun([
      '/opt/ffmpeg/bin/ffmpeg',
      '-f',
      'lavfi',
      '-i',
      'smptebars=r=1:s=64x64:d=0.5',
      '-f',
      'lavfi',
      '-i',
      'smptebars=r=1:s=64x64:d=0.5',
      '-lavfi',
      '[0:v][1:v]libvmaf=log_fmt=json:log_path=/dev/null',
      '-f',
      'null',
      '-',
    ]);
    expect(status, `ffmpeg libvmaf filter failed (stderr tail: ${stderr.slice(-300)})`).toBe(0);
  });
});
