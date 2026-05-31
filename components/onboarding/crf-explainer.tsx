'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { logger } from '@/src/lib/logger';
import type { EncoderId } from '@/src/lib/encode/profiles';

// 20-03 Plan Task 2 — Onboarding Step 5 CRFExplainer.
// Per-CRF-field Tooltip with horizontal 0..51 scale + current-value marker.
// Fires onboarding.qualityStep.crfExplainerOpened ONCE on first Tooltip-open
// per mount (firstOpenRef pattern; StrictMode-idempotent).
//
// scaleMax = 51 uniform across all 4 encoders per T0-decision (zod schema in
// quality-step.tsx:18 enforces z.number().int().min(0).max(51) for every
// CRF field). AC-15 boundary-clamp Math.max(0, Math.min(100, …)) defensive
// against bad inputs.
//
// Kill-switch NEXT_PUBLIC_ONBOARDING_CRF_EXPLAINER_DISABLED=1 at module load
// gates ALL behavior per AC-16.

const KILL = process.env.NEXT_PUBLIC_ONBOARDING_CRF_EXPLAINER_DISABLED === '1';
const SCALE_MAX = 51;

export function CRFExplainer({
  encoder,
  currentValue,
}: {
  encoder: EncoderId;
  currentValue: number;
}) {
  const t = useTranslations('onboarding');
  const firstOpenRef = useRef(false);
  const [open, setOpen] = useState(false);

  if (KILL) return null;

  const safeValue = Number.isFinite(currentValue) ? currentValue : 0;
  const markerPercent = Math.max(0, Math.min(100, (safeValue / SCALE_MAX) * 100));

  // Controlled open-state so click (touch + jsdom) + hover/focus (mouse + AT)
  // both work. Single firstOpenRef ensures logger fires once per mount.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) return;
      if (firstOpenRef.current) return;
      firstOpenRef.current = true;
      logger.info({
        event: 'onboarding.qualityStep.crfExplainerOpened',
        encoder,
        crfValue: safeValue,
      });
    },
    [encoder, safeValue],
  );

  return (
    <TooltipProvider delay={0}>
      <Tooltip open={open} onOpenChange={handleOpenChange}>
        <TooltipTrigger
          aria-label={t('step5.crfExplainer.triggerAriaLabel')}
          aria-expanded={open}
          type="button"
          onClick={() => handleOpenChange(!open)}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="h-4 w-4" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent className="max-w-xs flex-col items-start gap-2 p-3 text-left">
          <div className="flex flex-col gap-1">
            <p className="text-xs font-semibold">{t('step5.crfExplainer.header')}</p>
            <ul className="flex flex-col gap-0.5 text-xs">
              <li>{t('step5.crfExplainer.lossless')}</li>
              <li>{t('step5.crfExplainer.good')}</li>
              <li>{t('step5.crfExplainer.artifacts')}</li>
            </ul>
          </div>
          <div
            role="img"
            aria-label={t('step5.crfExplainer.scaleAriaLabel')}
            className="relative h-2 w-full overflow-hidden rounded-full bg-gradient-to-r from-emerald-500 via-amber-500 to-rose-500"
          >
            <span
              data-testid="crf-explainer-marker"
              className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-background ring-1 ring-foreground motion-safe:transition-[left] motion-safe:duration-150"
              style={{ left: `${markerPercent}%` }}
            />
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
