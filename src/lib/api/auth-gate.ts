// 28-03 (L6): single source of truth for the requireAuth + authGuard gate idiom.
//
// Replaces the 50× duplicated 3-line idiom across app/api/**/route.ts:
//   const __auth = await requireAuth(request);
//   const __denied = authGuard(__auth);
//   if (__denied) return __denied;
//
// gateAuth returns the resolved AuthDecision on the permitted branch so callers
// that read it downstream (settings-PUT actorUsername, the 10 routes that pipe
// it into a trailing withRenewCookie) keep full access. It deliberately does
// NOT wrap withRenewCookie — that rolling-renewal call stays at each route's
// success path (out of L6 dedup scope).
import { authGuard, requireAuth, type AuthDecision } from '@/src/lib/auth/require-auth';

// The permitted branch is narrowed to the ok:true variant: authGuard returns a
// Response IFF decision.ok===false, so a null denied guarantees auth.ok===true.
// Returning the narrowed shape lets every downstream reader (auth.mode,
// auth.username, withRenewCookie, actorFromAuth) type-check WITHOUT a redundant
// `if (!auth.ok)` guard — exactly the narrowing the prior inline idioms provided.
export type AuthOk = Extract<AuthDecision, { ok: true }>;

export async function gateAuth(
  request: Request,
): Promise<{ denied: Response; auth: null } | { denied: null; auth: AuthOk }> {
  const auth = await requireAuth(request);
  const denied = authGuard(auth);
  if (denied) return { denied, auth: null };
  // denied === null ⟹ auth.ok === true (authGuard contract).
  return { denied: null, auth: auth as AuthOk };
}
