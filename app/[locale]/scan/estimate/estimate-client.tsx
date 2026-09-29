'use client';

// Phase 13 Plan 13-04 Task 4b — Estimate-Mode result page.
//
// Form (4 inputs) → POST /api/scan/estimate → result-grid (3 cards) per
// T0 design (S1 single-column / S2 in-card source-pill / S3 icon-only
// empty / S4 amber pill in-card / S5 savings-first stack). Client-only;
// auth + scan_root pre-fill happen in page.tsx.

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Ban,
  Calculator,
  CheckCircle2,
  FileSearch,
  FolderSearch,
  Tag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardAction } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PageContainer, PageHeader } from '@/components/page-layout';
import { useTranslations, useLocale } from 'next-intl';
import { formatBytes, type FormatLocale } from '@/src/lib/format';

type SkipBuckets = {
  sidecar: number;
  blocklist: number;
  eligible: number;
  scanned: number;
};

type EstimateResponse = {
  filesScanned: number;
  filesEligible: number;
  skipBuckets: SkipBuckets;
  savings: {
    ratio: number;
    projectedBytes: number;
    totalBytes: number;
    source: 'bench-augmented' | 'naive';
    runId: number | null;
    encoder: string;
  };
  encodeTime: {
    seconds: number;
    source: 'bench-augmented' | 'naive';
    runId: number | null;
    encoder: string;
    scaleFactor: number;
    eligibleCount: number;
    withDurationCount: number;
  };
  effectiveFilters: {
    resolvedRootPath: string;
    extensions: string[];
    minSizeMb: number;
    maxDepth: number;
    encoder: string;
  };
  durationMs: number;
  truncated: boolean;
  requestId: string;
};

type EstimateError = {
  error: string;
  details?: unknown;
  requestId?: string;
};

type Props = {
  initialPath: string;
  scanRoot: string;
  scanRootExists: boolean;
  defaultExtensions: string;
  defaultMinSizeMb: number;
  defaultMaxDepth: number;
};

const ESTIMATE_MAX_FILES_DISPLAY = 100_000;

