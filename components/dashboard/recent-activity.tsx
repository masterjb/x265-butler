'use client';

// 03-04 Plan Task 2 — Recent Activity card per dashboard.md §6.
// Audit M4: 'use client' first line.
// Reuses 02-04 JobStatusChip byte-identical.
//
// 07-01 (E-RA): row swaps `#{id} · file {file_id}` for filename basename
// (primary) + ID-Badge (subtle), and the entire row becomes a clickable
// link to `/{locale}/library?file={file_id}` for one-click drill-down.
// Desktop uses PER-CELL <Link> wrapping (audit M3: <a> may NOT contain <tr>
// per HTML5 §4.9.1). Mobile <li> wraps a single outer <Link> (block-flow
// is valid inside <a>). Locale prefix is REQUIRED (i18n routing.ts has
// localePrefix: 'always'; naked /library 404s).

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SectionHint } from '@/components/stats/charts/section-hint';
import { JobStatusChip } from '@/components/queue/job-status-chip';
import { formatBytes, formatRelativeTime, type FormatLocale } from '@/src/lib/format';
import type { RecentActivityRow } from '@/src/lib/db';

interface Props {
  stats: { recentActivity?: RecentActivityRow[] } | null;
}

function truncateMiddle(s: string, max = 50): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// 07-01: POSIX-only basename (all paths in this DB are unRAID-style /mnt/user/…).
// Trailing-slash inputs ('/foo/') yield '' — caller must treat empty as missing
// via `basename(p) || t('fileMissing')` (audit S9 edge-case).
function basename(p: string): string {
  if (!p) return '';
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function RecentActivity({ stats }: Props) {
  const t = useTranslations('dashboard.recentActivity');
  const locale = useLocale() as FormatLocale;
  const rows = stats?.recentActivity ?? [];
  const now = Math.floor(Date.now() / 1000);

  const cardHeader = (
    <CardHeader>
      <div className="flex items-center gap-1.5">
        <CardTitle>{t('title')}</CardTitle>
        <SectionHint content={t('hint')} />
      </div>
    </CardHeader>
  );

  if (rows.length === 0) {
    return (
      <Card>
        {cardHeader}
        <CardContent>
          <p className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {cardHeader}
      <CardContent>
        {/* Desktop table — collapses to card list <md per dashboard.md §6 closing bullet. */}
        <div className="hidden md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-2 py-2 font-medium">{t('col.file')}</th>
                <th className="px-2 py-2 font-medium">{t('col.outcome')}</th>
                <th className="px-2 py-2 font-medium">{t('col.encoder')}</th>
                <th className="px-2 py-2 font-medium">{t('col.savings')}</th>
                <th className="px-2 py-2 font-medium">{t('col.time')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const savings =
                  r.bytes_in != null && r.bytes_out != null ? r.bytes_in - r.bytes_out : null;
                const filename = basename(r.file_path ?? '') || t('fileMissing');
                const truncated = truncateMiddle(filename, 40);
                const href = `/${locale}/library?file=${r.file_id}`;
                const ariaLabel = t('openInLibrary', { filename, id: r.id });
                // audit M3 + S11: per-cell Link wrapping (HTML5-valid; <a>
                // may NOT contain <tr>). Each cell carries the same href +
                // aria-label so click anywhere on the row navigates. Hover
                // tint + min-height live on the parent <tr>; reduced-motion
                // honored via Tailwind motion-safe: variant.
                return (
                  <tr
                    key={r.id}
                    className="border-b last:border-0 motion-safe:transition-colors motion-safe:hover:bg-muted/50 min-h-[44px]"
                  >
                    <td className="px-2 py-2">
                      <Link
                        href={href}
                        aria-label={ariaLabel}
                        className="block focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                      >
                        <span className="font-medium">{truncated}</span>{' '}
                        <Badge variant="secondary" className="font-mono text-xs">
                          {t('idBadge', { id: r.id })}
                        </Badge>
                      </Link>
                    </td>
                    <td className="px-2 py-2">
                      <Link
                        href={href}
                        aria-label={ariaLabel}
                        className="block focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                      >
                        <JobStatusChip status={r.status} label={r.status} />
                      </Link>
                    </td>
                    <td className="px-2 py-2 font-mono text-xs">
                      <Link
                        href={href}
                        aria-label={ariaLabel}
                        className="block focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                      >
                        {r.encoder ?? '—'}
                      </Link>
                    </td>
                    <td className="px-2 py-2 font-mono tabular-nums">
                      <Link
                        href={href}
                        aria-label={ariaLabel}
                        className="block focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                      >
                        {savings != null && r.status === 'done'
                          ? formatBytes(Math.max(0, savings), locale)
                          : '—'}
                      </Link>
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">
                      <Link
                        href={href}
                        aria-label={ariaLabel}
                        className="block focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                      >
                        {formatRelativeTime(r.finished_at ?? r.created_at, now, locale)}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* Mobile card list — single outer <Link> per <li> (block-flow valid
            inside <a>). 44px touch-target via card padding. */}
        <ul className="space-y-3 md:hidden">
          {rows.map((r) => {
            const savings =
              r.bytes_in != null && r.bytes_out != null ? r.bytes_in - r.bytes_out : null;
            const filename = basename(r.file_path ?? '') || t('fileMissing');
            const truncated = truncateMiddle(filename, 30);
            const href = `/${locale}/library?file=${r.file_id}`;
            const ariaLabel = t('openInLibrary', { filename, id: r.id });
            return (
              <li key={r.id}>
                <Link
                  href={href}
                  aria-label={ariaLabel}
                  className="block rounded-md border p-3 motion-safe:transition-colors motion-safe:hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring min-h-[44px]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium">
                      {truncated}{' '}
                      <Badge variant="secondary" className="font-mono text-xs">
                        {t('idBadge', { id: r.id })}
                      </Badge>
                    </span>
                    <JobStatusChip status={r.status} label={r.status} />
                  </div>
                  <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                    <span className="font-mono">{r.encoder ?? '—'}</span>
                    <span className="font-mono tabular-nums">
                      {savings != null && r.status === 'done'
                        ? formatBytes(Math.max(0, savings), locale)
                        : '—'}
                    </span>
                    <span>{formatRelativeTime(r.finished_at ?? r.created_at, now, locale)}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
