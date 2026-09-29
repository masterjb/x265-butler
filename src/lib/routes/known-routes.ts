// Phase 21 Plan 21-03 — single-source-of-truth for routes + locales used by
// the not-found heuristic. KNOWN_LOCALES + DEFAULT_LOCALE are re-exported from
// next-intl's `routing` so the heuristic and the middleware can never drift
// (audit-M3).

import { routing } from '@/i18n/routing';

export const KNOWN_LOCALES = routing.locales;
export const DEFAULT_LOCALE = routing.defaultLocale;

export const KNOWN_ROUTES = [
  'library',
  'queue',
  'dashboard',
  'settings',
  'stats',
  'blocklist',
  'trash',
  'storage',
  'logs',
  'bench',
  'scan',
  'login',
  'onboarding',
  'diagnostics',
] as const;

export type KnownRoute = (typeof KNOWN_ROUTES)[number];

export const PRIORITY_FALLBACK_ROUTES = ['library', 'queue', 'settings', 'diagnostics'] as const;

// Single-character distance: insert / delete / swap. Pure, no deps.
// Returns true if `a` can be transformed into `b` with exactly one edit
// (or zero — identical strings are within distance 1).
export function levenshtein1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i += 1) {
      if (a[i] !== b[i]) {
        diff += 1;
        if (diff > 1) return false;
      }
    }
    return diff === 1;
  }

  const [shorter, longer] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
    } else {
      if (skipped) return false;
      skipped = true;
      j += 1;
    }
  }
  return true;
}
