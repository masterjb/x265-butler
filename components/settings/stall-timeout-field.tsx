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
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { type FormValues } from '@/src/lib/api/settings-serialize';
import { MAX_STALL_TIMEOUT_MINUTES } from '@/src/lib/encode/stall-defaults';
import { INPUT_HEIGHT_CLASSES } from './settings-form-shared';

type StallTimeoutFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  localizeError: (message: string | undefined) => string | undefined;
};

export function StallTimeoutField({
  control,
  t,
  localizeError,
}: StallTimeoutFieldProps): React.ReactElement {
  return (
    <FormField
      control={control}
      name="stall_timeout_minutes"
      render={({ field, fieldState }) => (
        <FormItem>
          <FormLabel>{t('field.stallTimeout.label')}</FormLabel>
          <div className="flex items-center gap-2">
            <FormControl>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_STALL_TIMEOUT_MINUTES}
                step={1}
                className={cn(INPUT_HEIGHT_CLASSES, 'w-28 tabular-nums')}
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                value={Number.isNaN(field.value) ? '' : field.value}
                onChange={(e) => field.onChange(e.target.valueAsNumber)}
              />
            </FormControl>
            <span className="text-sm text-muted-foreground">{t('field.stallTimeout.unit')}</span>
          </div>
          <FormDescription className="text-sm">{t('field.stallTimeout.helper')}</FormDescription>
          <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
        </FormItem>
      )}
    />
  );
}
