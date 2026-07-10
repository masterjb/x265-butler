'use client';

// 05-02 T1: ShellGate — pathname-conditional App-Shell wrapper.
// Phase 5 Plan 05-02 — design-system/pages/login.md §2 ("No App-Shell" for /login).
//
// Suppresses Topbar + Sidebar on the login page only. Login renders its own
// centered card via NoShellLayout. All other locale-prefixed routes get the
// full App-Shell (Topbar + Sidebar + #main). When auth_enabled='false' the
// rendered markup is byte-identical to 1.4.0 since UserCluster auto-hides.

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AppShell } from './app-shell';

const NO_SHELL_PATTERNS = [/^\/(en|de)\/login(?:\/|$)/];

export function ShellGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const noShell = NO_SHELL_PATTERNS.some((re) => re.test(pathname));
  if (noShell) {
    return <main id="main">{children}</main>;
  }
  return <AppShell>{children}</AppShell>;
}
