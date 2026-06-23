'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Lightbulb } from 'lucide-react';
import { logger } from '@/src/lib/logger';
import { INTEL_IGPU_HEVC_QSV_MIN_GEN } from '@/src/lib/diagnostics/cpu-capability-constants';
import type { EncoderId } from '@/src/lib/encode/profiles';

// 23-05 Plan Task 3 — Onboarding Step 4 CpuCapabilityAdvisory.
// Mirrors BenchRecommendationChip ergonomics EXACTLY: module-load kill-switch,
// AbortController 5000ms upper-bound, silent-hide on non-200/abort/undefined,
// firedRef once-per-mount audit emit.
//
// Advisory-only (D1=A): when the host iGPU is too old for HW HEVC-QSV (Intel
// graphicsGen < INTEL_IGPU_HEVC_QSV_MIN_GEN, i.e. hevcQsv === 'none') AND qsv is
// not runtime-detected, it surfaces a libx265 recommendation naming the gen
// reason. It NEVER mutates encoder selection or calls any setter — display only.
//
// Kill-switch NEXT_PUBLIC_ONBOARDING_CPU_ADVISORY_DISABLED=1 at module load gates
// ALL behavior (no fetch, no logger, no render). Container restart required.

const KILL = process.env.NEXT_PUBLIC_ONBOARDING_CPU_ADVISORY_DISABLED === '1';
const FETCH_TIMEOUT_MS = 5000;

// Subset of CpuCapability returned by GET /api/diagnostics/cpu-capability.
interface CpuCapabilitySubset {
  isIntel: boolean;
  graphicsGen: number | null;
  microarch: string | null;
  hevcQsv: 'none' | '8bit' | '10bit' | 'unknown';
}

export function CpuCapabilityAdvisory({ detected }: { detected: EncoderId[] }) {
  const t = useTranslations('onboarding');
  const [cpu, setCpu] = useState<CpuCapabilitySubset | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    if (KILL) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/diagnostics/cpu-capability', { signal: controller.signal });
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as { cpu?: CpuCapabilitySubset };
        if (cancelled || !body.cpu) return;
        setCpu(body.cpu);
      } catch {
        // silent-hide on abort / network / parse failure
      }
    })().finally(() => clearTimeout(timeoutId));

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  if (KILL) return null;
  if (!cpu) return null;

  // Render-gate: Intel iGPU too old for HW HEVC-QSV AND qsv not runtime-detected.
  const tooOld =
    cpu.isIntel && cpu.graphicsGen != null && cpu.graphicsGen < INTEL_IGPU_HEVC_QSV_MIN_GEN;
  const qsvAbsent = !detected.includes('qsv' as EncoderId);
  if (!tooOld || !qsvAbsent) return null;

  // Once-per-mount audit emit (StrictMode-idempotent via firedRef).
  if (!firedRef.current) {
    firedRef.current = true;
    logger.info({
      event: 'onboarding.encoderStep.cpuQsvUnsupportedAdvisoryShown',
      graphicsGen: cpu.graphicsGen,
      microarch: cpu.microarch,
    });
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('step4.cpuAdvisory.ariaLabel')}
      className="flex items-start gap-2 self-start rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <Lightbulb
        className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <span>
        {t('step4.cpuAdvisory.label', {
          gen: cpu.graphicsGen ?? 0,
          minGen: INTEL_IGPU_HEVC_QSV_MIN_GEN,
        })}
      </span>
    </div>
  );
}
