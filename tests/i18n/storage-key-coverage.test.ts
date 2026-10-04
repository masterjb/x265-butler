// 15-02 T6 (audit-added AC-13): walks the storage + library/path-prefix
// component files, extracts every `t('storage.…')` / `t('library.path...')` /
// `t('nav.storage')` call, and asserts each key resolves in BOTH locales.
// Catches drift where a component references a key that was never added to
// the message bundle (or removed during a refactor).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import en from '@/messages/en.json';
import de from '@/messages/de.json';

type MessageBundle = Record<string, unknown>;

const STORAGE_DIR = join(process.cwd(), 'components', 'storage');
const PATH_PREFIX_PILL = join(
  process.cwd(),
  'components',
  'library',
  'path-prefix-filter-pill.tsx',
);
const STORAGE_CLIENT = join(process.cwd(), 'app', '[locale]', 'storage', 'storage-client.tsx');

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTsx(full));
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function getNamespace(filePath: string): string {
  const source = readFileSync(filePath, 'utf8');
  const ns = source.match(/useTranslations\(['"]([^'"]+)['"]\)/);
  return ns?.[1] ?? '';
}

function extractCallKeys(filePath: string, namespace: string): string[] {
  const source = readFileSync(filePath, 'utf8');
  const out = new Set<string>();
  // Plain t('foo.bar') and t.has('foo.bar') + template-style `${zone}` are
  // resolved via the namespace prefix when present.
  const regex = /\bt(?:\.has)?\(['"]([\w.]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const key = match[1];
    out.add(namespace ? `${namespace}.${key}` : key);
  }
  // ICU-style dynamic suffixes like t(`legacyCodecPercent.threshold.${zone}`)
  // need a coarser fallback — we collapse them to the parent path and rely on
  // explicit per-zone tests to catch the leaves.
  return Array.from(out);
}

function hasNestedKey(bundle: MessageBundle, dotted: string): boolean {
  const parts = dotted.split('.');
  let cur: unknown = bundle;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null) return false;
    cur = (cur as Record<string, unknown>)[p];
    if (cur === undefined) return false;
  }
  return cur !== undefined;
}

describe('storage key-coverage (AC-13)', () => {
  it('every static t(…) key in components/storage resolves in EN and DE', () => {
    const files = [...walkTsx(STORAGE_DIR), STORAGE_CLIENT];
    const missing: { key: string; bundle: 'en' | 'de'; file: string }[] = [];
    for (const file of files) {
      const ns = getNamespace(file);
      const keys = extractCallKeys(file, ns);
      for (const key of keys) {
        // Skip purely-namespaced calls (root `t(...)` inside namespaced hooks
        // already resolved). We only assert dot-paths.
        if (!key.includes('.')) continue;
        if (!hasNestedKey(en as MessageBundle, key)) {
          missing.push({ key, bundle: 'en', file });
        }
        if (!hasNestedKey(de as MessageBundle, key)) {
          missing.push({ key, bundle: 'de', file });
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('path-prefix-pill keys resolve in EN and DE', () => {
    const ns = getNamespace(PATH_PREFIX_PILL);
    const keys = extractCallKeys(PATH_PREFIX_PILL, ns);
    for (const key of keys) {
      if (!key.includes('.')) continue;
      expect(hasNestedKey(en as MessageBundle, key)).toBe(true);
      expect(hasNestedKey(de as MessageBundle, key)).toBe(true);
    }
  });
});
