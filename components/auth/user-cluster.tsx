'use client';

// 05-02 T1: Topbar user cluster.
// Phase 5 Plan 05-02 — AC-9 + audit M2 (SSR-rendered when authenticated; null otherwise).
//
// Reads useAuthStatus() from context — returns null when authenticated=false
// (zero-regression byte-identical 1.4.0 markup). Responsive variants:
//  - >=md: username pill (Badge) + LogOut button (label visible)
//  - <md:  AvatarInitial (role=img) + LogOut icon button (aria-label only)

import { User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useAuthStatus } from '@/components/auth/use-auth-status';
import { AvatarInitial } from '@/components/auth/avatar-initial';
import { LogoutButton } from '@/components/auth/logout-button';

export function UserCluster() {
  const { authenticated, username } = useAuthStatus();
  if (!authenticated || !username) return null;

  return (
    <>
      {/* >=md: pill + label-bearing button */}
      <div className="hidden items-center gap-2 md:flex">
        <Badge
          variant="secondary"
          className="max-w-[160px] gap-1.5 truncate px-3 py-1.5"
          title={username}
        >
          <User className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate font-sans text-sm font-medium">{username}</span>
        </Badge>
        <LogoutButton variant="inline" />
      </div>
      {/* <md: avatar + icon-only button */}
      <div className="flex items-center gap-1 md:hidden">
        <AvatarInitial username={username} />
        <LogoutButton variant="icon" />
      </div>
    </>
  );
}
