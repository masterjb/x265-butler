import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { HorizontalBarList } from '@/components/stats/charts/horizontal-bar-list';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const DATA = [
  { label: 'skipped-codec', count: 7 },
  { label: 'skipped-sidecar', count: 3 },
  { label: 'skipped-blocklist', count: 1 },
];

describe('HorizontalBarList', () => {
  it('test_horizontalBarList_when_empty_then_shows_empty_state', () => {
    render(
      wrap(
        <HorizontalBarList
          data={[]}
          title="Skip types"
          emptyTitle="No data"
          emptyBody="Nothing to show"
        />,
      ),
    );
    expect(screen.getByText('No data')).toBeTruthy();
  });

  it('test_horizontalBarList_when_data_then_renders_all_rows', () => {
    render(
      wrap(
        <HorizontalBarList
          data={DATA}
          title="Skip types"
          emptyTitle="No data"
          emptyBody="Nothing to show"
        />,
      ),
    );
    expect(screen.getByText('skipped-codec')).toBeTruthy();
    expect(screen.getByText('skipped-sidecar')).toBeTruthy();
    expect(screen.getByText('skipped-blocklist')).toBeTruthy();
  });

  it('test_horizontalBarList_aria_label_contains_title_and_count', () => {
    const { container } = render(
      wrap(
        <HorizontalBarList
          data={DATA}
          title="Skip types"
          emptyTitle="No data"
          emptyBody="Nothing to show"
        />,
      ),
    );
    const list = container.querySelector('[role="table"]');
    expect(list?.getAttribute('aria-label')).toMatch(/Skip types/);
    expect(list?.getAttribute('aria-label')).toMatch(/3 categories/);
  });

  it('test_horizontalBarList_sortable_exposes_aria_sort', () => {
    const { container } = render(
      wrap(
        <HorizontalBarList
          data={DATA}
          title="Skip types"
          emptyTitle="No data"
          emptyBody="Nothing to show"
          sortable
        />,
      ),
    );
    const list = container.querySelector('[role="table"]');
    expect(list?.getAttribute('aria-sort')).toBe('descending');
  });

  it('test_horizontalBarList_sortable_toggle_changes_aria_sort', async () => {
    const { container } = render(
      wrap(
        <HorizontalBarList
          data={DATA}
          title="Skip types"
          emptyTitle="No data"
          emptyBody="Nothing to show"
          sortable
        />,
      ),
    );
    const toggleBtn = container.querySelector('button');
    expect(toggleBtn).toBeTruthy();
    await userEvent.click(toggleBtn!);
    const list = container.querySelector('[role="table"]');
    expect(list?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('test_horizontalBarList_count_uses_tabular_nums', () => {
    const { container } = render(
      wrap(
        <HorizontalBarList
          data={DATA}
          title="Skip types"
          emptyTitle="No data"
          emptyBody="Nothing to show"
        />,
      ),
    );
    const nums = container.querySelectorAll('.tabular-nums');
    expect(nums.length).toBeGreaterThan(0);
  });
});
