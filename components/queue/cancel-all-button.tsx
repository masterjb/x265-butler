'use client';

// 05-09 → 13-01b T3: CancelAllButton migrated to inline ConfirmButton P2
// (10s undo-toast). AlertDialog Modal removed; counter is sourced from
// SSE-fresh useQueueCounts() (≤2s stale per audit M5 accepted trade-off).
// Red-emphasis border preserved on idle.

import { ListX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { useCancelAllConfirm } from './use-cancel-all-confirm';
import { useQueueCounts } from '@/src/lib/api/engine-events-client';

export function CancelAllButton() {
  const t = useTranslations('queue.cancel_all');
  const counts = useQueueCounts();
  const ssecounter = (counts.activeJobs ?? 0) + (counts.pendingJobs ?? 0);

  const { fire } = useCancelAllConfirm({
    successToast: ({ skipped, cancelled }) => t('toast.success', { skipped, cancelled }),
    errorToast: t('toast.error'),
  });

  const disabled = ssecounter === 0;

  if (disabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-block">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled
                  aria-label={t('button')}
                  className="min-h-[44px] shrink-0 md:min-h-0"
                >
                  <ListX className="size-4" aria-hidden="true" />
                  <span className="ml-1.5">{t('button')}</span>
                </Button>
              </span>
            }
          />
          <TooltipContent>{t('empty.tooltip')}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <ConfirmButton
      variant="P2"
      onConfirm={fire}
      label={t('button')}
      successToastMessage={t('undo.toastBody', { count: ssecounter })}
      className="shrink-0 border-red-500/40 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-950/30"
    >
      <ListX className="size-4" aria-hidden="true" />
    </ConfirmButton>
  );
}
