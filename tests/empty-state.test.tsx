import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Library } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';

describe('empty-state (audit-added G8)', () => {
  it('test_emptyState_when_rendered_shows_title_body_and_decorative_icon', () => {
    const { container } = render(
      <EmptyState icon={Library} title="No items" body="Configure to populate" />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'No items' })).toBeInTheDocument();
    expect(screen.getByText('Configure to populate')).toBeInTheDocument();
    // Icon is decorative — must carry aria-hidden so screen readers skip it
    const svg = container.querySelector('svg[aria-hidden="true"]');
    expect(svg).not.toBeNull();
  });

  it('test_emptyState_when_no_body_does_not_render_paragraph', () => {
    render(<EmptyState icon={Library} title="Empty" />);
    expect(screen.queryByText(/configure/i)).not.toBeInTheDocument();
  });
});
