// 14-03: ShareFilterPill component tests. Covers AC-9, AC-10 (onChange semantics),
// AC-13 (touch-target), AC-16 (M1 invalid id fallback), AC-9-extended (SR5
// aria-current, SR6 truncation + title), AC-13-extended (SR2 aria-live).

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { ShareRow } from '@/src/lib/db/schema';
import { ShareFilterPill } from '@/components/library/share-filter-pill';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const mkShare = (overrides: Partial<ShareRow> & { id: number; name: string }): ShareRow => ({
  path: `/share-${overrides.id}`,
  min_size_mb: 1,
  extensions_csv: 'mkv',
  max_depth: null,
  created_at: 0,
  updated_at: 0,
  ...overrides,
});

describe('<ShareFilterPill /> visibility rules (AC-9)', () => {
  it('test_renders_null_when_shares_empty', () => {
    const { container } = render(
      wrap(<ShareFilterPill shares={[]} orphanCount={0} active="all" onChange={() => {}} />),
    );
    expect(container.firstChild).toBeNull();
  });

  it('test_renders_null_when_single_share_and_zero_orphans_degenerate', () => {
    const { container } = render(
      wrap(
        <ShareFilterPill
          shares={[mkShare({ id: 1, name: 'OnlyShare' })]}
          orphanCount={0}
          active="all"
          onChange={() => {}}
        />,
      ),
    );
    expect(container.firstChild).toBeNull();
  });

  it('test_renders_when_single_share_with_orphans_present', () => {
    const { getByRole } = render(
      wrap(
        <ShareFilterPill
          shares={[mkShare({ id: 1, name: 'Library' })]}
          orphanCount={2}
          active="all"
          onChange={() => {}}
        />,
      ),
    );
    const trigger = getByRole('button');
    expect(trigger.textContent).toMatch(/Share: All/);
  });
});

describe('<ShareFilterPill /> trigger label + title', () => {
  const shares = [mkShare({ id: 1, name: 'Movies' }), mkShare({ id: 2, name: 'Series' })];

  it('test_trigger_label_when_active_all_shows_Share_All', () => {
    const { getByRole } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={0} active="all" onChange={() => {}} />),
    );
    expect(getByRole('button').textContent).toMatch(/Share: All/);
  });

  it('test_trigger_label_when_active_numeric_shows_share_name', () => {
    const { getByRole } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={0} active={2} onChange={() => {}} />),
    );
    const btn = getByRole('button');
    expect(btn.textContent).toMatch(/Share: Series/);
    expect(btn.getAttribute('title')).toBe('Series');
  });

  it('test_trigger_label_when_active_orphan_shows_Share_Orphaned', () => {
    const { getByRole } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={3} active="orphan" onChange={() => {}} />),
    );
    expect(getByRole('button').textContent).toMatch(/Share: Orphaned/);
  });

  // audit-added M1: AC-16 invalid / non-existent id fallback
  it('test_active_invalid_id_falls_back_to_Share_All_no_crash', () => {
    const { getByRole } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={0} active={99999} onChange={() => {}} />),
    );
    const btn = getByRole('button');
    expect(btn.textContent).toMatch(/Share: All/);
    expect(btn.getAttribute('title')).toBe('');
  });

  // audit-added SR6: long share-name truncation discoverability via title
  it('test_long_share_name_trigger_carries_full_name_in_title_attribute', () => {
    const longName = 'Family Photos & Vacation Videos 2020 Backup';
    const { getByRole } = render(
      wrap(
        <ShareFilterPill
          shares={[mkShare({ id: 5, name: longName }), mkShare({ id: 6, name: 'Other' })]}
          orphanCount={0}
          active={5}
          onChange={() => {}}
        />,
      ),
    );
    const btn = getByRole('button');
    expect(btn.getAttribute('title')).toBe(longName);
    // truncation applied via max-w-[12rem] / ellipsis classes on the label-span
    const labelSpan = btn.querySelector('span');
    expect(labelSpan?.className).toMatch(/max-w-\[12rem\]/);
    expect(labelSpan?.className).toMatch(/text-ellipsis/);
  });
});

