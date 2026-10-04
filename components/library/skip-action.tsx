'use client';

// 05-09 → 13-01b T3: Library SkipAction migrated to ConfirmButton P2
// (10s undo-toast). Shares useSkipConfirm hook with Queue SkipRowAction;
// the hook now exposes a single fire-callback consumed by ConfirmButton.

import { SkipForward } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { useSkipConfirm } from '@/components/queue/use-skip-confirm';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';

export const SKIP_ELIGIBLE_STATES: ReadonlySet<FileStatus> = new Set<FileStatus>([
  'queued',
  'encoding',
]);

export function SkipAction({ file }: { file: FileRow }) {
  const t = useTranslations('library.skip');
  const router = useRouter();
  const { fire } = useSkipConfirm({
    endpoint: `/api/library/${file.id}/skip`,
    successToast: t('toast.success'),
    errorToast: t('toast.error'),
    onSuccess: () => router.refresh(),
  });

  if (!SKIP_ELIGIBLE_STATES.has(file.status)) return null;

  return (
    <ConfirmButton
      variant="P2"
      onConfirm={fire}
      label={t('button')}
      successToastMessage={t('undo.toastBody')}
      className="shrink-0"
    >
      <SkipForward className="size-3.5" aria-hidden="true" />
    </ConfirmButton>
  );
}
