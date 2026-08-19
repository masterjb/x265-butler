import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeToggle } from '@/components/app-shell/theme-toggle';
import { LangSwitch } from '@/components/app-shell/lang-switch';
import { Topbar } from '@/components/app-shell/topbar';
import { wrap } from './test-utils';
import en from '@/messages/en.json';

// post-05-10 (B+3): Topbar carries the brand surface (32x32 logo + wordmark
// + version pill) on desktop, plus an active-section breadcrumb. Sidebar is
// nav-only.

vi.mock('@/components/auth/user-cluster', () => ({
  UserCluster: () => null,
}));

vi.mock('@/components/app-shell/active-jobs-badge', () => ({
  ActiveJobsBadge: () => null,
}));

// audit 01-04: 44px touch target on <lg per page-override §10 / MASTER §1.

describe('topbar icon-buttons (audit 01-04)', () => {
  it('test_themeToggle_when_rendered_then_has_44px_class_on_smaller_breakpoints', () => {
    render(wrap(<ThemeToggle />));
    const btn = screen.getByRole('button', { name: en.app.themeToggle.label });
    expect(btn.className).toMatch(/h-11/);
    expect(btn.className).toMatch(/w-11/);
    expect(btn.className).toMatch(/lg:h-9/);
    expect(btn.className).toMatch(/lg:w-9/);
  });

  it('test_themeToggle_when_rendered_then_has_aria_label', () => {
    render(wrap(<ThemeToggle />));
    expect(screen.getByRole('button', { name: en.app.themeToggle.label })).toBeInTheDocument();
  });

  it('test_langSwitch_when_rendered_then_has_44px_class_on_smaller_breakpoints', () => {
    render(wrap(<LangSwitch />));
    const btn = screen.getByRole('button', { name: en.app.langSwitch.label });
    expect(btn.className).toMatch(/h-11/);
    expect(btn.className).toMatch(/w-11/);
    expect(btn.className).toMatch(/lg:h-9/);
    expect(btn.className).toMatch(/lg:w-9/);
  });

  it('test_langSwitch_when_rendered_then_has_aria_label', () => {
    render(wrap(<LangSwitch />));
    expect(screen.getByRole('button', { name: en.app.langSwitch.label })).toBeInTheDocument();
  });
});

// post-05-10 user-decision (B+3): brand surface in Topbar, breadcrumb cue on desktop.
describe('topbar brand surface + active-section breadcrumb (post-05-10 B+3)', () => {
  it('renders 32x32 logo image with alt="" decorative inside the desktop brand link', () => {
    render(wrap(<Topbar />));
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('width')).toBe('32');
    expect(img!.getAttribute('height')).toBe('32');
    expect(img!.getAttribute('alt')).toBe('');
  });

  it('desktop brand link points to /en/dashboard (not /library)', () => {
    render(wrap(<Topbar />));
    // Multiple links exist (mobile section + desktop brand) — pick the one wrapping the wordmark.
    const wordmark = screen.getByText(en.app.title);
    const link = wordmark.closest('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/en/dashboard');
  });

  it('topbar does NOT duplicate the sidebar active-section indicator on desktop', () => {
    // tests/setup.ts mocks usePathname() => '/en/library'
    // post-05-10 follow-up: breadcrumb removed; sidebar aria-current is the
    // sole desktop indicator. Mobile branch still shows section name as the
    // brand-anchor link (asserted elsewhere).
    render(wrap(<Topbar />));
    expect(screen.queryByTestId('topbar-section-breadcrumb')).toBeNull();
  });
});
