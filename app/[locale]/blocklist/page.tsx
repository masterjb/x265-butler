import { setRequestLocale } from 'next-intl/server';
import { blocklistRepo, fileRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { PageContainer, PageHeader } from '@/components/page-layout';
import { BlocklistClient, type BlocklistRowWithFile } from './blocklist-client';
import { getTranslations } from 'next-intl/server';
import { assembleBlocklistEvaluation } from '@/src/lib/diagnostics/blocklist-evaluation';
import {
  derivePatternExtension,
  getCurrentScanExtensions,
} from '@/src/lib/blocklist/pattern-extension';

// 04-02: blocklist page Server Component. Direct repo reads (audit M5 pattern from 03-04).
// audit M3 + M7 (carry-forward from 03-05): runtime='nodejs' + try/catch DB-error fallback.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE_DEFAULT = 25;

export default async function BlocklistPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const size = Math.min(
    200,
    Math.max(1, parseInt(sp.size ?? String(PAGE_SIZE_DEFAULT), 10) || PAGE_SIZE_DEFAULT),
  );

  const t = await getTranslations({ locale, namespace: 'blocklist' });

  ensureServerInit();

  let rows: BlocklistRowWithFile[] = [];
  let total = 0;
  let dbErrored = false;
  let scanExtensions: string[] = [];
  try {
    const result = blocklistRepo().list({ page, size });
    total = result.total;

    // 22-03 T3: aggregate recent pattern-evaluations from 22-00 IMP-8 surface
    // + share scan-extensions for the ZERO-match warning hint. Wrapped in its
    // own try/catch — failures degrade gracefully (counts undefined, hint=false).
    let patternHitCount = new Map<number, number>();
    let scanExtSet = new Set<string>();
    try {
      const evalBlock = assembleBlocklistEvaluation();
      for (const ev of evalBlock.recentEvaluations) {
        const id = ev.matchedEntry?.id;
        if (typeof id === 'number') {
          patternHitCount.set(id, (patternHitCount.get(id) ?? 0) + 1);
        }
      }
      scanExtSet = getCurrentScanExtensions();
      scanExtensions = Array.from(scanExtSet).sort();
    } catch (err) {
      logger.warn(
        {
          action: 'blocklist_eval_aggregation_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'blocklist evaluation aggregation failed — counts hidden',
      );
      patternHitCount = new Map<number, number>();
      scanExtSet = new Set<string>();
      scanExtensions = [];
    }

    // Enrich file-pinned rows with file path for UI display.
    rows = result.rows.map((row) => {
      if (row.file_id !== null) {
        const file = fileRepo().getById(row.file_id);
        return { ...row, filePath: file?.path ?? null };
      }
      const recentMatchCount = patternHitCount.get(row.id) ?? 0;
      const derivedExtension = row.path_pattern ? derivePatternExtension(row.path_pattern) : null;
      const extensionWarningHint =
        recentMatchCount === 0 &&
        derivedExtension !== null &&
        scanExtSet.size > 0 &&
        !scanExtSet.has(derivedExtension);
      return {
        ...row,
        filePath: null,
        recentMatchCount,
        derivedExtension,
        extensionWarningHint,
      };
    });
  } catch (err) {
    logger.error(
      {
        action: 'blocklist_page_db_error',
        err: err instanceof Error ? err.stack : String(err),
      },
      'blocklist page DB read failed',
    );
    dbErrored = true;
  }

  logger.info({ action: 'blocklist_page_rendered', locale, total }, 'blocklist page rendered');

  // ui-ux-pro-max C4: subtitle with count gives operator at-a-glance density signal.
  const subhead = !dbErrored
    ? total === 1
      ? t('subhead.one')
      : t('subhead.many', { total })
    : undefined;

  return (
    <PageContainer variant="data">
      <PageHeader title={t('title')} subhead={subhead} />
      <BlocklistClient
        initialRows={rows}
        initialTotal={total}
        initialPage={page}
        initialSize={size}
        dbErrored={dbErrored}
        scanExtensions={scanExtensions}
      />
    </PageContainer>
  );
}
