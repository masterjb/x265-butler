import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Pagination } from '@/components/library/pagination';
import { wrap } from './test-utils';

describe('Pagination', () => {
  it('test_Pagination_when_page_1_then_prev_is_disabled', () => {
    render(
      wrap(
        <Pagination
          page={1}
          size={50}
          total={250}
          pageCount={5}
          onPageChange={vi.fn()}
          onSizeChange={vi.fn()}
        />,
      ),
    );
    const prev = screen.getByRole('button', { name: /previous/i });
    expect(prev).toBeDisabled();
  });

  it('test_Pagination_when_page_last_then_next_is_disabled', () => {
    render(
      wrap(
        <Pagination
          page={5}
          size={50}
          total={250}
          pageCount={5}
          onPageChange={vi.fn()}
          onSizeChange={vi.fn()}
        />,
      ),
    );
    const next = screen.getByRole('button', { name: /next/i });
    expect(next).toBeDisabled();
  });

  it('test_Pagination_when_pageCount_over_7_then_renders_ellipsis', () => {
    render(
      wrap(
        <Pagination
          page={5}
          size={50}
          total={1000}
          pageCount={20}
          onPageChange={vi.fn()}
          onSizeChange={vi.fn()}
        />,
      ),
    );
    const ellipses = screen.getAllByText('…');
    expect(ellipses.length).toBeGreaterThan(0);
  });

  it('test_Pagination_when_page_clicked_then_onPageChange_fires', () => {
    const onPageChange = vi.fn();
    render(
      wrap(
        <Pagination
          page={1}
          size={50}
          total={250}
          pageCount={5}
          onPageChange={onPageChange}
          onSizeChange={vi.fn()}
        />,
      ),
    );
    const page2 = screen.getByRole('button', { name: '2' });
    fireEvent.click(page2);
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  // audit-added S5: Home / End keyboard navigation
  it('test_Pagination_when_Home_pressed_then_jumps_to_page_1', () => {
    const onPageChange = vi.fn();
    render(
      wrap(
        <Pagination
          page={3}
          size={50}
          total={250}
          pageCount={5}
          onPageChange={onPageChange}
          onSizeChange={vi.fn()}
        />,
      ),
    );
    const nav = screen.getByRole('navigation');
    fireEvent.keyDown(nav, { key: 'Home' });
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('test_Pagination_when_End_pressed_then_jumps_to_pageCount', () => {
    const onPageChange = vi.fn();
    render(
      wrap(
        <Pagination
          page={1}
          size={50}
          total={250}
          pageCount={5}
          onPageChange={onPageChange}
          onSizeChange={vi.fn()}
        />,
      ),
    );
    const nav = screen.getByRole('navigation');
    fireEvent.keyDown(nav, { key: 'End' });
    expect(onPageChange).toHaveBeenCalledWith(5);
  });

  it('test_Pagination_when_total_zero_then_shows_zero_in_summary', () => {
    render(
      wrap(
        <Pagination
          page={1}
          size={50}
          total={0}
          pageCount={0}
          onPageChange={vi.fn()}
          onSizeChange={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText(/showing 0–0 of 0/i)).toBeInTheDocument();
  });
});
