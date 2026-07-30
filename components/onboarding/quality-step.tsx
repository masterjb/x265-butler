'use client';

import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AutoScanAwareness } from '@/components/onboarding/auto-scan-awareness';
import { CRFExplainer } from '@/components/onboarding/crf-explainer';
import type { EncoderId } from '@/src/lib/encode/profiles';

// 03-05 Plan Task 2 — wizard step 4 (Quality / CRF defaults).
// audit S2 focus-management: first CRF input auto-focused.
// audit M5: in-flight button-disable on Finish + Back.

const crfField = z.number().int().min(0).max(51);

const qualitySchema = z.object({
  crf_libx265: crfField,
  crf_nvenc: crfField,
  crf_qsv: crfField,
  crf_vaapi: crfField,
});

export type QualityStepValues = z.infer<typeof qualitySchema>;

const FIELDS = [
  { key: 'crf_libx265', label: 'libx265', encoder: 'libx265' as EncoderId },
  { key: 'crf_nvenc', label: 'NVENC', encoder: 'nvenc' as EncoderId },
  { key: 'crf_qsv', label: 'QSV', encoder: 'qsv' as EncoderId },
  { key: 'crf_vaapi', label: 'VAAPI', encoder: 'vaapi' as EncoderId },
] as const;

export function QualityStep({
  initialValues,
  onComplete,
  onBack,
  isSubmitting,
  onStashDraft,
}: {
  initialValues: {
    crf_libx265: string;
    crf_nvenc: string;
    crf_qsv: string;
    crf_vaapi: string;
  };
  onComplete: (values: QualityStepValues) => void;
  onBack: () => void;
  isSubmitting: boolean;
  // 16-03 deep-link state-loss fix: receives current form values for
  // sessionStorage persistence BEFORE operator clicks Awareness deep-link
  // and navigates away to /settings#auto-scan.
  onStashDraft?: (values: QualityStepValues) => void;
}) {
  const t = useTranslations('onboarding');
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const form = useForm<QualityStepValues>({
    resolver: zodResolver(qualitySchema),
    mode: 'onChange',
    defaultValues: {
      crf_libx265: Number(initialValues.crf_libx265),
      crf_nvenc: Number(initialValues.crf_nvenc),
      crf_qsv: Number(initialValues.crf_qsv),
      crf_vaapi: Number(initialValues.crf_vaapi),
    },
  });

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const { ref: firstHookRef, ...firstRest } = form.register('crf_libx265', {
    valueAsNumber: true,
  });

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 p-8">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('step5.headline')}
          </h1>
          <p className="text-base text-muted-foreground">{t('step5.body')}</p>
        </div>
        <form onSubmit={form.handleSubmit(onComplete)} className="flex flex-col gap-5" noValidate>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {FIELDS.map((field, idx) => {
              const isFirst = idx === 0;
              const errorMsg = form.formState.errors[field.key]?.message;
              const liveValue = form.watch(field.key);
              return (
                <div key={field.key} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <label htmlFor={field.key} className="text-sm font-medium">
                      {field.label}
                    </label>
                    <CRFExplainer encoder={field.encoder} currentValue={liveValue} />
                  </div>
                  {isFirst ? (
                    <Input
                      id={field.key}
                      type="number"
                      min={0}
                      max={51}
                      step={1}
                      {...firstRest}
                      ref={(el) => {
                        firstHookRef(el);
                        firstFieldRef.current = el;
                      }}
                      aria-invalid={Boolean(errorMsg)}
                    />
                  ) : (
                    <Input
                      id={field.key}
                      type="number"
                      min={0}
                      max={51}
                      step={1}
                      {...form.register(field.key, { valueAsNumber: true })}
                      aria-invalid={Boolean(errorMsg)}
                    />
                  )}
                  {errorMsg && (
                    <p className="text-xs text-destructive" role="alert">
                      0–51
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <AutoScanAwareness
            onDeepLinkClick={() => {
              if (!onStashDraft) return;
              const raw = form.getValues();
              const normalized: QualityStepValues = {
                crf_libx265: Number.isFinite(raw.crf_libx265) ? raw.crf_libx265 : 23,
                crf_nvenc: Number.isFinite(raw.crf_nvenc) ? raw.crf_nvenc : 23,
                crf_qsv: Number.isFinite(raw.crf_qsv) ? raw.crf_qsv : 22,
                crf_vaapi: Number.isFinite(raw.crf_vaapi) ? raw.crf_vaapi : 22,
              };
              onStashDraft(normalized);
            }}
          />

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
              type="submit"
              disabled={isSubmitting || !form.formState.isValid}
              aria-disabled={isSubmitting || !form.formState.isValid}
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {t('step5.cta.finish')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
