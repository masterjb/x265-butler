// Dashboard hint while the auto_encode master switch is OFF.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';
import { AutoEncodeOffCard } from '@/components/dashboard/auto-encode-off-card';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function renderCard(locale: 'en' | 'de', pendingFiles: number) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">
      <AutoEncodeOffCard pendingFiles={pendingFiles} />
    </NextIntlClientProvider>,
  );
}

describe('AutoEncodeOffCard', () => {
  it('test_card_when_rendered_then_shows_title', () => {
    renderCard('en', 3);
    expect(screen.getByRole('heading', { name: en.dashboard.autoEncodeOff.title })).toBeTruthy();
  });

  it('test_card_when_three_pending_then_body_names_count', () => {
    renderCard('en', 3);
    expect(screen.getByText(/3 files are waiting in the Library/)).toBeTruthy();
  });

  it('test_card_when_one_pending_then_singular', () => {
    renderCard('de', 1);
    expect(screen.getByText(/1 Datei wartet in der Bibliothek/)).toBeTruthy();
  });

  it('test_card_when_rendered_then_bench_link_is_locale_prefixed', () => {
    renderCard('de', 2);
    const link = screen.getByRole('link', { name: de.dashboard.autoEncodeOff.benchLink });
    expect(link.getAttribute('href')).toBe('/de/bench');
  });

  it('test_card_when_rendered_then_settings_link_targets_auto_encode_anchor', () => {
    renderCard('en', 2);
    const link = screen.getByRole('link', { name: en.dashboard.autoEncodeOff.settingsLink });
    expect(link.getAttribute('href')).toBe('/en/settings#auto-encode');
  });
});
