// 05-02 T1: AppShell — Topbar + Sidebar + main wrapper.
// Extracted from app/[locale]/layout.tsx so /[locale]/login can suppress it
// via the ShellGate Client Component (see shell-gate.tsx).
//
// audit M2 boundary: when auth_enabled='false' AND not on /login, the
// rendered DOM is byte-identical to 1.4.0 markup.

import type { ReactNode } from 'react';
import { Topbar } from '@/components/app-shell/topbar';
import { Sidebar } from '@/components/app-shell/sidebar';
import { TopbarWarningsBanner } from '@/components/app-shell/topbar-warnings-banner';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Topbar />
      {/* Phase 21 Plan 21-04: warnings banner with own sticky-wrapper at
          top-14 (lg:top-16) below the Topbar. z-10 < Topbar z-20 < Bell
          dropdown z-50 — Bell dropdown overlays banner correctly. */}
      <TopbarWarningsBanner />
      <div className="flex flex-1">
        {/* Persistent sidebar on >=lg; on mobile, navigation lives in
            the Topbar hamburger drawer (see MobileNav). */}
        <Sidebar />
        <main id="main" className="flex-1 overflow-y-auto p-4 lg:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
