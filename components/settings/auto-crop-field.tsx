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
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { type FormValues } from '@/src/lib/api/settings-serialize';

// 35-02: Auto-Crop card body — surfaces 35-01's backend auto_crop + crop_override.
// BOTH fields are ALWAYS editable (no gating/disabled dimming): per the 35-01
// resolve a valid override WINS over the toggle, so dimming the override when the
// toggle is off would mislead. The Switch mirrors preferences-card's
// auto_enqueue_after_scan (flex-row border row, text-base label + text-sm helper,
// aria-label). The Input mirrors trash-path-field (h-11 lg:h-9, autoComplete off,
// persistent FormDescription not placeholder-only, FormMessage via localizeError).
type AutoCropFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  localizeError: (message: string | undefined) => string | undefined;
};

export function AutoCropField({
  control,
  t,
  localizeError,
}: AutoCropFieldProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-5">
      <FormField
        control={control}
        name="auto_crop"
        render={({ field }) => (
          <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
            <div className="space-y-1">
              <FormLabel className="text-base">{t('field.autoCrop.label')}</FormLabel>
              <FormDescription className="text-sm">{t('field.autoCrop.helper')}</FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                aria-label={t('field.autoCrop.label')}
              />
            </FormControl>
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="crop_override"
        render={({ field, fieldState }) => (
          <FormItem>
            <FormLabel>{t('field.cropOverride.label')}</FormLabel>
            <FormControl>
              <Input
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                className="h-11 lg:h-9"
                placeholder={t('field.cropOverride.placeholder')}
                value={field.value ?? ''}
                onChange={field.onChange}
                onBlur={field.onBlur}
                name={field.name}
                ref={field.ref}
              />
            </FormControl>
            <FormDescription>{t('field.cropOverride.description')}</FormDescription>
            <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
          </FormItem>
        )}
      />
    </div>
  );
}
