'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, Loader2 } from 'lucide-react';
import { useTranslations, useLocale } from 'next-intl';
import { toast } from 'sonner';
import { authFetch } from '@/components/auth/auth-fetcher';
import type { ContainerFallbackRecord } from '@/src/lib/encode/sidecar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { StatusChip, statusToI18nKey } from './status-chip';
import { LibraryDeleteAction } from './delete-action';
import type { FileRow, JobRow } from '@/src/lib/db/schema';
import {
  formatBytes,
  formatBitrate,
  formatDuration,
  formatResolution,
  formatTimestamp,
  type FormatLocale,
} from '@/src/lib/format';

// Lightweight breakpoint hook — SSR-safe (returns false on server, updates on mount).
function useIsDesktop(query = '(min-width: 768px)'): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    setMatch(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatch(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);
  return match;
}

// audit-added S2: clipboard fallback for insecure HTTP / when the API rejects.
async function copyToClipboard(value: string, fallbackHint: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fall through
    }
  }
  // Fallback path: select the hidden input and let the user copy via keyboard.
  toast.info(fallbackHint);
  return false;
}

function CopyableRow({
  label,
  value,
  successMsg,
  fallbackHint,
}: {
  label: string;
  value: string;
  successMsg: string;
  fallbackHint: string;
}) {
  const t = useTranslations('library');
  return (
    <div className="flex items-start gap-2">
      <span className="shrink-0 text-xs font-medium text-muted-foreground min-w-[7rem]">
        {label}
      </span>
      <div className="flex flex-1 items-start gap-1 min-w-0">
        <code className="flex-1 break-all font-mono text-xs text-foreground">{value}</code>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('detail.copyAria', { label })}
          onClick={async () => {
            const ok = await copyToClipboard(value, fallbackHint);
            if (ok) toast.success(successMsg);
          }}
        >
          <Copy />
        </Button>
        {/* Hidden input for the fallback path — selectable & focusable */}
        <input readOnly value={value} aria-hidden="true" tabIndex={-1} className="sr-only" />
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-sm text-foreground tabular-nums">{value}</span>
    </div>
  );
}

const CONFIRM_WINDOW_MS = 3_000;

function ContainerFallbackCard({ fileId }: { fileId: number }) {
  const t = useTranslations('library.detail.containerFallback');
  const [fallback, setFallback] = useState<ContainerFallbackRecord | null | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/library/${fileId}/sidecar-summary`)
      .then((r) => r.json())
      .then((data: { containerFallback: ContainerFallbackRecord | null }) => {
        if (!cancelled) setFallback(data.containerFallback);
      })
      .catch(() => {
        if (!cancelled) setFallback(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  useEffect(() => {
    if (!confirming) return;
    confirmTimerRef.current = setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setConfirming(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      document.removeEventListener('keydown', handleKey);
    };
  }, [confirming]);

  if (fallback === undefined || fallback === null) return null;

  async function handleConfirm(e: React.MouseEvent) {
    e.stopPropagation();
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);
    try {
      const res = await authFetch(`/api/library/${fileId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceContainer: 'mp4' }),
      });
      if (res.ok) {
        toast.success(t('forceRetryButton.successToast'));
        setFallback(null);
        return;
      }
      if (res.status === 409) {
        toast.error(t('forceRetryButton.errorToast.validation'));
        return;
      }
      toast.error(t('forceRetryButton.errorToast.network'));
    } catch {
      toast.error(t('forceRetryButton.errorToast.network'));
    } finally {
      setSubmitting(false);
      setConfirming(false);
      submitLockRef.current = false;
    }
  }

  return (
    <div
      role="region"
      aria-label={t('aria.card')}
      className="mt-3 rounded-md border border-amber-500/40 bg-amber-50/60 p-3 dark:bg-amber-950/20"
    >
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle
          className="size-4 text-amber-600 dark:text-amber-400 shrink-0"
          aria-hidden="true"
        />
        <span className="text-xs font-semibold text-amber-800 dark:text-amber-300">
          {t('title')}
        </span>
      </div>
      <p className="text-xs text-amber-900/80 dark:text-amber-200/80 mb-2">{t('description')}</p>
      <div className="text-xs text-muted-foreground mb-3">
        <span aria-label={t('aria.reasonLabel')} className="font-medium">
          {t('aria.reasonLabel')}:{' '}
        </span>
        {t(`reason.${fallback.reason}`)}
      </div>
      {confirming ? (
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={handleConfirm}
          disabled={submitting}
          aria-label={t('forceRetryButton.confirmLabel')}
          aria-live="polite"
          autoFocus
          className="min-h-[44px] min-w-[44px] md:min-h-0 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
        >
          {submitting ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
          )}
          <span className="ml-1">{t('forceRetryButton.confirmLabel')}</span>
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
          aria-label={t('aria.retryButton')}
          className="min-h-[44px] min-w-[44px] md:min-h-0 border-amber-500/50 text-amber-800 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/30"
        >
          {t('forceRetryButton.label')}
        </Button>
      )}
    </div>
  );
}

