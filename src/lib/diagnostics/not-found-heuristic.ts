// Phase 21 Plan 21-03 — pure classifier for the 404 surface.
//
// Inputs are pathname (from middleware x-pathname header injection),
// locale-resolved (next-intl getLocale), and a snapshot of onboarding-state
// (settingRepo().get('onboarding_completed')). Returns a discriminated kind
// + suggestedHref + nearest-route candidates.
//
// Pure: no DOM, no DB, no fetch, no `next/headers`. Composable + trivially
// unit-tested. Server Component owns the I/O.

import {
  DEFAULT_LOCALE,
  KNOWN_LOCALES,
  KNOWN_ROUTES,
  PRIORITY_FALLBACK_ROUTES,
  levenshtein1,
  type KnownRoute,
} from '@/src/lib/routes/known-routes';

export type NotFoundKind = 'route-unknown' | 'locale-unknown' | 'locale-missing' | 'fallback';

export interface NotFoundResult {
  kind: NotFoundKind;
  locale: string;
  pathname: string;
  // The route segment that failed to resolve (if any). Empty string when no
  // route segment was present (e.g. naked `/fr`).
  route: string;
  // Best-effort recovery target — always defined; consumers can ignore for
  // 'fallback' but treating it as always-present simplifies the renderer.
  suggestedHref: string;
  // Nearest-match route candidates (max 3) when kind === 'route-unknown'.
  // PRIORITY_FALLBACK_ROUTES is used when no Levenshtein-1 match exists.
  candidates: readonly KnownRoute[];
  onboardingIncomplete: boolean;
}

export interface ClassifyNotFoundInput {
  pathname: string;
  // Pre-resolved by the Server Component (next-intl getLocale()).
  resolvedLocale: string;
  // Optional onboarding-state snapshot. Undefined when DB read failed; the
  // helper silently downgrades to onboardingIncomplete=false in that case.
  settings?: { onboardingCompleted: boolean } | undefined;
}

function stripFragmentAndQuery(input: string): string {
  let p = input;
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h !== -1) p = p.slice(0, h);
  return p;
}

function splitSegments(pathname: string): string[] {
  const clean = stripFragmentAndQuery(pathname);
  const trimmed = clean.startsWith('/') ? clean.slice(1) : clean;
  return trimmed.split('/').filter((s) => s.length > 0);
}

// Locale check is CASE-SENSITIVE. next-intl's routing accepts 'en' but not
// 'EN' — we must mirror that to surface mis-cased URLs as locale-unknown.
function isKnownLocale(value: string): value is (typeof KNOWN_LOCALES)[number] {
  return (KNOWN_LOCALES as readonly string[]).includes(value);
}

function isKnownRoute(value: string): value is KnownRoute {
  if (!value) return false;
  return (KNOWN_ROUTES as readonly string[]).includes(value.toLowerCase());
}

function suggestCandidates(route: string): readonly KnownRoute[] {
  if (!route) return PRIORITY_FALLBACK_ROUTES.slice(0, 3);
  const lower = route.toLowerCase();
  const fuzzy = KNOWN_ROUTES.filter((r) => levenshtein1(r, lower));
  if (fuzzy.length > 0) return fuzzy.slice(0, 3);
  return PRIORITY_FALLBACK_ROUTES.slice(0, 3);
}

export function classifyNotFound(input: ClassifyNotFoundInput): NotFoundResult {
  const onboardingIncomplete = input.settings ? !input.settings.onboardingCompleted : false;
  const pathname = stripFragmentAndQuery(input.pathname);
  const segments = splitSegments(pathname);

  // Empty or root path — middleware should have redirected to /{defaultLocale}.
  // Defensive landing-pad: suggest defaultLocale root.
  if (segments.length === 0) {
    return {
      kind: 'locale-missing',
      locale: input.resolvedLocale,
      pathname,
      route: '',
      suggestedHref: `/${DEFAULT_LOCALE}`,
      candidates: [],
      onboardingIncomplete,
    };
  }

  const first = segments[0]!;
  const second = segments[1] ?? '';

  // Single segment: ambiguous between locale-missing (naked route) and
  // locale-unknown (typo'd locale). Resolve via known-route lookup:
  //   - segment is a KNOWN_ROUTE → locale-missing
  //   - segment is a KNOWN_LOCALE → fallback (locale OK, no route)
  //   - else → locale-unknown (best-effort default-locale recovery)
  if (segments.length === 1) {
    if (isKnownRoute(first)) {
      return {
        kind: 'locale-missing',
        locale: input.resolvedLocale,
        pathname,
        route: first.toLowerCase(),
        suggestedHref: `/${DEFAULT_LOCALE}/${first.toLowerCase()}`,
        candidates: [],
        onboardingIncomplete,
      };
    }
    if (isKnownLocale(first)) {
      return {
        kind: 'fallback',
        locale: first,
        pathname,
        route: '',
        suggestedHref: `/${first}/library`,
        candidates: [],
        onboardingIncomplete,
      };
    }
    return {
      kind: 'locale-unknown',
      locale: input.resolvedLocale,
      pathname,
      route: '',
      suggestedHref: `/${DEFAULT_LOCALE}`,
      candidates: [],
      onboardingIncomplete,
    };
  }

  // Two or more segments: first segment must be a valid locale.
  if (!isKnownLocale(first)) {
    const recoveryRoute = isKnownRoute(second) ? second.toLowerCase() : '';
    return {
      kind: 'locale-unknown',
      locale: input.resolvedLocale,
      pathname,
      route: second.toLowerCase(),
      suggestedHref: recoveryRoute ? `/${DEFAULT_LOCALE}/${recoveryRoute}` : `/${DEFAULT_LOCALE}`,
      candidates: [],
      onboardingIncomplete,
    };
  }

  // Locale is valid; second segment is the route.
  if (!isKnownRoute(second)) {
    const candidates = suggestCandidates(second);
    const primary = candidates[0] ?? PRIORITY_FALLBACK_ROUTES[0];
    return {
      kind: 'route-unknown',
      locale: first,
      pathname,
      route: second.toLowerCase(),
      suggestedHref: `/${first}/${primary}`,
      candidates,
      onboardingIncomplete,
    };
  }

  // Both locale + route are valid; we landed on not-found via a sub-route
  // that the App Router could not resolve.
  return {
    kind: 'fallback',
    locale: first,
    pathname,
    route: second.toLowerCase(),
    suggestedHref: `/${first}/${second.toLowerCase()}`,
    candidates: [],
    onboardingIncomplete,
  };
}
