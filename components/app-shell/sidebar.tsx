import { SidebarNav } from './sidebar-nav';

// Persistent sidebar for >=lg viewports (per design-system/MASTER.md §6).
// Hidden on small screens — bottom-nav (also using <SidebarNav orientation="horizontal">)
// renders inside the topbar/footer area in [locale]/layout.tsx.
//
// post-05-10 user-decision (B+3): brand surface (logo + wordmark) lives in
// Topbar; Sidebar is nav-only. BrandHeader stays mounted in MobileNav drawer
// where the Topbar wordmark is replaced by the active-section name.
export function Sidebar() {
  return (
    <aside
      className="hidden w-60 shrink-0 border-r border-border bg-card lg:flex lg:flex-col"
      aria-label="Primary navigation"
    >
      <nav className="flex-1 overflow-y-auto p-3">
        <SidebarNav orientation="vertical" />
      </nav>
    </aside>
  );
}
