'use client';

import * as React from 'react';
import { type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { FormControl, FormDescription, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { type FormValues } from '@/src/lib/api/settings-serialize';
import { MAX_RESTART_INTERRUPTIONS } from '@/src/lib/encode/restart-resume';

// Switch for resume_after_restart, same row layout as Force10BitField. The
// label is tied to the switch, so the whole label text toggles it.
type ResumeAfterRestartFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
};

export function ResumeAfterRestartField({
  control,
  t,
}: ResumeAfterRestartFieldProps): React.ReactElement {
  return (
    <FormField
      control={control}
      name="resume_after_restart"
      render={({ field }) => (
        <FormItem className="flex min-h-11 flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
          <div className="space-y-1">
            <FormLabel className="text-base">{t('field.resumeAfterRestart.label')}</FormLabel>
            <FormDescription className="text-sm">
              {t('field.resumeAfterRestart.helper', { max: MAX_RESTART_INTERRUPTIONS })}
            </FormDescription>
          </div>
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}
