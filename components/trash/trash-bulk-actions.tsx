// 13-02 T5 — Trash bulk-action cluster (consumes ConfirmButton-Lib from 13-01a).
// 2 inline buttons (per T0 design-decision S3): bulk-restore P1 + bulk-delete P3.
// Restore = P1 (additive, low-risk). Delete = P3 one-way-door (3s cooldown / 8s auto-disarm).
//
// Result-toast formatter (audit AC-10): 3 paths — all-OK / mixed (formatter ≤3 detail-lines) / all-failed.
// Audit SR5: clear selection ONLY on partial-or-full success.

'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Undo2, Trash2 } from 'lucide-react';
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
  // 13-02 T7-FIX2: render as JSX (one <span> per line) — sonner collapses '\n' in
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

function toastResult(res: BulkResult, action: 'restore' | 'delete', t: Translator): void {
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

export function TrashBulkActions({
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
      <ConfirmButton
        variant="P1"
        size="md"
        label={t('trash.bulk.restore.label', { count: ids.length })}
        onConfirm={async () => {
          try {
            const res = await postBulk('/api/trash/bulk-restore', ids);
            toastResult(res, 'restore', t);
            if (res.successCount > 0) {
              onAfter();
              router.refresh();
            }
          } catch {
            toast.error(t('trash.bulk.restore.network_error'));
          }
        }}
        disabled={disabled}
      >
        <Undo2 className="size-4" aria-hidden="true" />
      </ConfirmButton>
      <ConfirmButton
        variant="P3"
        size="md"
        label={t('trash.bulk.delete.label', { count: ids.length })}
        onConfirm={async () => {
          try {
            const res = await postBulk('/api/trash/bulk-delete', ids);
            toastResult(res, 'delete', t);
            if (res.successCount > 0) {
              onAfter();
              router.refresh();
            }
          } catch {
            toast.error(t('trash.bulk.delete.network_error'));
          }
        }}
        disabled={disabled}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </ConfirmButton>
    </>
  );
}
