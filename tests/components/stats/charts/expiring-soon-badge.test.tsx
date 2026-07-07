import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { ExpiringSoonBadge } from '@/components/stats/charts/expiring-soon-badge';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe('ExpiringSoonBadge', () => {
  it('test_expiringSoonBadge_when_count_zero_then_muted_style', () => {
    const { container } = render(wrap(<ExpiringSoonBadge count={0} withinDays={7} />));
    const badge = container.querySelector('[aria-label]');
    expect(badge).toBeTruthy();
    // Muted — text-muted-foreground class
    expect(badge?.className).toMatch(/text-muted-foreground/);
  });

  it('test_expiringSoonBadge_when_count_zero_then_shows_none_soon_text', () => {
    render(wrap(<ExpiringSoonBadge count={0} withinDays={7} />));
    const noneSoonText = en.stats.charts.expiringSoon.noneSoon;
    expect(screen.getByText(noneSoonText)).toBeTruthy();
  });

  it('test_expiringSoonBadge_when_count_positive_then_alert_style', () => {
    const { container } = render(wrap(<ExpiringSoonBadge count={3} withinDays={7} />));
    const badge = container.querySelector('[aria-label]');
    expect(badge?.className).toMatch(/text-destructive/);
  });

  it('test_expiringSoonBadge_when_count_positive_then_shows_count', () => {
    render(wrap(<ExpiringSoonBadge count={5} withinDays={7} />));
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('test_expiringSoonBadge_count_uses_tabular_nums', () => {
    const { container } = render(wrap(<ExpiringSoonBadge count={2} withinDays={7} />));
    const numEl = container.querySelector('.tabular-nums');
    expect(numEl).toBeTruthy();
  });
});
