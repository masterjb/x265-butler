'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { logger } from '@/src/lib/logger';
import { getBenchRecommendation } from '@/src/lib/api/bench-client';
import type { EncoderId } from '@/src/lib/encode/profiles';
import type { EncoderRecommendation } from '@/src/lib/bench/recommendation';

// 20-03 Plan Task 1 — Onboarding Step 4 BenchRecommendationChip.
// Consumes GET /api/bench/recommendation (mode=quality). On 200 with a
// recommendation for `activeEncoder` → renders chip "Empfohlen: <enc> · CRF <n>"
// and emits onboarding.encoderStep.benchRecommendationServed once per mount
// (StrictMode-idempotent via firedRef). On 401/403/404/500/abort/undefined →
// renders null (silent hide; AC-2/AC-3/AC-12).
//
// AbortController upper-bound 5000ms per AC-12 (onboarding perceived-perf
// budget). Kill-switch NEXT_PUBLIC_ONBOARDING_BENCH_CHIP_DISABLED=1 at module
// load gates ALL behavior (no fetch, no logger, no render) per AC-16.

const KILL = process.env.NEXT_PUBLIC_ONBOARDING_BENCH_CHIP_DISABLED === '1';
const FETCH_TIMEOUT_MS = 5000;

export function BenchRecommendationChip({ activeEncoder }: { activeEncoder: EncoderId }) {
  const t = useTranslations('onboarding');
  const [rec, setRec] = useState<EncoderRecommendation | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    if (KILL) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let cancelled = false;

    (async () => {
      const result = await getBenchRecommendation(activeEncoder, controller.signal);
      if (cancelled) return;
      if (!result) return;
      setRec(result);
      if (!firedRef.current) {
        firedRef.current = true;
        logger.info({
          event: 'onboarding.encoderStep.benchRecommendationServed',
          encoder: activeEncoder,
          crf: result.crf,
        });
      }
    })().finally(() => clearTimeout(timeoutId));

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [activeEncoder]);

  if (KILL) return null;
  if (!rec) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('step4.benchRecommendation.ariaLabel')}
      className="inline-flex items-center gap-2 self-start rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
    >
      <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span>{t('step4.benchRecommendation.label', { encoder: activeEncoder, crf: rec.crf })}</span>
    </div>
  );
}
