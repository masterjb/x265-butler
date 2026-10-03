'use client';

import { CheckCircle, AlertTriangle, OctagonAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SectionHint } from '@/components/stats/charts/section-hint';

interface Props {
  value: number;
  sampleSize: number;
  thresholds: { healthy: number; attention: number };
  titleKey: string;
  hint?: string;
}

type Zone = 'healthy' | 'attention' | 'critical';

function getZone(value: number, thresholds: { healthy: number; attention: number }): Zone {
  if (value < thresholds.healthy) return 'healthy';
  if (value < thresholds.attention) return 'attention';
  return 'critical';
}

const ZONE_COLORS: Record<Zone, string> = {
  healthy: 'var(--chart-2)',
  attention: 'var(--chart-3)',
  critical: 'var(--destructive)',
};

const ZONE_TEXT_CLASSES: Record<Zone, string> = {
  healthy: 'text-green-600 dark:text-green-400',
  attention: 'text-amber-600 dark:text-amber-400',
  critical: 'text-destructive',
};

const ZONE_ICONS = {
  healthy: CheckCircle,
  attention: AlertTriangle,
  critical: OctagonAlert,
};

export function BulletKpiCard({ value, sampleSize, thresholds, titleKey, hint }: Props) {
  const t = useTranslations('stats.charts');
  const zone = getZone(value, thresholds);
  const pct = Math.round(value * 1000) / 10;
  const ZoneIcon = ZONE_ICONS[zone];
  const zoneLabel = t(`failedJobRate.threshold.${zone}`);
  const ariaLabel = t('failedJobRate.aria', { pct, thresholdLabel: zoneLabel });

  // Bullet axis: 0 to 1 (100%); tick marks at threshold breakpoints
  const healthyPct = thresholds.healthy * 100;
  const attentionPct = thresholds.attention * 100;
  const valuePct = Math.min(value * 100, 100);

  return (
    <Card aria-label={ariaLabel}>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1.5">
          <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t(titleKey as Parameters<typeof t>[0])}
          </CardTitle>
          {hint && <SectionHint content={hint} />}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <p className="font-mono text-2xl font-semibold tabular-nums">{pct}%</p>
          <div className={`flex items-center gap-1 text-sm font-medium ${ZONE_TEXT_CLASSES[zone]}`}>
            <ZoneIcon className="h-4 w-4" aria-hidden="true" />
            <span>{zoneLabel}</span>
          </div>
        </div>
        <p className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
          n={sampleSize}
        </p>

        {/* Bullet axis */}
        <div className="relative mt-3 h-4" role="presentation" aria-hidden="true">
          {/* Background zones */}
          <div className="flex h-2 overflow-hidden rounded">
            <div
              style={{ width: `${healthyPct}%`, backgroundColor: ZONE_COLORS.healthy }}
              className="h-full opacity-30"
            />
            <div
              style={{
                width: `${attentionPct - healthyPct}%`,
                backgroundColor: ZONE_COLORS.attention,
              }}
              className="h-full opacity-30"
            />
            <div
              style={{ width: `${100 - attentionPct}%`, backgroundColor: ZONE_COLORS.critical }}
              className="h-full opacity-30"
            />
          </div>
          {/* Current value indicator */}
          <div
            className="absolute top-0 h-2 w-0.5 bg-foreground"
            style={{ left: `${valuePct}%` }}
          />
          {/* Tick marks at thresholds */}
          <div
            className="absolute top-0 h-2.5 w-px bg-foreground/50"
            style={{ left: `${healthyPct}%` }}
          />
          <div
            className="absolute top-0 h-2.5 w-px bg-foreground/50"
            style={{ left: `${attentionPct}%` }}
          />
        </div>
        {/* Threshold labels */}
        <div className="relative mt-0.5 text-xs text-muted-foreground">
          <span className="absolute" style={{ left: `${healthyPct}%` }}>
            {healthyPct}%
          </span>
          <span className="absolute" style={{ left: `${attentionPct}%` }}>
            {attentionPct}%
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
