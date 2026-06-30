import crypto from 'node:crypto';
import { setRequestLocale } from 'next-intl/server';

import { ensureServerInit } from '@/src/lib/server-init';
import { logger } from '@/src/lib/logger';
import { fileRepo, shareRepo } from '@/src/lib/db';
import type { ShareRow } from '@/src/lib/db/schema';
import { StorageClient } from './storage-client';

// 15-02 T1: Storage-Analyzer route. RSC mirrors the stats-page pattern
// (locale + ensureServerInit + force-dynamic). The 5 storage data endpoints
// are fetched client-side via SWR; we only hydrate the toolbar's share-list
// here so the share-pill renders with the canonical ShareRow shape on first
// paint (avoids an extra `/api/shares` round-trip).

export const dynamic = 'force-dynamic';

export default async function StoragePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/storage:server' });

  let initialShares: ShareRow[] = [];
  let initialOrphanCount = 0;
  try {
    initialShares = shareRepo().listAll();
    initialOrphanCount = fileRepo().countOrphaned();
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'storage_page_share_prefetch_error',
    );
  }

  log.info(
    { shareCount: initialShares.length, orphanCount: initialOrphanCount },
    'storage_page_rendered',
  );

  return <StorageClient initialShares={initialShares} initialOrphanCount={initialOrphanCount} />;
}
