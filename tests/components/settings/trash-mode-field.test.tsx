/*
 * TrashModeField: trash on/off and where the trash lives. Covers stored values
 * and defaults, that turning the trash off shows a warning (icon and text, not
 * color alone) and disables location, custom path, retention and the delete
 * switch of the preferences, that values are sent as strings, touch height,
 * and en/de texts without dashes.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { useForm, FormProvider, type UseFormReturn } from 'react-hook-form';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';
import { ThemeProvider } from '@/components/app-shell/theme-provider';
import { serializeForApi, type FormValues } from '@/src/lib/api/settings-serialize';
import { TrashModeField } from '@/components/settings/trash-mode-field';
import { TrashPathField } from '@/components/settings/trash-path-field';
import { TrashRetentionField } from '@/components/settings/trash-retention-field';
import { PreferencesCard } from '@/components/settings/preferences-card';

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

type Init = Partial<Pick<FormValues, 'trash_enabled' | 'trash_location' | 'trash_path'>>;

function Harness({ init }: { init: Init }) {
  const form = useForm<FormValues>({
    defaultValues: {
      trash_enabled: true,
      trash_location: 'cache',
      trash_path: '',
      trash_retention_days: 30,
      language: 'en',
      theme_override: 'system',
      auto_encode: false,
      delete_original_after_encode: false,
      output_suffix: '-x265',
      output_container: 'mkv',
      ...init,
    } as FormValues,
  });
  formRef = form;
  const t = useTranslations('settings');
  return (
    <FormProvider {...form}>
      <form
        noValidate
        onSubmit={form.handleSubmit((v) =>
          onValid(
            serializeForApi({
              trash_enabled: v.trash_enabled,
              trash_location: v.trash_location,
            } as FormValues),
          ),
        )}
      >
        <TrashModeField control={form.control} t={t} />
        <TrashPathField control={form.control} t={t} localizeError={(m) => m} />
        <TrashRetentionField control={form.control} t={t} localizeError={(m) => m} />
        <PreferencesCard control={form.control} t={t} localizeError={(m) => m} />
        <button type="submit">submit</button>
      </form>
    </FormProvider>
  );
}

function renderIn(locale: 'en' | 'de', init: Init = {}) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        <Harness init={init} />
      </ThemeProvider>
    </NextIntlClientProvider>,
  );
}

const T = en.settings.field.trashMode;

function trashSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: T.enabled.label });
}

function radio(label: string): HTMLElement {
  return screen.getByRole('radio', { name: new RegExp(label.replace(/[()]/g, '\\$&')) });
}

// The switch and radio primitives render spans/buttons; disabled shows as
// aria-disabled / data-disabled rather than the DOM disabled property.
function isDisabled(el: HTMLElement): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.hasAttribute('data-disabled')
  );
}

afterEach(() => {
  cleanup();
  formRef = null;
  onValid.mockReset();
});

describe('TrashModeField', () => {
  it('shows stored values', () => {
    renderIn('en', { trash_enabled: true, trash_location: 'share' });
    expect(trashSwitch().getAttribute('aria-checked')).toBe('true');
    expect(radio(T.location.share.label).getAttribute('aria-checked')).toBe('true');
    expect(radio(T.location.cache.label).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(T.location.share.helper)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('turning the trash off shows the warning and disables dependent fields', async () => {
    renderIn('en');
    await act(async () => {
      fireEvent.click(trashSwitch());
    });
    expect(formRef?.getValues('trash_enabled')).toBe(false);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(T.offWarning);
    expect(status.querySelector('svg')).not.toBeNull();
    expect(isDisabled(radio(T.location.share.label))).toBe(true);
    expect(
      (screen.getByLabelText(en.settings.field.trashPath.label) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText(en.settings.field.trashRetention.label) as HTMLInputElement).disabled,
    ).toBe(true);
    const del = screen.getByRole('switch', {
      name: en.settings.field.deleteOriginalAfterEncode.label,
    });
    expect(isDisabled(del)).toBe(true);
    expect(
      screen.getByText(en.settings.field.deleteOriginalAfterEncode.helperTrashOff),
    ).toBeTruthy();
    // Stored values stay as they are.
    expect(formRef?.getValues('delete_original_after_encode')).toBe(false);
    expect(formRef?.getValues('trash_retention_days')).toBe(30);
  });

  it('with the trash on, the delete switch is usable', () => {
    renderIn('en');
    const del = screen.getByRole('switch', {
      name: en.settings.field.deleteOriginalAfterEncode.label,
    });
    expect(isDisabled(del)).toBe(false);
  });

  it('a custom path shows that it overrides the location', () => {
    renderIn('en', { trash_path: '/mnt/disk1/trash' });
    expect(screen.getByText(T.location.overridden)).toBeTruthy();
  });

  it('submits strings', async () => {
    renderIn('en');
    await act(async () => {
      fireEvent.click(radio(T.location.share.label));
    });
    await act(async () => {
      fireEvent.click(trashSwitch());
    });
    await act(async () => {
      fireEvent.click(screen.getByText('submit'));
    });
    expect(onValid).toHaveBeenCalledWith({ trash_enabled: 'false', trash_location: 'share' });
  });

  it('location options are at least touch height', () => {
    renderIn('en');
    const label = radio(T.location.share.label).closest('label');
    expect(label?.className).toContain('min-h-11');
  });

  it('has German texts without dashes', () => {
    renderIn('de');
    const flat = (o: unknown): string[] =>
      typeof o === 'string' ? [o] : Object.values(o as object).flatMap(flat);
    const texts = [
      ...flat(de.settings.field.trashMode),
      ...flat(en.settings.field.trashMode),
      ...flat(de.settings.field.trashPath),
      ...flat(en.settings.field.trashPath),
      de.settings.field.deleteOriginalAfterEncode.helperTrashOff,
      en.settings.field.deleteOriginalAfterEncode.helperTrashOff,
    ];
    for (const text of texts) expect(text).not.toMatch(/—| – /);
    expect(
      screen.getByRole('switch', { name: de.settings.field.trashMode.enabled.label }),
    ).toBeTruthy();
  });
});

describe('settings page', () => {
  beforeEach(() => {
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockDetectEncoders.mockResolvedValue({ detected: ['libx265'], activeFromAuto: 'libx265' });
  });

  async function renderPage(stored: Record<string, string>): Promise<void> {
    mockGetAll.mockReturnValue(stored);
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
    await waitFor(() => trashSwitch());
  }

  it('shows the stored values', async () => {
    await renderPage({ trash_enabled: 'false', trash_location: 'share' });
    expect(trashSwitch().getAttribute('aria-checked')).toBe('false');
    expect(radio(T.location.share.label).getAttribute('aria-checked')).toBe('true');
  });

  it('missing or unknown values mean on and cache', async () => {
    await renderPage({ trash_enabled: 'yes', trash_location: 'array' });
    expect(trashSwitch().getAttribute('aria-checked')).toBe('true');
    expect(radio(T.location.cache.label).getAttribute('aria-checked')).toBe('true');
  });
});
