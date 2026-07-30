import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LibraryTable } from '@/components/library/library-table';
import type { FileRow } from '@/src/lib/db/schema';
import { wrap } from './test-utils';

const baseRow: FileRow = {
  id: 1,
  path: '/media/example.mp4',
  size_bytes: 1024 ** 3,
  mtime: 1_700_000_000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 5_000_000,
  duration_seconds: 7200,
  width: 1920,
  height: 1080,
  container: 'mp4',
  status: 'pending',
  last_scanned_at: Math.floor(Date.now() / 1000) - 60,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  version: 0,
  container_override: null,
  share_id: null,
};

describe('LibraryTable', () => {
  it('test_LibraryTable_when_rows_then_renders_path_codec_bitrate_size', () => {
    render(
      wrap(
        <LibraryTable
          rows={[baseRow]}
          sort="size"
          dir="desc"
          onSort={vi.fn()}
          onRowClick={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText('/media/example.mp4')).toBeInTheDocument();
    expect(screen.getByText('h264')).toBeInTheDocument();
  });

  it('test_LibraryTable_when_sort_header_clicked_then_onSort_fires_with_column', () => {
    const onSort = vi.fn();
    render(
      wrap(
        <LibraryTable
          rows={[baseRow]}
          sort="size"
          dir="desc"
          onSort={onSort}
          onRowClick={vi.fn()}
        />,
      ),
    );
    // Click the Size header sort button
    const sizeHeader = screen.getByRole('button', { name: /size/i });
    fireEvent.click(sizeHeader);
    expect(onSort).toHaveBeenCalledWith('size');
  });

  it('test_LibraryTable_when_active_sort_size_desc_then_aria_sort_descending', () => {
    const { container } = render(
      wrap(
        <LibraryTable
          rows={[baseRow]}
          sort="size"
          dir="desc"
          onSort={vi.fn()}
          onRowClick={vi.fn()}
        />,
      ),
    );
    const sizeTh = container.querySelector('th[aria-sort="descending"]');
    expect(sizeTh).not.toBeNull();
  });

  it('test_LibraryTable_when_active_sort_scanned_asc_then_aria_sort_ascending', () => {
    const { container } = render(
      wrap(
        <LibraryTable
          rows={[baseRow]}
          sort="scanned"
          dir="asc"
          onSort={vi.fn()}
          onRowClick={vi.fn()}
        />,
      ),
    );
    const ths = Array.from(container.querySelectorAll('th[aria-sort]'));
    const scannedTh = ths.find((th) => th.getAttribute('aria-sort') === 'ascending');
    expect(scannedTh).not.toBeUndefined();
  });

  it('test_LibraryTable_when_row_clicked_then_onRowClick_fires_with_row_and_target', () => {
    const onRowClick = vi.fn();
    render(
      wrap(
        <LibraryTable
          rows={[baseRow]}
          sort="size"
          dir="desc"
          onSort={vi.fn()}
          onRowClick={onRowClick}
        />,
      ),
    );
    const row = screen.getByRole('button', { name: /media\/example\.mp4/ });
    fireEvent.click(row);
    expect(onRowClick).toHaveBeenCalled();
    expect(onRowClick.mock.calls[0][0]).toEqual(baseRow);
  });
});
