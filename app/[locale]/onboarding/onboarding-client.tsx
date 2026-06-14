'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { StepIndicator } from '@/components/onboarding/step-indicator';
import { WelcomeStep } from '@/components/onboarding/welcome-step';
import { HwAccelStep } from '@/components/onboarding/hw-accel-step';
import { PathsStep, type PathsStepValues } from '@/components/onboarding/paths-step';
import { EncoderStep, type DetectionPayload } from '@/components/onboarding/encoder-step';
import { QualityStep, type QualityStepValues } from '@/components/onboarding/quality-step';

// 03-05 — wizard orchestrator. 18-02: grew 4→5 steps with HwAccelStep inserted
// at position 2 (PRE-quality, post-welcome). audit M5 (in-flight button-disable)
// + M6 (AbortController(10000ms)) + 16-03 sessionStorage stash carry-forward.

type InitialSettings = {
  scan_root: string;
  min_size_mb: string;
  crf_libx265: string;
  crf_nvenc: string;
  crf_qsv: string;
  crf_vaapi: string;
};

type Step = 1 | 2 | 3 | 4 | 5;
type LegacyStep = 1 | 2 | 3 | 4;

// 20-01 (Task 2b): wizard step-array descriptors. Internal `step` state remains
// the legacy 1..5 union for v2 draft-compat (AC-7); `activeSteps` derives the
// visible-position track from the auto-skip branch flag. `key` is informational
// (matches StepIndicator's STEP_KEYS_SKIP) — drives no logic but documents the
// intent at the call-site.
type StepDescriptor = { index: Step; key: 'welcome' | 'hwAccel' | 'paths' | 'encoder' | 'quality' };
const STEPS_FULL: readonly StepDescriptor[] = [
  { index: 1, key: 'welcome' },
  { index: 2, key: 'hwAccel' },
  { index: 3, key: 'paths' },
  { index: 4, key: 'encoder' },
  { index: 5, key: 'quality' },
] as const;
const STEPS_SKIP: readonly StepDescriptor[] = STEPS_FULL.filter((s) => s.key !== 'paths');

const FETCH_TIMEOUT_MS = 10_000;

// 16-03 sessionStorage stash. 18-02 schema v2 — adds Step 2 (hwAccel) +
// renumbers paths/encoder/quality. Back-compat reads v1 (4-step) once, then
// removes v1 key. Detection payload NOT persisted (Q5 — re-detection cheap).
export const ONBOARDING_DRAFT_KEY = 'x265butler.onboarding.draft.v2';
export const ONBOARDING_DRAFT_KEY_V1 = 'x265butler.onboarding.draft.v1';

type OnboardingDraft = {
  step: Step;
  pathsValues: PathsStepValues | null;
  qualityValues: QualityStepValues | null;
};

type LegacyDraft = {
  step: LegacyStep;
  pathsValues: PathsStepValues | null;
  qualityValues: QualityStepValues | null;
};

function isValidStep(n: unknown): n is Step {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
}

function isValidLegacyStep(n: unknown): n is LegacyStep {
  return n === 1 || n === 2 || n === 3 || n === 4;
}

function migrateLegacyStep(v1: LegacyStep): Step {
  // v1.step 1 (welcome) stays 1; 2/3/4 shift +1 (paths→3, encoder→4, quality→5).
  return v1 === 1 ? 1 : ((v1 + 1) as Step);
}

function clearLegacyDraft(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(ONBOARDING_DRAFT_KEY_V1);
  } catch {
    // non-fatal
  }
}

