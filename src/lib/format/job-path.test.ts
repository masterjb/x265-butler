import { describe, it, expect } from 'vitest';
import { fileNameOf, parentOf, ROOT_PARENT_LABEL } from '@/src/lib/format/job-path';

describe('fileNameOf', () => {
  it('returns basename for nested path', () => {
    expect(fileNameOf('/movies/foo/bar.mkv')).toBe('bar.mkv');
  });
  it('returns full string when no separator present', () => {
    expect(fileNameOf('bar.mkv')).toBe('bar.mkv');
  });
  it('returns empty string for empty input', () => {
    expect(fileNameOf('')).toBe('');
  });
  it('strips trailing slashes before extracting basename', () => {
    expect(fileNameOf('/movies/foo/')).toBe('foo');
  });
});

describe('parentOf', () => {
  it('returns parent dir for nested path', () => {
    expect(parentOf('/movies/foo/bar.mkv')).toBe('/movies/foo');
  });
  it('returns root label for top-level path', () => {
    expect(parentOf('/bar.mkv')).toBe(ROOT_PARENT_LABEL);
  });
  it('returns root label for bare filename without separator', () => {
    expect(parentOf('bar.mkv')).toBe(ROOT_PARENT_LABEL);
  });
  it('returns root label for empty input', () => {
    expect(parentOf('')).toBe(ROOT_PARENT_LABEL);
  });
  it('strips trailing slashes before computing parent', () => {
    expect(parentOf('/movies/foo/')).toBe('/movies');
  });
});
