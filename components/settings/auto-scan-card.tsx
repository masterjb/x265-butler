'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import useSWR from 'swr';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Eye,
  PauseCircle,
  RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  AutoScanAdvanced,
  type AutoScanAdvancedInitial,
} from '@/components/settings/auto-scan-advanced';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

const HEALTH_URL = '/api/health';
const SYSCTL_SNIPPET = 'echo 524288 > /proc/sys/fs/inotify/max_user_watches';
const RECOMMENDED_MAX_USER_WATCHES = 524_288;

type WatcherStatusEnum = 'running' | 'error' | 'stopped';
type PollingMode = 'inotify' | 'polling-auto' | 'polling-forced';

interface AutoScanHealth {
  status: WatcherStatusEnum;
  lastEventAt: string | null;
  lastReconcileAt: string | null;
  bootReconcileCount: number;
  orphanReEnqueueCountAtBoot: number;
  droppedEventsLast24h: number;
  inotifyError: { code: string; message: string } | null;
  currentInotifyWatches: number | null;
  maxUserWatches: number | null;
  pollingModeByShare: Record<string, PollingMode>;
}

interface HealthResponse {
  version: string;
  autoScan?: AutoScanHealth;
}

const fetcher = async (url: string): Promise<HealthResponse> => {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return r.json();
};

