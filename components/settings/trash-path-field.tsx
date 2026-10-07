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

// Operator-configurable originals-trash location. A single text Input,
// mirroring the central-path Input half of SidecarModeField (FormField →
// FormItem → FormLabel + Input + FormDescription + FormMessage). UNLIKE the
// central-path field, this is ALWAYS editable — there is no gating mode, so no
// progressive-disclosure `disabled`/opacity-50 dimming. Empty = auto (track the
// cache stageRoot, the built-in default); the empty=auto semantics live
// in the persistent FormDescription (NOT placeholder-only), per the forms
// helper-text rule. Validation messages (trashPathAbsolute / trashPathForbidden
// client-side, trash_path_nested_under_share from the server) surface in
// FormMessage directly below the field.
type TrashPathFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  localizeError: (message: string | undefined) => string | undefined;
};

export function TrashPathField({
  control,
  t,
  localizeError,
}: TrashPathFieldProps): React.ReactElement {
  // Kept mounted when the trash is off (form state preserved), but disabled.
  const enabled = useWatch({ control, name: 'trash_enabled' }) !== false;
  return (
    <FormField
      control={control}
      name="trash_path"
      render={({ field, fieldState }) => (
        <FormItem className={cn(!enabled && 'opacity-50')}>
          {/* No explicit htmlFor/id: FormControl assigns the Input formItemId
              and FormLabel targets the same id — the shadcn auto-association
              idiom (matches SidecarModeField's central-path field). */}
          <FormLabel>{t('field.trashPath.label')}</FormLabel>
          <FormControl>
            <Input
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              className="h-11 lg:h-9"
              placeholder={t('field.trashPath.placeholder')}
              disabled={!enabled}
              value={field.value ?? ''}
              onChange={field.onChange}
              onBlur={field.onBlur}
              name={field.name}
              ref={field.ref}
            />
          </FormControl>
          <FormDescription>{t('field.trashPath.description')}</FormDescription>
          <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
        </FormItem>
      )}
    />
  );
}
