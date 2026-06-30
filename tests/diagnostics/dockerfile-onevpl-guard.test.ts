// @vitest-environment node
// 23-00 T3 (A1): Dockerfile static-assertion regression-guard.
//
// Source-intent guard — every-MR, ZERO build-cost. Reads the repo-root
// Dockerfile via fs and pins the invariants this phase depends on. The real
// `docker build` apt-resolution + the in-image dpkg-query gate are the
// downstream ground-truth; this test catches a silent source-level regression
// (a FROM swapped back to bookworm, a dropped oneVPL lib, a re-introduced
// legacy libmfx1, a hardcoded LIBVA_DRIVER_NAME, or removal of the M1
// artifact-gate) at PR-time before any image is built.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DOCKERFILE_PATH = resolve(REPO_ROOT, 'Dockerfile');
const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');

// Negative-assertion target: instruction lines only (comment lines stripped).
// The explanatory `#` comments deliberately NAME the banned tokens (libmfx1,
// LIBVA_DRIVER_NAME=iHD) to document WHY they are excluded — so the
// must-NOT-contain guards run against build instructions, not prose.
const instructions = dockerfile
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

describe('23-00 A1: Dockerfile oneVPL / trixie regression-guard', () => {
  it('every Debian/node base FROM uses a trixie tag — NOT bookworm', () => {
    const fromLines = dockerfile.split('\n').filter((l) => /^FROM\s+(node|debian):/.test(l.trim()));
    expect(
      fromLines.length,
      'expected at least the builder + ffmpeg-bin + runtime FROM stages',
    ).toBeGreaterThanOrEqual(3);
    for (const line of fromLines) {
      expect(line, `FROM stage must pin trixie, got: ${line.trim()}`).toMatch(/trixie/);
      expect(line, `FROM stage regressed to bookworm: ${line.trim()}`).not.toMatch(/bookworm/);
    }
  });

  it('runtime apt-install block contains the 3 oneVPL runtime libs', () => {
    expect(
      dockerfile,
      'missing libmfx-gen1.2 (Intel VPL GPU Runtime — root-cause fix for MFX -9)',
    ).toContain('libmfx-gen1.2');
    expect(dockerfile, 'missing libvpl2 (oneVPL dispatcher)').toContain('libvpl2');
    expect(dockerfile, 'missing libigfxcmrt7 (C-for-Media runtime)').toContain('libigfxcmrt7');
  });

  it('contains the M1 dpkg-query artifact-gate asserting all 3 oneVPL packages', () => {
    const dpkgLine = dockerfile
      .split('\n')
      .find((l) => l.includes('dpkg-query') && l.includes('libmfx-gen1.2'));
    expect(
      dpkgLine,
      'M1 enforced artifact-gate (dpkg-query self-assertion) was silently removed',
    ).toBeDefined();
    expect(dpkgLine, 'dpkg-query gate must reference libvpl2').toContain('libvpl2');
    expect(dpkgLine, 'dpkg-query gate must reference libigfxcmrt7').toContain('libigfxcmrt7');
  });

  it('does NOT install the legacy libmfx1 MSDK package', () => {
    // word-boundary: libmfx-gen1.2 must NOT false-positive as a libmfx1 match.
    expect(instructions, 'legacy libmfx1 (MSDK, no Arc/gen12+) must not be installed').not.toMatch(
      /\blibmfx1\b/,
    );
  });

  it('does NOT hardcode LIBVA_DRIVER_NAME=iHD (entrypoint sets it dynamically)', () => {
    expect(
      instructions,
      'LIBVA_DRIVER_NAME must stay dynamic via docker-entrypoint.sh',
    ).not.toMatch(/LIBVA_DRIVER_NAME=iHD/);
  });
});
