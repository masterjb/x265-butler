// 13-02 T5 — Library bulk-action cluster (consumes ConfirmButton-Lib from 13-01a).
// 2 inline P2 buttons (per T0 design-decision S3): bulk-blocklist + bulk-retry.
// Both run with 10s undo-window via P2 variant.
// 29-03 — 3rd button: bulk-delete P3 one-way-door (row-only "forget", mirrors trash
// bulk-delete wiring but NO disk unlink). 3-path toast via NEW bulk.forget.* token.
//
// Result-toast formatter (audit AC-10): 3 paths — all-OK / mixed (formatter ≤3 detail-lines + "+N weitere") / all-failed.
// Audit SR5: clear selection ONLY on partial-or-full success; preserve on all-failed and network-throw.

'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Play, ShieldOff, RotateCcw, Trash2 } from 'lucide-react';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { useRouter } from 'next/navigation';

const MAX_BULK = 500;

type BulkResult = {
  successCount: number;
  failed: Array<{ id: number; reason: string }>;
  requestId: string;
};

type Translator = (key: string, values?: Record<string, string | number>) => string;

function formatFailedDetail(
  failed: BulkResult['failed'],
  t: Translator,
  reasonNamespace: string,
): React.ReactNode {
  // 13-02 T7-FIX2: render as JSX (one <div> per line) — sonner collapses '\n' in
  // string descriptions to single line, hiding per-ID detail.
  const lines = failed.slice(0, 3).map((f) => `#${f.id}: ${t(`${reasonNamespace}.${f.reason}`)}`);
  if (failed.length > 3) {
    lines.push(t('bulk.failed.more', { count: failed.length - 3 }));
  }
  return (
    <div className="flex flex-col gap-0.5">
      {lines.map((line, i) => (
        <span key={i}>{line}</span>
      ))}
    </div>
  );
}

function toastResult(
  res: BulkResult,
  action: 'encode' | 'blocklist' | 'retry' | 'forget',
  t: Translator,
): void {
  if (res.failed.length === 0) {
    toast.success(t(`bulk.${action}.success`, { count: res.successCount }));
    return;
  }
  if (res.successCount === 0) {
    toast.error(t(`bulk.${action}.all_failed`, { count: res.failed.length }), {
      description: formatFailedDetail(res.failed, t, 'bulk.failed'),
    });
    return;
  }
  toast(t(`bulk.${action}.partial`, { ok: res.successCount, fail: res.failed.length }), {
    description: formatFailedDetail(res.failed, t, 'bulk.failed'),
  });
}

async function postBulk(endpoint: string, ids: number[]): Promise<BulkResult> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as BulkResult;
}

export function LibraryBulkActions({
  ids,
  onAfter,
}: {
  ids: number[];
  onAfter: () => void;
}): React.ReactElement {
  const t = useTranslations() as unknown as Translator;
  const router = useRouter();
  const disabled = ids.length === 0 || ids.length > MAX_BULK;

  return (
    <>
      {/* 32-01 — primary positive action FIRST (ui-ux primary-action ordering): P1
          immediate enqueue, plain result-toast (no undo apparatus — additive action). */}
      <ConfirmButton
        variant="P1"
        size="md"
        label={t('library.bulk.encode.label', { count: ids.length })}
        onConfirm={async () => {
          try {
            const res = await postBulk('/api/library/bulk-encode', ids);
            toastResult(res, 'encode', t);
            // SR5: clear selection only on at-least-some-success.
            if (res.successCount > 0) {
              onAfter();
              router.refresh();
            }
          } catch {
            toast.error(t('library.bulk.encode.network_error'));
            // SR5: preserve selection on network-throw.
          }
        }}
        disabled={disabled}
      >
        <Play className="size-4" aria-hidden="true" />
      </ConfirmButton>
      <ConfirmButton
        variant="P2"
        size="md"
        label={t('library.bulk.blocklist.label', { count: ids.length })}
        successToastMessage={t('library.bulk.blocklist.undo.toastBody', { count: ids.length })}
        onConfirm={async () => {
          try {
            const res = await postBulk('/api/library/bulk-blocklist', ids);
            toastResult(res, 'blocklist', t);
            // SR5: clear selection only on at-least-some-success.
            if (res.successCount > 0) {
              onAfter();
              router.refresh();
            }
          } catch {
            toast.error(t('library.bulk.blocklist.network_error'));
            // SR5: preserve selection on network-throw.
          }
        }}
        undoDelayMs={10000}
        disabled={disabled}
      >
        <ShieldOff className="size-4" aria-hidden="true" />
      </ConfirmButton>
      <ConfirmButton
        variant="P2"
        size="md"
        label={t('library.bulk.retry.label', { count: ids.length })}
        successToastMessage={t('library.bulk.retry.undo.toastBody', { count: ids.length })}
        onConfirm={async () => {
          try {
            const res = await postBulk('/api/library/bulk-retry', ids);
            toastResult(res, 'retry', t);
            if (res.successCount > 0) {
              onAfter();
              router.refresh();
            }
          } catch {
            toast.error(t('library.bulk.retry.network_error'));
          }
        }}
        undoDelayMs={10000}
        disabled={disabled}
      >
        <RotateCcw className="size-4" aria-hidden="true" />
      </ConfirmButton>
      <ConfirmButton
        variant="P3"
        size="md"
        label={t('library.bulk.delete.label', { count: ids.length })}
        onConfirm={async () => {
          try {
            const res = await postBulk('/api/library/bulk-delete', ids);
            toastResult(res, 'forget', t);
            if (res.successCount > 0) {
              onAfter();
              router.refresh();
            }
          } catch {
            toast.error(t('library.bulk.delete.network_error'));
          }
        }}
        disabled={disabled}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </ConfirmButton>
    </>
  );
}
