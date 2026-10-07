'use client';

import * as React from 'react';
import { useWatch, type Control } from 'react-hook-form';
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
import {
  MAX_TRASH_RETENTION_DAYS,
  MIN_TRASH_RETENTION_DAYS,
} from '@/src/lib/encode/trash-defaults';
import { INPUT_HEIGHT_CLASSES } from './settings-form-shared';

type TrashRetentionFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  localizeError: (message: string | undefined) => string | undefined;
};

export function TrashRetentionField({
  control,
  t,
  localizeError,
}: TrashRetentionFieldProps): React.ReactElement {
  // Kept mounted when the trash is off (form state preserved), but disabled.
  const enabled = useWatch({ control, name: 'trash_enabled' }) !== false;
  return (
    <FormField
      control={control}
      name="trash_retention_days"
      render={({ field, fieldState }) => (
        <FormItem className={cn(!enabled && 'opacity-50')}>
          <FormLabel>{t('field.trashRetention.label')}</FormLabel>
          <div className="flex items-center gap-2">
            <FormControl>
              <Input
                type="number"
                inputMode="numeric"
                min={MIN_TRASH_RETENTION_DAYS}
                max={MAX_TRASH_RETENTION_DAYS}
                step={1}
                disabled={!enabled}
                className={cn(INPUT_HEIGHT_CLASSES, 'w-28 tabular-nums')}
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                value={Number.isNaN(field.value) ? '' : field.value}
                onChange={(e) => field.onChange(e.target.valueAsNumber)}
              />
            </FormControl>
            <span className="text-sm text-muted-foreground">{t('field.trashRetention.unit')}</span>
          </div>
          <FormDescription className="text-sm">{t('field.trashRetention.helper')}</FormDescription>
          <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
        </FormItem>
      )}
    />
  );
}
