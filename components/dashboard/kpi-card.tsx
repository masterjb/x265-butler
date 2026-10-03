'use client';

// 03-04 Plan Task 2 — 6 KPI variants per dashboard.md §3.
// Audit findings landed:
// - M4: 'use client' first line (component uses no SSR-incompatible APIs but
//   keeps the dashboard sub-component family uniform — refactor-resistant).
// - S4: cumulativeThroughputPerDay em-dash when filesProcessed=0.
// - S5: em-dash boundary `value <= 0 || === null` not just `=== 0`.
// - S11: activeEncoder fallback resolution wires amber AlertTriangle.
// - S14: aria-label uses formatBytesAccessible for full-word units.

import {
  AlertTriangle,
  Cpu,
  FileVideo,
  HardDrive,
  ListOrdered,
  Percent,
  TrendingUp,
} from 'lucide-react';
import { useTranslations, useLocale } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBytes, formatBytesAccessible, type FormatLocale } from '@/src/lib/format';

type ResolutionFlag = 'auto' | 'override' | 'fallback';

type Stats = {
  kpis: {
    totalSaved: number;
    filesProcessed: number;
    avgSavingsPercent: number;
    cumulativeThroughputPerDay: number;
    queueDepth?: { pending: number; encoding: number };
  };
} | null;

type EncoderState = {
  active: string;
  resolution: ResolutionFlag;
  requestedButUnavailable?: string;
} | null;

type Kind =
  | { kind: 'totalSaved'; stats: Stats }
  | { kind: 'filesProcessed'; stats: Stats }
  | { kind: 'avgSavings'; stats: Stats }
  | { kind: 'activeEncoder'; encoders: EncoderState }
  | { kind: 'queueDepth'; stats: Stats }
  | { kind: 'throughput'; stats: Stats };

const EM_DASH = '—';

export function KpiCard(props: Kind) {
  const t = useTranslations('dashboard.kpi');
  const locale = useLocale() as FormatLocale;

  switch (props.kind) {
    case 'totalSaved': {
      const v = props.stats?.kpis.totalSaved ?? null;
      // audit S5: em-dash boundary `value <= 0 || === null`
      const empty = v === null || v <= 0;
      return (
        <CardShell
          icon={<HardDrive className="h-5 w-5" aria-hidden="true" />}
          label={t('totalSaved.label')}
          value={empty ? EM_DASH : formatBytes(v, locale)}
          ariaValue={empty ? undefined : formatBytesAccessible(v, locale)}
          subtext={t('totalSaved.subtext', { count: props.stats?.kpis.filesProcessed ?? 0 })}
          hint={t('totalSaved.hint')}
        />
      );
    }
    case 'filesProcessed': {
      const v = props.stats?.kpis.filesProcessed ?? null;
      const empty = v === null || v <= 0;
      return (
        <CardShell
          icon={<FileVideo className="h-5 w-5" aria-hidden="true" />}
          label={t('filesProcessed.label')}
          value={empty ? EM_DASH : String(v)}
          subtext={t('filesProcessed.subtext')}
          hint={t('filesProcessed.hint')}
        />
      );
    }
    case 'avgSavings': {
      const v = props.stats?.kpis.avgSavingsPercent ?? null;
      const empty = v === null || v <= 0;
      return (
        <CardShell
          icon={<Percent className="h-5 w-5" aria-hidden="true" />}
          label={t('avgSavings.label')}
          value={empty ? EM_DASH : `${v.toFixed(1)}%`}
          subtext={t('avgSavings.subtext')}
          hint={t('avgSavings.hint')}
        />
      );
    }
    case 'activeEncoder': {
      const enc = props.encoders;
      const empty = !enc;
      const subKey: ResolutionFlag = enc?.resolution ?? 'auto';
      return (
        <CardShell
          icon={<Cpu className="h-5 w-5" aria-hidden="true" />}
          label={t('activeEncoder.label')}
          value={empty ? EM_DASH : enc.active}
          subtext={
            empty ? '' : t(`activeEncoder.subtext.${subKey}` as 'activeEncoder.subtext.auto')
          }
          warning={enc?.resolution === 'fallback'}
          mono
          hint={t('activeEncoder.hint')}
        />
      );
    }
    case 'queueDepth': {
      const enc = props.stats?.kpis.queueDepth?.encoding ?? 0;
      const pend = props.stats?.kpis.queueDepth?.pending ?? 0;
      const total = enc + pend;
      const empty = total <= 0;
      return (
        <CardShell
          icon={<ListOrdered className="h-5 w-5" aria-hidden="true" />}
          label={t('queueDepth.label')}
          value={empty ? EM_DASH : String(total)}
          subtext={t('queueDepth.subtext', { encoding: enc, pending: pend })}
          hint={t('queueDepth.hint')}
        />
      );
    }
    case 'throughput': {
      const v = props.stats?.kpis.cumulativeThroughputPerDay ?? null;
      const filesProcessed = props.stats?.kpis.filesProcessed ?? 0;
      // audit S4: em-dash when filesProcessed === 0 (operator-honest empty state)
      const empty = v === null || v <= 0 || filesProcessed === 0;
      return (
        <CardShell
          icon={<TrendingUp className="h-5 w-5" aria-hidden="true" />}
          label={t('throughput.label')}
          value={empty ? EM_DASH : formatBytes(v, locale)}
          ariaValue={empty ? undefined : formatBytesAccessible(v, locale)}
          subtext={t('throughput.subtext')}
          hint={t('throughput.hint')}
        />
      );
    }
  }
}

interface ShellProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  ariaValue?: string;
  subtext?: string;
  warning?: boolean;
  mono?: boolean;
  hint?: string;
}

function CardShell({ icon, label, value, ariaValue, subtext, warning, mono, hint }: ShellProps) {
  return (
    <Card className="p-4">
      <CardContent className="flex flex-col gap-2 p-0">
        <div className="flex items-start justify-between text-muted-foreground">
          <span className="text-xs uppercase tracking-wide">{label}</span>
          {hint ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={hint}
                      className="rounded text-muted-foreground/60 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  {icon}
                </TooltipTrigger>
                <TooltipContent className="max-w-64 text-xs leading-relaxed">{hint}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <span aria-hidden="true">{icon}</span>
          )}
        </div>
        <div
          className={`font-semibold tabular-nums text-2xl md:text-3xl ${mono ? 'font-mono' : 'font-mono'}`}
          aria-label={ariaValue ?? value}
        >
          {value}
        </div>
        {subtext ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            {warning ? (
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label="warning" />
            ) : null}
            <span>{subtext}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
