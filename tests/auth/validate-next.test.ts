// 05-02 T1: validateNext open-redirect hardening tests.
// Phase 5 Plan 05-02 — audit M1 + AC-2.

import { describe, it, expect } from 'vitest';
import { validateNext } from '@/components/auth/auth-fetcher';

describe('validateNext — open-redirect defense (audit M1)', () => {
  describe('rejects attack vectors', () => {
    it('rejects scheme-relative // open-redirect', () => {
      expect(validateNext('//evil.com')).toBeNull();
      expect(validateNext('//evil.com/library')).toBeNull();
    });

    it('rejects backslash-prefix variant /\\\\', () => {
      expect(validateNext('/\\evil.com')).toBeNull();
      expect(validateNext('/\\\\evil.com')).toBeNull();
    });

    it('rejects javascript: URL injection', () => {
      expect(validateNext('javascript:alert(1)')).toBeNull();
    });

    it('rejects http(s)://-prefixed URL', () => {
      expect(validateNext('https://evil.com')).toBeNull();
      expect(validateNext('http://evil.com')).toBeNull();
    });

    it('rejects path traversal with ..', () => {
      expect(validateNext('/library/../etc/passwd')).toBeNull();
      expect(validateNext('/..')).toBeNull();
    });

    it('rejects whitespace-prefix and control characters', () => {
      expect(validateNext(' /library')).toBeNull();
      expect(validateNext('\t/library')).toBeNull();
      expect(validateNext('/library\x00')).toBeNull();
    });

    it('rejects empty string', () => {
      expect(validateNext('')).toBeNull();
    });

    it('rejects strings exceeding 256 chars', () => {
      const tooLong = '/library/' + 'a'.repeat(260);
      expect(validateNext(tooLong)).toBeNull();
    });

    it('rejects paths NOT starting with /', () => {
      expect(validateNext('library')).toBeNull();
      expect(validateNext('dashboard')).toBeNull();
    });

    it('rejects backslash anywhere in path', () => {
      expect(validateNext('/library\\..')).toBeNull();
    });

    it('rejects colon (URL protocol injection)', () => {
      expect(validateNext('/lib:rary')).toBeNull();
    });

    it('rejects non-string inputs', () => {
      expect(validateNext(undefined)).toBeNull();
      expect(validateNext(null)).toBeNull();
      expect(validateNext(['/library'])).toBeNull();
    });
  });

  describe('accepts whitelisted paths', () => {
    it('accepts /library', () => {
      expect(validateNext('/library')).toBe('/library');
    });

    it('accepts /dashboard', () => {
      expect(validateNext('/dashboard')).toBe('/dashboard');
    });

    it('accepts /queue, /trash, /blocklist, /logs, /settings', () => {
      expect(validateNext('/queue')).toBe('/queue');
      expect(validateNext('/trash')).toBe('/trash');
      expect(validateNext('/blocklist')).toBe('/blocklist');
      expect(validateNext('/logs')).toBe('/logs');
      expect(validateNext('/settings')).toBe('/settings');
    });

    it('accepts /library/sub-path (prefix match)', () => {
      expect(validateNext('/library/123')).toBe('/library/123');
    });

    it('accepts locale-prefixed paths and preserves the prefix on return', () => {
      expect(validateNext('/en/library')).toBe('/en/library');
      expect(validateNext('/de/dashboard')).toBe('/de/dashboard');
    });
  });

  describe('rejects non-whitelisted paths', () => {
    it('rejects unknown top-level segments', () => {
      expect(validateNext('/admin')).toBeNull();
      expect(validateNext('/secret')).toBeNull();
      expect(validateNext('/api')).toBeNull();
    });

    it('rejects root /', () => {
      expect(validateNext('/')).toBeNull();
    });
  });
});
