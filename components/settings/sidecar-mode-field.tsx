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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { type FormValues } from '@/src/lib/api/settings-serialize';

// 26-01 (F3): sidecar-location field group. A Select (off/beside/central) +
// a conditionally-relevant central-path Input. Mirrors the OutputContainerField
// idiom (FormItem → FormLabel + Select + FormDescription/FormMessage). The path
// input stays MOUNTED always (preserves RHF state per the V4 boundary) but is
// semantically `disabled` + de-emphasized (opacity-50, dropped from tab order)
// when mode≠central — progressive disclosure without losing form state.
type SidecarModeFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  localizeError: (message: string | undefined) => string | undefined;
};

export function SidecarModeField({
  control,
  t,
  localizeError,
}: SidecarModeFieldProps): React.ReactElement {
  // useWatch INSIDE the component body (Hook-rules clean — mirrors
  // OutputSuffixField's containerRaw watch pattern).
  const modeRaw = useWatch({ control, name: 'sidecar_mode' });
  const isCentral = modeRaw === 'central';

  return (
    <div className="space-y-5">
      <FormField
        control={control}
        name="sidecar_mode"
        render={({ field, fieldState }) => (
          <FormItem>
            <FormLabel htmlFor="sidecar_mode">{t('field.sidecarMode.label')}</FormLabel>
            <FormControl>
              <Select
                value={field.value}
                onValueChange={(v) => {
                  if (v === 'off' || v === 'beside' || v === 'central') field.onChange(v);
                }}
              >
                <SelectTrigger
                  id="sidecar_mode"
                  className="w-full h-11 lg:h-9"
                  aria-label={t('field.sidecarMode.aria.label')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t('field.sidecarMode.options.off')}</SelectItem>
                  <SelectItem value="beside">{t('field.sidecarMode.options.beside')}</SelectItem>
                  <SelectItem value="central">{t('field.sidecarMode.options.central')}</SelectItem>
                </SelectContent>
              </Select>
            </FormControl>
            <FormDescription>{t('field.sidecarMode.description')}</FormDescription>
            <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name="sidecar_central_path"
        render={({ field, fieldState }) => (
          <FormItem className={cn(!isCentral && 'opacity-50')}>
            {/* No explicit htmlFor/id: FormControl assigns the Input formItemId
                (Radix Slot overrides a manual id), and FormLabel targets the same
                formItemId — auto-association is the correct shadcn idiom here. */}
            <FormLabel>{t('field.sidecarCentralPath.label')}</FormLabel>
            <FormControl>
              <Input
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                className="h-11 lg:h-9"
                placeholder={t('field.sidecarCentralPath.placeholder')}
                // Progressive disclosure: keep mounted (RHF state preserved) but
                // semantically disabled when mode≠central — also drops it from the
                // tab order (disabled-states rule) instead of visual greying alone.
                disabled={!isCentral}
                value={field.value ?? ''}
                onChange={field.onChange}
                onBlur={field.onBlur}
                name={field.name}
                ref={field.ref}
              />
            </FormControl>
            <FormDescription>{t('field.sidecarCentralPath.description')}</FormDescription>
            <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
          </FormItem>
        )}
      />
    </div>
  );
}
