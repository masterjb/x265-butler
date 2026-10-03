// 22-01 IMP-4 audit-SR1: share-token leakage prevention.
//
// Substitutes /share/<token>/ → /share/[token]/ before web-vital posts so the
// ring-buffer never persists a verbatim 32+-char share token (URL-as-secret).
// Extend SHARE_TOKEN_RE when adding new dynamic-token routes.

const SHARE_TOKEN_RE = /\/share\/[^/]{16,}/g;

export function normalizeRoute(pathname: string): string {
  return pathname.replace(SHARE_TOKEN_RE, '/share/[token]');
}
