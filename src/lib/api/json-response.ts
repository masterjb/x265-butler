// 28-03 (L6): single source of truth for the JSON Route Handler response shape.
//
// Replaces the 49× byte-duplicated local `function jsonResponse` across
// app/api/**/route.ts. Two prior shapes existed: the common 2-arg
// `(body, status)` and a 3-arg `(body, status, extraHeaders?)` Set-Cookie
// variant in auth/{login,setup,disable-and-delete}. This helper absorbs both —
// the extraHeaders merge uses `.append` (auth-route semantics), so multiple
// cookies remain valid and the two base keys are set exactly once.
export function jsonResponse(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((v, k) => headers.append(k, v));
  }
  return new Response(JSON.stringify(body), { status, headers });
}
