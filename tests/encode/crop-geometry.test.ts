import { describe, it, expect } from 'vitest';
import { parseCropGeometry } from '@/src/lib/encode/crop-geometry';

describe('parseCropGeometry', () => {
  it('accepts a valid even geometry', () => {
    expect(parseCropGeometry('1920:800:0:140')).toBe('1920:800:0:140');
  });

  it('strips a leading crop= prefix', () => {
    expect(parseCropGeometry('crop=1920:800:0:140')).toBe('1920:800:0:140');
  });

  it('trims surrounding whitespace', () => {
    expect(parseCropGeometry('  1920:800:0:140  ')).toBe('1920:800:0:140');
  });

  it.each([
    ['abc'],
    ['1920x800'],
    ['1920:800:0'], // too few fields
    ['1920:800:0:0:0'], // too many fields
    ['-1:0:0:0'],
    ['0:0:0:0'],
    ['1920:0:0:0'],
    [''],
    ['   '],
  ])('rejects malformed %s', (raw) => {
    expect(parseCropGeometry(raw)).toBeNull();
  });

  it.each([
    ['1921:800:0:0'], // odd W
    ['1920:801:0:0'], // odd H
    ['1920:800:1:0'], // odd X
    ['1920:800:0:1'], // odd Y
  ])('rejects odd-dimension %s (audit SR-2)', (raw) => {
    expect(parseCropGeometry(raw)).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(parseCropGeometry(null)).toBeNull();
    expect(parseCropGeometry(undefined)).toBeNull();
  });

  // Re-export back-compat: importing from cropdetect must return the same function.
  it('is re-exported from cropdetect for back-compat', async () => {
    const { parseCropGeometry: viaCropdetect } = await import('@/src/lib/encode/cropdetect');
    expect(viaCropdetect).toBe(parseCropGeometry);
  });
});
