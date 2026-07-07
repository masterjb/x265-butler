// Phase 21 Plan 21-02 T3 Step 8 — i18n key-coverage for diagnostics surface.
// AC-13: every diagnostics.* key + nav.diagnostics is present in BOTH locales
// with identical structural shape.

import { describe, it, expect } from 'vitest';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

function collectKeys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [];
  const out: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof val === 'object' && val !== null) {
      out.push(...collectKeys(val, full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('diagnostics i18n key-coverage', () => {
  it('every diagnostics.* key in en.json exists in de.json (and vice-versa)', () => {
    const enDiag = collectKeys((en as Record<string, unknown>).diagnostics, 'diagnostics');
    const deDiag = collectKeys((de as Record<string, unknown>).diagnostics, 'diagnostics');
    expect(enDiag.sort()).toEqual(deDiag.sort());
  });

  it('nav.diagnostics exists in both locales', () => {
    expect((en as { nav: { diagnostics?: string } }).nav.diagnostics).toBeTruthy();
    expect((de as { nav: { diagnostics?: string } }).nav.diagnostics).toBeTruthy();
  });

  // Plan 21-04 — banner subtree existence + key-count lock against accidental drop.
  it('diagnostics.banner subtree is defined in both locales', () => {
    const enBanner = (en as { diagnostics: { banner?: unknown } }).diagnostics.banner;
    const deBanner = (de as { diagnostics: { banner?: unknown } }).diagnostics.banner;
    expect(enBanner).toBeDefined();
    expect(deBanner).toBeDefined();
  });

  it('diagnostics.banner has at least 10 leaf keys per locale', () => {
    const enBannerKeys = collectKeys(
      (en as { diagnostics: { banner: unknown } }).diagnostics.banner,
      'diagnostics.banner',
    );
    const deBannerKeys = collectKeys(
      (de as { diagnostics: { banner: unknown } }).diagnostics.banner,
      'diagnostics.banner',
    );
    expect(enBannerKeys.length).toBeGreaterThanOrEqual(10);
    expect(deBannerKeys.length).toBeGreaterThanOrEqual(10);
  });

  // Plan 21-05 — test-encode-evidence gate keys (AC-11).
  it('21-05: diagnostics.copyReport.gateHelper exists in both locales', () => {
    const enKey = (en as { diagnostics: { copyReport: { gateHelper?: string } } }).diagnostics
      .copyReport.gateHelper;
    const deKey = (de as { diagnostics: { copyReport: { gateHelper?: string } } }).diagnostics
      .copyReport.gateHelper;
    expect(enKey).toBeTruthy();
    expect(deKey).toBeTruthy();
  });

  it('21-05: diagnostics.copyReport.gateAriaDescription exists in both locales', () => {
    const enKey = (en as { diagnostics: { copyReport: { gateAriaDescription?: string } } })
      .diagnostics.copyReport.gateAriaDescription;
    const deKey = (de as { diagnostics: { copyReport: { gateAriaDescription?: string } } })
      .diagnostics.copyReport.gateAriaDescription;
    expect(enKey).toBeTruthy();
    expect(deKey).toBeTruthy();
  });

  it('21-05: diagnostics.feedback.bugGateHelper exists in both locales with Sie-form (DE)', () => {
    const enKey = (en as { diagnostics: { feedback: { bugGateHelper?: string } } }).diagnostics
      .feedback.bugGateHelper;
    const deKey = (de as { diagnostics: { feedback: { bugGateHelper?: string } } }).diagnostics
      .feedback.bugGateHelper;
    expect(enKey).toBeTruthy();
    expect(deKey).toBeTruthy();
    expect(deKey).toMatch(/Sie/);
  });
});
