'use client';

import { Play, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';

// audit-added S2 (02-04): optimistic override callback — parent tracks overrides.
export interface EncodeNowActionProps {
  file: FileRow;
  onOptimisticOverride?: (fileId: number, status: FileStatus | null) => void;
}

// States from which encoding can be triggered (mirrors /api/queue POST server-side check).
export const ELIGIBLE_STATES: ReadonlySet<FileStatus> = new Set<FileStatus>([
  'pending',
  'failed',
  'interrupted',
  'done-larger',
]);

export function EncodeNowAction({ file, onOptimisticOverride }: EncodeNowActionProps) {
  const t = useTranslations('library.encodeNow');
  const [loading, setLoading] = useState(false);

  // Hidden for non-eligible statuses — don't disable, just don't render.
  if (!ELIGIBLE_STATES.has(file.status)) {
    return null;
  }

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation(); // don't open FileDetailPanel
    setLoading(true);
    // Optimistic override: chip swaps to 'queued' immediately.
    onOptimisticOverride?.(file.id, 'queued');
    try {
      const res = await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: file.id }),
      });
      if (res.status === 201) {
        toast.success(t('toastQueued'));
        // Keep optimistic override until queue.updated SSE confirms.
      } else if (res.status === 409) {
        const body = (await res.json()) as { error: string };
        if (body.error === 'already_queued') {
          toast.info(t('toastAlreadyQueued'));
        } else {
          toast.error(t('toastStatusChanged'));
        }
        onOptimisticOverride?.(file.id, null); // revert
      } else {
        toast.error(t('toastError'));
        onOptimisticOverride?.(file.id, null); // revert
      }
    } catch {
      toast.error(t('toastError'));
      onOptimisticOverride?.(file.id, null); // revert
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      type="button"
      variant="default"
      disabled={loading}
      onClick={handleClick}
      className="h-11 min-h-11 px-4 text-sm gap-2 shrink-0"
    >
      {loading ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Play className="size-3.5" aria-hidden="true" />
      )}
      <span>{t('button')}</span>
    </Button>
  );
}
