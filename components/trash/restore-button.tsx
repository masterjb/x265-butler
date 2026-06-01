'use client';

// 02-04 → 13-01b T2: Trash Restore migrated to ConfirmButton P1 (1-click +
// plain success-toast). base-ui Popover wrapper REMOVED entirely; 4 response-
// path branching preserved verbatim inside onConfirm.

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { cn } from '@/lib/utils';
import type { TrashEntryRow } from '@/src/lib/db/schema';

type Props = {
  entry: TrashEntryRow;
  onRemoveRow: (id: number) => void;
  onSummaryRefetch: () => void;
};

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

export function RestoreButton({ entry, onRemoveRow, onSummaryRefetch }: Props) {
  const t = useTranslations('trash');
  const router = useRouter();
  const [restoring, setRestoring] = useState(false);
  const submitLockRef = useRef(false);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setRestoring(true);
    try {
      const res = await fetch(`/api/trash/${entry.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.ok) {
        const filename = basename(entry.original_path);
        toast.success(t('restore.success', { filename }));
        onRemoveRow(entry.id);
        onSummaryRefetch();
        router.refresh();
        return;
      }

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        originalPath?: string;
      };

      if (res.status === 409 && data.error === 'already_restored') {
        toast(t('restore.alreadyRestored'));
        onRemoveRow(entry.id);
        return;
      }

      if (res.status === 409 && data.error === 'original_path_exists') {
        toast.error(t('restore.collisionError'));
        return;
      }

      if (res.status === 410) {
        toast.error(t('restore.missingError'));
        return;
      }

      toast.error(t('restore.genericError'));
    } catch {
      toast.error(t('restore.genericError'));
    } finally {
      setRestoring(false);
      submitLockRef.current = false;
    }
  }, [entry.id, entry.original_path, onRemoveRow, onSummaryRefetch, router, t]);

  return (
    <div className={cn('transition-opacity duration-150', restoring && 'opacity-50')}>
      <ConfirmButton
        variant="P1"
        onConfirm={handleConfirm}
        label={t('restore.button')}
        disabled={restoring}
        className="shrink-0"
      >
        <Undo2 className="size-4" aria-hidden="true" />
      </ConfirmButton>
    </div>
  );
}