describe('<ShareFilterPill /> dropdown contents + onChange', () => {
  const shares = [
    mkShare({ id: 1, name: 'Movies' }),
    mkShare({ id: 2, name: 'Series' }),
    mkShare({ id: 3, name: 'Photos' }),
  ];

  function openMenu(getByRole: ReturnType<typeof render>['getByRole']) {
    const trigger = getByRole('button');
    fireEvent.click(trigger);
    return trigger;
  }

  it('test_dropdown_lists_all_then_shares_id_asc_then_orphan_when_present', () => {
    const { getByRole, baseElement } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={4} active="all" onChange={() => {}} />),
    );
    openMenu(getByRole);
    const text = within(baseElement as HTMLElement)
      .getAllByRole('menuitem')
      .map((el) => el.textContent ?? '');
    // ["All", "Movies", "Series", "Photos", "Orphaned (4)"]
    expect(text[0]).toMatch(/All/);
    expect(text[1]).toMatch(/Movies/);
    expect(text[2]).toMatch(/Series/);
    expect(text[3]).toMatch(/Photos/);
    expect(text[text.length - 1]).toMatch(/Orphaned \(4\)/);
  });

  it('test_dropdown_omits_orphan_when_orphanCount_zero', () => {
    const { getByRole, baseElement } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={0} active="all" onChange={() => {}} />),
    );
    openMenu(getByRole);
    const text = within(baseElement as HTMLElement)
      .getAllByRole('menuitem')
      .map((el) => el.textContent ?? '');
    expect(text.some((t) => /Orphaned/.test(t))).toBe(false);
  });

  it('test_onChange_fires_with_numeric_id_when_share_item_clicked', () => {
    const onChange = vi.fn();
    const { getByRole, baseElement } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={0} active="all" onChange={onChange} />),
    );
    openMenu(getByRole);
    const items = within(baseElement as HTMLElement).getAllByRole('menuitem');
    fireEvent.click(items[2]); // Series (id=2)
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('test_onChange_fires_with_all_when_All_item_clicked', () => {
    const onChange = vi.fn();
    const { getByRole, baseElement } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={0} active={2} onChange={onChange} />),
    );
    openMenu(getByRole);
    const items = within(baseElement as HTMLElement).getAllByRole('menuitem');
    fireEvent.click(items[0]); // All
    expect(onChange).toHaveBeenCalledWith('all');
  });

  it('test_onChange_fires_with_orphan_when_Orphaned_item_clicked', () => {
    const onChange = vi.fn();
    const { getByRole, baseElement } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={5} active="all" onChange={onChange} />),
    );
    openMenu(getByRole);
    const items = within(baseElement as HTMLElement).getAllByRole('menuitem');
    fireEvent.click(items[items.length - 1]); // Orphaned (5)
    expect(onChange).toHaveBeenCalledWith('orphan');
  });

  // audit-added M1: AC-16 component slice — clicking "All" while active=invalid
  // gives operator the escape route
  it('test_active_invalid_id_click_All_fires_onChange_all_escape_route', () => {
    const onChange = vi.fn();
    const { getByRole, baseElement } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={0} active={99999} onChange={onChange} />),
    );
    openMenu(getByRole);
    const items = within(baseElement as HTMLElement).getAllByRole('menuitem');
    fireEvent.click(items[0]);
    expect(onChange).toHaveBeenCalledWith('all');
  });

  // audit-added M1: NO aria-current marker on any item in fallback state
  it('test_active_invalid_id_no_share_item_marked_aria_current', () => {
    const { getByRole, baseElement } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={0} active={99999} onChange={() => {}} />),
    );
    openMenu(getByRole);
    const items = within(baseElement as HTMLElement).getAllByRole('menuitem');
    // The All item carries aria-current (fallback marker); share items do NOT
    expect(items[0].getAttribute('aria-current')).toBe('true');
    for (let i = 1; i < items.length; i++) {
      expect(items[i].getAttribute('aria-current')).toBeNull();
    }
  });

  // audit-added SR5: AC-9-extended aria-current on active item
  it('test_aria_current_set_on_active_numeric_share_item', () => {
    const { getByRole, baseElement } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={0} active={2} onChange={() => {}} />),
    );
    openMenu(getByRole);
    const items = within(baseElement as HTMLElement).getAllByRole('menuitem');
    expect(items[2].getAttribute('aria-current')).toBe('true');
    expect(items[0].getAttribute('aria-current')).toBeNull();
    expect(items[1].getAttribute('aria-current')).toBeNull();
  });

  it('test_aria_current_set_on_active_orphan_item', () => {
    const { getByRole, baseElement } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={2} active="orphan" onChange={() => {}} />),
    );
    openMenu(getByRole);
    const items = within(baseElement as HTMLElement).getAllByRole('menuitem');
    const orphanItem = items[items.length - 1];
    expect(orphanItem.getAttribute('aria-current')).toBe('true');
  });
});

describe('<ShareFilterPill /> aria-live announcement (SR2) + touch-target (AC-13)', () => {
  const shares = [mkShare({ id: 1, name: 'Movies' }), mkShare({ id: 2, name: 'Series' })];

  it('test_onAnnounce_fires_orphan_variant_when_orphan_selected', () => {
    const onAnnounce = vi.fn();
    const { getByRole, baseElement } = render(
      wrap(
        <ShareFilterPill
          shares={shares}
          orphanCount={3}
          active="all"
          onChange={() => {}}
          onAnnounce={onAnnounce}
        />,
      ),
    );
    fireEvent.click(getByRole('button'));
    const items = within(baseElement as HTMLElement).getAllByRole('menuitem');
    fireEvent.click(items[items.length - 1]); // Orphaned
    expect(onAnnounce).toHaveBeenCalled();
    expect(onAnnounce.mock.calls[0][0]).toMatch(/orphan/i);
  });

  it('test_onAnnounce_fires_share_variant_when_share_selected', () => {
    const onAnnounce = vi.fn();
    const { getByRole, baseElement } = render(
      wrap(
        <ShareFilterPill
          shares={shares}
          orphanCount={0}
          active="all"
          onChange={() => {}}
          onAnnounce={onAnnounce}
        />,
      ),
    );
    fireEvent.click(getByRole('button'));
    const items = within(baseElement as HTMLElement).getAllByRole('menuitem');
    fireEvent.click(items[2]); // Series
    expect(onAnnounce).toHaveBeenCalled();
    expect(onAnnounce.mock.calls[0][0]).toMatch(/Series/);
  });

  it('test_trigger_carries_min_height_44px_touch_target_class', () => {
    const { getByRole } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={0} active="all" onChange={() => {}} />),
    );
    expect(getByRole('button').className).toMatch(/min-h-\[44px\]/);
  });

  it('test_dropdown_items_carry_min_height_44px_touch_target_class', () => {
    const { getByRole, baseElement } = render(
      wrap(<ShareFilterPill shares={shares} orphanCount={0} active="all" onChange={() => {}} />),
    );
    fireEvent.click(getByRole('button'));
    const items = within(baseElement as HTMLElement).getAllByRole('menuitem');
    for (const item of items) {
      expect(item.className).toMatch(/min-h-\[44px\]/);
    }
  });
});