type ContainerOverrideValue = 'mkv' | 'mp4' | 'match-source' | null;

function ContainerOverrideField({
  fileId,
  initialOverride,
  globalContainer,
}: {
  fileId: number;
  initialOverride: ContainerOverrideValue;
  globalContainer: string;
}) {
  const t = useTranslations('library.detail.containerOverride');
  const globalLabel = globalContainer.toUpperCase();
  const [value, setValue] = useState<ContainerOverrideValue>(initialOverride);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const raw = e.target.value;
    const next: ContainerOverrideValue = raw === '' ? null : (raw as ContainerOverrideValue);
    setValue(next);
    setDirty(next !== initialOverride);
  }

  async function handleSave() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const res = await authFetch(`/api/library/${fileId}/container-override`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        toast.error(t('saveError'));
      } else {
        setDirty(false);
        toast.success(t('saved'));
      }
    } catch {
      toast.error(t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-3">
      <label className="text-xs font-medium text-muted-foreground">{t('label')}</label>
      <div className="flex items-center gap-2">
        <select
          value={value ?? ''}
          onChange={handleChange}
          disabled={saving}
          className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        >
          <option value="">{t('options.inherit', { global: globalLabel })}</option>
          <option value="mkv">{t('options.mkv')}</option>
          <option value="mp4">{t('options.mp4')}</option>
          <option value="match-source">{t('options.matchSource')}</option>
        </select>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saving}
          aria-label={t('saveAria')}
          onClick={handleSave}
        >
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('hint', { global: globalLabel })}</p>
    </div>
  );
}

function DetailBody({ file, globalContainer }: { file: FileRow; globalContainer: string }) {
  const t = useTranslations('library');
  const locale = useLocale() as FormatLocale;
  return (
    <div className="flex flex-col gap-2 px-4 pb-4">
      <CopyableRow
        label={t('detail.path')}
        value={file.path}
        successMsg={t('detail.copied.path')}
        fallbackHint={t('detail.copyFallback')}
      />
      <CopyableRow
        label={t('detail.hash')}
        value={file.content_hash}
        successMsg={t('detail.copied.hash')}
        fallbackHint={t('detail.copyFallback')}
      />
      <div className="mt-2">
        <StatRow label={t('column.codec')} value={file.codec ?? '—'} />
        <StatRow
          label={t('column.bitrate')}
          value={file.bitrate != null ? formatBitrate(file.bitrate, locale) : '—'}
        />
        <StatRow
          label={t('column.duration')}
          value={file.duration_seconds != null ? formatDuration(file.duration_seconds) : '—'}
        />
        <StatRow label={t('detail.resolution')} value={formatResolution(file.width, file.height)} />
        <StatRow label={t('detail.container')} value={file.container ?? '—'} />
        <StatRow label={t('column.size')} value={formatBytes(file.size_bytes, locale)} />
        <StatRow label={t('detail.mtime')} value={formatTimestamp(file.mtime, locale)} />
        <StatRow
          label={t('detail.lastScanned')}
          value={formatTimestamp(file.last_scanned_at, locale)}
        />
        <StatRow label={t('detail.created')} value={formatTimestamp(file.created_at, locale)} />
        <div className="flex items-center justify-between py-2">
          <span className="text-xs font-medium text-muted-foreground">{t('column.status')}</span>
          <StatusChip status={file.status} label={t(`status.${statusToI18nKey(file.status)}`)} />
        </div>
      </div>
      <EncodeInfoSection fileId={file.id} />
      <ContainerOverrideField
        fileId={file.id}
        initialOverride={file.container_override}
        globalContainer={globalContainer}
      />
      <ContainerFallbackCard fileId={file.id} />
      {/* 24-04 F6: row-only "forget" delete — prominent for vanished entries.
          LibraryDeleteAction self-hides for active (queued/encoding) statuses. */}
      <div className="mt-3 flex justify-end">
        <LibraryDeleteAction file={file} />
      </div>
    </div>
  );
}

