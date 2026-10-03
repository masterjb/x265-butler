'use client';

// 11-03 AC-8 + design-checkpoint option-a:
// 3-column grid (VMAF / Size / Time) with Δ-rows + emphasis-row reusing
// Top-3 vocabulary (TrendingDown / TrendingUp / noSavings) from 11-02-FIX-V2.

import { Award, ChevronsLeft, Minimize2, TrendingDown, TrendingUp } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { BenchComboRow, Top3Role } from '@/src/lib/db/schema';
import { formatBytes, formatDuration, type FormatLocale } from '@/src/lib/format';
import { computeSavings } from '@/src/lib/format/savings';

// 11-03 UAT request: provenance line — which Top-3 role + combo-config was
// verified. Same icon vocabulary as Top3Cards for visual continuity.
const ROLE_ICON: Record<Top3Role, typeof Award> = {
  size: ChevronsLeft,
  balanced: Minimize2,
  quality: Award,
};

export interface Pass2ResultPanelProps {
  combo: BenchComboRow;
  // Full-file source size for projected-vs-verified savings. 0 → savings row hidden.
  sourceFullFileBytes: number;
}

export function Pass2ResultPanel({ combo, sourceFullFileBytes }: Pass2ResultPanelProps) {
  const t = useTranslations('bench.pass2');
  const tTop3 = useTranslations('bench.top3');
  const locale = useLocale() as FormatLocale;

  if (
    combo.pass2_vmaf === null ||
    combo.pass2_size_bytes === null ||
    combo.pass2_encode_seconds === null
  ) {
    // Defensive — parent gates on pass2_completed_at, but the row could be
    // in a transient state mid-write.
    return null;
  }

  // Δ vs sample (Pass-1 metrics persisted on same row).
  const deltaVmaf = combo.vmaf !== null ? combo.pass2_vmaf - combo.vmaf : null;
  const projectedFullBytes =
    combo.source_sample_bytes !== null && combo.source_sample_bytes > 0 && sourceFullFileBytes > 0
      ? Math.round((combo.size_bytes ?? 0) * (sourceFullFileBytes / combo.source_sample_bytes))
      : null;
  const deltaSizePct =
    projectedFullBytes !== null && projectedFullBytes > 0
      ? Math.round(((combo.pass2_size_bytes - projectedFullBytes) / projectedFullBytes) * 100)
      : null;

  // Savings vs full-file source — verified, not projected.
  const verifiedSavings =
    sourceFullFileBytes > 0
      ? computeSavings(sourceFullFileBytes, combo.pass2_size_bytes, sourceFullFileBytes)
      : null;

  // 11-03 UAT request: which Top-3 role + combo-config produced this result?
  // Format: "<Icon> <RoleTitle> · <encoder> <preset> <param>=<value>"
  // Falls back to combo-config-only when top3_role is null (combo verified
  // outside the Top-3 set — currently not reachable but defensive).
  const RoleIcon = combo.top3_role !== null ? ROLE_ICON[combo.top3_role] : null;
  const roleTitle = combo.top3_role !== null ? tTop3(`${combo.top3_role}.title`) : null;
  const comboConfig = [
    combo.encoder,
    combo.preset,
    `${combo.native_quality_param}=${combo.native_quality_value}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="p-4 space-y-3">
        <h3 className="text-sm font-semibold">{t('heading')}</h3>

        {/* 11-03 UAT request: provenance — role + combo identity */}
        <div className="flex items-center gap-2 text-xs">
          {RoleIcon !== null && (
            <RoleIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          {roleTitle !== null && <span className="font-medium">{roleTitle}</span>}
          {roleTitle !== null && <span className="text-muted-foreground">·</span>}
          <span className="font-mono text-muted-foreground truncate" title={comboConfig}>
            {comboConfig}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-4 sm:gap-6">
          {/* VMAF */}
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t('vmafLabel')}</dt>
            <dd className="font-mono tabular-nums text-base sm:text-lg">
              {combo.pass2_vmaf.toFixed(2)}
            </dd>
            {deltaVmaf !== null && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {t('deltaVsSample', {
                  delta: `${deltaVmaf >= 0 ? '+' : ''}${deltaVmaf.toFixed(2)}`,
                })}
              </p>
            )}
          </div>

          {/* Size */}
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t('sizeLabel')}</dt>
            <dd className="font-mono tabular-nums text-base sm:text-lg">
              {formatBytes(combo.pass2_size_bytes, locale)}
            </dd>
            {verifiedSavings !== null && verifiedSavings.pct !== 0 && (
              <p className="flex items-center gap-0.5 text-base sm:text-lg tabular-nums font-mono">
                {verifiedSavings.pct > 0 ? (
                  <>
                    <TrendingDown
                      className="h-3 w-3 shrink-0 text-[var(--chart-4)]"
                      aria-hidden="true"
                    />
                    <span className="text-[var(--chart-4)]">
                      {tTop3('savesPct', { pct: verifiedSavings.pct })}
                    </span>
                  </>
                ) : (
                  <>
                    <TrendingUp className="h-3 w-3 shrink-0 text-destructive" aria-hidden="true" />
                    <span className="text-destructive">
                      {tTop3('worseByPct', { pct: Math.abs(verifiedSavings.pct) })}
                    </span>
                  </>
                )}
              </p>
            )}
            {deltaSizePct !== null && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {t('deltaVsSample', {
                  delta: `${deltaSizePct >= 0 ? '+' : ''}${deltaSizePct}%`,
                })}
              </p>
            )}
          </div>

          {/* Time */}
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t('timeLabel')}</dt>
            <dd className="font-mono tabular-nums text-base sm:text-lg">
              {formatDuration(combo.pass2_encode_seconds)}
            </dd>
          </div>
        </div>

        {/* Emphasis-row — reuses Top-3 vocabulary (TrendingDown / TrendingUp / muted). */}
        {verifiedSavings !== null &&
          (verifiedSavings.pct > 0 ? (
            <>
              <hr className="border-border" />
              <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--chart-4)] tabular-nums">
                <TrendingDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{t('savingsVsFull', { pct: verifiedSavings.pct })}</span>
              </p>
            </>
          ) : verifiedSavings.pct < 0 ? (
            <>
              <hr className="border-border" />
              <p className="flex items-center gap-1.5 text-sm font-medium text-destructive tabular-nums">
                <TrendingUp className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{t('savingsVsFull', { pct: verifiedSavings.pct })}</span>
              </p>
            </>
          ) : null)}
      </div>
    </div>
  );
}
