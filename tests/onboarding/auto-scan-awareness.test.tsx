// 16-03 Plan Task 2 — tests for the onboarding Auto-Scan Awareness surface.
// Covers AC-1 (3-fact body), AC-3 (i18n keys resolve), AC-4 (deep-link href),
// AC-5 (icon aria-label + touch-target intent), AC-6 (locale render parity),
// + audit SR2 (uniqueness gate) + SR6 (locale parity unit-level).

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

describe('AutoScanAwareness (16-03)', () => {
  it('renders 3-fact body with EN i18n labels (AC-1, AC-3)', () => {
    renderWithLocale('en');
    expect(screen.getByText(en.onboarding.autoScan.heading)).toBeInTheDocument();
    expect(screen.getByText(en.onboarding.autoScan.bodyAutoScanOn)).toBeInTheDocument();
    expect(screen.getByText(en.onboarding.autoScan.bodyBootScan)).toBeInTheDocument();
    expect(screen.getByText(en.onboarding.autoScan.bodyAdvancedOptions)).toBeInTheDocument();
  });

  it('renders 3-fact body with DE i18n labels (AC-3, AC-6)', () => {
    renderWithLocale('de');
    expect(screen.getByText(de.onboarding.autoScan.heading)).toBeInTheDocument();
    expect(screen.getByText(de.onboarding.autoScan.bodyAutoScanOn)).toBeInTheDocument();
    expect(screen.getByText(de.onboarding.autoScan.bodyBootScan)).toBeInTheDocument();
    expect(screen.getByText(de.onboarding.autoScan.bodyAdvancedOptions)).toBeInTheDocument();
  });

  it('icon rendered with aria-label (AC-5)', () => {
    renderWithLocale('en');
    const icon = screen.getByLabelText(en.onboarding.autoScan.iconLabel);
    expect(icon).toBeInTheDocument();
  });

  it('contains deep-link anchor with locale-prefixed /settings#auto-scan-advanced href (20-02 AC-1)', () => {
    renderWithLocale('en');
    const link = screen.getByRole('link', { name: en.onboarding.autoScan.deepLinkLabel });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/en/settings#auto-scan-advanced');
    expect(link.getAttribute('href')?.endsWith('#auto-scan-advanced')).toBe(true);
  });

  it('deep-link locale-prefix follows current locale (DE) (20-02 AC-1, AC-6)', () => {
    renderWithLocale('de');
    const link = screen.getByRole('link', { name: de.onboarding.autoScan.deepLinkLabel });
    expect(link.getAttribute('href')).toBe('/de/settings#auto-scan-advanced');
  });

  it('deep-link uses touch-target-safe h-11 class (AC-5 audit-M7 carry-forward)', () => {
    renderWithLocale('en');
    const link = screen.getByRole('link', { name: en.onboarding.autoScan.deepLinkLabel });
    expect(link.className).toMatch(/\bh-11\b/);
  });

  it('uses semantic primary icon-color token (AC-5 SR8 token-combo)', () => {
    renderWithLocale('en');
    const icon = screen.getByLabelText(en.onboarding.autoScan.iconLabel);
    expect(icon.getAttribute('class') ?? '').toMatch(/text-primary/);
  });

  it('surface mounts exactly once (uniqueness gate — audit SR2)', () => {
    renderWithLocale('en');
    expect(screen.queryAllByTestId('onboarding-autoscan-awareness')).toHaveLength(1);
  });

  it('reduced-motion safe — no animation class on surface (AC-5)', () => {
    renderWithLocale('en');
    const surface = screen.getByTestId('onboarding-autoscan-awareness');
    expect(surface.className).not.toMatch(/animate-/);
  });

  it('invokes onDeepLinkClick when deep-link is clicked (16-03 state-loss-fix)', () => {
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

  it('locale render-parity: EN and DE share structural DOM, differ in text (AC-6, audit SR6)', () => {
    const enRender = renderWithLocale('en');
    const enSurface = enRender.getByTestId('onboarding-autoscan-awareness');
    const enRoles = enSurface.querySelectorAll('[role], a, h2, ul, li').length;
    const enText = enSurface.textContent ?? '';
    enRender.unmount();

    const deRender = renderWithLocale('de');
    const deSurface = deRender.getByTestId('onboarding-autoscan-awareness');
    const deRoles = deSurface.querySelectorAll('[role], a, h2, ul, li').length;
    const deText = deSurface.textContent ?? '';

    // Same structural-element count across locales (AC-6 structural-equality).
    expect(enRoles).toBe(deRoles);
    // Same testid count = exactly 1 in each tree (SR2 re-check post-locale-swap).
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
