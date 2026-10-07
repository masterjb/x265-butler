/*
 * HwDecodeField: the switch for VAAPI hardware decode. Covers the label tied to
 * the switch (the whole label text toggles it), the helper text, the value
 * reaching the form and the API payload, the touch height, and the section and
 * field texts in both languages without dashes.
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
import { HwDecodeField } from '@/components/settings/hw-decode-field';

let formRef: UseFormReturn<FormValues> | null = null;

function Harness({ value }: { value: boolean }) {
  const form = useForm<FormValues>({
    defaultValues: { vaapi_hw_decode: value } as FormValues,
  });
  formRef = form;
  const t = useTranslations('settings');
  return (
    <FormProvider {...form}>
      <form>
        <HwDecodeField control={form.control} t={t} />
      </form>
    </FormProvider>
  );
}

function renderIn(locale: 'en' | 'de', value = false) {
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

describe('HwDecodeField', () => {
  it('labels the switch, shows the stored state and the helper', () => {
    renderIn('en', false);
    const sw = screen.getByRole('switch', { name: en.settings.field.hwDecode.label });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(en.settings.field.hwDecode.helper)).toBeTruthy();
  });

  it('toggles from the label text and sends the bool string', () => {
    renderIn('en', false);
    fireEvent.click(screen.getByText(en.settings.field.hwDecode.label));
    expect(formRef?.getValues('vaapi_hw_decode')).toBe(true);
    expect(serializeForApi({ vaapi_hw_decode: true } as Partial<FormValues>)).toMatchObject({
      vaapi_hw_decode: 'true',
    });
  });

  it('keeps the row at touch height', () => {
    renderIn('en');
    const row = screen.getByRole('switch').closest('[class*="rounded-lg"]');
    expect(row?.className).toContain('min-h-11');
  });

  it('has section and field texts in both languages without dashes, naming VAAPI', () => {
    renderIn('de', true);
    const texts = [
      ...Object.values(de.settings.field.hwDecode),
      ...Object.values(en.settings.field.hwDecode),
      ...Object.values(de.settings.section.hwDecode),
      ...Object.values(en.settings.section.hwDecode),
    ];
    expect(texts).toHaveLength(8);
    for (const text of texts) {
      expect(text).not.toMatch(/—| – /);
      expect(text.length).toBeGreaterThan(0);
    }
    expect(en.settings.field.hwDecode.helper).toContain('VAAPI');
    expect(de.settings.field.hwDecode.helper).toContain('VAAPI');
    expect(screen.getByRole('switch', { name: de.settings.field.hwDecode.label })).toBeTruthy();
  });

  it('says in the title, the label and the first helper sentence that only VAAPI is affected', () => {
    for (const msgs of [en, de]) {
      expect(msgs.settings.section.hwDecode.title).toContain('VAAPI');
      expect(msgs.settings.field.hwDecode.label).toContain('VAAPI');
      const firstSentence = msgs.settings.field.hwDecode.helper.split('. ')[0];
      expect(firstSentence).toContain('VAAPI');
      expect(msgs.settings.field.hwDecode.helper).toContain('NVENC');
      expect(msgs.settings.field.hwDecode.helper).toContain('QSV');
    }
  });
});
