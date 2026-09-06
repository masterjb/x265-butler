/*
 * 28-03 (L6) AC-2: shared gateAuth helper.
 *
 * gateAuth wraps requireAuth + authGuard. Pins:
 *   - a denied decision returns { denied: Response, auth: null }
 *   - a permitted decision returns { denied: null, auth: AuthDecision }
 *     (so downstream readers — settings actorUsername, withRenewCookie — keep
 *     access to the resolved decision).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AuthDecision } from '@/src/lib/auth/require-auth';

const { mockRequireAuth, mockAuthGuard } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockAuthGuard: vi.fn(),
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: mockRequireAuth,
  authGuard: mockAuthGuard,
}));

import { gateAuth } from '@/src/lib/api/auth-gate';

beforeEach(() => {
  mockRequireAuth.mockReset();
  mockAuthGuard.mockReset();
});

describe('gateAuth (L6 shared auth gate)', () => {
  it('test_denied_decision_returns_denied_response_and_null_auth', async () => {
    const decision: AuthDecision = {
      ok: false,
      status: 401,
      body: { error_code: 'auth_required' },
    };
    const deniedResponse = new Response('{}', { status: 401 });
    mockRequireAuth.mockResolvedValue(decision);
    mockAuthGuard.mockReturnValue(deniedResponse);

    const result = await gateAuth(new Request('http://test/api/x'));
    expect(result.denied).toBe(deniedResponse);
    expect(result.auth).toBeNull();
  });

  it('test_permitted_decision_exposes_resolved_auth', async () => {
    const decision: AuthDecision = {
      ok: true,
      mode: 'authenticated',
      username: 'admin',
    };
    mockRequireAuth.mockResolvedValue(decision);
    mockAuthGuard.mockReturnValue(null);

    const result = await gateAuth(new Request('http://test/api/x'));
    expect(result.denied).toBeNull();
    expect(result.auth).toBe(decision);
  });

  it('test_disabled_mode_is_permitted', async () => {
    const decision: AuthDecision = { ok: true, mode: 'disabled', username: null };
    mockRequireAuth.mockResolvedValue(decision);
    mockAuthGuard.mockReturnValue(null);

    const result = await gateAuth(new Request('http://test/api/x'));
    expect(result.denied).toBeNull();
    expect(result.auth).toEqual(decision);
  });
});
