/*
 * ResumeAfterRestartField: the switch for putting jobs back in the queue after a
 * restart. Covers the label tied to the switch (clicking the label text toggles
 * it, so the touch area is the whole label, not the small switch), the helper
 * text with the limit, the value reaching the form, and texts without dashes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useForm, FormProvider, type UseFormReturn } from 'react-hook-form';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';
import type { FormValues } from '@/src/lib/api/settings-serialize';
import { serializeForApi } from '@/src/lib/api/settings-serialize';
import { ResumeAfterRestartField } from '@/components/settings/resume-after-restart-field';

let formRef: UseFormReturn<FormValues> | null = null;

function Harness({ value }: { value: boolean }) {
  const form = useForm<FormValues>({
    defaultValues: { resume_after_restart: value } as FormValues,
  });
  formRef = form;
  const t = useTranslations('settings');
  return (
    <FormProvider {...form}>
      <form>
        <ResumeAfterRestartField control={form.control} t={t} />
      </form>
    </FormProvider>
  );
}

function renderIn(locale: 'en' | 'de', value = true) {
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

describe('ResumeAfterRestartField', () => {
  it('labels the switch and shows the stored state with the limit in the helper', () => {
    renderIn('en', true);
    const sw = screen.getByRole('switch', { name: en.settings.field.resumeAfterRestart.label });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByText(en.settings.field.resumeAfterRestart.helper.replace('{max}', '3')),
    ).toBeTruthy();
  });

  it('toggles from the label text and passes the value to the form', () => {
    renderIn('en', true);
    fireEvent.click(screen.getByText(en.settings.field.resumeAfterRestart.label));
    expect(formRef?.getValues('resume_after_restart')).toBe(false);
    expect(serializeForApi({ resume_after_restart: false } as Partial<FormValues>)).toMatchObject({
      resume_after_restart: '0',
    });
    expect(serializeForApi({ resume_after_restart: true } as Partial<FormValues>)).toMatchObject({
      resume_after_restart: '1',
    });
  });

  it('keeps the row at touch height', () => {
    renderIn('en', false);
    const row = screen.getByRole('switch').closest('[class*="rounded-lg"]');
    expect(row?.className).toContain('min-h-11');
  });

  it('has texts without dashes in both languages', () => {
    renderIn('de', true);
    const texts = [
      ...Object.values(de.settings.field.resumeAfterRestart),
      ...Object.values(en.settings.field.resumeAfterRestart),
    ];
    for (const text of texts) expect(text).not.toMatch(/—| – /);
    expect(
      screen.getByRole('switch', { name: de.settings.field.resumeAfterRestart.label }),
    ).toBeTruthy();
  });
});