function readDraft(): OnboardingDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    // v2 wins if both present (race: stale tab restored v1 after v2 migration).
    const rawV2 = window.sessionStorage.getItem(ONBOARDING_DRAFT_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as Partial<OnboardingDraft>;
      if (!isValidStep(parsed.step)) {
        // v2 corrupt: leave both keys untouched (avoid silent data loss).
        return null;
      }
      // Housekeeping: remove v1 if it lingers alongside authoritative v2.
      clearLegacyDraft();
      return {
        step: parsed.step,
        pathsValues: parsed.pathsValues ?? null,
        qualityValues: parsed.qualityValues ?? null,
      };
    }

    // No v2 — check v1 (one-shot migration).
    const rawV1 = window.sessionStorage.getItem(ONBOARDING_DRAFT_KEY_V1);
    if (!rawV1) return null;

    let parsedV1: Partial<LegacyDraft>;
    try {
      parsedV1 = JSON.parse(rawV1) as Partial<LegacyDraft>;
    } catch {
      // Malformed JSON: leave both keys untouched (avoid silent data loss on
      // transient parse error — next stashDraft will overwrite v2 cleanly).
      return null;
    }

    if (!isValidLegacyStep(parsedV1.step)) {
      // Out-of-range (e.g., step:99): corrupt-data sweep — remove v1.
      clearLegacyDraft();
      return null;
    }

    // Valid v1 — migrate + remove v1 key (one-shot).
    const migrated: OnboardingDraft = {
      step: migrateLegacyStep(parsedV1.step),
      pathsValues: parsedV1.pathsValues ?? null,
      qualityValues: parsedV1.qualityValues ?? null,
    };
    clearLegacyDraft();
    return migrated;
  } catch {
    // sessionStorage disabled (private mode SecurityError / QuotaExceededError).
    return null;
  }
}

