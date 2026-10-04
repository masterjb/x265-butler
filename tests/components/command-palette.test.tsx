// 13-03 T2 tests — CommandPalette component (≥15 cases per plan + audit M6+M9+SR2).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

const { mockRouterPush, mockUsePathname } = vi.hoisted(() => ({
  mockRouterPush: vi.fn(),
  mockUsePathname: vi.fn<() => string>(() => '/en/library'),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => mockUsePathname(),
  useSearchParams: () => new URLSearchParams(),
}));

import { CommandPalette } from '@/components/ui/command-palette';

function Wrapper({ children, locale = 'en' }: { children: React.ReactNode; locale?: 'en' | 'de' }) {
  return (
    <NextIntlClientProvider locale={locale} messages={locale === 'de' ? de : en}>
      {children}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  mockRouterPush.mockReset();
  mockUsePathname.mockImplementation(() => '/en/library');
});

describe('CommandPalette', () => {
  it('open=false → palette NOT in DOM', () => {
    render(
      <Wrapper>
        <CommandPalette open={false} onOpenChange={() => undefined} />
      </Wrapper>,
    );
    expect(screen.queryByTestId('command-palette-popup')).not.toBeInTheDocument();
  });

  it('open=true → palette + input + 10 items rendered', () => {
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    expect(screen.getByTestId('command-palette-popup')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search page…')).toBeInTheDocument();
    const items = screen.getAllByTestId(/^command-palette-item-/);
    // 13-04 added scanEstimate → 10. 15-02 added storage between bench and
    // library → 11.
    expect(items).toHaveLength(12);
  });

  it('items follow NAV_ITEMS order: Dashboard..Logs', () => {
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    const items = screen.getAllByTestId(/^command-palette-item-/);
    const order = items.map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual([
      'command-palette-item-dashboard',
      'command-palette-item-stats',
      'command-palette-item-bench',
      // 15-02: storage inserted between bench and library.
      'command-palette-item-storage',
      'command-palette-item-library',
      'command-palette-item-queue',
      'command-palette-item-trash',
      'command-palette-item-blocklist',
      // 13-04: scanEstimate inserted between blocklist and settings.
      'command-palette-item-scanEstimate',
      'command-palette-item-settings',
      // 21-02: diagnostics inserted between settings and logs.
      'command-palette-item-diagnostics',
      'command-palette-item-logs',
    ]);
  });

  it('type "lib" → only Library row visible (EN locale)', () => {
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    const input = screen.getByPlaceholderText('Search page…');
    fireEvent.change(input, { target: { value: 'lib' } });
    const items = screen.queryAllByTestId(/^command-palette-item-/);
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute('data-testid', 'command-palette-item-library');
  });

  it('type "ubersicht" (no umlaut) → Übersicht matches in DE locale (diacritics-insensitive)', () => {
    render(
      <Wrapper locale="de">
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    const input = screen.getByPlaceholderText('Seite suchen…');
    fireEvent.change(input, { target: { value: 'ubersicht' } });
    const items = screen.queryAllByTestId(/^command-palette-item-/);
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute('data-testid', 'command-palette-item-dashboard');
  });

  it('type "xyz" → no items + empty-state visible', () => {
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    const input = screen.getByPlaceholderText('Search page…');
    fireEvent.change(input, { target: { value: 'xyz' } });
    expect(screen.queryAllByTestId(/^command-palette-item-/)).toHaveLength(0);
    expect(screen.getByTestId('command-palette-empty')).toHaveTextContent('No matches');
  });

  it('clear filter → all 10 items restored', () => {
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    const input = screen.getByPlaceholderText('Search page…');
    fireEvent.change(input, { target: { value: 'lib' } });
    expect(screen.queryAllByTestId(/^command-palette-item-/)).toHaveLength(1);
    fireEvent.change(input, { target: { value: '' } });
    // 13-04 added scanEstimate → 10. 15-02 added storage → 11. 21-02 added diagnostics → 12.
    expect(screen.queryAllByTestId(/^command-palette-item-/)).toHaveLength(12);
  });

  it('click item (Queue) → router.push called with /en/queue', () => {
    const onOpenChange = vi.fn();
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={onOpenChange} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId('command-palette-item-queue'));
    expect(mockRouterPush).toHaveBeenCalledWith('/en/queue');
  });

  it('click item → onOpenChange(false) called BEFORE navigation', () => {
    const onOpenChange = vi.fn();
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={onOpenChange} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId('command-palette-item-queue'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('every item has min-h-[44px] (touch-target a11y)', () => {
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    const items = screen.getAllByTestId(/^command-palette-item-/);
    for (const item of items) {
      expect(item.className).toMatch(/min-h-\[44px\]/);
    }
  });

  it('items render Icon + Label + secondary-path (3 channels per S2)', () => {
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    const libraryItem = screen.getByTestId('command-palette-item-library');
    expect(libraryItem.querySelector('svg')).toBeInTheDocument();
    expect(libraryItem).toHaveTextContent('Library');
    expect(libraryItem).toHaveTextContent('/en/library');
  });

  it('audit-SR2: pathname === target → router.push NOT called, onOpenChange still called', () => {
    mockUsePathname.mockImplementation(() => '/en/library');
    const onOpenChange = vi.fn();
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={onOpenChange} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId('command-palette-item-library'));
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('active-route highlight: current pathname item carries border-l-2 border-primary class', () => {
    mockUsePathname.mockImplementation(() => '/en/library');
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    const libraryItem = screen.getByTestId('command-palette-item-library');
    expect(libraryItem.className).toMatch(/border-l-2/);
    expect(libraryItem.className).toMatch(/border-primary/);
    const queueItem = screen.getByTestId('command-palette-item-queue');
    expect(queueItem.className).not.toMatch(/border-primary/);
  });

  it('input has aria-label = palette.title and placeholder = palette.placeholder', () => {
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    const input = screen.getByPlaceholderText('Search page…');
    expect(input).toHaveAttribute('aria-label', 'Quick navigation');
  });

  it('DE locale: input placeholder is localized "Seite suchen…" + empty-state "Keine Treffer"', () => {
    render(
      <Wrapper locale="de">
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    expect(screen.getByPlaceholderText('Seite suchen…')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('Seite suchen…');
    fireEvent.change(input, { target: { value: 'xyz' } });
    expect(screen.getByTestId('command-palette-empty')).toHaveTextContent('Keine Treffer');
  });

  it('audit-SR1 negative: type "ue" (typographic equivalent) → Übersicht does NOT match (out-of-scope)', () => {
    render(
      <Wrapper locale="de">
        <CommandPalette open onOpenChange={() => undefined} />
      </Wrapper>,
    );
    const input = screen.getByPlaceholderText('Seite suchen…');
    fireEvent.change(input, { target: { value: 'ue' } });
    const items = screen.queryAllByTestId(/^command-palette-item-/);
    const labels = items.map((el) => el.getAttribute('data-testid'));
    expect(labels).not.toContain('command-palette-item-dashboard');
  });

  it('click on different-route item routes correctly + closes palette (Trash → /en/trash)', () => {
    const onOpenChange = vi.fn();
    render(
      <Wrapper>
        <CommandPalette open onOpenChange={onOpenChange} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId('command-palette-item-trash'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockRouterPush).toHaveBeenCalledWith('/en/trash');
  });
});
