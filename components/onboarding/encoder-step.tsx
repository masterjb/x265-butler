'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { logger } from '@/src/lib/logger';
import { BenchRecommendationChip } from '@/components/onboarding/bench-recommendation-chip';
import { CpuCapabilityAdvisory } from '@/components/onboarding/cpu-capability-advisory';
import { EncoderWarningsBadge } from '@/components/settings/encoder-warnings-badge';

// 03-05 Plan Task 2 — wizard step 3 (Encoder detect).
// On mount: POST /api/encoders/refresh + cache for Continue handler.
// audit M6: AbortController(10000ms) — `/dev/dri` kernel hang must NEVER
// freeze wizard. AbortError follows the SAME fallback path as 5xx.

type EncoderId = 'libx265' | 'nvenc' | 'qsv' | 'vaapi';

export type DetectionPayload = {
  refreshed: boolean;
  detected: EncoderId[];
  active: EncoderId;
  resolution: 'auto' | 'override' | 'fallback';
  requestedButUnavailable?: EncoderId;
  devicePath?: string;
};

const ALL_ENCODERS: readonly EncoderId[] = ['nvenc', 'qsv', 'vaapi', 'libx265'] as const;

export function EncoderStep({
  cachedDetection,
  onDetectionResolved,
  onContinue,
  onBack,
  isSubmitting,
}: {
  cachedDetection: DetectionPayload | null;
  onDetectionResolved: (payload: DetectionPayload | 'error') => void;
  onContinue: () => void;
  onBack: () => void;
  isSubmitting: boolean;
}) {
  const t = useTranslations('onboarding');
  // null = probe in-flight; 'error' = AbortError or 5xx; otherwise the payload.
  const [state, setState] = useState<DetectionPayload | 'error' | null>(cachedDetection);

  useEffect(() => {
    // If parent already cached a result, do not re-probe.
    if (cachedDetection) {
      setState(cachedDetection);
      return;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/encoders/refresh', {
          method: 'POST',
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) {
          setState('error');
          onDetectionResolved('error');
          return;
        }
        const payload = (await res.json()) as DetectionPayload;
        setState(payload);
        onDetectionResolved(payload);
      } catch {
        if (cancelled) return;
        setState('error');
        onDetectionResolved('error');
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [cachedDetection, onDetectionResolved]);

  const probing = state === null;
  const errored = state === 'error';
  const payload = !probing && !errored ? (state as DetectionPayload) : null;
  const detectionDone = !probing;

  // 20-03 Plan Task 1: audit-trail event-emit for detect-fail remediation
  // surface visibility. Single-fire per error-mount via dedicated ref so
  // StrictMode double-mount + cachedDetection re-evaluations do not duplicate.
  const remediationFiredRef = useRef(false);
  useEffect(() => {
    if (!errored) return;
    if (remediationFiredRef.current) return;
    remediationFiredRef.current = true;
    logger.info({ event: 'onboarding.encoderStep.detectFailRemediationShown' });
  }, [errored]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 p-8">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('step4.headline')}
          </h1>
          <p className="text-base text-muted-foreground">{t('step4.body')}</p>
        </div>

        <div aria-live="polite" className="flex flex-col gap-3">
          {probing && (
            <div className="flex flex-col gap-3">
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('step4.probing')}
              </p>
              <div className="flex flex-wrap gap-2">
                {ALL_ENCODERS.map((enc) => (
                  <Skeleton key={enc} className="h-7 w-20" />
                ))}
              </div>
            </div>
          )}

          {errored && (
            <div className="flex flex-col gap-2">
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
              >
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
                  aria-hidden="true"
                />
                <span>{t('step4.error.fallback')}</span>
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium">{t('step4.detectFailRemediation.heading')}</p>
                <EncoderWarningsBadge />
              </div>
            </div>
          )}

          {payload && (
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">{t('step4.detected.heading')}</p>
              <div className="flex flex-wrap gap-2">
                {ALL_ENCODERS.map((enc) => {
                  const available = payload.detected.includes(enc);
                  return (
                    <span
                      key={enc}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium',
                        available
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-muted-foreground/20 bg-muted text-muted-foreground',
                      )}
                      aria-label={`${enc} ${available ? 'available' : 'unavailable'}`}
                    >
                      {available ? (
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {enc}
                    </span>
                  );
                })}
              </div>
              <p className="text-sm text-muted-foreground">
                {t('step4.active.line', {
                  encoder: payload.active,
                  resolution: payload.resolution,
                })}
              </p>
              {payload.resolution !== 'fallback' && (
                <BenchRecommendationChip activeEncoder={payload.active} />
              )}
              {/* 23-05: advisory-only libx265 hint when the iGPU predates HEVC-QSV
                  and qsv is not detected. Renders null otherwise (silent-hide). */}
              <CpuCapabilityAdvisory detected={payload.detected} />
              {payload.resolution === 'fallback' && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
                >
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
                    aria-hidden="true"
                  />
                  <span>{t('step4.error.fallback')}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            disabled={isSubmitting}
            aria-disabled={isSubmitting}
          >
            {t('nav.back')}
          </Button>
          <Button
            type="button"
            onClick={onContinue}
            disabled={isSubmitting || !detectionDone}
            aria-disabled={isSubmitting || !detectionDone}
          >
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {t('nav.continue')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
