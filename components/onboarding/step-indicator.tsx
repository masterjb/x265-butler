'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

// 03-05 Plan Task 2 — wizard step indicator.
// audit S1 a11y: role="progressbar" + aria-valuenow/min/max + aria-label
// conveys state by SHAPE (filled vs hollow) NOT only color (color-not-only).
// Container is NOT keyboard-focusable — operator cannot jump steps.
// 20-01 (Task 1b / AC-6): `totalSteps` optional prop defaults to 5; skip-branch
// passes 4 to render a 4-dot track. STEP_KEYS_FULL/SKIP map visible position
// to headline-i18n-key so aria-name stays correct in both branches.

export type StepName = 'welcome' | 'hwAccel' | 'paths' | 'encoder' | 'quality';

const STEP_KEYS_FULL: readonly StepName[] = [
  'welcome',
  'hwAccel',
  'paths',
  'encoder',
  'quality',
] as const;

const STEP_KEYS_SKIP: readonly StepName[] = ['welcome', 'hwAccel', 'encoder', 'quality'] as const;

// Maps a StepName to its existing onboarding.step{N}.headline i18n key — keeps
// aria-name correct under both totalSteps={5} (full) and {4} (skip-branch).
const HEADLINE_KEY_BY_STEP_KEY: Record<StepName, string> = {
  welcome: 'step1.headline',
  hwAccel: 'step2.headline',
  paths: 'step3.headline',
  encoder: 'step4.headline',
  quality: 'step5.headline',
};

export function StepIndicator({
  currentStep,
  totalSteps = 5,
}: {
  currentStep: number;
  totalSteps?: number;
}) {
  const t = useTranslations('onboarding');
  const stepKeys = totalSteps === 4 ? STEP_KEYS_SKIP : STEP_KEYS_FULL;
  const total = totalSteps;
  const currentKey = stepKeys[currentStep - 1] ?? stepKeys[0];
  const currentName = t(HEADLINE_KEY_BY_STEP_KEY[currentKey]);

  return (
    <div
      role="progressbar"
      aria-valuenow={currentStep}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={t('indicator.aria', { current: currentStep, total, name: currentName })}
      tabIndex={-1}
      className="flex items-center justify-center gap-2"
    >
      {stepKeys.map((key, idx) => {
        const stepNum = idx + 1;
        const isCompleted = stepNum < currentStep;
        const isCurrent = stepNum === currentStep;
        const isFilled = isCompleted || isCurrent;
        return (
          <div key={key} className="flex items-center gap-2">
            <span
              className={cn(
                // shape conveys state — filled (border + bg) vs hollow (border only)
                'inline-flex h-3 w-3 rounded-full border-2 transition-colors motion-safe:duration-200',
                isFilled
                  ? 'border-primary bg-primary'
                  : 'border-muted-foreground/40 bg-transparent',
                isCurrent && 'ring-2 ring-primary/30 ring-offset-2 ring-offset-background',
              )}
              aria-hidden="true"
            />
            {idx < stepKeys.length - 1 && (
              <span
                className={cn(
                  'h-0.5 w-8 rounded-full',
                  isCompleted ? 'bg-primary' : 'bg-muted-foreground/30',
                )}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
