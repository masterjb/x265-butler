'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { Calculator, Folder, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { LibraryTable } from '@/components/library/library-table';
import { LibraryCardList } from '@/components/library/library-card-list';
import { LibraryBulkActions } from '@/components/library/library-bulk-actions';
import { SelectionBar } from '@/components/ui/selection-bar';
import { useMultiSelect } from '@/src/lib/ui/use-multi-select';
import { Pagination } from '@/components/library/pagination';
import { SearchInput } from '@/components/library/search-input';
import { FilterBar } from '@/components/library/filter-bar';
import { ShareFilterPill, type ShareActiveValue } from '@/components/library/share-filter-pill';
import { PathPrefixFilterPill } from '@/components/library/path-prefix-filter-pill';
import { Checkbox } from '@/components/ui/checkbox';
import { FileDetailPanel } from '@/components/library/file-detail-panel';
import { ExportCsvAction } from '@/components/library/export-csv-action';
import { PageContainer, PageHeader } from '@/components/page-layout';
import { cn } from '@/lib/utils';
import type { FileRow, ShareRow } from '@/src/lib/db/schema';
import type { CountByStatus, SortKey, SortDir } from '@/src/lib/db/repos/file';
import type { LibraryQuery } from '@/src/lib/api/library-query';

type Props = {
  rows: FileRow[];
  pagination: {
    page: number;
    size: number;
    total: number;
    pageCount: number;
  };
  counts: CountByStatus;
  query: LibraryQuery;
  scanRootExists: boolean;
  // 13-04: scan_root path piped through for the [Estimate folder] header
  // button — navigates to /scan/estimate?path=<scanRoot>. Defaults to '/media'
  // at the page-layer when settings.scan_root is unset.
  scanRoot: string;
  // 10-02 E-D1: global output_container for ContainerOverrideField hint.
  globalContainer?: string;
  // 14-03: share-axis filter inputs. `shares` is empty when shareRepo
  // has no rows (degenerate state, pill hidden); `orphanCount` feeds the
  // "Orphaned (n)" bucket in the dropdown.
  shares: ShareRow[];
  orphanCount: number;
};

const SEARCH_DEBOUNCE_MS = 250;

