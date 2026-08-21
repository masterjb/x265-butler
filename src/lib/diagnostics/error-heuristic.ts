// Phase 21 Plan 21-03 — pure classifier for the runtime-error surface.
//
// `error.tsx` Client Component compares `window.__APP_VERSION__` (injected by
// `app/[locale]/layout.tsx` at SSR time) against `NEXT_PUBLIC_APP_VERSION`
// (baked into the client bundle at build/start). A mismatch indicates the
// browser is rendering a stale bundle against a newer server — most common
// after a container redeploy without a hard refresh.
//
// Pure: defensive on every field read; NEVER throws. Composable + trivially
// unit-tested.

export type ErrorKind = 'stale-cache' | 'unknown';

export interface VersionFingerprint {
  actual?: string | null;
  expected?: string | null;
}

export interface ErrorResult {
  kind: ErrorKind;
  digest?: string;
  versionFingerprint: VersionFingerprint | null;
}

export interface ClassifyErrorInput {
  error: { digest?: string } | undefined | null;
  versionFingerprint?: VersionFingerprint | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function classifyError(input: ClassifyErrorInput): ErrorResult {
  const digest =
    input.error && typeof input.error.digest === 'string' ? input.error.digest : undefined;
  const fp = input.versionFingerprint ?? null;

  if (
    fp &&
    isNonEmptyString(fp.actual) &&
    isNonEmptyString(fp.expected) &&
    fp.actual !== fp.expected
  ) {
    return { kind: 'stale-cache', digest, versionFingerprint: fp };
  }

  return { kind: 'unknown', digest, versionFingerprint: fp };
}
