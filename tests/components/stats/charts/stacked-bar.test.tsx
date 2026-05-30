import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { StackedBar } from '@/components/stats/charts/stacked-bar';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const DATA = [
  { bucket: '4K', count: 5 },
  { bucket: '1080p', count: 3 },
  { bucket: '720p', count: 2 },
];

describe('StackedBar', () => {
  it('test_stackedBar_when_empty_then_shows_empty_state', () => {
    render(
      wrap(
        <StackedBar
          data={[]}
          total={0}
          title="Resolution"
          emptyTitle="No data"
          emptyBody="Nothing"
        />,
      ),
    );
    expect(screen.getByText('No data')).toBeTruthy();
  });

  it('test_stackedBar_when_data_then_renders_legend_rows', () => {
    render(
      wrap(
        <StackedBar
          data={DATA}
          total={10}
          title="Resolution"
          emptyTitle="No data"
          emptyBody="Nothing"
        />,
      ),
    );
    expect(screen.getByText('4K')).toBeTruthy();
    expect(screen.getByText('1080p')).toBeTruthy();
    expect(screen.getByText('720p')).toBeTruthy();
  });

  it('test_stackedBar_when_rendered_then_has_role_img_with_aria_label', () => {
    const { container } = render(
      wrap(
        <StackedBar
          data={DATA}
          total={10}
          title="Resolution"
          emptyTitle="No data"
          emptyBody="Nothing"
        />,
      ),
    );
    const img = container.querySelector('[role="img"]');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('aria-label')).toMatch(/Resolution/);
    expect(img?.getAttribute('aria-label')).toMatch(/4K/);
  });

  it('test_stackedBar_bar_width_proportional_to_count', () => {
    const { container } = render(
      wrap(
        <StackedBar
          data={DATA}
          total={10}
          title="Resolution"
          emptyTitle="No data"
          emptyBody="Nothing"
        />,
      ),
    );
    // First bar: 5/10 = 50%
    const bars = container.querySelectorAll('[aria-hidden="true"]');
    const firstBar = bars[0] as HTMLElement;
    expect(firstBar.style.width).toBe('50%');
  });

  it('test_stackedBar_legend_shows_count_and_percent', () => {
    render(
      wrap(
        <StackedBar
          data={DATA}
          total={10}
          title="Resolution"
          emptyTitle="No data"
          emptyBody="Nothing"
        />,
      ),
    );
    // 5/10 = 50%
    expect(screen.getByText('5 (50%)')).toBeTruthy();
  });

  it('test_stackedBar_is_keyboard_focusable', () => {
    const { container } = render(
      wrap(
        <StackedBar
          data={DATA}
          total={10}
          title="Resolution"
          emptyTitle="No data"
          emptyBody="Nothing"
        />,
      ),
    );
    const img = container.querySelector('[role="img"]');
    expect(img?.getAttribute('tabindex')).toBe('0');
  });
});
