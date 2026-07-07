// Phase 21 Plan 21-03 T1 — unit tests for classifyError (stale-cache vs unknown).
// AC-13: ≥6 cases covering each path + edge cases.

import { describe, it, expect } from 'vitest';
import { classifyError } from '@/src/lib/diagnostics/error-heuristic';

describe('classifyError', () => {
  it('actual !== expected (both non-empty) → stale-cache', () => {
    const r = classifyError({
      error: { digest: 'abc' },
      versionFingerprint: { actual: '2.17.4', expected: '2.17.5' },
    });
    expect(r.kind).toBe('stale-cache');
    expect(r.digest).toBe('abc');
    expect(r.versionFingerprint?.actual).toBe('2.17.4');
  });

  it('actual === expected → unknown', () => {
    const r = classifyError({
      error: { digest: 'abc' },
      versionFingerprint: { actual: '2.17.5', expected: '2.17.5' },
    });
    expect(r.kind).toBe('unknown');
  });

  it('both fingerprint fields empty → unknown', () => {
    const r = classifyError({
      error: { digest: 'd' },
      versionFingerprint: { actual: '', expected: '' },
    });
    expect(r.kind).toBe('unknown');
  });

  it('actual missing → unknown (cannot prove staleness)', () => {
    const r = classifyError({
      error: { digest: 'd' },
      versionFingerprint: { expected: '2.17.5' },
    });
    expect(r.kind).toBe('unknown');
  });

  it('expected missing → unknown (cannot prove staleness)', () => {
    const r = classifyError({
      error: { digest: 'd' },
      versionFingerprint: { actual: '2.17.5' },
    });
    expect(r.kind).toBe('unknown');
  });

  it('versionFingerprint null → unknown', () => {
    const r = classifyError({ error: { digest: 'd' }, versionFingerprint: null });
    expect(r.kind).toBe('unknown');
    expect(r.versionFingerprint).toBeNull();
  });

  it('error undefined → unknown with undefined digest, no throw', () => {
    const r = classifyError({ error: undefined, versionFingerprint: null });
    expect(r.kind).toBe('unknown');
    expect(r.digest).toBeUndefined();
  });

  it('error.digest missing → digest=undefined', () => {
    const r = classifyError({
      error: {},
      versionFingerprint: { actual: '2.17.4', expected: '2.17.5' },
    });
    expect(r.kind).toBe('stale-cache');
    expect(r.digest).toBeUndefined();
  });
});
