// Phase 21 Plan 21-03 T1 — unit tests for classifyNotFound + levenshtein1.
// AC-13: ≥12 cases covering every kind + edge cases.

import { describe, it, expect } from 'vitest';
import { classifyNotFound } from '@/src/lib/diagnostics/not-found-heuristic';
import { levenshtein1 } from '@/src/lib/routes/known-routes';

function call(pathname: string, opts: Partial<Parameters<typeof classifyNotFound>[0]> = {}) {
  return classifyNotFound({
    pathname,
    resolvedLocale: opts.resolvedLocale ?? 'en',
    settings: opts.settings,
  });
}

describe('classifyNotFound — locale resolution', () => {
  it('valid locale + unknown route → route-unknown', () => {
    const r = call('/en/foo');
    expect(r.kind).toBe('route-unknown');
    expect(r.locale).toBe('en');
    expect(r.route).toBe('foo');
    expect(r.candidates.length).toBeGreaterThan(0);
  });

  it('valid locale + known route → fallback', () => {
    const r = call('/en/library');
    expect(r.kind).toBe('fallback');
    expect(r.suggestedHref).toBe('/en/library');
  });

  it('unknown locale → locale-unknown with default-locale suggestion', () => {
    const r = call('/fr/library');
    expect(r.kind).toBe('locale-unknown');
    expect(r.suggestedHref).toBe('/en/library');
  });

  it('unknown locale + naked path → locale-unknown without route', () => {
    const r = call('/fr');
    expect(r.kind).toBe('locale-unknown');
    expect(r.suggestedHref).toBe('/en');
  });

  it('missing locale (naked /library) → locale-missing', () => {
    const r = call('/library');
    expect(r.kind).toBe('locale-missing');
    expect(r.suggestedHref).toBe('/en/library');
  });

  it('empty pathname → locale-missing with /en suggestion', () => {
    const r = call('');
    expect(r.kind).toBe('locale-missing');
    expect(r.suggestedHref).toBe('/en');
  });

  it('root pathname / → locale-missing with /en suggestion', () => {
    const r = call('/');
    expect(r.kind).toBe('locale-missing');
    expect(r.suggestedHref).toBe('/en');
  });

  it('uppercase locale segment → locale-unknown (case-sensitive locales)', () => {
    const r = call('/EN/library');
    expect(r.kind).toBe('locale-unknown');
    expect(r.suggestedHref).toBe('/en/library');
  });

  it('nested path under unknown route → route-unknown on parent segment', () => {
    const r = call('/en/foo/bar/baz');
    expect(r.kind).toBe('route-unknown');
    expect(r.route).toBe('foo');
  });

  it('strips query + fragment before parsing', () => {
    const r = call('/en/foo?bar=1#frag');
    expect(r.kind).toBe('route-unknown');
    expect(r.pathname).toBe('/en/foo');
  });
});

describe('classifyNotFound — onboarding-state', () => {
  it('settings undefined → onboardingIncomplete=false (silent fallback)', () => {
    const r = call('/en/library');
    expect(r.onboardingIncomplete).toBe(false);
  });

  it('settings.onboardingCompleted=false → onboardingIncomplete=true', () => {
    const r = call('/en/library', { settings: { onboardingCompleted: false } });
    expect(r.onboardingIncomplete).toBe(true);
  });

  it('settings.onboardingCompleted=true → onboardingIncomplete=false', () => {
    const r = call('/en/library', { settings: { onboardingCompleted: true } });
    expect(r.onboardingIncomplete).toBe(false);
  });
});

describe('classifyNotFound — route-unknown candidate suggestions', () => {
  it('Levenshtein-1 match returned when possible (libary → library)', () => {
    const r = call('/en/libary');
    expect(r.kind).toBe('route-unknown');
    expect(r.candidates).toContain('library');
  });

  it('no Levenshtein-1 match falls back to PRIORITY_FALLBACK_ROUTES', () => {
    const r = call('/en/zzzzzzz');
    expect(r.kind).toBe('route-unknown');
    expect(r.candidates.length).toBe(3);
    expect(r.candidates[0]).toBe('library');
  });

  it('suggestedHref points at first candidate', () => {
    const r = call('/en/libary');
    expect(r.suggestedHref).toBe('/en/library');
  });
});

describe('levenshtein1', () => {
  it('identical strings → true', () => {
    expect(levenshtein1('library', 'library')).toBe(true);
  });

  it('single-char swap → true', () => {
    expect(levenshtein1('libary', 'library')).toBe(true);
  });

  it('single-char insert → true', () => {
    expect(levenshtein1('librry', 'library')).toBe(true);
  });

  it('single-char substitute → true', () => {
    expect(levenshtein1('libracy', 'library')).toBe(true);
  });

  it('two-char diff → false', () => {
    expect(levenshtein1('libaaay', 'library')).toBe(false);
  });

  it('length diff >1 → false', () => {
    expect(levenshtein1('libr', 'library')).toBe(false);
  });
});
