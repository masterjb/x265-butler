import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { SimpleKpiCard } from '@/components/stats/charts/simple-kpi-card';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe('SimpleKpiCard', () => {
  it('test_simpleKpiCard_when_value_then_renders_value', () => {
    render(wrap(<SimpleKpiCard value="42" label="Test Label" />));
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('test_simpleKpiCard_when_empty_dash_then_muted_style', () => {
    const { container } = render(wrap(<SimpleKpiCard value="—" label="Empty" />));
    const valueEl = container.querySelector('.text-muted-foreground');
    expect(valueEl).toBeTruthy();
  });

  it('test_simpleKpiCard_when_sampleSize_then_renders_n_annotation', () => {
    render(wrap(<SimpleKpiCard value="6.0×" label="Speed" sampleSize={42} />));
    expect(screen.getByText('n=42')).toBeTruthy();
  });

  it('test_simpleKpiCard_when_subtext_then_renders_subtext', () => {
    render(wrap(<SimpleKpiCard value="1.5 GB" label="Trash" subtext="12 files" />));
    expect(screen.getByText('12 files')).toBeTruthy();
  });

  it('test_simpleKpiCard_aria_label_uses_ariaValue_when_provided', () => {
    const { container } = render(
      wrap(<SimpleKpiCard value="42" ariaValue="42 files" label="Label" />),
    );
    const card = container.querySelector('[aria-label="42 files"]');
    expect(card).toBeTruthy();
  });

  it('test_simpleKpiCard_numeric_value_uses_tabular_nums', () => {
    const { container } = render(wrap(<SimpleKpiCard value="123" label="Count" />));
    const numEl = container.querySelector('.tabular-nums');
    expect(numEl).toBeTruthy();
  });
});
