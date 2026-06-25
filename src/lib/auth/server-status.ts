// 05-02 T1: server-side helper for layout (Server Component) to compute
// initialAuthStatus that GET /api/auth/status would return.
//
// audit M2: layout calls this once per request and passes the result into
// <AuthStatusProvider initialStatus={...}> wrapping the App-Shell. Eliminates
// mount-time /api/auth/status roundtrip + zero CLS.

import { headers } from 'next/headers';
import { getCachedAuthSetting, invalidateAuthSettingsCache } from '@/src/lib/auth/settings-cache';
import { parseSessionCookie, verifySession } from '@/src/lib/auth/session';
import { ensureServerInit } from '@/src/lib/server-init';

export interface ServerAuthStatus {
  authEnabled: boolean;
  setupCompleted: boolean;
  authenticated: boolean;
  username: string | null;
}

/**
 * Compute the same shape as GET /api/auth/status response, but server-side
 * via next/headers (no roundtrip). Safe to call from Server Components.
 *
 * Mirrors the logic of /api/auth/status route handler.
 */
export async function getServerAuthStatus(): Promise<ServerAuthStatus> {
  ensureServerInit();
  const authEnabled = getCachedAuthSetting('auth_enabled') === 'true';
  const setupCompleted = getCachedAuthSetting('auth_setup_completed') === 'true';

  if (!authEnabled) {
    return {
      authEnabled: false,
      setupCompleted,
      authenticated: false,
      username: null,
    };
  }

  let cookieHeader: string | null = null;
  try {
    const h = await headers();
    cookieHeader = h.get('cookie');
  } catch {
    cookieHeader = null;
  }
  const cookieToken = parseSessionCookie(cookieHeader);
  if (!cookieToken) {
    return {
      authEnabled: true,
      setupCompleted,
      authenticated: false,
      username: null,
    };
  }
  const secret = getCachedAuthSetting('session_secret');
  if (!secret) {
    return {
      authEnabled: true,
      setupCompleted,
      authenticated: false,
      username: null,
    };
  }
  const result = verifySession(cookieToken, secret);
  if (!result.payload) {
    return {
      authEnabled: true,
      setupCompleted,
      authenticated: false,
      username: null,
    };
  }
  return {
    authEnabled: true,
    setupCompleted,
    authenticated: true,
    username: result.payload.username,
  };
}

/**
 * 05-02 contract: PUT /api/settings handler calls this when an auth-key changes
 * to ensure the next Server Component render reads fresh state.
 *
 * Re-export for ergonomic single-import on the server side.
 */
export { invalidateAuthSettingsCache };
