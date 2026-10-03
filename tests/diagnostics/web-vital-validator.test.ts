// @vitest-environment node
// 22-01 T4 audit-SR5: web-vital payload validator tests.

import { describe, it, expect } from 'vitest';
import { validateWebVitalPayload } from '@/src/lib/diagnostics/web-vital-validator';

describe('22-01 T4: validateWebVitalPayload', () => {
  it('happy path → { ok: true }', () => {
    const result = validateWebVitalPayload({
      metric: 'ttfb',
      value: 250,
      route: '/library',
      atIso: '2026-05-24T10:00:00.000Z',
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects non-object body', () => {
    expect(validateWebVitalPayload(null).ok).toBe(false);
    expect(validateWebVitalPayload('string').ok).toBe(false);
    expect(validateWebVitalPayload([]).ok).toBe(false);
    expect(validateWebVitalPayload(42).ok).toBe(false);
  });

  it('rejects unknown metric', () => {
    const r = validateWebVitalPayload({
      metric: 'cls',
      value: 0.1,
      route: '/x',
      atIso: '2026-01-01',
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('metric_invalid');
  });

  it('rejects negative value', () => {
    const r = validateWebVitalPayload({ metric: 'ttfb', value: -1, route: '/x', atIso: 'x' });
    expect(r.ok === false && r.reason).toBe('value_invalid');
  });

  it('rejects NaN/Infinity value', () => {
    const r1 = validateWebVitalPayload({ metric: 'lcp', value: NaN, route: '/x', atIso: 'x' });
    expect(r1.ok === false && r1.reason).toBe('value_invalid');
    const r2 = validateWebVitalPayload({
      metric: 'lcp',
      value: Infinity,
      route: '/x',
      atIso: 'x',
    });
    expect(r2.ok === false && r2.reason).toBe('value_invalid');
  });

  it('rejects route over 256 chars', () => {
    const long = '/' + 'a'.repeat(300);
    const r = validateWebVitalPayload({ metric: 'inp', value: 50, route: long, atIso: 'x' });
    expect(r.ok === false && r.reason).toBe('route_invalid');
  });

  it('rejects atIso over 64 chars', () => {
    const r = validateWebVitalPayload({
      metric: 'ttfb',
      value: 100,
      route: '/x',
      atIso: 'x'.repeat(80),
    });
    expect(r.ok === false && r.reason).toBe('atIso_invalid');
  });
});
