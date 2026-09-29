'use client';

import { Award, ChevronsLeft, Minimize2, TrendingDown, TrendingUp } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ConfirmButton } from '@/components/ui/confirm-button';
import type { AggregatedComboView, BenchMode } from '@/src/lib/db/schema';
import { formatBytes, formatDuration, type FormatLocale } from '@/src/lib/format';
import { pickTop3 } from '@/src/lib/bench/pareto';
import { computeSavings, sumFileSizes } from '@/src/lib/format/savings';

const ROLE_ORDER = ['size', 'balanced', 'quality'] as const;
type RoleKey = (typeof ROLE_ORDER)[number];

// 11-03 UAT dark-mode fix: globals.css chart-N already wrapped in hsl(),
// component-side wrap would produce hsl(hsl(...)) → invalid CSS → SVG fill
// defaults to black → invisible against .dark near-black bg.
const ROLE_CHART_TOKEN: Record<RoleKey, string> = {
  size: 'var(--chart-1)',
  balanced: 'var(--chart-2)',
  quality: 'var(--chart-3)',
};

const ROLE_ICON = {
  size: ChevronsLeft,
  balanced: Minimize2,
  quality: Award,
} as const;

interface CardProps {
  role: RoleKey;
  combo: AggregatedComboView | undefined;
  mode: BenchMode;
  sameAs?: RoleKey;
  // 11-02-FIX-V2 UAT-003: sum of full-file sizes for the run's fileIds
  // (computed once in Top3Cards, passed in to avoid per-card recomputation).
  sourceFullFileBytesSum: number;
  // 11-03 AC-7: lifecycle / handlers wired from bench-client.tsx.
  runVerifiable: boolean;
  pass2Verified: boolean;
  pass2Running: boolean;
  onUseThis: () => void;
  onApplyAsDefaults: () => void;
}

function ComboCard({
  role,
  combo,
  mode,
  sameAs,
  sourceFullFileBytesSum,
  runVerifiable,
  pass2Verified,
  pass2Running,
  onUseThis,
  onApplyAsDefaults,
}: CardProps) {
  const t = useTranslations('bench.top3');
  const locale = useLocale() as FormatLocale;
  const tooltipId = useId();
  const Icon = ROLE_ICON[role];
  const title = t(`${role}.title`);
  const stripe = ROLE_CHART_TOKEN[role];

  if (!combo) {
    return (
      <div
        className="rounded-lg border bg-card overflow-hidden opacity-50"
        role="article"
        aria-label={`${title} — ${t('noCandidate')}`}
        aria-disabled="true"
        data-testid={`top3-card-${role}`}
      >
        <div className="h-1.5" style={{ backgroundColor: stripe }} aria-hidden="true" />
        <div className="p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Icon
              className="h-4 w-4 shrink-0"
              aria-hidden="true"
              data-testid={`top3-icon-${role}`}
            />
            <span>{title}</span>
          </div>
          <p className="text-xs text-muted-foreground">{t('noCandidate')}</p>
        </div>
      </div>
    );
  }

  const comboLine = [
    combo.encoder,
    combo.preset,
    `${combo.native_quality_param}=${combo.native_quality_value}`,
    mode === 'vmaf-anchored' && combo.vmaf_target !== null
      ? `vmafTarget=${combo.vmaf_target}`
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  const savings = computeSavings(combo.sourceSampleBytes, combo.sizeBytes, sourceFullFileBytesSum);
  const savingsUnavailable = savings === null || sourceFullFileBytesSum === 0;

  return (
    <div
      className="rounded-lg border bg-card overflow-hidden"
      role="article"
      aria-label={title}
      data-testid={`top3-card-${role}`}
    >
      <div className="h-1.5" style={{ backgroundColor: stripe }} aria-hidden="true" />
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" data-testid={`top3-icon-${role}`} />
          <span>{title}</span>
        </div>
        <p className="text-xs font-mono text-muted-foreground truncate" title={comboLine}>
          {comboLine}
        </p>
        {sameAs !== undefined && (
          <p className="text-xs text-muted-foreground italic" data-testid={`top3-same-as-${role}`}>
            {t('sameComboAs', { roleTitle: t(`${sameAs}.title`) })}
          </p>
        )}
        <dl className="space-y-1 text-xs">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">VMAF</dt>
            <dd className="font-mono tabular-nums">{combo.vmaf.toFixed(2)}</dd>
          </div>
          <div className="flex justify-between items-start">
            <dt className="text-muted-foreground">{t('sizeLabel')}</dt>
            <dd className="font-mono tabular-nums text-right" data-testid={`size-dd-${role}`}>
              <div>{formatBytes(combo.sizeBytes, locale)}</div>
              {!savingsUnavailable && (
                <div className="flex items-center justify-end gap-0.5 mt-0.5">
                  {savings!.pct > 0 ? (
                    <>
                      <TrendingDown
                        className="h-3 w-3 shrink-0 text-[var(--chart-4)]"
                        aria-hidden="true"
                      />
                      <span className="text-[var(--chart-4)]">
                        {t('savesPct', { pct: savings!.pct })}
                      </span>
                    </>
                  ) : savings!.pct < 0 ? (
                    <>
                      <TrendingUp
                        className="h-3 w-3 shrink-0 text-destructive"
                        aria-hidden="true"
                      />
                      <span className="text-destructive">
                        {t('worseByPct', { pct: -savings!.pct })}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{t('noSavings')}</span>
                  )}
                </div>
              )}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">{t('timeLabel')}</dt>
            <dd className="font-mono tabular-nums">{formatDuration(combo.encodeSec)}</dd>
          </div>
        </dl>

        {/* 11-02-FIX-V2 UAT-003: projected full-file savings emphasis-row.
            11-04 Option C: simplified — projected bytes only (savings% moved to SIZE sub-line). */}
        {savingsUnavailable ? (
          <>
            <hr className="border-border" />
            <p className="text-xs text-muted-foreground tabular-nums">
              {t('compressionUnavailable')}
            </p>
          </>
        ) : (
          <>
            <hr className="border-border" />
            <p
              className="text-xs text-muted-foreground tabular-nums"
              title={t('projectionAssumption')}
            >
              {t('savesBytes', {
                bytes: formatBytes(savings!.projectedFullFileBytes, locale),
              })}
            </p>
          </>
        )}

        {/* 11-03 AC-7: enable-path matrix.
              - run not verifiable → disabled stub with "verifyTooltipReady" tip
              - verifiable + not yet verified → "Use this" (POST /pass2)
              - verified → "Apply as defaults" (opens dialog)
              - currently running → disabled with running-state styling */}
        {!runVerifiable ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-disabled="true"
                    aria-describedby={tooltipId}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-medium opacity-50 cursor-default"
                  />
                }
              >
                {t('useThis')}
              </TooltipTrigger>
              <TooltipContent id={tooltipId}>{t('verifyTooltipReady')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : pass2Verified ? (
          // 13-01b T5: AlertDialog removed → inline ConfirmButton P1 (fire-
          // immediate). Variant-B Undo composition lives in the consumer
          // callback (bench-client.tsx handleApplyClick).
          <ConfirmButton
            variant="P1"
            onConfirm={onApplyAsDefaults}
            label={t('applyAsDefaults')}
            className="w-full border-primary bg-primary text-primary-foreground hover:bg-primary/90"
          />
        ) : (
          <button
            type="button"
            onClick={onUseThis}
            disabled={pass2Running}
            aria-disabled={pass2Running}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('useThis')}
          </button>
        )}
      </div>
    </div>
  );
}

