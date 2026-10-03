// Phase 21 Plan 21-03 T5 — i18n key-coverage for the error-page surfaces.
// AC-11: notfound.* and error.* key-trees structurally equal between EN + DE.

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

describe('error-pages i18n key-coverage', () => {
  it('every notfound.* key in en.json exists in de.json (and vice versa)', () => {
    const enKeys = collectKeys((en as Record<string, unknown>).notfound, 'notfound');
    const deKeys = collectKeys((de as Record<string, unknown>).notfound, 'notfound');
    expect(enKeys.sort()).toEqual(deKeys.sort());
  });

  it('every error.* key in en.json exists in de.json (and vice versa)', () => {
    const enKeys = collectKeys((en as Record<string, unknown>).error, 'error');
    const deKeys = collectKeys((de as Record<string, unknown>).error, 'error');
    expect(enKeys.sort()).toEqual(deKeys.sort());
  });

  it('every heuristic branch declares title + body + primaryCta in both locales', () => {
    const notfoundBranches = [
      'routeUnknown',
      'localeUnknown',
      'localeMissing',
      'fallback',
    ] as const;
    for (const k of notfoundBranches) {
      for (const tree of [en, de] as Array<Record<string, unknown>>) {
        const branch = (tree.notfound as Record<string, Record<string, string>>)[k];
        expect(branch, `notfound.${k} missing`).toBeTruthy();
        expect(branch.title).toBeTruthy();
        expect(branch.body).toBeTruthy();
        expect(branch.primaryCta).toBeTruthy();
      }
    }
    for (const k of ['staleCache', 'unknown'] as const) {
      for (const tree of [en, de] as Array<Record<string, unknown>>) {
        const branch = (tree.error as Record<string, Record<string, string>>)[k];
        expect(branch, `error.${k} missing`).toBeTruthy();
        expect(branch.title).toBeTruthy();
        expect(branch.body).toBeTruthy();
        expect(branch.primaryCta).toBeTruthy();
      }
    }
  });

  it('actionCluster labels parity (both notfound + error)', () => {
    const labels = ['diagnostics', 'library', 'forum', 'onboarding'] as const;
    for (const tree of [en, de] as Array<Record<string, unknown>>) {
      const cluster = (tree.notfound as Record<string, Record<string, string>>).actionCluster;
      for (const k of labels) {
        expect(cluster[k], `notfound.actionCluster.${k}`).toBeTruthy();
      }
      const errCluster = (tree.error as Record<string, Record<string, string>>).actionCluster;
      for (const k of ['retry', ...labels] as const) {
        expect(errCluster[k], `error.actionCluster.${k}`).toBeTruthy();
      }
    }
  });
});
