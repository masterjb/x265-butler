'use client';

// 05-09 → 13-01b T3: SkipRowAction migrated to ConfirmButton P2 (10s undo-toast).
// The 2-step confirm state-machine lives inside ConfirmButton P2 now; this
// component just wires the fire-callback (useSkipConfirm.fire) + undo-toast
// body text.

import { SkipForward } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { useSkipConfirm } from './use-skip-confirm';
import type { JobRow } from '@/src/lib/db/schema';

const SKIP_ELIGIBLE_JOB_STATUSES: ReadonlySet<JobRow['status']> = new Set<JobRow['status']>([
  'queued',
  'encoding',
]);

export function SkipRowAction({ job }: { job: JobRow }) {
  const t = useTranslations('queue.skip');
  const { fire } = useSkipConfirm({
    endpoint: `/api/queue/${job.id}/skip`,
    successToast: t('toast.success'),
    errorToast: t('toast.error'),
  });

  if (!SKIP_ELIGIBLE_JOB_STATUSES.has(job.status)) return null;

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
