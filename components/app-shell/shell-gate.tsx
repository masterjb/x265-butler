'use client';

// ShellGate — pathname-conditional App-Shell wrapper ("No App-Shell" for /login).
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
