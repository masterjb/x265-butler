// 16-03 audit-added (carry-forward 16-01 S5 / Phase 15 storage-key-coverage):
// i18n coverage release-bar for the onboarding namespace.
//
// Walks components/onboarding/*.{ts,tsx} extracting every t(...) reference
// (and useTranslations(...) namespace prefix) then asserts each key resolves
// in BOTH locale bundles. Catches drift where a component references a key
// that was never added to the bundle (or removed during refactor).
//
// Also asserts the new onboarding.autoScan.* namespace introduced by 16-03
// is structurally identical between EN and DE.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import en from '@/messages/en.json';
import de from '@/messages/de.json';

type Bundle = Record<string, unknown>;

const ONBOARDING_DIR = join(process.cwd(), 'components', 'onboarding');

function walkOnboardingFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(ONBOARDING_DIR)) {
    const full = join(ONBOARDING_DIR, entry);
    const st = statSync(full);
    if (st.isFile() && (full.endsWith('.tsx') || full.endsWith('.ts'))) out.push(full);
  }
  return out;
}

function getNamespace(filePath: string): string {
  const source = readFileSync(filePath, 'utf8');
  const ns = source.match(/useTranslations\(['"]([^'"]+)['"]\)/);
  return ns?.[1] ?? '';
}

function extractKeys(filePath: string, namespace: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  const out = new Set<string>();
  const regex = /\bt\(['"]([\w.]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const key = match[1];
    out.add(namespace ? `${namespace}.${key}` : key);
  }
  return Array.from(out);
}

function hasNestedKey(bundle: Bundle, dotted: string): boolean {
  const parts = dotted.split('.');
  let cur: unknown = bundle;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null) return false;
    cur = (cur as Record<string, unknown>)[p];
    if (cur === undefined) return false;
  }
  return cur !== undefined;
}

