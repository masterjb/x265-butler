'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SectionHint } from '@/components/stats/charts/section-hint';

interface Props {
  value: string;
  ariaValue?: string;
  label: string;
  subtext?: string;
  sampleSize?: number;
  target?: { value: number; label: string };
  mono?: boolean;
  hint?: string;
}

export function SimpleKpiCard({
  value,
  ariaValue,
  label,
  subtext,
  sampleSize,
  target,
  mono = true,
  hint,
}: Props) {
  const isMuted = value === '—';
  return (
    <Card aria-label={ariaValue ?? value}>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-1.5">
          <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </CardTitle>
          {hint && <SectionHint content={hint} />}
        </div>
      </CardHeader>
      <CardContent>
        <p
          className={`text-2xl font-semibold leading-none ${mono ? 'font-mono tabular-nums' : ''} ${isMuted ? 'text-muted-foreground' : ''}`}
        >
          {value}
        </p>
        {subtext && <p className="mt-1 text-sm text-muted-foreground">{subtext}</p>}
        {sampleSize !== undefined && (
          <p className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
            n={sampleSize}
          </p>
        )}
        {target && (
          <div className="relative mt-2">
            <div className="h-px w-full bg-border" />
            <span
              className="absolute right-0 top-1 font-mono text-xs tabular-nums text-muted-foreground"
              title={target.label}
            >
              {target.label}: {target.value}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
