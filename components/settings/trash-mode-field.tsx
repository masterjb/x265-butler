'use client';

import * as React from 'react';
import { useWatch, type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { FormControl, FormDescription, FormField, FormItem, FormLabel } from '@/components/ui/form';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { type FormValues } from '@/src/lib/api/settings-serialize';
import { TRASH_LOCATIONS, type TrashLocation } from '@/src/lib/encode/trash-defaults';

// Trash on/off plus where the trash lives. When the trash is off the location
// stays mounted (form state kept) but is disabled, and a warning says that
// originals are removed for good. A set trash_path below overrides the
// location; the hint says so instead of hiding the choice.
type TrashModeFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
};

export function TrashModeField({ control, t }: TrashModeFieldProps): React.ReactElement {
  const enabled = useWatch({ control, name: 'trash_enabled' }) !== false;
  const customPath = useWatch({ control, name: 'trash_path' }) ?? '';
  const pathOverrides = customPath.trim() !== '';

  return (
    <div className="space-y-5">
      <FormField
        control={control}
        name="trash_enabled"
        render={({ field }) => (
          <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
            <div className="space-y-1">
              <FormLabel className="text-base">{t('field.trashMode.enabled.label')}</FormLabel>
              <FormDescription className="text-sm">
                {t('field.trashMode.enabled.helper')}
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                aria-label={t('field.trashMode.enabled.label')}
              />
            </FormControl>
          </FormItem>
        )}
      />
      {!enabled && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('field.trashMode.offWarning')}</span>
        </p>
      )}
      <FormField
        control={control}
        name="trash_location"
        render={({ field }) => (
          <FormItem className={cn(!enabled && 'opacity-50')}>
            <FormLabel>{t('field.trashMode.location.label')}</FormLabel>
            <FormControl>
              <RadioGroup
                value={field.value}
                onValueChange={(v) => {
                  if ((TRASH_LOCATIONS as readonly string[]).includes(v)) {
                    field.onChange(v as TrashLocation);
                  }
                }}
                disabled={!enabled}
                className="grid gap-2"
              >
                {TRASH_LOCATIONS.map((loc) => (
                  <label
                    key={loc}
                    className={cn(
                      'flex min-h-11 items-start gap-3 rounded-md border p-3 transition-colors',
                      enabled ? 'cursor-pointer' : 'cursor-not-allowed',
                      field.value === loc
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-card hover:bg-muted',
                    )}
                  >
                    <RadioGroupItem value={loc} className="mt-0.5" />
                    <span className="space-y-0.5">
                      <span className="block text-sm font-medium text-foreground">
                        {t(`field.trashMode.location.${loc}.label`)}
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        {t(`field.trashMode.location.${loc}.helper`)}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </FormControl>
            {pathOverrides && (
              <FormDescription className="text-sm">
                {t('field.trashMode.location.overridden')}
              </FormDescription>
            )}
          </FormItem>
        )}
      />
    </div>
  );
}
