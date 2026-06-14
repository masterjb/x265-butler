'use client';

import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import type { BenchComboRow } from '@/src/lib/db/schema';

interface Pass2ProgressCardProps {
  overallPct: number;
  combo?: BenchComboRow;
  onCancel?: () => void;
}

export function Pass2ProgressCard({ overallPct, combo, onCancel }: Pass2ProgressCardProps) {
  const tPass2 = useTranslations('bench.pass2');

  const pct = Math.max(0, Math.min(100, overallPct));

  const encoderLine = combo
    ? [combo.encoder, combo.preset, `${combo.native_quality_param}=${combo.native_quality_value}`]
        .filter(Boolean)
        .join(' ')
    : null;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm font-medium min-w-0">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
          <span>{tPass2('running')}</span>
          {encoderLine && (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="truncate text-muted-foreground">{encoderLine}</span>
            </>
          )}
        </div>
        <span className="text-xl font-semibold tabular-nums shrink-0">{pct}%</span>
      </div>

      <div
        className="relative h-3 w-full overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={tPass2('progressLabel')}
      >
        <div
          className="h-full bg-primary motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>

      {onCancel && (
        <div className="text-xs text-muted-foreground">
          <button
            type="button"
            onClick={onCancel}
            className="hover:text-foreground underline underline-offset-2"
          >
            {tPass2('cancelCta')}
          </button>
        </div>
      )}
    </div>
  );
}