function relativeTime(iso: string | null, neverLabel: string): string {
  if (!iso) return neverLabel;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return neverLabel;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} d`;
}

function StatusBadge({
  status,
  t,
}: {
  status: WatcherStatusEnum;
  t: ReturnType<typeof useTranslations>;
}) {
  // audit-added M7: triple-redundant encoding — color + lucide-icon + text-label.
  // Shape-distinct icons (check / exclamation / pause-bars) survive deuteranopia,
  // protanopia, and achromatopsia per Phase 7-04 release-gate.
  const map: Record<WatcherStatusEnum, { Icon: typeof CheckCircle2; tone: string; label: string }> =
    {
      running: {
        Icon: CheckCircle2,
        tone: 'bg-primary/10 text-primary ring-primary/30',
        label: t('statusRunning'),
      },
      error: {
        Icon: AlertCircle,
        tone: 'bg-destructive/10 text-destructive ring-destructive/30',
        label: t('statusError'),
      },
      stopped: {
        Icon: PauseCircle,
        tone: 'bg-muted text-muted-foreground ring-muted-foreground/20',
        label: t('statusStopped'),
      },
    };
  const { Icon, tone, label } = map[status];
  return (
    <span
      role="status"
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1',
        tone,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      <span>{label}</span>
    </span>
  );
}

function PollingModeCell({
  mode,
  t,
}: {
  mode: PollingMode;
  t: ReturnType<typeof useTranslations>;
}) {
  const map: Record<PollingMode, { Icon: typeof Activity; label: string }> = {
    inotify: { Icon: Activity, label: t('pollingModeInotify') },
    'polling-auto': { Icon: Eye, label: t('pollingModeAuto') },
    'polling-forced': { Icon: RefreshCw, label: t('pollingModeForced') },
  };
  const { Icon, label } = map[mode];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm" data-polling-mode={mode}>
      <Icon className="size-3.5 text-muted-foreground" aria-hidden />
      <span>{label}</span>
    </span>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => toast.success(label))
          .catch(() => toast.error('Copy failed'));
      }}
    >
      <Copy className="mr-1 size-3.5" aria-hidden />
      {label}
    </Button>
  );
}

function BudgetBar({
  current,
  max,
  t,
}: {
  current: number | null;
  max: number | null;
  t: ReturnType<typeof useTranslations>;
}) {
  if (current === null || max === null || max === 0) {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-muted-foreground text-xs">{t('inotifyBudgetLabel')}</div>
        <div className="h-2 w-full rounded-full bg-muted" data-budget-state="unknown" />
        <div className="text-muted-foreground text-xs">{t('inotifyBudgetUnknown')}</div>
      </div>
    );
  }
  const ratio = Math.min(1, current / max);
  const pct = Math.round(ratio * 100);
  // audit M7: threshold-icon supplements color (do not rely on bar fill alone).
  const fillClass =
    ratio > 0.95 ? 'bg-destructive' : ratio > 0.8 ? 'bg-amber-500 dark:bg-amber-400' : 'bg-primary';
  const state = ratio > 0.95 ? 'critical' : ratio > 0.8 ? 'pressure' : 'healthy';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{t('inotifyBudgetLabel')}</span>
        <span className="tabular-nums text-foreground">
          {current.toLocaleString()} / {max.toLocaleString()} ({pct}%)
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full transition-[width] duration-300', fillClass)}
          style={{ width: `${pct}%` }}
          data-budget-state={state}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          role="progressbar"
        />
      </div>
      {state !== 'healthy' && (
        <div className="text-xs">
          <span className="text-amber-700 dark:text-amber-300 inline-flex items-center gap-1">
            <AlertTriangle className="size-3.5" aria-hidden />
            {t('inotifyBudgetWarn')}
          </span>
        </div>
      )}
    </div>
  );
}

function BudgetBanner({
  variant,
  t,
}: {
  variant: 'low' | 'pressure';
  t: ReturnType<typeof useTranslations>;
}) {
  const tone =
    variant === 'low'
      ? 'border-destructive/30 bg-destructive/5 text-destructive'
      : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100';
  const copyKey = variant === 'low' ? 'inotifyBudgetBannerLow' : 'inotifyBudgetBannerPressure';
  return (
    <div
      role="alert"
      data-banner={variant}
      className={cn('flex flex-col gap-2 rounded-md border-l-4 p-3 text-sm', tone)}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{t(copyKey)}</span>
      </div>
      <pre className="overflow-x-auto rounded bg-background/60 p-2 font-mono text-xs">
        {SYSCTL_SNIPPET}
      </pre>
      <CopyButton value={SYSCTL_SNIPPET} label={t('enospcSnippetCopy')} />
    </div>
  );
}

function EnospcBanner({
  inotifyError,
  t,
}: {
  inotifyError: { code: string; message: string };
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div
      role="alert"
      data-banner="enospc"
      className="flex flex-col gap-2 rounded-md border-l-4 border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="flex flex-col">
          <span className="font-medium">{t('enospcWarningTitle')}</span>
          <span className="text-destructive/80">{t('enospcWarningBody')}</span>
          <span className="text-destructive/60 mt-0.5 text-xs">code: {inotifyError.code}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-foreground/80 text-xs font-medium">{t('enospcSnippetTitle')}</span>
        <pre className="overflow-x-auto rounded bg-background/60 p-2 font-mono text-xs text-foreground">
          {SYSCTL_SNIPPET}
        </pre>
        <CopyButton value={SYSCTL_SNIPPET} label={t('enospcSnippetCopy')} />
      </div>
      <p className="text-muted-foreground text-xs italic">{t('enospcAutoRetryHint')}</p>
    </div>
  );
}

export function AutoScanCard({
  advancedInitial,
}: {
  advancedInitial?: AutoScanAdvancedInitial;
} = {}) {
  const t = useTranslations('settings.autoScan');
  const { data, error, isLoading } = useSWR<HealthResponse>(HEALTH_URL, fetcher, {
    refreshInterval: 5_000,
    revalidateOnFocus: true,
  });

  if (error || (!isLoading && !data?.autoScan)) {
    return (
      <Card>
        <CardContent>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </CardContent>
      </Card>
    );
  }

  const a = data?.autoScan;
  const shares = a ? Object.entries(a.pollingModeByShare) : [];
  const ratio =
    a && a.currentInotifyWatches !== null && a.maxUserWatches && a.maxUserWatches > 0
      ? a.currentInotifyWatches / a.maxUserWatches
      : null;
  const lowBudget =
    a?.maxUserWatches !== null && (a?.maxUserWatches ?? Infinity) < RECOMMENDED_MAX_USER_WATCHES;
  const pressureBudget = ratio !== null && ratio > 0.8;
  const showBanner = lowBudget || pressureBudget;
  const bannerVariant: 'low' | 'pressure' = lowBudget ? 'low' : 'pressure';

  return (
    <Card data-slot="auto-scan-card">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('title')}</CardTitle>
          {a && <StatusBadge status={a.status} t={t} />}
        </div>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4">
        {a && (
          <>
            <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">{t('lastEventLabel')}</span>
                <span className="tabular-nums">
                  {relativeTime(a.lastEventAt, t('lastEventNever'))}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">{t('lastReconcileLabel')}</span>
                <span className="tabular-nums">
                  {relativeTime(a.lastReconcileAt, t('reconcileNever'))}
                </span>
              </div>
            </div>

            <BudgetBar current={a.currentInotifyWatches} max={a.maxUserWatches} t={t} />

            {showBanner && <BudgetBanner variant={bannerVariant} t={t} />}

            {shares.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('shareTableShare')}</TableHead>
                      <TableHead>{t('shareTableMode')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shares.map(([name, mode]) => (
                      <TableRow key={name} data-share-row={name}>
                        <TableCell className="font-medium">{name}</TableCell>
                        <TableCell>
                          <PollingModeCell mode={mode} t={t} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {advancedInitial && <AutoScanAdvanced initial={advancedInitial} />}

            {a.status === 'error' && a.inotifyError?.code === 'ENOSPC' && (
              <EnospcBanner inotifyError={a.inotifyError} t={t} />
            )}
          </>
        )}
      </CardContent>
      {a && (
        <CardFooter className="flex flex-wrap justify-between gap-2 px-4 pb-4 text-xs text-muted-foreground">
          <span>
            {t('bootReconcileCountLabel')}:{' '}
            <span className="tabular-nums">{a.bootReconcileCount}</span>
          </span>
          <span>
            {t('orphanReEnqueueCountAtBootLabel')}:{' '}
            <span className="tabular-nums">{a.orphanReEnqueueCountAtBoot}</span>
          </span>
          {a.droppedEventsLast24h > 0 && (
            <span data-dropped="visible">
              {t('droppedEventsLast24hLabel')}:{' '}
              <span className="tabular-nums">{a.droppedEventsLast24h}</span>
            </span>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