function clearDraft(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(ONBOARDING_DRAFT_KEY);
  } catch {
    // non-fatal
  }
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit & { method: string },
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export function OnboardingClient({
  initialSettings,
  locale,
  autoSkipPathsStep = false,
  placeholderSharePath = null,
}: {
  initialSettings: InitialSettings;
  locale: string;
  // 20-01: server-side flag + path (audit M2 invariant — true IMPLIES non-null
  // path, computed jointly in page.tsx). Defaults preserve 18-02 call-sites.
  autoSkipPathsStep?: boolean;
  placeholderSharePath?: string | null;
}) {
  const t = useTranslations('onboarding');
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const [pathsValues, setPathsValues] = useState<PathsStepValues | null>(null);
  const [detection, setDetection] = useState<DetectionPayload | null>(null);
  const [stashedQuality, setStashedQuality] = useState<QualityStepValues | null>(null);
  const [hydrated, setHydrated] = useState(false);
  // 20-01 (Task 2d): exactly-once toast guard. Refs persist across StrictMode
  // dev-mode double-mount so toast emits once even under React.StrictMode.
  const toastFiredRef = useRef(false);

  // 20-01: derived step-array per active branch. Internal `step` keeps the
  // legacy 1..5 union for v2 draft-compat (AC-7); `activeSteps` filters out
  // paths (index 3) when the skip-branch is active.
  const activeSteps = autoSkipPathsStep ? STEPS_SKIP : STEPS_FULL;
  const totalSteps = activeSteps.length;
  const visibleStep = Math.max(1, activeSteps.findIndex((s) => s.index === step) + 1);

  useEffect(() => {
    const draft = readDraft();
    if (draft) {
      // 20-01 (AC-7): in skip-branch, v2 draft.step=3 (paths in fallback
      // semantics) is invalid — reroute to step=2 (HwAccel) without losing
      // qualityValues. Clear stale pathsValues for the rerouted draft.
      if (autoSkipPathsStep && draft.step === 3) {
        // audit M1 (RESOLVED): explicit console.info — browser-safe, zero new
        // logging infra. Alternative pino-browser proxy rejected.
        console.info('wizard_draft_step_invalid_in_skip_branch', { old_step: 3, reroute_to: 2 });
        setStep(2);
        if (draft.qualityValues) setStashedQuality(draft.qualityValues);
      } else {
        setStep(draft.step);
        if (draft.pathsValues) setPathsValues(draft.pathsValues);
        if (draft.qualityValues) setStashedQuality(draft.qualityValues);
      }
    }
    setHydrated(true);
    // autoSkipPathsStep is a server-render-time constant per mount; including
    // it in deps is defensive — value won't change after hydration.
  }, [autoSkipPathsStep]);

  // 20-01 (Task 2d / AC-5): exactly-once skip-toast emission. M2 invariant
  // from server side guarantees placeholderSharePath is non-null when
  // autoSkipPathsStep===true — no client null-fallback.
  useEffect(() => {
    if (!autoSkipPathsStep) return;
    if (toastFiredRef.current) return;
    toastFiredRef.current = true;
    // audit S3 trust-boundary: sonner renders description as text-only (no
    // HTML / no dangerouslySetInnerHTML); ICU {path} interpolation is safe
    // — share paths are first-party operator-owned data.
    toast.info(t('paths.autoSkipToast.title'), {
      description: t('paths.autoSkipToast.description', { path: placeholderSharePath ?? '' }),
      action: {
        label: t('paths.autoSkipToast.actionLabel'),
        onClick: () => router.push(`/${locale}/settings#paths`),
      },
      duration: 4000,
    });
  }, [autoSkipPathsStep, placeholderSharePath, t, router, locale]);

  // 20-01 (audit M3 / AC-13): skip-branch step-state invariant guard. ANY
  // attempt to land step=3 (paths legacy index) under autoSkipPathsStep
  // re-routes to step=2 (HwAccel) + emits a warn-log. Catches corrupted-draft
  // races, hash-nav side-effects, future regression setStep(3) calls.
  useEffect(() => {
    if (autoSkipPathsStep && step === 3) {
      console.warn('wizard_skip_branch_step_invariant_violated', { old_value: 3, reroute_to: 2 });
      setStep(2);
    }
  }, [autoSkipPathsStep, step]);

  // 20-01: pre-seed pathsValues from placeholderShare so the final POST to
  // /api/onboarding/complete sends scan_root+min_size_mb matching the
  // placeholder verbatim. Backend's audit-log discriminator (Task 2-bis)
  // depends on the verbatim match to emit `wizard_completed_via_auto_skip_path`.
  useEffect(() => {
    if (!autoSkipPathsStep) return;
    if (placeholderSharePath === null) return;
    if (pathsValues !== null) return;
    setPathsValues({
      scan_root: placeholderSharePath,
      min_size_mb: Number(initialSettings.min_size_mb),
    });
  }, [autoSkipPathsStep, placeholderSharePath, pathsValues, initialSettings.min_size_mb]);

  const stashDraft = useCallback(
    (qualityValues?: QualityStepValues) => {
      if (typeof window === 'undefined') return;
      const draft: OnboardingDraft = {
        step,
        pathsValues,
        qualityValues: qualityValues ?? stashedQuality,
      };
      try {
        window.sessionStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(draft));
      } catch {
        // non-fatal — operator simply loses state-restore on this nav.
      }
    },
    [step, pathsValues, stashedQuality],
  );

  const handleStep1Continue = useCallback(() => {
    setStep(2);
  }, []);

  const handleHwAccelContinue = useCallback(() => {
    // 20-01: skip-branch jumps step 2 (HwAccel) → step 4 (Encoder), bypassing
    // paths (step 3). v2 internal numbering preserved for draft-compat.
    setStep(autoSkipPathsStep ? 4 : 3);
  }, [autoSkipPathsStep]);

  const handleDetectionResolved = useCallback((payload: DetectionPayload | 'error') => {
    if (payload !== 'error') {
      setDetection(payload);
    }
  }, []);

  const handleStep3Continue = useCallback((values: PathsStepValues) => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    try {
      // 14-04: scan_root / min_size_mb travel with final POST to
      // /api/onboarding/complete (translated into share create / PATCH).
      setPathsValues(values);
      setStep(4);
    } finally {
      submitLockRef.current = false;
    }
  }, []);

  const handleStep4Continue = useCallback(() => {
    // Detection already cached in state by EncoderStep (or earlier by HwAccelStep).
    setStep(5);
  }, []);

  const handleFinish = useCallback(
    async (values: QualityStepValues) => {
      if (submitLockRef.current) return;
      submitLockRef.current = true;
      setIsSubmitting(true);
      try {
        const putRes = await fetchWithTimeout('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            settings: {
              crf_libx265: String(values.crf_libx265),
              crf_nvenc: String(values.crf_nvenc),
              crf_qsv: String(values.crf_qsv),
              crf_vaapi: String(values.crf_vaapi),
            },
          }),
        });
        if (!putRes.ok) {
          toast.error(t('error.networkTimeout'));
          return;
        }
        const completeRes = await fetchWithTimeout('/api/onboarding/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            pathsValues
              ? {
                  scan_root: pathsValues.scan_root,
                  min_size_mb: Number(pathsValues.min_size_mb),
                }
              : {},
          ),
        });
        if (!completeRes.ok) {
          toast.error(t('error.networkTimeout'));
          return;
        }
        clearDraft();
        toast.success(t('complete.toast'));
        router.push(`/${locale}/library`);
      } catch {
        toast.error(t('error.networkTimeout'));
      } finally {
        setIsSubmitting(false);
        submitLockRef.current = false;
      }
    },
    [t, router, locale, pathsValues],
  );

  const handleBack = useCallback(() => {
    setStep((s) => {
      if (s <= 1) return s;
      // 20-01: skip-branch backward nav from step 4 (Encoder) lands on step 2
      // (HwAccel) without passing through step 3 (paths). All other backward
      // transitions decrement by 1 as before.
      if (autoSkipPathsStep && s === 4) return 2 as Step;
      return (s - 1) as Step;
    });
  }, [autoSkipPathsStep]);

  return (
    <div className="flex flex-col gap-8">
      <StepIndicator currentStep={visibleStep} totalSteps={totalSteps} />
      {hydrated && step === 1 && (
        <WelcomeStep onContinue={handleStep1Continue} isSubmitting={isSubmitting} />
      )}
      {hydrated && step === 2 && (
        <HwAccelStep
          cachedDetection={detection}
          onDetectionResolved={handleDetectionResolved}
          onContinue={handleHwAccelContinue}
          onBack={handleBack}
          isSubmitting={isSubmitting}
        />
      )}
      {/* 20-01: PathsStep never renders in skip-branch — invariant + render
          guard belt-and-suspenders. M3 useEffect reroutes step=3→2 on the
          next tick; this guard prevents the transient render in-between. */}
      {hydrated && step === 3 && !autoSkipPathsStep && (
        <PathsStep
          initialValues={{
            scan_root: pathsValues?.scan_root ?? initialSettings.scan_root,
            min_size_mb:
              pathsValues?.min_size_mb !== undefined
                ? String(pathsValues.min_size_mb)
                : initialSettings.min_size_mb,
          }}
          onContinue={handleStep3Continue}
          onBack={handleBack}
          isSubmitting={isSubmitting}
        />
      )}
      {hydrated && step === 4 && (
        <EncoderStep
          cachedDetection={detection}
          onDetectionResolved={handleDetectionResolved}
          onContinue={handleStep4Continue}
          onBack={handleBack}
          isSubmitting={isSubmitting}
        />
      )}
      {hydrated && step === 5 && (
        <QualityStep
          initialValues={{
            crf_libx265:
              stashedQuality?.crf_libx265 !== undefined
                ? String(stashedQuality.crf_libx265)
                : initialSettings.crf_libx265,
            crf_nvenc:
              stashedQuality?.crf_nvenc !== undefined
                ? String(stashedQuality.crf_nvenc)
                : initialSettings.crf_nvenc,
            crf_qsv:
              stashedQuality?.crf_qsv !== undefined
                ? String(stashedQuality.crf_qsv)
                : initialSettings.crf_qsv,
            crf_vaapi:
              stashedQuality?.crf_vaapi !== undefined
                ? String(stashedQuality.crf_vaapi)
                : initialSettings.crf_vaapi,
          }}
          onComplete={handleFinish}
          onBack={handleBack}
          isSubmitting={isSubmitting}
          onStashDraft={stashDraft}
        />
      )}
    </div>
  );
}
