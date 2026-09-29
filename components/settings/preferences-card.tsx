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
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { OutputSuffixField } from './output-suffix-field';
import { type FormValues } from '@/src/lib/api/settings-serialize';

// 28-10: General-tab Preferences Card extracted from settings-form.tsx (L2 split).
// Hosts language + theme selects, the two encode-behavior switches, and the
// container-aware OutputSuffixField (relocated sibling).
type PreferencesCardProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  localizeError: (message: string | undefined) => string | undefined;
};

export function PreferencesCard({
  control,
  t,
  localizeError,
}: PreferencesCardProps): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('section.preferences.title')}</CardTitle>
        <CardDescription>{t('section.preferences.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={control}
            name="language"
            render={({ field, fieldState }) => (
              <FormItem>
                <FormLabel>{t('field.language.label')}</FormLabel>
                <FormControl>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full h-11 lg:h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="de">Deutsch</SelectItem>
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name="theme_override"
            render={({ field, fieldState }) => (
              <FormItem>
                <FormLabel>{t('field.theme.label')}</FormLabel>
                <FormControl>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full h-11 lg:h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">{t('field.theme.system')}</SelectItem>
                      <SelectItem value="light">{t('field.theme.light')}</SelectItem>
                      <SelectItem value="dark">{t('field.theme.dark')}</SelectItem>
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={control}
          name="auto_enqueue_after_scan"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <FormLabel className="text-base">{t('field.autoEnqueueAfterScan.label')}</FormLabel>
                <FormDescription className="text-sm">
                  {t('field.autoEnqueueAfterScan.helper')}
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  aria-label={t('field.autoEnqueueAfterScan.label')}
                />
              </FormControl>
            </FormItem>
          )}
        />
        {/* 05-bonus: hard-delete original after successful encode (skip trash). */}
        <FormField
          control={control}
          name="delete_original_after_encode"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <FormLabel className="text-base">
                  {t('field.deleteOriginalAfterEncode.label')}
                </FormLabel>
                <FormDescription className="text-sm">
                  {t('field.deleteOriginalAfterEncode.helper')}
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  aria-label={t('field.deleteOriginalAfterEncode.label')}
                />
              </FormControl>
            </FormItem>
          )}
        />
        {/* 05-bonus: configurable output filename suffix. */}
        <FormField
          control={control}
          name="output_suffix"
          render={({ field, fieldState }) => (
            <OutputSuffixField
              field={field}
              fieldState={fieldState}
              control={control}
              t={t}
              localizeError={localizeError}
            />
          )}
        />
      </CardContent>
    </Card>
  );
}
