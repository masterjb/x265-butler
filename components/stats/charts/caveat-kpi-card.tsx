'use client';

import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  value: number;
  titleKey: string;
  tooltipKey: string;
  subtitle?: string;
  formatValue?: (v: number) => string;
}

export function CaveatKpiCard({ value, titleKey, tooltipKey, subtitle, formatValue }: Props) {
  const t = useTranslations('stats.charts');
  const displayValue = formatValue ? formatValue(value) : String(value);
  const isNegative = value < 0;

  return (
    <Card aria-label={t(titleKey as Parameters<typeof t>[0])}>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t(titleKey as Parameters<typeof t>[0])}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-1.5">
          <p
            className={`font-mono text-2xl font-semibold tabular-nums ${isNegative ? 'text-destructive' : ''}`}
          >
            {displayValue}
          </p>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={t(tooltipKey as Parameters<typeof t>[0])}
                    className="rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <Info className="h-4 w-4" aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>{t(tooltipKey as Parameters<typeof t>[0])}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}