function collectLeafKeys(bundle: Bundle, prefix: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(bundle)) {
    const path = `${prefix}.${k}`;
    if (typeof v === 'object' && v !== null) {
      out.push(...collectLeafKeys(v as Bundle, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

describe('onboarding i18n key coverage (16-03 audit)', () => {
  it('every static t(...) key in components/onboarding/* resolves in EN', () => {
    const files = walkOnboardingFiles();
    expect(files.length).toBeGreaterThan(0);
    const missing: { key: string; file: string }[] = [];
    for (const file of files) {
      const ns = getNamespace(file);
      const keys = extractKeys(file, ns);
      for (const key of keys) {
        if (!key.includes('.')) continue;
        if (!hasNestedKey(en as Bundle, key)) missing.push({ key, file });
      }
    }
    expect(missing).toEqual([]);
  });

  it('every static t(...) key in components/onboarding/* resolves in DE', () => {
    const files = walkOnboardingFiles();
    const missing: { key: string; file: string }[] = [];
    for (const file of files) {
      const ns = getNamespace(file);
      const keys = extractKeys(file, ns);
      for (const key of keys) {
        if (!key.includes('.')) continue;
        if (!hasNestedKey(de as Bundle, key)) missing.push({ key, file });
      }
    }
    expect(missing).toEqual([]);
  });

  it('onboarding.autoScan.* namespace is structurally identical in EN and DE', () => {
    const enLeaves = collectLeafKeys((en as Bundle).onboarding as Bundle, 'onboarding');
    const deLeaves = collectLeafKeys((de as Bundle).onboarding as Bundle, 'onboarding');
    const enAutoScan = enLeaves.filter((k) => k.startsWith('onboarding.autoScan.')).sort();
    const deAutoScan = deLeaves.filter((k) => k.startsWith('onboarding.autoScan.')).sort();
    expect(enAutoScan).toEqual(deAutoScan);
    // Plan T1 final key-list = 6 keys (heading + 3 bodies + deepLinkLabel + iconLabel).
    expect(enAutoScan).toHaveLength(6);
  });

  // 20-01 (Test 14 / AC-8): onboarding.paths.autoSkipToast.* parity + presence.
  it('onboarding.paths.autoSkipToast.* namespace is identical in EN and DE with 4 keys', () => {
    const enLeaves = collectLeafKeys((en as Bundle).onboarding as Bundle, 'onboarding');
    const deLeaves = collectLeafKeys((de as Bundle).onboarding as Bundle, 'onboarding');
    const enToast = enLeaves.filter((k) => k.startsWith('onboarding.paths.autoSkipToast.')).sort();
    const deToast = deLeaves.filter((k) => k.startsWith('onboarding.paths.autoSkipToast.')).sort();
    expect(enToast).toEqual(deToast);
    expect(enToast).toHaveLength(4);
    expect(enToast).toEqual([
      'onboarding.paths.autoSkipToast.actionLabel',
      'onboarding.paths.autoSkipToast.ariaLabel',
      'onboarding.paths.autoSkipToast.description',
      'onboarding.paths.autoSkipToast.title',
    ]);
  });

  // 20-01 (Test 15 / AC-8 + S12): camelCase naming convention enforcement.
  it('onboarding.paths.autoSkipToast.* keys conform to S12 camelCase (no underscore / no kebab)', () => {
    const enLeaves = collectLeafKeys((en as Bundle).onboarding as Bundle, 'onboarding');
    const toast = enLeaves.filter((k) => k.startsWith('onboarding.paths.autoSkipToast.'));
    for (const leaf of toast) {
      const lastSegment = leaf.split('.').pop() ?? '';
      expect(lastSegment).not.toMatch(/_/);
      expect(lastSegment).not.toMatch(/-/);
      // First char lowercase (camelCase).
      expect(lastSegment[0]).toBe(lastSegment[0].toLowerCase());
    }
  });

  // 20-03 (AC-8): three new namespaces introduced by Plan 20-03.
  const NEW_NAMESPACES_20_03 = [
    { prefix: 'onboarding.step4.benchRecommendation.', count: 2 },
    { prefix: 'onboarding.step4.detectFailRemediation.', count: 1 },
    { prefix: 'onboarding.step5.crfExplainer.', count: 6 },
  ] as const;

  for (const ns of NEW_NAMESPACES_20_03) {
    it(`${ns.prefix}* namespace is structurally identical in EN and DE with ${ns.count} keys`, () => {
      const enLeaves = collectLeafKeys((en as Bundle).onboarding as Bundle, 'onboarding');
      const deLeaves = collectLeafKeys((de as Bundle).onboarding as Bundle, 'onboarding');
      const enSet = enLeaves.filter((k) => k.startsWith(ns.prefix)).sort();
      const deSet = deLeaves.filter((k) => k.startsWith(ns.prefix)).sort();
      expect(enSet).toEqual(deSet);
      expect(enSet).toHaveLength(ns.count);
    });

    it(`${ns.prefix}* keys conform to S12 camelCase`, () => {
      const enLeaves = collectLeafKeys((en as Bundle).onboarding as Bundle, 'onboarding');
      const subset = enLeaves.filter((k) => k.startsWith(ns.prefix));
      for (const leaf of subset) {
        const lastSegment = leaf.split('.').pop() ?? '';
        expect(lastSegment).not.toMatch(/_/);
        expect(lastSegment).not.toMatch(/-/);
        expect(lastSegment[0]).toBe(lastSegment[0].toLowerCase());
      }
    });
  }

  // 20-03 (AC-19): cross-namespace collision check across all onboarding
  // namespaces accreted from 16-03 + 20-01 + 20-02 + 20-03. Asserts no leaf
  // key path appears under two different namespaces (e.g. step4.foo defined
  // twice). Catches drift if a future plan re-registers an existing key.
  it('onboarding.* has zero leaf-key path collisions across namespaces (AC-19)', () => {
    const enLeaves = collectLeafKeys((en as Bundle).onboarding as Bundle, 'onboarding');
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const leaf of enLeaves) {
      if (seen.has(leaf)) duplicates.push(leaf);
      seen.add(leaf);
    }
    expect(duplicates).toEqual([]);
  });
});
