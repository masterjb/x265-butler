'use client';

import * as React from 'react';
import { type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { FormControl, FormDescription, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { type FormValues } from '@/src/lib/api/settings-serialize';

// Switch for vaapi_hw_decode, same row layout as ResumeAfterRestartField. The
// label is tied to the switch, so the whole label text toggles it.
type HwDecodeFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
};

export function HwDecodeField({ control, t }: HwDecodeFieldProps): React.ReactElement {
  return (
    <FormField
      control={control}
      name="vaapi_hw_decode"
      render={({ field }) => (
        <FormItem className="flex min-h-11 flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
          <div className="space-y-1">
            <FormLabel className="text-base">{t('field.hwDecode.label')}</FormLabel>
            <FormDescription className="text-sm">{t('field.hwDecode.helper')}</FormDescription>
          </div>
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}
