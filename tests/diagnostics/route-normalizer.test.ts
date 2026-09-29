// @vitest-environment node
// 22-01 T4 audit-SR1: route-normalizer tests.
// Contract: substitute /share/<32+>/ → /share/[token] before posting web-vital
// payloads so ring-buffer never persists share-token leak.

import { describe, it, expect } from 'vitest';
import { normalizeRoute } from '@/src/lib/diagnostics/route-normalizer';

describe('22-01 T4: normalizeRoute', () => {
  it('pass-through plain route unchanged', () => {
    expect(normalizeRoute('/library')).toBe('/library');
    expect(normalizeRoute('/en/dashboard')).toBe('/en/dashboard');
  });

  it('substitutes share-token routes', () => {
    expect(normalizeRoute('/share/abcdefghijklmnopqrstuvwxyz012345/')).toBe('/share/[token]/');
    expect(normalizeRoute('/en/share/abc123def456ghi789jkl012mno345pqr')).toBe('/en/share/[token]');
  });

  it('handles multi-segment share-token paths', () => {
    expect(normalizeRoute('/share/abcdef1234567890ABCDEF/files/foo.mkv')).toBe(
      '/share/[token]/files/foo.mkv',
    );
  });

  it('leaves short share segments unchanged (token-length floor: 16)', () => {
    expect(normalizeRoute('/share/short')).toBe('/share/short');
    expect(normalizeRoute('/share/abc123')).toBe('/share/abc123');
  });
});