// audit-added M3: page reset on filter change
// 07-01: `file` added to update-key union + isFilterChange keys so clearing
// the deep-link filter via the banner also resets pagination to page=1.
function buildUrl(
  base: URLSearchParams,
  updates: Partial<
    Record<
      | 'q'
      | 'status'
      | 'sort'
      | 'dir'
      | 'page'
      | 'size'
      | 'includeVanished'
      | 'file'
      | 'share'
      | 'pathPrefix',
      string | null
    >
  >,
): string {
  const params = new URLSearchParams(base);
  const isFilterChange = Object.keys(updates).some(
    (k) =>
      k === 'q' ||
      k === 'status' ||
      k === 'sort' ||
      k === 'dir' ||
      k === 'size' ||
      k === 'includeVanished' ||
      k === 'file' ||
      // 14-03 audit SR4: share-pill switch drops `page` so the operator does
      // not land on a stale page=N after scope changes; q/status/sort/dir are
      // preserved because they live on different param keys.
      k === 'share' ||
      // 15-02 T5: pathPrefix dismiss resets pagination so the operator
      // doesn't land on a stale page=N after the scope widens.
      k === 'pathPrefix',
  );
  for (const [k, v] of Object.entries(updates)) {
    if (v == null || v === '') params.delete(k);
    else params.set(k, v);
  }
  if (isFilterChange) {
    params.delete('page');
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '?';
}

export function LibraryClient({
  rows,
  pagination,
  counts,
  query,
  scanRootExists,
  scanRoot,
  globalContainer = 'mkv',
  shares,
  orphanCount,
}: Props) {
  const t = useTranslations('library');
  const tNav = useTranslations('nav');
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [searchInput, setSearchInput] = useState(query.q ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // audit-added M1: debounce cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    setSearchInput(query.q ?? '');
  }, [query.q]);

  function pushUrl(updates: Parameters<typeof buildUrl>[1]) {
    const base = new URLSearchParams(searchParams.toString());
    const url = buildUrl(base, updates);
    startTransition(() => {
      router.push(url, { scroll: false });
    });
  }

  function onSearchChange(next: string) {
    setSearchInput(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushUrl({ q: next.length > 0 ? next : null });
    }, SEARCH_DEBOUNCE_MS);
  }

  function onSearchClear() {
    setSearchInput('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    pushUrl({ q: null });
  }

  function onFilterChange(next: string) {
    pushUrl({ status: next === 'all' ? null : next });
  }

  // 05-bonus: toggle visibility of rows with status='vanished'.
  function onIncludeVanishedToggle(checked: boolean) {
    pushUrl({ includeVanished: checked ? '1' : null });
  }

  function onSort(col: SortKey) {
    let nextDir: SortDir = 'desc';
    if (query.sort === col) {
      nextDir = query.dir === 'desc' ? 'asc' : 'desc';
    }
    pushUrl({ sort: col, dir: nextDir });
  }

  function onPageChange(next: number) {
    if (next < 1) return;
    pushUrl({ page: String(next) });
  }

  function onSizeChange(next: number) {
    pushUrl({ size: String(next), page: '1' });
  }

  function onClearFilters() {
    setSearchInput('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    startTransition(() => {
      router.push('?', { scroll: false });
    });
  }

  // File detail panel state.
  const [selectedFile, setSelectedFile] = useState<FileRow | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef<Map<number, HTMLElement>>(new Map());
  // Tracks which query.file value triggered auto-open — prevents re-open on close.
  const autoOpenedFileRef = useRef<number | null>(null);

  useEffect(() => {
    if (query.file == null) return;
    if (autoOpenedFileRef.current === query.file) return;
    const match = rows.find((r) => r.id === query.file);
    if (!match) return;
    autoOpenedFileRef.current = query.file;
    triggerRef.current = rowRefs.current.get(match.id) ?? null;
    setSelectedFile(match);
    setPanelOpen(true);
  }, [query.file, rows]);

  function onRowClick(row: FileRow, target: HTMLElement) {
    triggerRef.current = target;
    setSelectedFile(row);
    setPanelOpen(true);
  }

  // Scan-now action.
  const [scanning, setScanning] = useState(false);
  async function onScanNow() {
    setScanning(true);
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.ok) {
        toast.success(t('rescan.toastSuccess'));
        startTransition(() => router.refresh());
      } else if (res.status === 409) {
        toast.info(t('rescan.toastInProgress'));
      } else {
        toast.error(t('rescan.toastError'));
      }
    } catch {
      toast.error(t('rescan.toastError'));
    } finally {
      setScanning(false);
    }
  }

  // 13-02 T5: bulk-select state. Reset on page/filter/search change via resetSignal.
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const resetSignal = `${query.page ?? 1}|${query.size ?? 25}|${query.q ?? ''}|${query.status ?? 'all'}|${query.sort}|${query.dir}|${query.includeVanished ? '1' : '0'}|${query.share ?? 'all'}`;
  const sel = useMultiSelect({ visibleIds, resetSignal });
  const selection = useMemo(
    () => ({
      isSelected: sel.isSelected,
      toggle: sel.toggle,
      headerState: sel.headerState,
      selectAllOnPage: () => sel.selectAllOnPage(visibleIds),
      visibleIds,
    }),
    [sel, visibleIds],
  );

  const activeStatus = (query.status ?? 'all') as 'all' | (typeof query.status & string);
  // 14-03: share-axis active value. URL omitted → 'all' default.
  const activeShare: ShareActiveValue = query.share ?? 'all';

  // 14-03 audit SR2: share-pill operator-driven aria-live announcement. Co-located
  // with the existing live-region (already declared below for filter/search) so
  // status FilterBar + share pill share ONE landmark — no double-announce.
  const [shareAnnouncement, setShareAnnouncement] = useState<string>('');

  function onShareChange(next: ShareActiveValue) {
    pushUrl({ share: next === 'all' ? null : String(next) });
  }

  // 15-02 T5: pathPrefix-pill dismiss handler — drops ONLY the pathPrefix
  // param. share/status/q/sort/dir/size are preserved so the operator stays
  // in the same broader scope.
  function onPathPrefixClear() {
    pushUrl({ pathPrefix: null });
  }
  // 07-01: `query.file != null` participates in the filtered-empty branch so a
  // ?file=999999 zero-result triggers the existing `filteredEmpty` EmptyState
  // (instead of the cold-start `empty` headline) and the operator can `clear filter`.
  const isFiltered = !!query.q || (!!query.status && query.status !== 'all') || query.file != null;
  const isEmpty = pagination.total === 0;

  // 05-04: serialized URL state for the CSV export endpoint. Only the keys
  // that map to libraryQuerySchema (q/status/sort/dir/includeVanished/share)
  // — page and size are intentionally omitted: the export streams the full
  // filtered set, not a pagination window.
  // 14-03 audit SR1/AC-12: `share` propagated so the CSV-export filename
  // carries scope-provenance (Content-Disposition: x265-butler-library-share-<id>-<slug>-…csv).
  const currentQueryString = useMemo(() => {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    params.set('sort', query.sort);
    params.set('dir', query.dir);
    if (query.includeVanished) params.set('includeVanished', '1');
    if (query.share != null) params.set('share', String(query.share));
    return params.toString();
  }, [query.q, query.status, query.sort, query.dir, query.includeVanished, query.share]);

  // audit-added S4: live-region announcement for filter / search changes.
  // 14-03 audit SR2: share-pill announcement (set by ShareFilterPill onAnnounce)
  // wins when present so the operator-driven share-change is announced before
  // the auto-derived results-count update. Single live-region (no second one
  // declared in ShareFilterPill) — prevents SR double-announce.
  const liveAnnouncement =
    shareAnnouncement ||
    (pagination.total === 0
      ? t('aria.noResults')
      : t('aria.resultsCount', { count: pagination.total }));

  return (
    <PageContainer variant="data">
      <PageHeader
        title={tNav('library')}
        subhead={t('header.subhead', { total: pagination.total })}
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="lg"
              onClick={onScanNow}
              disabled={scanning || isPending || !scanRootExists}
              className="min-h-[44px]"
            >
              <RefreshCw className={scanning ? 'animate-spin' : undefined} aria-hidden="true" />
              {scanning ? t('rescan.buttonScanning') : t('rescan.buttonIdle')}
            </Button>
            {/* 13-04: Estimate-folder shortcut to /scan/estimate?path=<scanRoot>.
                Disabled when scan_root absent — same gate as Scan button. */}
            {scanRootExists ? (
              <Link
                href={`/${locale}/scan/estimate?path=${encodeURIComponent(scanRoot)}`}
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'min-h-[44px]')}
              >
                <Calculator aria-hidden="true" />
                {t('estimate.button')}
              </Link>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled
                className="min-h-[44px]"
                aria-disabled="true"
              >
                <Calculator aria-hidden="true" />
                {t('estimate.button')}
              </Button>
            )}
            <ExportCsvAction
              currentQueryString={currentQueryString}
              disabled={pagination.total === 0}
            />
          </div>
        }
      />

      {/* Sticky sub-header: search + filter chips. Sticks to top of main scroll
          container so operators always have filter access while scrolling
          through long lists. */}
      <div
        className={cn(
          'sticky top-0 z-10 -mx-4 flex flex-col gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur',
          'lg:-mx-6 lg:px-6',
        )}
      >
        {/* 14-03: Search + ShareFilterPill row. Desktop: pill inline-right of
            SearchInput (flex-row). Mobile: pill stacks ABOVE the search box
            (flex-col-reverse via order) so the scope-anchor reads first. */}
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="md:flex-1">
            <SearchInput value={searchInput} onChange={onSearchChange} onClear={onSearchClear} />
          </div>
          <div className="flex flex-wrap items-center gap-2 md:shrink-0">
            <ShareFilterPill
              shares={shares}
              orphanCount={orphanCount}
              active={activeShare}
              onChange={onShareChange}
              onAnnounce={setShareAnnouncement}
            />
            {/* 15-02 T5: pathPrefix-pill sits to the right of share-pill so
                the two scope filters read as a group. Pill self-hides when
                pathPrefix is undefined. */}
            <PathPrefixFilterPill pathPrefix={query.pathPrefix} onClear={onPathPrefixClear} />
          </div>
        </div>
        <FilterBar active={activeStatus} counts={counts} onChange={onFilterChange} />
        {/* 05-bonus: surface vanished rows on operator opt-in. Hidden when
            no vanished rows exist (counts.vanished === 0) AND toggle is off —
            keeps the UI quiet for healthy libraries. */}
        {((counts.vanished ?? 0) > 0 || query.includeVanished) && (
          <label
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[32px]"
            aria-label={t('filter.includeVanishedAria')}
          >
            <Checkbox
              checked={!!query.includeVanished}
              onCheckedChange={(v) => onIncludeVanishedToggle(v === true)}
              aria-label={t('filter.includeVanishedAria')}
            />
            <span className="select-none">
              {t('filter.includeVanishedLabel')}
              {(counts.vanished ?? 0) > 0 ? ` (${counts.vanished})` : ''}
            </span>
          </label>
        )}
      </div>

      <div role="status" aria-live="polite" aria-atomic="false" className="sr-only">
        {liveAnnouncement}
      </div>

      {/* 07-01: deep-link file=N banner — rendered ABOVE the EmptyState
          branches so it persists when total === 0 (operator can always escape
          via the clear-filter button). Plain div with aria-label only — the
          sr-only live-region above already announces filter changes via the
          single status landmark; duplicating that landmark would cause double
          screen-reader announcements (audit S5). The clear button uses
          pushUrl({ file: null }) to drop ONLY the file param while preserving
          q/status/sort/dir/includeVanished. */}
      {query.file != null ? (
        <div
          aria-label={t('filteredByFile.banner', { id: query.file })}
          className="rounded-md border bg-muted/50 px-3 py-2 text-sm flex items-center gap-2"
        >
          <span>{t('filteredByFile.banner', { id: query.file })}</span>
          <button
            type="button"
            onClick={() => pushUrl({ file: null })}
            className="underline underline-offset-2 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring rounded-sm min-h-[44px] px-1"
          >
            {t('filteredByFile.clearLink')}
          </button>
        </div>
      ) : null}

      {isEmpty && !isFiltered ? (
        <EmptyState
          icon={Folder}
          size="lg"
          title={t('empty.headline')}
          body={scanRootExists ? t('empty.helper') : t('empty.helperMissingRoot')}
          action={
            scanRootExists ? (
              <Button onClick={onScanNow} size="lg" disabled={scanning}>
                <RefreshCw className={scanning ? 'animate-spin' : undefined} aria-hidden="true" />
                {scanning ? t('rescan.buttonScanning') : t('empty.scanCta')}
              </Button>
            ) : (
              <Link
                href={`/${locale}/settings`}
                className={cn(buttonVariants({ variant: 'default', size: 'lg' }))}
              >
                {t('empty.configurePathCta')}
              </Link>
            )
          }
        />
      ) : isEmpty && isFiltered ? (
        <EmptyState
          icon={Search}
          size="lg"
          title={t('filteredEmpty.headline')}
          body={t('filteredEmpty.helper')}
          action={
            <Button variant="outline" size="lg" onClick={onClearFilters}>
              {t('filteredEmpty.clearCta')}
            </Button>
          }
        />
      ) : (
        <>
          {sel.selectedCount > 0 && (
            <SelectionBar
              count={sel.selectedCount}
              onClear={sel.clear}
              countLabel={t('selection.bar.label_count', { count: sel.selectedCount })}
              clearLabel={t('selection.bar.clear')}
              maxWarningLabel={
                sel.selectedCount > 500
                  ? t('selection.bar.max_warning_over', {
                      count: sel.selectedCount,
                      overflow: sel.selectedCount - 500,
                    })
                  : undefined
              }
            >
              <LibraryBulkActions ids={[...sel.selectedIds]} onAfter={sel.clear} />
            </SelectionBar>
          )}
          {/* Hide on <md (cards instead) */}
          <div className="hidden md:block">
            <LibraryTable
              rows={rows}
              sort={query.sort}
              dir={query.dir}
              onSort={onSort}
              onRowClick={onRowClick}
              rowRefs={rowRefs}
              selection={selection}
            />
          </div>
          <div className="md:hidden">
            <LibraryCardList
              rows={rows}
              onRowClick={onRowClick}
              rowRefs={rowRefs}
              selection={selection}
            />
          </div>
          <Pagination
            page={pagination.page}
            size={pagination.size}
            total={pagination.total}
            pageCount={pagination.pageCount}
            onPageChange={onPageChange}
            onSizeChange={onSizeChange}
          />
        </>
      )}

      <FileDetailPanel
        file={selectedFile}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        triggerRef={triggerRef}
        globalContainer={globalContainer}
      />
    </PageContainer>
  );
}
