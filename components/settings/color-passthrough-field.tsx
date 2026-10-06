'use client';

import * as React from 'react';
import { type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { FormControl, FormDescription, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { type FormValues } from '@/src/lib/api/settings-serialize';

// Color-passthrough card body — surfaces the backend color_passthrough setting.
// Single Switch, mirrors Force10BitField's force_10bit row (flex-row border row,
// text-base label + text-sm helper, aria-label). Default unchecked = unchanged
// encoder output (the UI-side guarantee of that contract for fresh installs).
type ColorPassthroughFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
};

export function ColorPassthroughField({
  control,
  t,
}: ColorPassthroughFieldProps): React.ReactElement {
  return (
    <FormField
      control={control}
      name="color_passthrough"
      render={({ field }) => (
        <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
          <div className="space-y-1">
            <FormLabel className="text-base">{t('field.colorPassthrough.label')}</FormLabel>
            <FormDescription className="text-sm">
              {t('field.colorPassthrough.helper')}
            </FormDescription>
          </div>
          <FormControl>
            <Switch
              checked={field.value}
              onCheckedChange={field.onChange}
              aria-label={t('field.colorPassthrough.label')}
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
}