// Inline humanize helper — single consumer, premature to extract.
// Format: `12h 34m` for ≥1h, `34m 12s` for <1h, `42s` for <1m, `0s` for 0.
function humanizeDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function pctOf(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

export function EstimateClient({
  initialPath,
  scanRootExists,
  defaultExtensions,
  defaultMinSizeMb,
  defaultMaxDepth,
}: Props) {
  const t = useTranslations('scan.estimate');
  const tNav = useTranslations('nav');
  const locale = useLocale() as FormatLocale;
  const [, startTransition] = useTransition();

  const [path, setPath] = useState(initialPath);
  const [extensions, setExtensions] = useState(defaultExtensions);
  const [minSizeMb, setMinSizeMb] = useState(String(defaultMinSizeMb));
  const [maxDepth, setMaxDepth] = useState(String(defaultMaxDepth));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EstimateResponse | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setPathError(null);
    try {
      const body = {
        rootPath: path,
        extensions: extensions
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        minSizeMb: Number.parseInt(minSizeMb, 10) || 0,
      };
      const res = await fetch('/api/scan/estimate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json()) as EstimateResponse;
        startTransition(() => setResult(data));
        return;
      }
      const err = (await res.json().catch(() => ({}))) as EstimateError;
      switch (res.status) {
        case 409:
          toast.error(t('errors.scanInProgress'));
          break;
        case 404:
          setPathError(t('errors.rootNotFound'));
          break;
        case 422:
          setPathError(t('errors.rootNotDirectory'));
          break;
        case 415:
          toast.error(t('errors.unsupportedMediaType'));
          break;
        case 400:
          if (err.error === 'root_outside_scope') {
            setPathError(t('errors.rootOutsideScope'));
          } else {
            toast.error(t('errors.invalidBody'));
          }
          break;
        default:
          toast.error(t('errors.internal'));
      }
    } catch {
      toast.error(t('errors.internal'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <PageContainer variant="data">
      <PageHeader title={t('title')} subhead={t('subhead')} />

      {/* Form Card */}
      <Card>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-[2fr_1fr_1fr_1fr_auto]">
            <div className="flex flex-col gap-1">
              <label htmlFor="estimate-path" className="text-sm font-medium">
                {t('form.path')}
              </label>
              <Input
                id="estimate-path"
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                aria-describedby={pathError ? 'estimate-path-error' : undefined}
                aria-invalid={pathError ? true : undefined}
                disabled={loading}
              />
              {pathError && (
                <p id="estimate-path-error" role="alert" className="text-xs text-destructive">
                  {pathError}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="estimate-extensions" className="text-sm font-medium">
                {t('form.extensions')}
              </label>
              <Input
                id="estimate-extensions"
                type="text"
                value={extensions}
                onChange={(e) => setExtensions(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="estimate-minsize" className="text-sm font-medium">
                {t('form.minSize')}
              </label>
              <Input
                id="estimate-minsize"
                type="number"
                inputMode="numeric"
                min={0}
                value={minSizeMb}
                onChange={(e) => setMinSizeMb(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="estimate-maxdepth" className="text-sm font-medium">
                {t('form.maxDepth')}
              </label>
              <Input
                id="estimate-maxdepth"
                type="number"
                inputMode="numeric"
                min={1}
                value={maxDepth}
                onChange={(e) => setMaxDepth(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="flex items-end">
              <Button
                type="submit"
                size="lg"
                className="min-h-[44px] w-full md:w-auto"
                disabled={loading || !scanRootExists}
              >
                <Calculator aria-hidden="true" />
                {loading ? t('form.submitting') : t('form.submit')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* aria-live announces state to screen readers without stealing focus. */}
      <div role="status" aria-live="polite" aria-busy={loading} className="sr-only">
        {loading ? t('form.submitting') : ''}
      </div>

      {/* Truncated banner — distinct from naive-fallback in-card pill (S4). */}
      {result?.truncated && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <span>{t('errors.truncated', { cap: ESTIMATE_MAX_FILES_DISPLAY.toLocaleString() })}</span>
        </div>
      )}

      {/* Loading skeleton — 3 cards mirror final layout for spatial continuity. */}
      {loading && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-32 motion-safe:animate-pulse" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-9 w-40 motion-safe:animate-pulse" />
                <Skeleton className="h-4 w-24 motion-safe:animate-pulse" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Empty-state — distinct from result-grid; renders only when complete + 0 files. */}
      {!loading && result && result.filesScanned === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <FolderSearch className="size-12 text-muted-foreground" aria-hidden="true" />
            <p className="text-lg font-medium">{t('empty.title')}</p>
            <p className="text-sm text-muted-foreground">{t('empty.body')}</p>
          </CardContent>
        </Card>
      )}

      {/* Result-Grid — only renders when complete + has scanned files. */}
      {!loading && result && result.filesScanned > 0 && (
        <div aria-label={tNav('scanEstimate')} className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {/* Card 1 — Savings */}
          <Card>
            <CardHeader>
              <CardTitle>{t('result.savings.title')}</CardTitle>
              <CardAction>
                <SourcePill source={result.savings.source} runId={result.savings.runId} />
              </CardAction>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tabular-nums">
                {formatBytes(result.savings.projectedBytes, locale)}
              </p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {t('result.savings.of', {
                  percent: pctOf(result.savings.projectedBytes, result.savings.totalBytes),
                  total: formatBytes(result.savings.totalBytes, locale),
                })}
              </p>
            </CardContent>
          </Card>

          {/* Card 2 — Encode Time */}
          <Card>
            <CardHeader>
              <CardTitle>{t('result.encodeTime.title')}</CardTitle>
              <CardAction>
                <SourcePill source={result.encodeTime.source} runId={result.encodeTime.runId} />
              </CardAction>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tabular-nums">
                {result.encodeTime.seconds > 0
                  ? humanizeDuration(result.encodeTime.seconds)
                  : t('result.encodeTime.unknown')}
              </p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {t('result.encodeTime.files', { count: result.filesEligible })}
              </p>
            </CardContent>
          </Card>

          {/* Card 3 — Skip Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle>{t('result.skipBuckets.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2 text-sm">
                <BucketRow
                  icon={<Tag className="size-4" aria-hidden="true" />}
                  label={t('result.skipBuckets.sidecar')}
                  count={result.skipBuckets.sidecar}
                />
                <BucketRow
                  icon={<Ban className="size-4" aria-hidden="true" />}
                  label={t('result.skipBuckets.blocklist')}
                  count={result.skipBuckets.blocklist}
                />
                <BucketRow
                  icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
                  label={t('result.skipBuckets.eligible')}
                  count={result.skipBuckets.eligible}
                />
                <BucketRow
                  icon={<FileSearch className="size-4" aria-hidden="true" />}
                  label={t('result.skipBuckets.scanned')}
                  count={result.skipBuckets.scanned}
                />
              </ul>
            </CardContent>
          </Card>

          {/* Footer note — single source-of-truth for "read-only" reassurance. */}
          <p className="md:col-span-2 lg:col-span-3 text-xs text-muted-foreground">
            {t('result.computedIn', { seconds: (result.durationMs / 1000).toFixed(2) })}
          </p>
        </div>
      )}
    </PageContainer>
  );
}

function SourcePill({
  source,
  runId,
}: {
  source: 'bench-augmented' | 'naive';
  runId: number | null;
}) {
  const t = useTranslations('scan.estimate.result.savings.source');
  if (source === 'bench-augmented' && runId !== null) {
    return <Badge variant="secondary">{t('benchAugmented', { runId })}</Badge>;
  }
  // Naive — amber pill with icon (S4 + UX rule color-not-only).
  return (
    <Badge
      variant="outline"
      className="border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100"
    >
      <AlertTriangle className="size-3" aria-hidden="true" />
      <span>{t('naive')}</span>
    </Badge>
  );
}

function BucketRow({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2">
      <span className="flex items-center gap-2 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="tabular-nums font-medium">{count}</span>
    </li>
  );
}
