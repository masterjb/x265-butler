'use client';

import * as React from 'react';
import { useWatch, type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
// 26-02 (F5): P3 arm→confirm gate for the data-loss-sensitive replace mode.
import { ConfirmButton } from '@/components/ui/confirm-button';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, Check } from 'lucide-react';
import { AMBER_ADVISORY_CLASS } from './settings-form-shared';
import { type FormValues } from '@/src/lib/api/settings-serialize';

// 26-02 (F5): output-mode field — suffix (default) vs in-place replace. Replace
// is a data-loss one-way-door (original → trash, output renamed into basename),
// so selecting it reveals an amber warning + a P3 arm→confirm control
// (ConfirmButton, NOT an AlertDialog modal per [[feedback_confirm_patterns]]).
// The parent SettingsForm gates the actual save on `replaceArmed`. A second
// amber advisory surfaces the off+replace anti-double-work gap (AC-10). Both
// useWatch calls live INSIDE the body (Hook-rules clean — mirrors
// SidecarModeField/OutputSuffixField).
type OutputModeFieldProps = {
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  localizeError: (message: string | undefined) => string | undefined;
  replaceArmed: boolean;
  onArm: () => void;
};

export function OutputModeField({
  control,
  t,
  localizeError,
  replaceArmed,
  onArm,
}: OutputModeFieldProps): React.ReactElement {
  const modeRaw = useWatch({ control, name: 'output_mode' });
  const sidecarRaw = useWatch({ control, name: 'sidecar_mode' });
  const isReplace = modeRaw === 'replace';
  const showOffReplaceHint = isReplace && sidecarRaw === 'off';

  return (
    <div className="space-y-5">
      <FormField
        control={control}
        name="output_mode"
        render={({ field, fieldState }) => (
          <FormItem>
            <FormLabel htmlFor="output_mode">{t('field.outputMode.label')}</FormLabel>
            <FormControl>
              <Select
                value={field.value}
                onValueChange={(v) => {
                  if (v === 'suffix' || v === 'replace') field.onChange(v);
                }}
              >
                <SelectTrigger
                  id="output_mode"
                  className="w-full h-11 lg:h-9"
                  aria-label={t('field.outputMode.aria.label')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="suffix">{t('field.outputMode.options.suffix')}</SelectItem>
                  <SelectItem value="replace">{t('field.outputMode.options.replace')}</SelectItem>
                </SelectContent>
              </Select>
            </FormControl>
            <FormDescription>{t('field.outputMode.description')}</FormDescription>
            <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
          </FormItem>
        )}
      />

      {/* AC-9: replace one-way-door — amber warning + P3 arm-confirm. Icon+text
          (color-not-alone). role="status" announces politely without stealing focus. */}
      {isReplace ? (
        <div role="status" className={AMBER_ADVISORY_CLASS}>
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div className="flex-1 space-y-3 leading-relaxed">
            <p>{t('field.outputMode.replaceWarning')}</p>
            {replaceArmed ? (
              <p className="flex items-center gap-1.5 font-medium">
                <Check aria-hidden="true" className="size-4 shrink-0" />
                {t('field.outputMode.armedConfirmed')}
              </p>
            ) : (
              <ConfirmButton
                variant="P3"
                size="sm"
                onConfirm={onArm}
                label={t('field.outputMode.armLabel')}
              >
                <AlertTriangle className="size-3.5" aria-hidden="true" />
              </ConfirmButton>
            )}
          </div>
        </div>
      ) : null}

      {/* AC-10: off+replace anti-double-work advisory. Informational only — no gate. */}
      {showOffReplaceHint ? (
        <div role="status" className={AMBER_ADVISORY_CLASS}>
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p className="flex-1 leading-relaxed">{t('field.outputMode.offReplaceHint')}</p>
        </div>
      ) : null}
    </div>
  );
}
