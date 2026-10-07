// @vitest-environment node
// Storage-path consistency guard.
//
// `VOLUME /media` and `/media0` made Docker create root-owned anonymous volumes
// on every install that did not map them (the CA template maps neither); the
// diagnostics then reported `EACCES /media writable=false` and operators read
// it as "my share is read-only". `/media0` was never read by the code at all.
// Only `/config` stays a VOLUME (`/cache` was taken out for the same reason).
//
// Docs guard: Butler writes the HEVC file next to the original, so the media
// mapping must be read/write and there is no separate write path.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf-8');

const instructions = (text: string): string[] =>
  text.split('\n').filter((l) => !l.trim().startsWith('#'));

describe('Dockerfile VOLUME only /config', () => {
  const volumeLines = instructions(read('Dockerfile')).filter((l) => /^\s*VOLUME\b/.test(l));

  it('exactly one VOLUME instruction, and it is ["/config"]', () => {
    expect(volumeLines).toHaveLength(1);
    expect(volumeLines[0].trim()).toBe('VOLUME ["/config"]');
  });

  it('no VOLUME line names /media, /media0 or /cache', () => {
    for (const l of volumeLines) {
      expect(l).not.toMatch(/\/media|\/cache/);
    }
  });
});

describe('no /media0 and no read-only media mapping in docs', () => {
  const FILES = ['README.md', 'docker-entrypoint.sh', 'Dockerfile'];

  it.each(FILES)('%s does not mention media0', (rel) => {
    expect(read(rel)).not.toMatch(/media0/);
  });

  it.each(['README.md'])('%s maps /media read/write (no :/media:ro)', (rel) => {
    expect(read(rel)).not.toMatch(/:\/media:ro\b/);
  });

  it.each(['README.md'])('%s volume list names /config, /media and optional /cache', (rel) => {
    const text = read(rel);
    expect(text).toMatch(/`\/config` → /);
    expect(text).toMatch(/`\/media` → .*read\/write/);
    expect(text).toMatch(/optional `\/cache` → /);
  });
});
