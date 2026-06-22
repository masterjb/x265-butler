// 35-02: AutoCropField — a Switch (auto_crop) + text Input (crop_override) pair,
// both ALWAYS editable. Direct-render against the exported sub-component (mirrors
// settings-gpu-device-field.test.tsx). Asserts:
//   - visible FormLabels + persistent FormDescriptions (form-labels / helper-text)
//   - the Switch carries an aria-label (accessibility)
//   - a valid geometry produces NO FormMessage; an odd/malformed one DOES
//     (client superRefine via the SAME parseCropGeometry the server uses — AC-5)
//   - whitespace-only is treated as empty/auto (no error) — trim-tolerant (SR-1)

import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useEffect } from 'react';
import { useForm, FormProvider, type Control } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { wrap } from '../test-utils';

import { AutoCropField } from '@/components/settings/auto-crop-field';
import { parseCropGeometry } from '@/src/lib/encode/crop-geometry';
import type { FormValues } from '@/src/lib/api/settings-serialize';

// Minimal client-mirror of the settings-form crop_override superRefine (SR-1
// trim-tolerant guard) so the test can drive zodResolver validation in isolation.
const schema = z
  .object({ auto_crop: z.boolean(), crop_override: z.string().max(32) })
  .superRefine((vals, ctx) => {
    if (vals.crop_override.trim() !== '' && parseCropGeometry(vals.crop_override) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['crop_override'],
        message: 'cropOverrideFormat',
      });
    }
  });

function localizeError(message: string | undefined): string | undefined {
  if (message === 'cropOverrideFormat') return 'Must be empty (auto) or even W:H:X:Y geometry';
  return message;
}

function Harness({ value = '', validate = false }: { value?: string; validate?: boolean }) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema) as never,
    defaultValues: { auto_crop: false, crop_override: value } as FormValues,
    mode: 'onChange',
  });
  const t = useTranslations('settings');
  useEffect(() => {
    if (validate) void form.trigger();
  }, [validate, form]);
  return (
    <FormProvider {...form}>
      <AutoCropField
        control={form.control as Control<FormValues>}
        t={t}
        localizeError={localizeError}
      />
    </FormProvider>
  );
}

describe('AutoCropField (35-02)', () => {
  it('renders both visible labels + persistent helper descriptions', () => {
    render(wrap(<Harness />));
    expect(screen.getByText('Auto-crop black bars')).toBeTruthy();
    expect(screen.getByText(/Detect letterbox \/ pillarbox bars/)).toBeTruthy();
    expect(screen.getByText('Crop override')).toBeTruthy();
    expect(screen.getByText(/Optional fixed crop as W:H:X:Y/)).toBeTruthy();
  });

  it('the Switch carries an aria-label (accessibility)', () => {
    render(wrap(<Harness />));
    expect(screen.getByRole('switch', { name: 'Auto-crop black bars' })).toBeTruthy();
  });

  // FormMessage (shadcn) renders the raw zod message key when an error is present
  // (the cropOverrideFormat key), so the superRefine firing is observable as a
  // role="alert" carrying that key.
  it('an odd geometry triggers the client superRefine FormMessage (AC-2/AC-5)', async () => {
    render(wrap(<Harness value="1921:801:0:0" validate />));
    expect(await screen.findByText('cropOverrideFormat')).toBeTruthy();
  });

  it('a valid geometry shows NO FormMessage', async () => {
    render(wrap(<Harness value="1920:800:0:140" validate />));
    // Let the triggered validation settle, then assert no error surfaced.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByText('cropOverrideFormat')).toBeNull();
  });

  it('whitespace-only is treated as empty/auto — NO FormMessage (SR-1)', async () => {
    render(wrap(<Harness value="   " validate />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByText('cropOverrideFormat')).toBeNull();
  });
});
