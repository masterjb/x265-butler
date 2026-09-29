'use client';

import * as React from 'react';
import { type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
// 05-13: shadcn Slider primitive for the min_savings_percent threshold
// (Encoder tab). Imported directly to attach getAriaValueText on the Thumb
// for screen-reader announcement (audit S4) — generic Slider wrapper
// in components/ui/slider.tsx does not expose Thumb-level ARIA hooks.
import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { type FormValues } from '@/src/lib/api/settings-serialize';

// 28-10: Minimum-Savings-Threshold Card extracted from settings-form.tsx (L2 split).
// Slider primitive used inline so getAriaValueText (audit S4) lands on the Thumb.
type MinSavingsCardProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  localizeError: (message: string | undefined) => string | undefined;
};

export function MinSavingsCard({
  control,
  t,
  localizeError,
}: MinSavingsCardProps): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('section.minSavings.title')}</CardTitle>
        <CardDescription>{t('section.minSavings.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <FormField
          control={control}
          name="min_savings_percent"
          render={({ field, fieldState }) => {
            const v = typeof field.value === 'number' ? field.value : 5;
            return (
              <FormItem>
                <FormLabel>{t('field.minSavings.label')}</FormLabel>
                <FormControl>
                  {/* 05-13 UAT-fix (option-F): cross-color-family contrast for
                      track-vs-indicator. Pre-fix: track bg-secondary (Blue 500) +
                      indicator bg-primary (Blue 800) — both blue, low fill/empty
                      separation. Post-fix: track in slate-300 / dark:slate-600
                      (neutral gray ≥4:1 in both modes), indicator stays bg-primary
                      (blue) — clear color-family swap so the filled portion is
                      visually distinct from the rail. Track height h-3 (12px) +
                      token-compliant thumb (bg-background border-2 border-primary).
                      Tick scale below shows operator the granularity (0/10/20/30/40/50). */}
                  {/* 05-13 UAT-fix round 3: drop `data-horizontal:` Tailwind
                      prefixes — globals.css defines no custom variant for it
                      (only `dark`), and base-ui Slider emits `data-orientation`,
                      not `data-horizontal`. Result was track height resolving to
                      0 → invisible. Fixed by using plain h-3 / w-full / h-full. */}
                  <div className="space-y-2">
                    <SliderPrimitive.Root
                      min={0}
                      max={50}
                      step={1}
                      value={[v]}
                      onValueChange={(next) => {
                        const arr = Array.isArray(next) ? next : [next];
                        field.onChange(arr[0]);
                      }}
                      className="w-full"
                      aria-label={t('field.minSavings.label')}
                    >
                      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none py-3">
                        <SliderPrimitive.Track className="relative h-3 w-full grow overflow-hidden rounded-full bg-slate-300 select-none dark:bg-slate-600">
                          <SliderPrimitive.Indicator
                            data-slot="slider-range"
                            className="h-full bg-primary select-none"
                          />
                        </SliderPrimitive.Track>
                        <SliderPrimitive.Thumb
                          data-slot="slider-thumb"
                          getAriaValueText={(value) =>
                            t('field.minSavings.aria.valuetext', { value })
                          }
                          className="relative block size-5 shrink-0 rounded-full border-2 border-primary bg-background ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50"
                        />
                      </SliderPrimitive.Control>
                    </SliderPrimitive.Root>
                    {/* Tick scale — 6 marks at 0/10/20/30/40/50% of range
                        (= values 0/10/20/30/40/50). flex-justify-between
                        aligns endpoints with track ends; px-[10px] offsets the
                        inner ticks so they sit visually under the track-pixel
                        positions (matches Thumb size-5/2 = 10px center offset). */}
                    <div
                      aria-hidden="true"
                      className="flex w-full justify-between px-[10px] text-xs text-muted-foreground"
                    >
                      {[0, 10, 20, 30, 40, 50].map((mark) => (
                        <span key={mark} className="flex flex-col items-center gap-1 leading-none">
                          <span className="block h-1.5 w-px bg-muted-foreground/50" />
                          <span className="font-mono tabular-nums">{mark}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </FormControl>
                <FormDescription className="text-sm" aria-live="polite" aria-atomic="true">
                  <span className="font-mono tabular-nums tracking-tight mr-2 text-foreground">
                    {v}%
                  </span>
                  {t('field.minSavings.helper.template', { value: v })}
                </FormDescription>
                <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
              </FormItem>
            );
          }}
        />
      </CardContent>
    </Card>
  );
}
