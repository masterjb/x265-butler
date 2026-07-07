'use client';

import * as React from 'react';
import { type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { FormControl, FormDescription, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { type FormValues } from '@/src/lib/api/settings-serialize';

// 43-01: Force-10bit card body — surfaces 43-01's backend force_10bit. Single
// Switch, mirrors AutoCropField's auto_crop row (flex-row border row, text-base
// label + text-sm helper, aria-label). Default unchecked = byte-identical pre-43
// (the UI-side guarantee of the AC-1 byte-identical contract for fresh installs).
type Force10BitFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
};

export function Force10BitField({ control, t }: Force10BitFieldProps): React.ReactElement {
  return (
    <FormField
      control={control}
      name="force_10bit"
      render={({ field }) => (
        <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
          <div className="space-y-1">
            <FormLabel className="text-base">{t('field.force10bit.label')}</FormLabel>
            <FormDescription className="text-sm">{t('field.force10bit.helper')}</FormDescription>
          </div>
          <FormControl>
            <Switch
              checked={field.value}
              onCheckedChange={field.onChange}
              aria-label={t('field.force10bit.label')}
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
}
