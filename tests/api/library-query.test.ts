import { describe, it, expect } from 'vitest';
import { parseLibraryQuery, toListOptions } from '@/src/lib/api/library-query';

// 07-01: deep-link single-file filter (`?file=N`) — operator clicks a Recent
// Activity row on the Dashboard and lands on a 1-row Library view filtered to
// that exact file_id. Per-field `.catch(undefined)` is REQUIRED so malformed
// input on `file` does NOT cascade into the outer schema-fallback that drops
// EVERY other operator-supplied param (page/sort/dir/q/status/includeVanished).

describe('libraryQuerySchema · 07-01 file deep-link filter', () => {
  it('parses ?file=17 to integer 17 round-trip via toListOptions', () => {
    const parsed = parseLibraryQuery({ file: '17' });
    expect(parsed.file).toBe(17);
    const opts = toListOptions(parsed);
    expect(opts.idFilter).toBe(17);
  });

  // M1 combined-params round-trip. Covers both `?file=abc` (non-numeric) AND
  // `?file=-1` (negative, rejected by `.min(1)`). Pre-fix this assertion would
  // FAIL because the outer-cascade fallback in app/[locale]/library/page.tsx
  // drops EVERY operator-supplied param to defaults when ANY field rejects.
  // Per-field `.catch(undefined)` localizes the failure to `file` alone.
  it('silently drops ?file=abc / ?file=-1 via per-field .catch(undefined) WHILE preserving sibling params', () => {
    for (const malformed of ['abc', '-1']) {
      const parsed = parseLibraryQuery({
        file: malformed,
        page: '2',
        size: '50',
        sort: 'size',
        dir: 'desc',
        q: 'movie',
        status: 'done-smaller',
        includeVanished: '1',
      });
      expect(parsed.file).toBeUndefined();
      expect(parsed.page).toBe(2);
      expect(parsed.size).toBe(50);
      expect(parsed.sort).toBe('size');
      expect(parsed.dir).toBe('desc');
      expect(parsed.q).toBe('movie');
      expect(parsed.status).toBe('done-smaller');
      expect(parsed.includeVanished).toBe(true);
      const opts = toListOptions(parsed);
      expect(opts.idFilter).toBeUndefined();
      expect(opts.page).toBe(2);
      expect(opts.sort).toBe('size');
      expect(opts.dir).toBe('desc');
      expect(opts.q).toBe('movie');
      expect(opts.status).toBe('done-smaller');
      expect(opts.includeVanished).toBe(true);
    }
  });
});

// 14-03: share-axis filter. Per-field `.catch(undefined)` mirrors `file:` —
// malformed input localizes to `share` alone and never cascade-drops siblings.
describe('libraryQuerySchema · 14-03 share-axis filter', () => {
  it('parses ?share=1 to integer 1 round-trip via toListOptions', () => {
    const parsed = parseLibraryQuery({ share: '1' });
    expect(parsed.share).toBe(1);
    expect(toListOptions(parsed).shareId).toBe(1);
  });

  it("parses ?share=all to 'all' but toListOptions maps to undefined (no filter)", () => {
    const parsed = parseLibraryQuery({ share: 'all' });
    expect(parsed.share).toBe('all');
    expect(toListOptions(parsed).shareId).toBeUndefined();
  });

  it("parses ?share=orphan and toListOptions preserves the 'orphan' literal", () => {
    const parsed = parseLibraryQuery({ share: 'orphan' });
    expect(parsed.share).toBe('orphan');
    expect(toListOptions(parsed).shareId).toBe('orphan');
  });

  it('drops malformed ?share=abc / ?share=-3 / ?share=0 via per-field .catch(undefined)', () => {
    for (const malformed of ['abc', '-3', '0']) {
      const parsed = parseLibraryQuery({ share: malformed });
      expect(parsed.share).toBeUndefined();
      expect(toListOptions(parsed).shareId).toBeUndefined();
    }
  });

  it('omitted ?share parses to undefined / no shareId filter', () => {
    const parsed = parseLibraryQuery({});
    expect(parsed.share).toBeUndefined();
    expect(toListOptions(parsed).shareId).toBeUndefined();
  });

  it('cohabits with ?file=N — both parsed, neither cascades on malformed sibling', () => {
    const parsed = parseLibraryQuery({ file: '42', share: '7', q: 'foo', page: '3' });
    expect(parsed.file).toBe(42);
    expect(parsed.share).toBe(7);
    expect(parsed.q).toBe('foo');
    expect(parsed.page).toBe(3);
    // malformed share + valid file → only share drops
    const mixed = parseLibraryQuery({ file: '42', share: 'abc', q: 'foo' });
    expect(mixed.file).toBe(42);
    expect(mixed.share).toBeUndefined();
    expect(mixed.q).toBe('foo');
  });
});
