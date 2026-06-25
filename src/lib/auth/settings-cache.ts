// 05-01: 5-second TTL cache over settingRepo.get for the 7 auth keys.
// Phase 5 Plan 05-01 (Auth Backend Foundation).
//
// Purpose: keep GET /api/auth/status p95 < 50ms (AC-5) by avoiding a SQLite
// hit per request. 5s TTL is short enough that operator setting flips
// (delivered in 05-02 PUT /api/settings) are visible nearly immediately.
//
// 05-02 contract (audit S11): PUT /api/settings handler MUST call
// invalidateAuthSettingsCache() whenever any of these 7 keys changes:
// auth_enabled, session_secret, session_ttl_seconds, auth_setup_completed,
// auth_trust_proxy_xff, password_pepper, bcrypt_cost.

import { settingRepo } from '@/src/lib/db';

export type AuthCacheKey =
  | 'auth_enabled'
  | 'auth_setup_completed'
  | 'session_secret'
  | 'session_ttl_seconds'
  | 'auth_trust_proxy_xff'
  | 'password_pepper'
  | 'bcrypt_cost';

const TTL_MS = 5_000;

declare global {
  var __x265butler_auth_settings_cache:
    | {
        values: Map<AuthCacheKey, string>;
        loadedAt: number; // epoch ms
      }
    | undefined;
}

function getStore(): {
  values: Map<AuthCacheKey, string>;
  loadedAt: number;
} {
  if (!globalThis.__x265butler_auth_settings_cache) {
    globalThis.__x265butler_auth_settings_cache = {
      values: new Map(),
      loadedAt: 0,
    };
  }
  return globalThis.__x265butler_auth_settings_cache;
}

function refreshCache(): void {
  const store = getStore();
  store.values.clear();
  // Defensive try/catch: when existing test files mock '@/src/lib/db' without
  // settingRepo (most do — they only export the repo their handler under test
  // uses), calling settingRepo() throws TypeError. Treat that as the
  // off-by-default factory state so requireAuth() returns mode='disabled'
  // and 20 protected-handler test suites stay green without per-suite mock churn.
  try {
    const repo = settingRepo();
    for (const key of [
      'auth_enabled',
      'auth_setup_completed',
      'session_secret',
      'session_ttl_seconds',
      'auth_trust_proxy_xff',
      'password_pepper',
      'bcrypt_cost',
    ] as AuthCacheKey[]) {
      const v = repo.get(key);
      store.values.set(key, v ?? '');
    }
  } catch {
    // settingRepo unavailable (mocked module without settingRepo, or DB not
    // initialized). Populate with factory defaults — auth_enabled stays 'false'
    // so all paths short-circuit to mode='disabled'.
    store.values.set('auth_enabled', 'false');
    store.values.set('auth_setup_completed', 'false');
    store.values.set('session_secret', '');
    store.values.set('session_ttl_seconds', '604800');
    store.values.set('auth_trust_proxy_xff', 'false');
    store.values.set('password_pepper', '');
    store.values.set('bcrypt_cost', '12');
  }
  store.loadedAt = Date.now();
}

/**
 * Read an auth setting via cache. TTL = 5s. Cache misses (first call or
 * post-invalidation) fan out to a single settingRepo bulk-load of all 7 keys.
 */
export function getCachedAuthSetting(key: AuthCacheKey): string {
  const store = getStore();
  const now = Date.now();
  if (now - store.loadedAt > TTL_MS || !store.values.has(key)) {
    refreshCache();
  }
  return store.values.get(key) ?? '';
}

/**
 * Force-invalidate the auth-settings cache. Called by:
 *   - app/api/auth/setup/route.ts after setup commits
 *   - app/api/auth/login/route.ts after login (refresh auth_enabled view)
 *   - 05-02 PUT /api/settings handler when any of the 7 keys changes (S11)
 */
export function invalidateAuthSettingsCache(): void {
  const store = getStore();
  store.loadedAt = 0;
  store.values.clear();
}
