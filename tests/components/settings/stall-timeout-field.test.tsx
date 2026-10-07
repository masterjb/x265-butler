/*
 * StallTimeoutField: the minutes field for stopping stalled encodes. Covers the
 * label tied to the input, the unit and helper text, that a typed value reaches
 * the form as a number, and that the input is tall enough for touch on small
 * screens.
 */

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useForm, FormProvider, type UseFormReturn } from 'react-hook-form';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';
import type { FormValues } from '@/src/lib/api/settings-serialize';
import { StallTimeoutField } from '@/components/settings/stall-timeout-field';

let formRef: UseFormReturn<FormValues> | null = null;

function Harness({ value }: { value: number }) {
  const form = useForm<FormValues>({
    defaultValues: { stall_timeout_minutes: value } as FormValues,
  });
  formRef = form;
  const t = useTranslations('settings');
  return (
    <FormProvider {...form}>
      <form>
        <StallTimeoutField control={form.control} t={t} localizeError={(m) => m} />
      </form>
    </FormProvider>
  );
}

function renderIn(locale: 'en' | 'de', value = 10) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de}>
      <Harness value={value} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  formRef = null;
});

describe('StallTimeoutField', () => {
  it('labels the input and shows the stored value', () => {
    renderIn('en', 10);
    const input = screen.getByLabelText(en.settings.field.stallTimeout.label) as HTMLInputElement;
    expect(input.value).toBe('10');
    expect(input.type).toBe('number');
    expect(screen.getByText(en.settings.field.stallTimeout.unit)).toBeTruthy();
    expect(screen.getByText(en.settings.field.stallTimeout.helper)).toBeTruthy();
  });

  it('passes a typed value to the form as a number', () => {
    renderIn('en', 10);
    const input = screen.getByLabelText(en.settings.field.stallTimeout.label);
    fireEvent.change(input, { target: { value: '45' } });
    expect(formRef?.getValues('stall_timeout_minutes')).toBe(45);
  });

  it('keeps the input at touch height on small screens', () => {
    renderIn('en', 0);
    const input = screen.getByLabelText(en.settings.field.stallTimeout.label);
    expect(input.className).toContain('h-11');
  });

  it('has German texts without dashes', () => {
    renderIn('de', 10);
    const texts = Object.values(de.settings.field.stallTimeout).concat(
      de.settings.validation.stallTimeoutRange,
      Object.values(en.settings.field.stallTimeout),
      en.settings.validation.stallTimeoutRange,
    );
    for (const text of texts) expect(text).not.toMatch(/—| – /);
    expect(screen.getByLabelText(de.settings.field.stallTimeout.label)).toBeTruthy();
  });
});
