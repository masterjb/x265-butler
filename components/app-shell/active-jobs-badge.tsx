'use client';

// 03-04 Plan Task 3 — Topbar active-jobs badge + browser tab title hook.
// Audit findings landed:
// - M4: 'use client' first line.
// - S2: 1-retry with 1s backoff on initial fetch (transient 5xx recovery).
// - S3: didPrefixRef cleanup tracking — only restore BASE_TITLE when this
//   effect actually applied a prefix.
// - AC-7 S4: pulse animation gated behind motion-safe: prefix.
// - AC-7 S5: focus ring + ≥44×44px touch target via h-11 min-w-11.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Cpu } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { useQueueCounts } from '@/src/lib/api/engine-events-client';

const BASE_TITLE = 'x265-butler';
const RETRY_BACKOFF_MS = 1000;

// audit S2: 1-retry with 1s backoff. Without retry, badge stays stuck at 0
// indefinitely if first fetch errors and the queue is empty (no
// queue.updated event ever fires).
async function fetchEncodingCountWithRetry(): Promise<number> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch('/api/queue/status', { cache: 'no-store' });
      if (r.ok) {
        const j = (await r.json()) as { encodingJobs?: number };
        return typeof j.encodingJobs === 'number' ? j.encodingJobs : 0;
      }
    } catch {
      // fall through to retry
    }
    if (attempt === 1) await new Promise((res) => setTimeout(res, RETRY_BACKOFF_MS));
  }
  // Both attempts failed — log + return 0 (badge stays hidden).
  console.warn('[active_jobs_badge_bootstrap_failed] /api/queue/status unreachable');
  return 0;
}

export function ActiveJobsBadge() {
  const t = useTranslations('topbar.activeJobsBadge');
  const locale = useLocale();
  const counts = useQueueCounts();
  const [bootstrap, setBootstrap] = useState(0);
  // audit S3: track whether THIS effect prefixed document.title so cleanup
  // only restores BASE_TITLE when we actually applied a prefix.
  const didPrefixRef = useRef(false);

  // Bootstrap from /api/queue/status on mount with retry (audit S2)
  useEffect(() => {
    let cancelled = false;
    fetchEncodingCountWithRetry().then((n) => {
      if (!cancelled) setBootstrap(n);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live updates via engineEvents take precedence over bootstrap once they arrive.
  // counts.activeJobs from useQueueCounts (existing 02-04 hook) is the live
  // value; if the EngineEventsProvider has no events yet, fall back to bootstrap.
  const activeJobs = counts.activeJobs > 0 ? counts.activeJobs : bootstrap;

  // Browser tab title prefix (audit S3: didPrefix tracking)
  useEffect(() => {
    if (activeJobs > 0) {
      document.title = `(${activeJobs}) ${BASE_TITLE}`;
      didPrefixRef.current = true;
    } else if (didPrefixRef.current) {
      // Only restore BASE_TITLE if we previously applied a prefix.
      document.title = BASE_TITLE;
      didPrefixRef.current = false;
    }
    return () => {
      // audit S3: cleanup ONLY restores when we applied a prefix.
      if (didPrefixRef.current) {
        document.title = BASE_TITLE;
        didPrefixRef.current = false;
      }
    };
  }, [activeJobs]);

  if (activeJobs === 0) return null;

  return (
    <Link
      href={`/${locale}/queue`}
      aria-label={t('aria', { count: activeJobs })}
      className="inline-flex h-11 min-w-11 items-center justify-center rounded-md px-3 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-safe:animate-pulse"
    >
      <Badge variant="default" className="gap-1">
        <Cpu className="h-4 w-4" aria-hidden="true" />
        <span className="font-mono tabular-nums">{activeJobs}</span>
        <span>{t('label')}</span>
      </Badge>
    </Link>
  );
}
