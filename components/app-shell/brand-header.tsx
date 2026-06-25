'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useLocale } from 'next-intl';

// 05-10 B7: brand header — 32x32 logo + monospace wordmark, links to
// /[locale]/dashboard. Mounted at top of <Sidebar/> + <MobileNav/> drawer.
//
// a11y (audit S3): image is decorative (alt="") because the visible text
// "x265-butler" is the accessible name for the Link. Single source of truth
// for the accessible name keeps screen-reader announcement and on-screen
// text aligned per WCAG 2.5.3 Label in Name.
export function BrandHeader() {
  const locale = useLocale();
  return (
    <Link
      href={`/${locale}/dashboard`}
      className="flex min-h-[44px] items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/50"
    >
      <Image
        src="/brand/Logo-512x512.png"
        width={32}
        height={32}
        alt=""
        className="rounded-sm"
        priority
      />
      <span className="font-mono text-sm font-medium tracking-tight">x265-butler</span>
    </Link>
  );
}
