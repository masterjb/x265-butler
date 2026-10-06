'use client';

import * as React from 'react';
import { type UseFormReturn, useWatch } from 'react-hook-form';
import { useTranslations, useLocale } from 'next-intl';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Card, CardContent, CardHeader, CardDescription, CardTitle } from '@/components/ui/card';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
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
import { AMBER_ADVISORY_CLASS, INPUT_HEIGHT_CLASSES } from './settings-form-shared';
import { PRESETS_BY_ENCODER } from '@/src/lib/encode/presets';
// LEAF path on purpose — this file is 'use client', and profiles.ts /
// the encode barrel would drag node:os + pino into the client bundle.
import { QSV_QUALITY_PARAM_FALLBACK, resolveCrfParam } from '@/src/lib/encode/crf-defaults';
import type { EncoderId, QsvRateControl } from '@/src/lib/encode/profiles';
import { type FormValues } from '@/src/lib/api/settings-serialize';

// Per-encoder CRF + Preset Card, composed by settings-form.tsx.
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
  // The boot-resolved QSV ratecontrol tier, threaded from
  // detectEncoders() through settings/page.tsx → SettingsClient → SettingsForm.
  // undefined = both probe tiers failed, qsv was never probed, or the page's
  // detection catch-branch fired — the helper then names the FALLBACK the real
  // encode still emits, it does not go silent.
  qsvRateControl?: QsvRateControl;
  // Gate for the legacy-default advisory. Same EncoderDetectionState the
  // tier comes from, so the advisory can never fire on a host where qsv was not
  // actually detected.
  detectedEncoders?: EncoderId[];
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
  qsvRateControl,
  detectedEncoders,
}: CrfCardProps): React.ReactElement {
  const localeCode = useLocale();
  // The advisory reaches EXACTLY the population that still carries
  // the old QSV default seed on a host that really has QSV. `detectedEncoders` is
  // undefined on a caller that threads no detection at all, and ['libx265'] when
  // settings/page.tsx swallowed a probe error (:207-214) — neither may produce a
  // QSV recommendation, and `includes('qsv')` says so in both cases.
  const showQsvLegacyAdvisory =
    useWatch({ control: form.control, name: 'crf_qsv' }) === 22 &&
    (detectedEncoders ?? []).includes('qsv');
  return (
    <Card>
      {/* Title + description get the full card width; the bench controls
          live in their own framed panel below. Placing the RunModePicker
          (`w-full`) in a lg:flex-row next to the text would squeeze title +
          description into a narrow, tall strip. */}
      <CardHeader className="flex flex-col gap-4">
        <div className="space-y-1.5">
          <CardTitle>{t('section.crf.title')}</CardTitle>
          {/* The description does not claim one shared scale; it
              points at the empirical path. The link text is self-contained so it
              stays meaningful out of context (a11y link-purpose). */}
          <CardDescription>
            {t('section.crf.description')}{' '}
            <Link
              href={`/${localeCode}/bench`}
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            >
              {t('section.crf.benchLink')}
            </Link>
          </CardDescription>
        </div>
        <div
          role="group"
          aria-labelledby="crf-bench-panel-title"
          data-testid="crf-bench-panel"
          className="rounded-lg border border-border bg-muted/40 p-4"
        >
          <p id="crf-bench-panel-title" className="mb-3 text-sm font-medium text-foreground">
            {t('section.crf.benchPanel.title')}
          </p>
          <RunModePicker
            selectedRunId={pickerRunId}
            mode={pickerMode}
            selectionSource={pickerSource}
            selectionMode={pickerModeSource}
            onChange={onPickerChange}
            action={
              <ApplyFromBenchButton
                form={form}
                runId={applyButtonRunId}
                mode={pickerMode}
                selectionMeta={applyButtonMeta}
              />
            }
          />
        </div>
      </CardHeader>
      <CardContent>
        {/* One block per encoder. A fixed `grid-cols-[140px_1fr]` row would
            squeeze the longest helper (qsv: three sentences) into a tall 140 px
            strip while the Preset-Select stretched across the card. Instead
            both controls get content-sized columns (6rem / ≤14rem) and all
            prose runs full width underneath. From sm up a THIRD, empty 1fr
            track closes the row: `col-span-full` only spans the tracks that
            exist, so without it head, helpers and messages stopped after
            ~20rem while the divider ran across the whole card.
            Both FormItems are `display: contents` so their children become
            items of THIS grid and can be placed row by row — the helper and the
            message must stay inside their FormField render, because FormControl
            points aria-describedby at the ids useFormField() hands out
            (components/ui/form.tsx). Rendering them outside would leave the
            screen reader a dangling reference.
            No gap-y on purpose: empty rows (no error, no advisory) collapse to
            0 height, a row gap would still be drawn for them. */}
        <div className="divide-y divide-border">
          {(['libx265', 'nvenc', 'qsv', 'vaapi'] as const).map((encoder) => {
            const crfName = `crf_${encoder}` as const;
            const presetName = `preset_${encoder}` as const;
            const presetOptions = PRESETS_BY_ENCODER[encoder];
            const encoderName = t(`field.encoder.option.${encoder}`);
            const param = resolveCrfParam(encoder, qsvRateControl);
            const headingId = `crf-card-${encoder}-heading`;
            return (
              <div
                key={encoder}
                role="group"
                aria-labelledby={headingId}
                data-testid={`crf-row-${encoder}`}
                className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[6rem_14rem_minmax(0,1fr)]"
              >
                <div className="col-span-full row-start-1 flex items-baseline justify-between gap-2">
                  <p id={headingId} className="text-sm font-medium text-foreground">
                    {encoderName}
                  </p>
                  <code
                    data-testid={`crf-param-${encoder}`}
                    aria-label={t('section.crf.paramBadge', { param })}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                  >
                    {param}
                  </code>
                </div>
                <FormField
                  control={form.control}
                  name={crfName}
                  render={({ field, fieldState }) => (
                    <FormItem className="contents">
                      {/* The label holds ONLY the long, unique name;
                          the visible short "CRF" lives outside it, so the
                          accessible name never reads "CRF CRF for qsv". */}
                      <FormLabel className="sr-only">{t(`field.${crfName}.label`)}</FormLabel>
                      <span
                        aria-hidden="true"
                        className="col-start-1 row-start-2 mt-3 text-sm font-medium leading-none text-foreground"
                      >
                        {t('section.crf.crfShort')}
                      </span>
                      <FormControl
                        className="col-start-1 row-start-3 mt-1.5 w-24"
                        data-testid={`crf-input-wrap-${encoder}`}
                      >
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
                      <FormMessage className="col-span-full row-start-4 mt-1.5">
                        {localizeError(fieldState.error?.message)}
                      </FormMessage>
                      <FormDescription className="col-span-full row-start-6 mt-2 text-sm">
                        {encoder === 'qsv'
                          ? qsvRateControl === undefined
                            ? t('field.crf_qsv.helperUnknown', {
                                param: QSV_QUALITY_PARAM_FALLBACK,
                              })
                            : t('field.crf_qsv.helper')
                          : t(`field.${crfName}.helper`)}
                      </FormDescription>
                      {/* Display-only. No setValue, no auto-save —
                          it dissolves as soon as the operator edits the field.
                          Icon + text so the amber is not the only carrier
                          (color-not-alone); role="status" announces politely. */}
                      {encoder === 'qsv' && showQsvLegacyAdvisory ? (
                        <div
                          role="status"
                          className={`${AMBER_ADVISORY_CLASS} col-span-full row-start-8 mt-2`}
                        >
                          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                          <p className="flex-1 leading-relaxed">
                            {t('field.crf_qsv.advisoryLegacyDefault')}
                          </p>
                        </div>
                      ) : null}
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={presetName}
                  render={({ field, fieldState }) => (
                    <FormItem className="contents">
                      <span
                        aria-hidden="true"
                        className="col-start-2 row-start-2 mt-3 text-sm font-medium leading-none text-foreground"
                      >
                        {t('section.crf.preset.label')}
                      </span>
                      <FormControl className="col-start-2 row-start-3 mt-1.5 min-w-0">
                        <Select
                          value={typeof field.value === 'string' ? field.value : ''}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger
                            className={`${INPUT_HEIGHT_CLASSES} w-full`}
                            aria-label={t('section.crf.preset.labelFor', {
                              encoder: encoderName,
                            })}
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
                      <FormMessage className="col-span-full row-start-5 mt-1.5">
                        {localizeError(fieldState.error?.message)}
                      </FormMessage>
                      <FormDescription className="col-span-full row-start-7 mt-1 text-sm">
                        {t(`section.crf.preset.helper.${encoder}`)}
                      </FormDescription>
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
