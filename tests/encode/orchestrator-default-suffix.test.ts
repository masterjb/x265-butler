// 16-05: pure-function tests for isDefaultOutputSuffix dual-sentinel
// detector. Decoupled from the orchestrator-loop harness because the helper
// is a stateless string predicate — no DB, no repos, no stage required.
//
// Covers AC-4 (dual-sentinel semantics + non-default rejections) and the
// negative case where the composed-default literal '-x265.mkv' is NOT
// itself a sentinel (only the bare label '-x265' and the legacy
// '.x265.mkv' are).

import { describe, it, expect } from 'vitest';
import { isDefaultOutputSuffix } from '@/src/lib/encode/orchestrator';

describe('orchestrator — isDefaultOutputSuffix dual-sentinel (16-05 AC-4)', () => {
  it('returns true for NEW default "-x265" (post-migration 0028)', () => {
    expect(isDefaultOutputSuffix('-x265')).toBe(true);
  });

  it('returns true for LEGACY default ".x265.mkv" (defensive safety-net)', () => {
    expect(isDefaultOutputSuffix('.x265.mkv')).toBe(true);
  });

  it('returns false for operator-customized label "_h265"', () => {
    expect(isDefaultOutputSuffix('_h265')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isDefaultOutputSuffix('')).toBe(false);
  });

  it('returns false for composed-default literal "-x265.mkv" (not a sentinel)', () => {
    // The composed default is what resolveOutputSuffix RETURNS for the
    // '-x265' sentinel; it is NOT itself a sentinel that should trigger
    // the auto-derive path. Operator setting their value to '-x265.mkv'
    // verbatim is operator-customized intent (already-suffixed) and must
    // pass through unchanged.
    expect(isDefaultOutputSuffix('-x265.mkv')).toBe(false);
  });

  it('returns false for operator-customized terminal ".x265.mp4"', () => {
    // Legacy operators with mp4-explicit customization should be treated as
    // customized, not default — the LEGACY sentinel is ONLY '.x265.mkv'.
    expect(isDefaultOutputSuffix('.x265.mp4')).toBe(false);
  });
});
