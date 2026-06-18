import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SidebarNav, NAV_ITEMS } from '@/components/app-shell/sidebar-nav';
import en from '@/messages/en.json';
import de from '@/messages/de.json';
import { wrap } from './test-utils';

describe('sidebar nav (audit-added G8)', () => {
  it('test_sidebarNav_when_rendered_shows_all_six_items_in_locale_text', () => {
    render(wrap(<SidebarNav />));
    (Object.values(en.nav) as string[]).forEach((label) => {
      expect(screen.getByRole('link', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    });
  });

  it('test_sidebarNav_when_on_library_route_marks_library_link_active', () => {
    // tests/setup.ts mocks usePathname() => '/en/library'
    render(wrap(<SidebarNav />));
    const active = screen.getByRole('link', { name: new RegExp(en.nav.library, 'i') });
    expect(active).toHaveAttribute('aria-current', 'page');
  });

  // 21-02 T1 Step 9: Diagnostics nav-entry assertions.
  it('test_sidebarNav_diagnostics_entry_sits_between_settings_and_logs', () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    const settingsIdx = hrefs.indexOf('/settings');
    const diagIdx = hrefs.indexOf('/diagnostics');
    const logsIdx = hrefs.indexOf('/logs');
    expect(diagIdx).toBe(settingsIdx + 1);
    expect(logsIdx).toBe(diagIdx + 1);
  });

  it('test_sidebarNav_diagnostics_entry_uses_wrench_icon', () => {
    const entry = NAV_ITEMS.find((item) => item.href === '/diagnostics');
    expect(entry).toBeDefined();
    expect(entry?.icon?.displayName ?? entry?.icon?.name ?? '').toMatch(/wrench/i);
  });

  it('test_sidebarNav_diagnostics_label_resolves_in_en_and_de', () => {
    expect(en.nav.diagnostics).toBe('Diagnostics');
    expect(de.nav.diagnostics).toBe('Diagnose');
    render(wrap(<SidebarNav />));
    const list = screen.getByRole('list');
    expect(
      within(list).getByRole('link', { name: new RegExp(en.nav.diagnostics, 'i') }),
    ).toBeInTheDocument();
  });
});