export interface Top3CardsProps {
  summary: AggregatedComboView[];
  mode: BenchMode;
  // 11-02-FIX-V2 UAT-003: required for projected-full-file-savings computation.
  // Empty array / empty map → emphasis-row gracefully degrades to compressionUnavailable.
  fileIds?: number[];
  fileSizeMap?: Record<number, number>;
  // 11-03 AC-7: enables the Pass-2 / Apply enable-path.
  runVerifiable?: boolean;
  // Predicate: is the per-card combo verified (pass2_completed_at !== null)?
  // Receives the targetable comboId (sampleIds[0]) per card.
  isPass2Verified?: (comboId: number) => boolean;
  // Predicate: is the targetable combo currently running Pass-2?
  isPass2Running?: (comboId: number) => boolean;
  onUseThis?: (comboId: number) => void;
  onApplyAsDefaults?: (comboId: number) => void;
}

export function Top3Cards({
  summary,
  mode,
  fileIds = [],
  fileSizeMap = {},
  runVerifiable = false,
  isPass2Verified = () => false,
  isPass2Running = () => false,
  onUseThis = () => {},
  onApplyAsDefaults = () => {},
}: Top3CardsProps) {
  const paretoFront = summary.filter((c) => c.is_pareto).sort((a, b) => a.sizeBytes - b.sizeBytes);
  const top3 = pickTop3(paretoFront);

  const byRole: Record<RoleKey, AggregatedComboView | undefined> = {
    size: top3?.size,
    balanced: top3?.balanced,
    quality: top3?.quality,
  };

  // Sum once per render — passed to all 3 cards.
  const sourceFullFileBytesSum = sumFileSizes(fileIds, fileSizeMap);

  // Detect roles that share the same combo (2-point Pareto front: size ≡ balanced).
  const idToFirstRole = new Map<number, RoleKey>();
  const duplicateOf: Partial<Record<RoleKey, RoleKey>> = {};
  for (const role of ROLE_ORDER) {
    const id = byRole[role]?.sampleIds[0];
    if (id === undefined) continue;
    const first = idToFirstRole.get(id);
    if (first !== undefined) {
      duplicateOf[role] = first;
    } else {
      idToFirstRole.set(id, role);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {ROLE_ORDER.map((role) => {
        const combo = byRole[role];
        // Each Top-3 view aggregates N sample bench_combo rows. Use sampleIds[0]
        // as the verify target (operator-facing single-pick — Pass-2 metrics
        // attach to that row).
        const targetComboId = combo?.sampleIds[0];
        const pass2Verified = targetComboId !== undefined && isPass2Verified(targetComboId);
        const pass2Running = targetComboId !== undefined && isPass2Running(targetComboId);
        return (
          <ComboCard
            key={role}
            role={role}
            combo={combo}
            mode={mode}
            sameAs={duplicateOf[role]}
            sourceFullFileBytesSum={sourceFullFileBytesSum}
            runVerifiable={runVerifiable && targetComboId !== undefined}
            pass2Verified={pass2Verified}
            pass2Running={pass2Running}
            onUseThis={() => {
              if (targetComboId !== undefined) onUseThis(targetComboId);
            }}
            onApplyAsDefaults={() => {
              if (targetComboId !== undefined) onApplyAsDefaults(targetComboId);
            }}
          />
        );
      })}
    </div>
  );
}
