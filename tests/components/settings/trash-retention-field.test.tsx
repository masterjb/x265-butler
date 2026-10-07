/*
 * TrashRetentionField: how many days originals stay in the trash. Covers the
 * label tied to the input, unit and helper text, that a typed value reaches the
 * form as a number and is sent as a string, that 0 and 4000 are blocked by the
 * same rule the settings form uses, and that the settings page shows the stored
 * value (or 30 for a broken stored value).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { useForm, FormProvider, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';
import { ThemeProvider } from '@/components/app-shell/theme-provider';
import { serializeForApi, type FormValues } from '@/src/lib/api/settings-serialize';
import { TrashRetentionField } from '@/components/settings/trash-retention-field';
import { trashRetentionDaysSchema } from '@/components/settings/settings-form-shared';

const { mockGetAll, mockStat, mockDetectEncoders } = vi.hoisted(() => ({
  mockGetAll: vi.fn<() => Record<string, string>>(),
  mockStat: vi.fn(),
  mockDetectEncoders: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ getAll: mockGetAll, get: (k: string) => mockGetAll()?.[k] }),
  userRepo: () => ({ count: () => 0 }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/encode', () => ({
  detectEncoders: mockDetectEncoders,
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'] as const,
  resolveEffectiveCachePathCached: () => ({
    effectivePath: '/config/cache',
    resolution: 'config-fallback',
  }),
  default: {},
}));

vi.mock('node:fs/promises', () => ({
  default: { stat: (...a: unknown[]) => mockStat(...a) },
  stat: (...a: unknown[]) => mockStat(...a),
}));

vi.mock('@/src/lib/api/engine-events-client', () => ({
  useQueueCounts: () => ({ activeJobs: 0, pendingJobs: 0 }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/en/settings',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import SettingsPage from '@/app/[locale]/settings/page';

let formRef: UseFormReturn<FormValues> | null = null;
const onValid = vi.fn();

const harnessSchema = z.object({ trash_retention_days: trashRetentionDaysSchema });

function Harness({ value }: { value: number }) {
  const form = useForm<FormValues>({
    defaultValues: { trash_retention_days: value } as FormValues,
    resolver: zodResolver(harnessSchema) as never,
  });
  formRef = form;
  const t = useTranslations('settings');
  const tValidation = useTranslations('settings.validation');
  return (
    <FormProvider {...form}>
      {/* noValidate: the settings page saves through the form handle, so the
          zod rule decides, not the browser's min/max check. */}
      <form noValidate onSubmit={form.handleSubmit((v) => onValid(serializeForApi(v)))}>
        <TrashRetentionField
          control={form.control}
          t={t}
          localizeError={(m) => (m === 'trashRetentionRange' ? tValidation(m) : m)}
        />
        <button type="submit">submit</button>
      </form>
    </FormProvider>
  );
}

function renderIn(locale: 'en' | 'de', value = 30) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de}>
      <Harness value={value} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  formRef = null;
  onValid.mockReset();
});

describe('TrashRetentionField', () => {
  it('shows stored value with unit and helper', () => {
    renderIn('en', 30);
    const input = screen.getByLabelText(en.settings.field.trashRetention.label) as HTMLInputElement;
    expect(input.value).toBe('30');
    expect(input.type).toBe('number');
    expect(screen.getByText(en.settings.field.trashRetention.unit)).toBeTruthy();
    expect(screen.getByText(en.settings.field.trashRetention.helper)).toBeTruthy();
  });

  it('submits as string', async () => {
    renderIn('en', 30);
    const input = screen.getByLabelText(en.settings.field.trashRetention.label);
    fireEvent.change(input, { target: { value: '90' } });
    expect(formRef?.getValues('trash_retention_days')).toBe(90);
    await act(async () => {
      fireEvent.click(screen.getByText('submit'));
    });
    expect(onValid).toHaveBeenCalledWith({ trash_retention_days: '90' });
  });

  it.each(['0', '4000'])('blocks %s', async (v) => {
    renderIn('en', 30);
    const input = screen.getByLabelText(en.settings.field.trashRetention.label);
    fireEvent.change(input, { target: { value: v } });
    await act(async () => {
      fireEvent.click(screen.getByText('submit'));
    });
    const alert = await screen.findByRole('alert');
    expect(onValid).not.toHaveBeenCalled();
    expect(alert.textContent).toBe(en.settings.validation.trashRetentionRange);
  });

  it('keeps the input at touch height on small screens', () => {
    renderIn('en', 30);
    const input = screen.getByLabelText(en.settings.field.trashRetention.label);
    expect(input.className).toContain('h-11');
  });

  it('has German texts without dashes', () => {
    renderIn('de', 30);
    const texts = Object.values(de.settings.field.trashRetention).concat(
      de.settings.validation.trashRetentionRange,
      Object.values(en.settings.field.trashRetention),
      en.settings.validation.trashRetentionRange,
    );
    for (const text of texts) expect(text).not.toMatch(/—| – /);
    expect(screen.getByLabelText(de.settings.field.trashRetention.label)).toBeTruthy();
  });
});

describe('settings page', () => {
  beforeEach(() => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockDetectEncoders.mockResolvedValue({ detected: ['libx265'], activeFromAuto: 'libx265' });
  });

  async function fieldValueFor(stored: string | undefined): Promise<string> {
    mockGetAll.mockReturnValue(stored === undefined ? {} : { trash_retention_days: stored });
    const ui = await SettingsPage();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          {ui}
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /encoder/i }));
    });
    const input = await waitFor(
      () => screen.getByLabelText(en.settings.field.trashRetention.label) as HTMLInputElement,
    );
    return input.value;
  }

  it('shows the stored retention', async () => {
    expect(await fieldValueFor('90')).toBe('90');
  });

  it.each([['abc'], ['0'], [undefined]])('shows 30 for stored %j', async (stored) => {
    expect(await fieldValueFor(stored)).toBe('30');
  });
});
