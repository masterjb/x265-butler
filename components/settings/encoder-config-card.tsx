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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EncoderWarningsBadge } from './encoder-warnings-badge';
import { cn } from '@/lib/utils';
import { type FormValues } from '@/src/lib/api/settings-serialize';
import {
  ENCODER_DISPLAY_ORDER,
  INPUT_HEIGHT_CLASSES,
  type EncoderDetectionState,
} from './settings-form-shared';

// 28-10: Encoder-config Card extracted from settings-form.tsx (L2 split). Renders
// the Detected pill row + encoder Select + concurrency Select. `id="encoder-config"`
// is the deeplink anchor (18-01) — must stay on the outer Card.
type EncoderConfigCardProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  localizeError: (message: string | undefined) => string | undefined;
  detection?: EncoderDetectionState;
};

export function EncoderConfigCard({
  control,
  t,
  localizeError,
  detection,
}: EncoderConfigCardProps): React.ReactElement {
  return (
    <Card id="encoder-config">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <CardTitle>{t('section.encoder.title')}</CardTitle>
            <CardDescription>{t('section.encoder.description')}</CardDescription>
          </div>
          {/* 18-01: badge surfaces structured detection-warnings adjacent
              to the section header. Hidden (returns null) when there are
              no warnings, so the layout stays identical for happy-path. */}
          <EncoderWarningsBadge />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {/* 03-03 audit S1: Detected pill row above the encoder Select.
            Each pill carries an explicit aria-label for screen readers. */}
        {detection && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-foreground">{t('encoder.detected.heading')}</p>
            <div
              role="list"
              className="flex flex-wrap items-center gap-2"
              aria-label={t('encoder.detected.heading')}
            >
              {ENCODER_DISPLAY_ORDER.map((id) => {
                const present = detection.detectedEncoders.includes(id);
                const isLibx265 = id === 'libx265';
                const ariaLabel = isLibx265
                  ? t('encoder.detected.pill.libx265')
                  : present
                    ? t('encoder.detected.pill.available', { encoder: id })
                    : t('encoder.detected.pill.unavailable', { encoder: id });
                return (
                  <span
                    key={id}
                    role="listitem"
                    aria-label={ariaLabel}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium font-mono',
                      present
                        ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                        : 'border border-border bg-muted text-muted-foreground line-through opacity-70',
                    )}
                  >
                    <span aria-hidden="true">{present ? '✓' : '✗'}</span>
                    {id}
                  </span>
                );
              })}
            </div>
            <p
              className="text-sm text-muted-foreground"
              aria-label={t('encoder.active.aria', {
                encoder: detection.activeEncoder,
                resolution: detection.encoderResolution,
              })}
            >
              {t('encoder.active.line', {
                encoder: detection.activeEncoder,
                resolution: detection.encoderResolution,
              })}
              {detection.vaapiDevice && detection.activeEncoder === 'vaapi' && (
                <>
                  {' '}
                  <span className="font-mono">[{detection.vaapiDevice}]</span>
                </>
              )}
            </p>
            {detection.encoderResolution === 'fallback' && detection.requestedButUnavailable && (
              <p role="alert" className="text-sm font-medium text-amber-600 dark:text-amber-400">
                ⚠{' '}
                {t('encoder.active.fallbackLine', {
                  requested: detection.requestedButUnavailable,
                })}
              </p>
            )}
          </div>
        )}

        <FormField
          control={control}
          name="encoder"
          render={({ field, fieldState }) => (
            <FormItem>
              <FormLabel>{t('field.encoder.label')}</FormLabel>
              <FormControl>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger className={INPUT_HEIGHT_CLASSES}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{t('field.encoder.option.auto')}</SelectItem>
                    <SelectItem value="nvenc">{t('field.encoder.option.nvenc')}</SelectItem>
                    <SelectItem value="qsv">{t('field.encoder.option.qsv')}</SelectItem>
                    <SelectItem value="vaapi">{t('field.encoder.option.vaapi')}</SelectItem>
                    <SelectItem value="libx265">{t('field.encoder.option.libx265')}</SelectItem>
                  </SelectContent>
                </Select>
              </FormControl>
              <FormDescription className="text-sm">{t('field.encoder.helper')}</FormDescription>
              <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="concurrency"
          render={({ field, fieldState }) => (
            <FormItem>
              <FormLabel>{t('field.concurrency.label')}</FormLabel>
              <FormControl>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger className={INPUT_HEIGHT_CLASSES}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{t('field.concurrency.option.auto')}</SelectItem>
                    {(['1', '2', '3', '4', '5', '6', '7', '8'] as const).map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormControl>
              <FormDescription className="text-sm">{t('field.concurrency.helper')}</FormDescription>
              <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
            </FormItem>
          )}
        />
      </CardContent>
    </Card>
  );
}
