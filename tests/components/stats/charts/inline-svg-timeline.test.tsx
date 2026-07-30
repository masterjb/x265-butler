import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { InlineSvgTimeline } from '@/components/stats/charts/inline-svg-timeline';
import type { StatsTrendPointFull } from '@/src/lib/db';

if (typeof globalThis.ResizeObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function makeDay(date: string, savings: number, jobCount: number): StatsTrendPointFull {
  return { date, bytesIn: savings + 100, bytesOut: 100, savings, jobCount };
}

const DATA_30: StatsTrendPointFull[] = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(2027, 0, i + 1);
  const dd = d.toISOString().slice(0, 10);
  return makeDay(dd, i * 1_000_000, i > 0 ? 1 : 0);
});

describe('InlineSvgTimeline', () => {
  it('test_inlineSvgTimeline_when_all_zero_then_shows_empty_state', () => {
    const empty = Array.from({ length: 30 }, (_, i) =>
      makeDay(`2027-01-${String(i + 1).padStart(2, '0')}`, 0, 0),
    );
    render(wrap(<InlineSvgTimeline data={empty} locale="en" />));
    const emptyTitle = en.stats.charts.savingsTimeline.empty.title;
    expect(screen.getByText(emptyTitle)).toBeTruthy();
  });

  it('test_inlineSvgTimeline_when_data_then_renders_svg_with_testid', () => {
    const { container } = render(wrap(<InlineSvgTimeline data={DATA_30} locale="en" />));
    expect(container.querySelector('[data-testid="inline-svg-timeline"]')).toBeTruthy();
  });

  it('test_inlineSvgTimeline_chart_container_has_aria_label', () => {
    const { container } = render(wrap(<InlineSvgTimeline data={DATA_30} locale="en" />));
    const chart = container.querySelector('[role="img"][aria-label]');
    expect(chart).toBeTruthy();
  });

  it('test_inlineSvgTimeline_chart_container_is_keyboard_navigable', () => {
    const { container } = render(wrap(<InlineSvgTimeline data={DATA_30} locale="en" />));
    const focusable = container.querySelector('[role="img"][tabindex="0"]');
    expect(focusable).toBeTruthy();
  });

  it('test_inlineSvgTimeline_subtitle_visible', () => {
    render(wrap(<InlineSvgTimeline data={DATA_30} locale="en" />));
    const subtitle = en.stats.charts.savingsTimeline.subtitle;
    expect(screen.getByText(subtitle)).toBeTruthy();
  });
});
