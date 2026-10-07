// @vitest-environment node
// The unRAID CA template is a tracked file (unraid/x265-butler.xml).
// Before that the published template only ever got <Version>/<Date> bumped, so
// it still mapped `/library` while the app, README and diagnostics expect
// `/media`, and the AppData + Cache Pool rows never shipped.
// The template must also stay on the live header (`:latest`, project URL): an
// old staging copy pinned `:2.13.0` and would have sent every new install back.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const xml = readFileSync(resolve(REPO_ROOT, 'unraid', 'x265-butler.xml'), 'utf-8');

interface ConfigRow {
  attrs: Record<string, string>;
}

function configRows(): ConfigRow[] {
  const rows: ConfigRow[] = [];
  for (const m of xml.matchAll(/<Config\s+([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    rows.push({ attrs });
  }
  return rows;
}

const tag = (name: string): string | undefined =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim();

describe('tracked CA template content', () => {
  const paths = configRows().filter((r) => r.attrs.Type === 'Path');
  const byTarget = Object.fromEntries(paths.map((r) => [r.attrs.Target, r.attrs]));

  it('path targets are exactly /media, /config, /cache', () => {
    expect(paths.map((r) => r.attrs.Target).sort()).toEqual(['/cache', '/config', '/media']);
  });

  it('/media and /config are required and read/write', () => {
    for (const t of ['/media', '/config']) {
      expect(byTarget[t].Required).toBe('true');
      expect(byTarget[t].Mode).toBe('rw');
    }
  });

  it('/cache is optional with an empty default', () => {
    expect(byTarget['/cache'].Required).toBe('false');
    expect(byTarget['/cache'].Default).toBe('');
  });

  it('no /library target anywhere', () => {
    expect(xml).not.toMatch(/Target="\/library"/);
  });

  it('visible texts carry no em dash and no spaced en dash', () => {
    const visible = [
      ...configRows().flatMap((r) => [r.attrs.Name ?? '', r.attrs.Description ?? '']),
      tag('Overview') ?? '',
      tag('Description') ?? '',
    ].join('\n');
    expect(visible).not.toMatch(/—| – /);
  });

  it('Container and Config tags are balanced', () => {
    expect((xml.match(/<Container\b/g) ?? []).length).toBe(1);
    expect((xml.match(/<\/Container>/g) ?? []).length).toBe(1);
    const open = (xml.match(/<Config\b/g) ?? []).length;
    const selfClosed = (xml.match(/<Config\b[^>]*\/>/g) ?? []).length;
    const closed = (xml.match(/<\/Config>/g) ?? []).length;
    expect(selfClosed + closed).toBe(open);
  });
});

describe('header matches the live template, not the 2.13 staging copy', () => {
  it('Repository is the :latest image', () => {
    expect(tag('Repository')).toBe('ghcr.io/masterjb/x265-butler:latest');
  });

  it('Project points at the x265-butler repo', () => {
    expect(tag('Project')).toBe('https://github.com/masterjb/x265-butler');
  });

  it('TemplateURL and Icon point at unraid-templates/main/x265-butler/', () => {
    const base = 'https://raw.githubusercontent.com/masterjb/unraid-templates/main/x265-butler/';
    expect(tag('TemplateURL')).toBe(`${base}x265-butler.xml`);
    expect(tag('Icon')).toBe(`${base}icon.png`);
  });

  it('Changes points at the CHANGELOG in the x265-butler repo', () => {
    expect(tag('Changes')).toBe('https://github.com/masterjb/x265-butler/blob/main/CHANGELOG.md');
  });

  // The Overview deliberately shows a pin EXAMPLE ("e.g. ...:2.16.0"); what must
  // not come back is the stale 2.13 staging header.
  it('no 2.13 staging leftovers (":2.13.0" pin, RELEASE-NOTES.md)', () => {
    expect(xml).not.toMatch(/x265-butler:2\.13\.0/);
    expect(xml).not.toMatch(/RELEASE-NOTES\.md/);
  });
});
