// 15-02 T6: PathPrefixFilterPill tests. Covers AC-8 visibility,
// dismiss-X dispatch, middle-ellipsis truncation, and aria contract.

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';
import {
  PathPrefixFilterPill,
  truncateMiddleEllipsis,
} from '@/components/library/path-prefix-filter-pill';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe('<PathPrefixFilterPill /> visibility (AC-8)', () => {
  it('renders nothing when pathPrefix is undefined', () => {
    const { container } = render(wrap(<PathPrefixFilterPill onClear={() => undefined} />));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when pathPrefix is an empty string', () => {
    const { container } = render(
      wrap(<PathPrefixFilterPill pathPrefix="" onClear={() => undefined} />),
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the pill with label + value when pathPrefix is present', () => {
    render(wrap(<PathPrefixFilterPill pathPrefix="/mnt/movies/A" onClear={() => undefined} />));
    expect(screen.getByTestId('path-prefix-pill-value')).toHaveTextContent('/mnt/movies/A');
    expect(screen.getByText(/Folder/)).toBeInTheDocument();
  });
});

describe('<PathPrefixFilterPill /> dismiss + a11y', () => {
  it('clicking dismiss-X fires onClear', () => {
    const onClear = vi.fn();
    render(wrap(<PathPrefixFilterPill pathPrefix="/mnt/movies/A" onClear={onClear} />));
    fireEvent.click(screen.getByRole('button', { name: /Clear folder filter/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('exposes aria-label that carries the full path (not truncated)', () => {
    const full = '/very/long/path/component/that/keeps/going/forever/until/it/wraps';
    render(wrap(<PathPrefixFilterPill pathPrefix={full} onClear={() => undefined} />));
    const pill = screen.getByLabelText(`Filter active: folder ${full}`);
    expect(pill).toBeInTheDocument();
  });
});

describe('truncateMiddleEllipsis (D5 ui-ux-pro-max)', () => {
  it('returns input untouched when shorter than the budget', () => {
    expect(truncateMiddleEllipsis('/short/path', 40)).toBe('/short/path');
  });

  it('keeps both ends and inserts an ellipsis in the middle when truncated', () => {
    const out = truncateMiddleEllipsis('/aaaaaaaaaa/bbbbbbbbbb/cccccccccc/dddddddddd/eeee', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).toContain('…');
    expect(out.startsWith('/aaaa')).toBe(true);
    expect(out.endsWith('eeee')).toBe(true);
  });
});
