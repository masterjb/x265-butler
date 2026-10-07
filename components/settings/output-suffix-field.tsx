'use client';

import * as React from 'react';
import { useWatch, type Control } from 'react-hook-form';
import { useTranslations } from 'next-intl';
import {
  FormControl,
  FormDescription,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { type FormValues } from '@/src/lib/api/settings-serialize';

// Container-aware suffix field. Subscribes to
// output_container via useWatch INSIDE its own body (Hook-rules clean;
// no useWatch in FormField render-prop closure). Drives
// both the Input placeholder (-x265.mkv | -x265.mp4 | -x265 in the
// infix-label style) and the FormDescription helper-text key
// (helper.{mkv,mp4,matchSource}).
//
// Invariant: the placeholder string MUST equal
// sanitizeOutputSuffix('-x265', container) (with match-source mapping to
// the bare label '-x265' since composition happens upstream at dispatch).
// Pinned by the placeholder-vs-sanitizer drift-guard test in
// tests/components/settings-output-suffix-field.test.tsx.
type OutputSuffixFieldProps = {
  field: {
    value: string;
    // Typed as ChangeEventHandler rather than `(v: string) => void`:
    // native <Input>'s `onChange` expects ChangeEventHandler. RHF's
    // field.onChange is broadly typed to accept either an event or a value;
    // narrowing to ChangeEventHandler keeps the Input prop satisfied while
    // still compatible at runtime (RHF inspects target.value).
    onChange: React.ChangeEventHandler<HTMLInputElement>;
    onBlur: () => void;
    name: string;
    ref: React.Ref<unknown>;
  };
  fieldState: { error?: { message?: string } };
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  // localizeError is closure-scoped inside the SettingsForm
  // body — captures tValidation closure. OutputSuffixField is
  // module-scoped + exported, so it cannot reach the closure-scoped helper.
  // Pass it as a prop, parallel to how `t` is passed.
  localizeError: (message: string | undefined) => string | undefined;
};

export function OutputSuffixField({
  field,
  fieldState,
  control,
  t,
  localizeError,
}: OutputSuffixFieldProps): React.ReactElement {
  const containerRaw = useWatch({ control, name: 'output_container' });
  // Defensive default — useWatch can return undefined transiently
  // before RHF defaultValues populate. Mirrors the OutputSuffixPreview guard.
  const container: 'mkv' | 'mp4' | 'match-source' =
    containerRaw === 'mkv' || containerRaw === 'mp4' || containerRaw === 'match-source'
      ? containerRaw
      : 'mkv';

  const placeholder = container === 'match-source' ? '-x265' : `-x265.${container}`;

  // i18n key uses camelCase ('matchSource'); container
  // enum value uses kebab ('match-source') per the API contract. Translation
  // point is intentional — do not "fix" the casing without also touching
  // messages/*.json.
  const helperKey =
    container === 'match-source'
      ? 'field.outputSuffix.helper.matchSource'
      : container === 'mp4'
        ? 'field.outputSuffix.helper.mp4'
        : 'field.outputSuffix.helper.mkv';

  return (
    <FormItem>
      <FormLabel>{t('field.outputSuffix.label')}</FormLabel>
      <FormControl>
        <Input
          type="text"
          value={field.value}
          onChange={field.onChange}
          onBlur={field.onBlur}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          placeholder={placeholder}
        />
      </FormControl>
      <FormDescription className="text-sm">{t(helperKey)}</FormDescription>
      <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
    </FormItem>
  );
}
