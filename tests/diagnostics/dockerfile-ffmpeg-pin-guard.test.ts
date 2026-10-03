// @vitest-environment node
// 52-06 (AC-4): static guard on the Dockerfile's ffmpeg supply chain. Every-MR, zero build cost.
// Pins the invariants that make each release's ffmpeg re-fetchable and identifiable: both
// binaries come from our mirror (never from a rolling upstream URL), are checked against the
// pinned sha256, and SOURCE.txt names the exact build. The real `docker build` is the downstream
// ground truth; this catches a silent source-level regression at MR time.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPins, buildStringOf } from '../../scripts/ffmpeg-pins.js';

const dockerfile = readFileSync(resolve(__dirname, '..', '..', 'Dockerfile'), 'utf-8');
const instructions = dockerfile
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

function stage(name: string): string {
  const start = instructions.indexOf(`AS ${name}`);
  expect(start, `stage ${name} missing`).toBeGreaterThan(-1);
  const next = instructions.indexOf('\nFROM ', start);
  return instructions.slice(start, next === -1 ? undefined : next);
}

describe('52-06 Dockerfile ffmpeg supply chain', () => {
  it('has valid pins for both binaries', () => {
    const pins = readPins(dockerfile);
    expect(buildStringOf(pins.btbn.asset)).toMatch(/^n\d+\.\d+/); // a release branch, not master
    expect(pins.btbn.tag).toBe(`ffmpeg-${buildStringOf(pins.btbn.asset)}`);
    expect(pins.nvenc.asset).toMatch(/^jellyfin-ffmpeg_.+_portable_linux64-gpl\.tar\.xz$/);
  });

  it('downloads nothing from a rolling or upstream URL', () => {
    expect(instructions).not.toMatch(/BtbN\/FFmpeg-Builds\/releases\/download/);
    expect(instructions).not.toMatch(/jellyfin\/jellyfin-ffmpeg\/releases\/download/);
    expect(instructions).not.toMatch(/master-latest/);
    expect(instructions).not.toMatch(/BTBN_TAG/);
  });

  for (const [name, prefix] of [
    ['ffmpeg-bin', 'FFMPEG'],
    ['ffmpeg-nvenc-bin', 'FFMPEG_NVENC'],
  ] as const) {
    describe(`stage ${name}`, () => {
      it('downloads from the mirror release of the pin', () => {
        expect(stage(name)).toContain(
          `https://github.com/masterjb/x265-butler/releases/download/\${${prefix}_MIRROR_TAG}/\${${prefix}_ASSET}`,
        );
      });

      it('verifies the pinned sha256 before unpacking', () => {
        const s = stage(name);
        const check = s.indexOf('sha256sum -c');
        expect(check, 'sha256sum -c missing').toBeGreaterThan(-1);
        expect(s).toContain(`\${${prefix}_SHA256}`);
        expect(check).toBeLessThan(s.indexOf('tar -xJf'));
      });

      it('writes SOURCE.txt with build, sha256 and mirror URL', () => {
        const s = stage(name);
        expect(s).toMatch(/SOURCE\.txt/);
        expect(s).toMatch(
          new RegExp(
            `SOURCE\\.txt[\\s\\S]*\\$\\{${prefix}_SHA256\\}|\\$\\{${prefix}_SHA256\\}[\\s\\S]*SOURCE\\.txt`,
          ),
        );
      });
    });
  }

  it('runtime copies both SOURCE.txt files from the download stages', () => {
    expect(instructions).toMatch(
      /COPY --from=ffmpeg-bin \S*SOURCE\.txt \/usr\/share\/doc\/ffmpeg\/SOURCE\.txt/,
    );
    expect(instructions).toMatch(
      /COPY --from=ffmpeg-nvenc-bin \S*SOURCE\.txt \/usr\/share\/doc\/ffmpeg-nvenc\/SOURCE\.txt/,
    );
  });
});
