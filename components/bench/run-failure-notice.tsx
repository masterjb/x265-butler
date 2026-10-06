'use client';

import { AlertTriangle, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { parseRunFailureReason } from '@/src/lib/bench/failure-excerpt';

// Run-level failure surfaces for the bench page and the run
// detail page. Before, a run that measured nothing looked like an empty result
// ("Kein Kandidat") and a partly failed run hid its failures entirely.

export function formatRunFailure(
  t: (key: string, values?: Record<string, string | number>) => string,
  errorReason: string,
): string {
  const parsed = parseRunFailureReason(errorReason);
  return parsed.kind === 'all_combos_failed'
    ? t('allFailed', { count: parsed.count })
    : parsed.text;
}

export function RunFailedNotice({ errorReason }: { errorReason: string | null }) {
  const t = useTranslations('bench.runFailure');
  const tTerminal = useTranslations('bench.terminal');
  const parsed = errorReason ? parseRunFailureReason(errorReason) : null;

  return (
    <div
      role="alert"
      data-testid="bench-run-failed-notice"
      className="flex gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm"
    >
      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p className="font-semibold text-destructive">{tTerminal('failed.title')}</p>
        {parsed?.kind === 'all_combos_failed' ? (
          <>
            <p className="text-destructive">{t('allFailed', { count: parsed.count })}</p>
            {parsed.excerpt && (
              <p className="break-words font-mono text-xs text-muted-foreground">
                {parsed.excerpt}
              </p>
            )}
            <p className="text-muted-foreground">{t('allFailedHint')}</p>
          </>
        ) : (
          parsed && <p className="break-words text-destructive">{parsed.text}</p>
        )}
      </div>
    </div>
  );
}

export function PartialFailureNotice({ failed, total }: { failed: number; total: number }) {
  const t = useTranslations('bench.runFailure');
  if (failed === 0) return null;
  return (
    <div
      role="status"
      data-testid="bench-run-partial-failure"
      className="flex gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>{t('partialFailed', { failed, total })}</p>
    </div>
  );
}
