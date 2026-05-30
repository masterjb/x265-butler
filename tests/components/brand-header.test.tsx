// 05-10 B7: BrandHeader — 32x32 logo + visible "x265-butler" text linking
// to /[locale]/dashboard. a11y (audit S3): alt="" decorative + no aria-label
// on Link (visible text is the accessible name per WCAG 2.5.3).

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandHeader } from '@/components/app-shell/brand-header';
import { wrap } from '../test-utils';

// next-intl client provider in `wrap()` injects locale="en". next/navigation
// is not used directly by the component but mock it defensively.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

// next/image renders a real <img> in jsdom; no mock required.

describe('BrandHeader — B7', () => {
  it('renders an <img> at 32x32 with alt="" (decorative — audit S3)', () => {
    render(wrap(<BrandHeader />));
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('width')).toBe('32');
    expect(img!.getAttribute('height')).toBe('32');
    expect(img!.getAttribute('alt')).toBe('');
  });

  it('Link points to /en/dashboard and carries NO aria-label (visible text accessible name — audit S3)', () => {
    render(wrap(<BrandHeader />));
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/en/dashboard');
    expect(link.hasAttribute('aria-label')).toBe(false);
  });

  it('renders the visible monospace brand text "x265-butler" inside the Link', () => {
    render(wrap(<BrandHeader />));
    const span = screen.getByText('x265-butler');
    expect(span).toBeInTheDocument();
    expect(span.className).toMatch(/font-mono/);
    // Visible text lives inside the anchor (single accessible-name source).
    const link = screen.getByRole('link');
    expect(link.contains(span)).toBe(true);
  });

  it('Image src targets the runtime-served path /brand/Logo-512x512.png (next/image optimizer URL contains encoded path)', () => {
    render(wrap(<BrandHeader />));
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    const src = img!.getAttribute('src') ?? '';
    // next/image rewrites to `/_next/image?url=%2Fbrand%2FLogo-512x512.png&w=...`
    // — assert the original path appears either decoded or URL-encoded.
    const decoded = decodeURIComponent(src);
    expect(decoded).toContain('/brand/Logo-512x512.png');
  });
});
