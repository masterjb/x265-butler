'use client';

import { Award, ChevronsLeft, Minimize2, TrendingDown, TrendingUp } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { BenchComboRow, Top3Role } from '@/src/lib/db/schema';
import { formatBytes, formatDuration, type FormatLocale } from '@/src/lib/format';
import { computeSavings } from '@/src/lib/format/savings';

const ROLE_ORDER = ['size', 'balanced', 'quality'] as const;

const ROLE_CHART_TOKEN: Record<Top3Role, string> = {
  size: 'var(--chart-1)',
  balanced: 'var(--chart-2)',
  quality: 'var(--chart-3)',
};

const ROLE_ICON: Record<Top3Role, typeof Award> = {
  size: ChevronsLeft,
  balanced: Minimize2,
  quality: Award,
};

export interface Pass2ComparisonTableProps {
  // Keyed by Top3Role — pre-computed by bench-client via pickTop3 to correctly
  // handle cases where two roles share the same Pareto-front combo (e.g. size ≡ balanced
  // when the front has only 2 points). Using BenchComboRow.top3_role from the DB would
  // miss the balanced entry in those cases.
  combosByRole: Record<Top3Role, BenchComboRow | undefined>;
  sourceFullFileBytes: number;
}

function comboKey(combo: BenchComboRow): string {
  return [
    combo.encoder,
    combo.preset,
    `${combo.native_quality_param}=${combo.native_quality_value}`,
    combo.vmaf_target !== null ? `vmafTarget=${combo.vmaf_target}` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

export function Pass2ComparisonTable({
  combosByRole,
  sourceFullFileBytes,
}: Pass2ComparisonTableProps) {
  const t = useTranslations('bench.compareTable');
  const tTop3 = useTranslations('bench.top3');
  const locale = useLocale() as FormatLocale;

  const byRole = combosByRole;

  // Detect which roles share the same combo settings (identical encoder/preset/crf/vmafTarget).
  // The first occurrence in ROLE_ORDER is the "original"; later ones show a hint.
  const keyToFirstRole = new Map<string, Top3Role>();
  const duplicateOf: Partial<Record<Top3Role, Top3Role>> = {};
  for (const role of ROLE_ORDER) {
    const combo = byRole[role];
    if (!combo) continue;
    const key = comboKey(combo);
    const first = keyToFirstRole.get(key);
    if (first !== undefined) {
      duplicateOf[role] = first;
    } else {
      keyToFirstRole.set(key, role);
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{t('heading')}</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {ROLE_ORDER.map((role) => {
          const combo = byRole[role];
          const Icon = ROLE_ICON[role];
          const stripe = ROLE_CHART_TOKEN[role];
          const title = tTop3(`${role}.title`);
          const isVerified = combo !== undefined && combo.pass2_completed_at !== null;
          const sameAs = duplicateOf[role];

          const comboConfig =
            combo !== undefined
              ? [
                  combo.encoder,
                  combo.preset,
                  `${combo.native_quality_param}=${combo.native_quality_value}`,
                  combo.vmaf_target !== null ? `vmafTarget=${combo.vmaf_target}` : null,
                ]
                  .filter(Boolean)
                  .join(' ')
              : null;

          const verifiedSavings =
            isVerified && sourceFullFileBytes > 0 && combo.pass2_size_bytes !== null
              ? computeSavings(sourceFullFileBytes, combo.pass2_size_bytes, sourceFullFileBytes)
              : null;

          return (
            <div
              key={role}
              className="rounded-lg border bg-card overflow-hidden"
              data-testid={`compare-col-${role}`}
            >
              <div className="h-1.5" style={{ backgroundColor: stripe }} aria-hidden="true" />
              <div className="p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Icon
                    className="h-4 w-4 shrink-0"
                    aria-hidden="true"
                    data-testid={`compare-icon-${role}`}
                  />
                  <span>{title}</span>
                </div>

                {comboConfig !== null && (
                  <p
                    className="text-xs font-mono text-muted-foreground truncate"
                    title={comboConfig}
                  >
                    {comboConfig}
                  </p>
                )}

                {sameAs !== undefined && (
                  <p
                    className="text-xs text-muted-foreground italic"
                    data-testid={`compare-same-as-${role}`}
                  >
                    {t('sameComboAs', { roleTitle: tTop3(`${sameAs}.title`) })}
                  </p>
                )}

                <dl className="space-y-2">
                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">{t('vmafLabel')}</dt>
                    {isVerified && combo.pass2_vmaf !== null ? (
                      <dd className="font-mono tabular-nums text-base">
                        {combo.pass2_vmaf.toFixed(2)}
                      </dd>
                    ) : (
                      <dd className="font-mono text-muted-foreground" aria-label={t('notVerified')}>
                        —
                      </dd>
                    )}
                  </div>

                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">{t('sizeLabel')}</dt>
                    {isVerified && combo.pass2_size_bytes !== null ? (
                      <dd className="font-mono tabular-nums text-base">
                        <div>{formatBytes(combo.pass2_size_bytes, locale)}</div>
                        {verifiedSavings !== null && verifiedSavings.pct !== 0 && (
                          <div className="flex items-center gap-0.5 mt-0.5 text-sm">
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
                                <TrendingUp
                                  className="h-3 w-3 shrink-0 text-destructive"
                                  aria-hidden="true"
                                />
                                <span className="text-destructive">
                                  {tTop3('worseByPct', { pct: Math.abs(verifiedSavings.pct) })}
                                </span>
                              </>
                            )}
                          </div>
                        )}
                      </dd>
                    ) : (
                      <dd className="font-mono text-muted-foreground" aria-label={t('notVerified')}>
                        —
                      </dd>
                    )}
                  </div>

                  <div className="space-y-0.5">
                    <dt className="text-xs text-muted-foreground">{t('timeLabel')}</dt>
                    {isVerified && combo.pass2_encode_seconds !== null ? (
                      <dd className="font-mono tabular-nums text-base">
                        {formatDuration(combo.pass2_encode_seconds)}
                      </dd>
                    ) : (
                      <dd className="font-mono text-muted-foreground" aria-label={t('notVerified')}>
                        —
                      </dd>
                    )}
                  </div>
                </dl>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
