/*
 * 28-03 (L6) AC-1: shared jsonResponse helper — header parity.
 *
 * Pins the behavior the 49 migrated routes depend on:
 *   - 2-arg case emits exactly Content-Type + Cache-Control + JSON body.
 *   - 3-arg Set-Cookie case (auth login/disable-and-delete) appends the cookie
 *     WITHOUT duplicating either base header (audit SR-3 append-vs-set pin).
 */

import { describe, it, expect } from 'vitest';
import { jsonResponse } from '@/src/lib/api/json-response';

describe('jsonResponse (L6 shared helper)', () => {
  it('test_two_arg_emits_base_headers_and_json_body', async () => {
    const res = jsonResponse({ ok: true, n: 1 }, 200);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toEqual({ ok: true, n: 1 });
  });

  it('test_two_arg_preserves_status', () => {
    expect(jsonResponse({ error_code: 'x' }, 401).status).toBe(401);
    expect(jsonResponse({}, 500).status).toBe(500);
  });

  it('test_three_arg_appends_set_cookie_without_duplicating_base_headers', () => {
    const cookie = 'x265b_session=abc; Path=/; HttpOnly';
    const res = jsonResponse({ username: 'admin' }, 200, { 'Set-Cookie': cookie });
    // exactly one base header each (set once, not doubled by the merge)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    // the cookie survived the append merge
    expect(res.headers.get('set-cookie')).toBe(cookie);
  });

  it('test_three_arg_with_undefined_extra_headers_equals_two_arg', () => {
    const res = jsonResponse({ a: 1 }, 200, undefined);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