// 12-03 inline-extend Route-1: surface encoder + crf + preset_used from the
// latest done job row for this file. Lazy-fetched per panel-open so the
// library-list payload stays small. Pre-0025 legacy rows + queued/encoding
// rows return preset_used=null → render as '—'. Section hidden entirely when
// no done job exists for this file (no encode yet).
function EncodeInfoSection({ fileId }: { fileId: number }) {
  const t = useTranslations('library');
  const locale = useLocale() as FormatLocale;
  const [lastJob, setLastJob] = useState<JobRow | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`/api/library/${fileId}`, { cache: 'no-store' });
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { lastJob: JobRow | null };
          setLastJob(body.lastJob ?? null);
        }
      } catch {
        // Network failure or invalid URL (e.g. SSR/jsdom env without origin)
        // → silently treat as "no job info". The panel still renders the
        // file-level details above; the EncodeInfo section just stays hidden.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  if (!loaded) return null;
  if (!lastJob) return null;

  const isDone = lastJob.status === 'done';
  // 12-03 inline-extend Route-1: when the latest attempt is NOT done (failed /
  // cancelled / interrupted / queued / encoding) the section header carries
  // a status suffix so operator immediately sees "Encoded with (failed)"
  // rather than thinking the displayed preset succeeded. JobStatus literal
  // is shown verbatim (operator-domain shorthand, locale-independent).
  const titleSuffix = isDone ? '' : ` (${lastJob.status})`;

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('detail.encodeInfo.title')}
        {titleSuffix}
      </h3>
      <StatRow label={t('detail.encodeInfo.encoder')} value={lastJob.encoder ?? '—'} />
      <StatRow
        label={t('detail.encodeInfo.crf')}
        value={lastJob.crf != null ? String(lastJob.crf) : '—'}
      />
      <StatRow
        label={t('detail.encodeInfo.preset')}
        value={
          lastJob.preset_used != null && lastJob.preset_used !== '' ? lastJob.preset_used : '—'
        }
      />
      {lastJob.finished_at != null && (
        <StatRow
          label={t('detail.encodeInfo.finishedAt')}
          value={formatTimestamp(lastJob.finished_at, locale)}
        />
      )}
    </div>
  );
}

export function FileDetailPanel({
  file,
  open,
  onOpenChange,
  triggerRef,
  globalContainer = 'mkv',
}: {
  file: FileRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // audit-added S11: ref to the originating row/card so focus can be restored.
  triggerRef?: React.MutableRefObject<HTMLElement | null>;
  // 10-02 E-D1: global output_container setting passed from server component
  // so ContainerOverrideField can display "(global: X)" hint.
  globalContainer?: string;
}) {
  const t = useTranslations('library');
  const isDesktop = useIsDesktop();

  // audit-added S11: when the panel transitions from open → closed, restore
  // focus to the originating row/card. base-ui doesn't expose
  // `onCloseAutoFocus`, so we observe `open` ourselves.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !open && triggerRef?.current) {
      triggerRef.current.focus();
    }
    wasOpenRef.current = open;
  }, [open, triggerRef]);

  if (!file) return null;

  if (isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t('detail.title')}</SheetTitle>
            <SheetDescription className="font-mono text-xs break-all">{file.path}</SheetDescription>
          </SheetHeader>
          <DetailBody file={file} globalContainer={globalContainer} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('detail.title')}</DrawerTitle>
          <DrawerDescription className="font-mono text-xs break-all">{file.path}</DrawerDescription>
        </DrawerHeader>
        <DetailBody file={file} globalContainer={globalContainer} />
      </DrawerContent>
    </Drawer>
  );
}
