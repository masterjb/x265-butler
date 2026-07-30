'use client';

import * as React from 'react';
import { type UseFormReturn } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Card, CardContent, CardHeader, CardDescription, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApplyFromBenchButton, type SelectionMeta } from './apply-from-bench-button';
import { RunModePicker, type PickerMode, type PickerChange } from './run-mode-picker';
import { INPUT_HEIGHT_CLASSES } from './settings-form-shared';
import { PRESETS_BY_ENCODER } from '@/src/lib/encode/presets';
import { type FormValues } from '@/src/lib/api/settings-serialize';

// 28-10: per-encoder CRF + Preset Card extracted from settings-form.tsx (L2 split).
// Hosts the RunModePicker + ApplyFromBenchButton header controls; the picker state
// is owned by the orchestrator and threaded down as props (single source of truth).
type CrfCardProps = {
  form: UseFormReturn<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  localizeError: (message: string | undefined) => string | undefined;
  pickerRunId: number | null;
  pickerMode: PickerMode;
  pickerSource: 'default' | 'operator';
  pickerModeSource: 'default' | 'operator';
  onPickerChange: (next: PickerChange) => void;
  applyButtonRunId: number | undefined;
  applyButtonMeta: SelectionMeta;
};

export function CrfCard({
  form,
  t,
  localizeError,
  pickerRunId,
  pickerMode,
  pickerSource,
  pickerModeSource,
  onPickerChange,
  applyButtonRunId,
  applyButtonMeta,
}: CrfCardProps): React.ReactElement {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex-1 space-y-1.5">
          <CardTitle>{t('section.crf.title')}</CardTitle>
          <CardDescription>{t('section.crf.description')}</CardDescription>
        </div>
        {/* 12-04 T0 sub-3: mobile stack-order RunPicker → ModeToggle → ApplyButton.
            On lg+ the picker sits left of the action button. */}
        <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-end lg:gap-4">
          <RunModePicker
            selectedRunId={pickerRunId}
            mode={pickerMode}
            selectionSource={pickerSource}
            selectionMode={pickerModeSource}
            onChange={onPickerChange}
          />
          <div className="flex justify-end lg:justify-start">
            <ApplyFromBenchButton
              form={form}
              runId={applyButtonRunId}
              mode={pickerMode}
              selectionMeta={applyButtonMeta}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* 12-03 T0 sub-2=A side-by-side flex + sub-3=A CRF-above-Preset
            on ≤640px stack. Each row pairs a CRF number-input with the
            encoder's Preset-Select (shadcn Select per T0 sub-1=A). On
            desktop the row uses a 2-col grid (CRF compact + Preset
            fills); on mobile both fields stack with CRF first. */}
        <div className="space-y-5">
          {(['libx265', 'nvenc', 'qsv', 'vaapi'] as const).map((encoder) => {
            const crfName = `crf_${encoder}` as const;
            const presetName = `preset_${encoder}` as const;
            const presetOptions = PRESETS_BY_ENCODER[encoder];
            return (
              <div
                key={encoder}
                className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr] sm:items-start"
              >
                <FormField
                  control={form.control}
                  name={crfName}
                  render={({ field, fieldState }) => (
                    <FormItem>
                      <FormLabel>{t(`field.${crfName}.label`)}</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={51}
                          {...field}
                          onChange={(e) => field.onChange(e.target.valueAsNumber)}
                          className={INPUT_HEIGHT_CLASSES}
                        />
                      </FormControl>
                      <FormDescription className="text-sm">
                        {t(`field.${crfName}.helper`)}
                      </FormDescription>
                      <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={presetName}
                  render={({ field, fieldState }) => (
                    <FormItem>
                      <FormLabel>{t('section.crf.preset.label')}</FormLabel>
                      <FormControl>
                        <Select
                          value={typeof field.value === 'string' ? field.value : ''}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger
                            className={INPUT_HEIGHT_CLASSES}
                            aria-label={t('section.crf.preset.label')}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {presetOptions.map((value) => (
                              <SelectItem key={value} value={value}>
                                {t(`section.crf.preset.option.${encoder}.${value}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormDescription className="text-sm">
                        {t(`section.crf.preset.helper.${encoder}`)}
                      </FormDescription>
                      <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
                    </FormItem>
                  )}
                />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
