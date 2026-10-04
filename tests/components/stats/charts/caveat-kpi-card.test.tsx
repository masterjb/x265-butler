import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { CaveatKpiCard } from '@/components/stats/charts/caveat-kpi-card';
import { formatBytes } from '@/src/lib/format';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe('CaveatKpiCard', () => {
  it('test_caveatKpiCard_when_positive_value_then_renders_value', () => {
    render(
      wrap(
        <CaveatKpiCard
          value={14_000_000_000}
          titleKey="netDiskFreed.title"
          tooltipKey="netDiskFreed.caveat.tooltip"
          formatValue={(v) => formatBytes(v, 'en')}
        />,
      ),
    );
    // Value renders (formatBytes of 14GB → "13.0 GiB" IEC units)
    expect(screen.getByText(/GiB/)).toBeTruthy();
  });

  it('test_caveatKpiCard_when_negative_value_then_text_destructive_class', () => {
    const { container } = render(
      wrap(
        <CaveatKpiCard
          value={-500_000_000}
          titleKey="netDiskFreed.title"
          tooltipKey="netDiskFreed.caveat.tooltip"
          formatValue={(v) => formatBytes(v, 'en')}
        />,
      ),
    );
    const destructive = container.querySelector('.text-destructive');
    expect(destructive).toBeTruthy();
  });

  it('test_caveatKpiCard_info_icon_present', () => {
    const { container } = render(
      wrap(
        <CaveatKpiCard
          value={1000}
          titleKey="netDiskFreed.title"
          tooltipKey="netDiskFreed.caveat.tooltip"
        />,
      ),
    );
    // Info icon via aria-label on button
    const btn = container.querySelector('button[aria-label]');
    expect(btn).toBeTruthy();
  });

  it('test_caveatKpiCard_info_button_keyboard_reachable', () => {
    const { container } = render(
      wrap(
        <CaveatKpiCard
          value={5000}
          titleKey="netDiskFreed.title"
          tooltipKey="netDiskFreed.caveat.tooltip"
        />,
      ),
    );
    const btn = container.querySelector('button');
    expect(btn).toBeTruthy();
    expect(btn?.tagName).toBe('BUTTON');
  });

  it('test_caveatKpiCard_subtitle_renders_when_provided', () => {
    render(
      wrap(
        <CaveatKpiCard
          value={0}
          titleKey="netDiskFreed.title"
          tooltipKey="netDiskFreed.caveat.tooltip"
          subtitle="Accounting caveat applies"
        />,
      ),
    );
    expect(screen.getByText('Accounting caveat applies')).toBeTruthy();
  });
});
