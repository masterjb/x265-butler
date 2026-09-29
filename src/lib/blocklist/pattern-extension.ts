// 22-03 T1: derive pattern-extension + scan-extension union + warning composer.
//
// Consumes 22-00 IMP-8 surface (no new persistence). Suppresses warning when
// share-extension lookup fails (audit-S1+S3: returns empty set + WARN-level
// pino emit so the failure is operator-visible without surfacing a
// false-positive warning at the API boundary).

import { shareRepo as defaultShareRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import type { ShareRepo } from '@/src/lib/db/repos/share';

const VALID_EXT_REGEX = /^[a-z0-9]{1,8}$/;

export function derivePatternExtension(pattern: string): string | null {
  if (typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith('*')) return null;
  const lower = trimmed.toLowerCase();
  const lastDot = lower.lastIndexOf('.');
  if (lastDot < 0) return null;
  const ext = lower.slice(lastDot + 1);
  if (!VALID_EXT_REGEX.test(ext)) return null;
  return ext;
}

export interface ExtensionWarningPayload {
  resolvedExt: string;
  scanExtensions: string[];
}

export interface ExtensionHelperDeps {
  shareRepo?: () => ShareRepo;
}

export function getCurrentScanExtensions(deps: ExtensionHelperDeps = {}): Set<string> {
  const factory = deps.shareRepo ?? defaultShareRepo;
  const out = new Set<string>();
  try {
    const shares = factory().listAll();
    for (const s of shares) {
      const raw = s.extensions_csv;
      if (typeof raw !== 'string' || raw.length === 0) continue;
      for (const t of raw.split(',')) {
        let token = t.trim().toLowerCase();
        if (token.length === 0) continue;
        if (token.startsWith('.')) token = token.slice(1);
        if (token.length === 0) continue;
        out.add(token);
      }
    }
  } catch (err) {
    logger.warn(
      {
        action: 'scan_extensions_lookup_failed',
        error: (err as Error)?.message ?? String(err),
      },
      'shareRepo.listAll threw — scan-extension warning suppressed',
    );
    return new Set<string>();
  }
  return out;
}

export function composeExtensionWarning(
  pattern: string,
  deps: ExtensionHelperDeps = {},
): ExtensionWarningPayload | null {
  const resolvedExt = derivePatternExtension(pattern);
  if (!resolvedExt) return null;
  const scanSet = getCurrentScanExtensions(deps);
  if (scanSet.size === 0) return null;
  if (scanSet.has(resolvedExt)) return null;
  return {
    resolvedExt,
    scanExtensions: Array.from(scanSet).sort(),
  };
}
