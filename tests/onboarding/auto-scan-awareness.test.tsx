// Tests for the onboarding Auto-Scan Awareness surface.
// Covers the 3-fact body, i18n keys resolve, deep-link href, icon aria-label +
// touch-target intent, locale render parity, and the uniqueness gate.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';
import de from '@/messages/de.json';
import { AutoScanAwareness } from '@/components/onboarding/auto-scan-awareness';

function renderWithLocale(locale: 'en' | 'de') {
  const messages = locale === 'en' ? en : de;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <AutoScanAwareness />
    </NextIntlClientProvider>,
  );
}

describe('AutoScanAwareness', () => {
  it('renders 3-fact body with EN i18n labels', () => {
    renderWithLocale('en');
    expect(screen.getByText(en.onboarding.autoScan.heading)).toBeInTheDocument();
    expect(screen.getByText(en.onboarding.autoScan.bodyAutoScanOn)).toBeInTheDocument();
    expect(screen.getByText(en.onboarding.autoScan.bodyBootScan)).toBeInTheDocument();
    expect(screen.getByText(en.onboarding.autoScan.bodyAdvancedOptions)).toBeInTheDocument();
  });

  it('renders 3-fact body with DE i18n labels', () => {
    renderWithLocale('de');
    expect(screen.getByText(de.onboarding.autoScan.heading)).toBeInTheDocument();
    expect(screen.getByText(de.onboarding.autoScan.bodyAutoScanOn)).toBeInTheDocument();
    expect(screen.getByText(de.onboarding.autoScan.bodyBootScan)).toBeInTheDocument();
    expect(screen.getByText(de.onboarding.autoScan.bodyAdvancedOptions)).toBeInTheDocument();
  });

  it('icon rendered with aria-label', () => {
    renderWithLocale('en');
    const icon = screen.getByLabelText(en.onboarding.autoScan.iconLabel);
    expect(icon).toBeInTheDocument();
  });

  it('contains deep-link anchor with locale-prefixed /settings#auto-scan-advanced href', () => {
    renderWithLocale('en');
    const link = screen.getByRole('link', { name: en.onboarding.autoScan.deepLinkLabel });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/en/settings#auto-scan-advanced');
    expect(link.getAttribute('href')?.endsWith('#auto-scan-advanced')).toBe(true);
  });

  it('deep-link locale-prefix follows current locale (DE)', () => {
    renderWithLocale('de');
    const link = screen.getByRole('link', { name: de.onboarding.autoScan.deepLinkLabel });
    expect(link.getAttribute('href')).toBe('/de/settings#auto-scan-advanced');
  });

  it('deep-link uses touch-target-safe h-11 class', () => {
    renderWithLocale('en');
    const link = screen.getByRole('link', { name: en.onboarding.autoScan.deepLinkLabel });
    expect(link.className).toMatch(/\bh-11\b/);
  });

  it('uses semantic primary icon-color token', () => {
    renderWithLocale('en');
    const icon = screen.getByLabelText(en.onboarding.autoScan.iconLabel);
    expect(icon.getAttribute('class') ?? '').toMatch(/text-primary/);
  });

  it('surface mounts exactly once (uniqueness gate)', () => {
    renderWithLocale('en');
    expect(screen.queryAllByTestId('onboarding-autoscan-awareness')).toHaveLength(1);
  });

  it('reduced-motion safe — no animation class on surface', () => {
    renderWithLocale('en');
    const surface = screen.getByTestId('onboarding-autoscan-awareness');
    expect(surface.className).not.toMatch(/animate-/);
  });

  it('invokes onDeepLinkClick when deep-link is clicked (deep-link state-loss fix)', () => {
    const onDeepLinkClick = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AutoScanAwareness onDeepLinkClick={onDeepLinkClick} />
      </NextIntlClientProvider>,
    );
    const link = screen.getByRole('link', { name: en.onboarding.autoScan.deepLinkLabel });
    fireEvent.click(link);
    expect(onDeepLinkClick).toHaveBeenCalledTimes(1);
  });

  it('locale render-parity: EN and DE share structural DOM, differ in text', () => {
    const enRender = renderWithLocale('en');
    const enSurface = enRender.getByTestId('onboarding-autoscan-awareness');
    const enRoles = enSurface.querySelectorAll('[role], a, h2, ul, li').length;
    const enText = enSurface.textContent ?? '';
    enRender.unmount();

    const deRender = renderWithLocale('de');
    const deSurface = deRender.getByTestId('onboarding-autoscan-awareness');
    const deRoles = deSurface.querySelectorAll('[role], a, h2, ul, li').length;
    const deText = deSurface.textContent ?? '';

    // Same structural-element count across locales (structural equality).
    expect(enRoles).toBe(deRoles);
    // Same testid count = exactly 1 in each tree (uniqueness re-check after the locale swap).
    expect(deRender.queryAllByTestId('onboarding-autoscan-awareness')).toHaveLength(1);
    // Text content MUST differ between EN and DE — proves real translation not raw-key leak.
    expect(enText).not.toBe(deText);
    expect(enText.length).toBeGreaterThan(0);
    expect(deText.length).toBeGreaterThan(0);
    // No raw i18n-key leak (e.g. 'onboarding.autoScan.heading' as visible text).
    expect(enText).not.toMatch(/onboarding\.autoScan\./);
    expect(deText).not.toMatch(/onboarding\.autoScan\./);
  });
});

// The awareness copy follows the wizard's auto-encode switch.
describe('AutoScanAwareness — auto-encode line', () => {
  function renderWith(autoEncode: boolean | undefined) {
    return render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AutoScanAwareness autoEncode={autoEncode} />
      </NextIntlClientProvider>,
    );
  }

  it('test_awareness_when_auto_encode_off_then_says_files_wait', () => {
    renderWith(false);
    expect(screen.getByTestId('autoscan-awareness-encode-line').textContent).toBe(
      en.onboarding.autoScan.bodyAutoEncodeOff,
    );
  });

  it('test_awareness_when_auto_encode_on_then_says_files_join_queue', () => {
    renderWith(true);
    expect(screen.getByTestId('autoscan-awareness-encode-line').textContent).toBe(
      en.onboarding.autoScan.bodyAutoEncodeOn,
    );
  });

  it('test_awareness_when_prop_absent_then_defaults_to_off_copy', () => {
    renderWith(undefined);
    expect(screen.getByTestId('autoscan-awareness-encode-line').textContent).toBe(
      en.onboarding.autoScan.bodyAutoEncodeOff,
    );
  });
});
