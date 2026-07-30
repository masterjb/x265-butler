// 16-01 audit-added S5: i18n coverage release-bar for the AutoScan namespace.
//
// Walks components/settings/auto-scan-*.{ts,tsx} extracting every t(...) and
// useTranslations(...) reference, then asserts each key resolves in BOTH
// locale bundles (mirrors Phase 15 storage-key-coverage pattern). Catches
// drift where a component references a key that was never added to the
// message bundle (or removed during a refactor).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import en from '@/messages/en.json';
import de from '@/messages/de.json';

type Bundle = Record<string, unknown>;

const SETTINGS_DIR = join(process.cwd(), 'components', 'settings');

function walkAutoScanFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(SETTINGS_DIR)) {
    if (!entry.startsWith('auto-scan-')) continue;
    const full = join(SETTINGS_DIR, entry);
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

describe('auto-scan i18n key coverage (audit S5)', () => {
  it('every static t(...) key in components/settings/auto-scan-* resolves in EN', () => {
    const files = walkAutoScanFiles();
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

  it('every static t(...) key in components/settings/auto-scan-* resolves in DE', () => {
    const files = walkAutoScanFiles();
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

  it('settings.autoScan namespace is structurally identical in EN and DE', () => {
    const enKeys = collectLeafKeys((en as Bundle).settings as Bundle, 'settings');
    const deKeys = collectLeafKeys((de as Bundle).settings as Bundle, 'settings');
    const enAuto = enKeys.filter((k) => k.startsWith('settings.autoScan.')).sort();
    const deAuto = deKeys.filter((k) => k.startsWith('settings.autoScan.')).sort();
    expect(enAuto).toEqual(deAuto);
    expect(enAuto.length).toBeGreaterThan(20);
  });
});

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
