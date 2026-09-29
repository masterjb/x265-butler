// 15-02 T6: StorageEmptyState — 3 variants, distinct headlines + correct CTA.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '@/messages/en.json';
import { StorageEmptyState } from '@/components/storage/storage-empty-state';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe('<StorageEmptyState />', () => {
  it('noShares variant — headline + Settings CTA href', () => {
    render(wrap(<StorageEmptyState variant="noShares" locale="en" />));
    expect(screen.getByText('No shares configured')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /Go to Settings/ });
    expect(cta).toHaveAttribute('href', '/en/settings/paths');
  });

  it('noFiles variant — headline + Run scan CTA href', () => {
    render(wrap(<StorageEmptyState variant="noFiles" locale="en" />));
    expect(screen.getByText('No files scanned yet')).toBeInTheDocument();
    const cta = screen.getByRole('link', { name: /Run scan/ });
    expect(cta).toHaveAttribute('href', '/en/scan');
  });

  it('noFilesForShare variant — headline visible, NO CTA rendered (AC-10)', () => {
    render(wrap(<StorageEmptyState variant="noFilesForShare" locale="en" />));
    expect(screen.getByText('No files in this share')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('locale="de" path prefix is honoured for CTA href', () => {
    render(wrap(<StorageEmptyState variant="noShares" locale="de" />));
    const cta = screen.getByRole('link');
    expect(cta).toHaveAttribute('href', '/de/settings/paths');
  });
});
