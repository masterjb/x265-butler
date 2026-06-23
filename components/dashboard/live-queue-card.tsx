'use client';

// 03-04 Plan Task 2 — Live Queue card per dashboard.md §5.
// Reuses existing 02-04 EngineEventsProvider via useActiveJob + useQueueCounts.
// Audit M4: 'use client' first line.

import { Coffee } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SectionHint } from '@/components/stats/charts/section-hint';
import { ActiveSlotCard } from '@/components/queue/active-slot-card';
import { useActiveJob, useQueueCounts } from '@/src/lib/api/engine-events-client';

interface Props {
  initialQueueStatus: { activeJobs?: number; pendingJobs?: number; paused?: boolean } | null;
}

export function LiveQueueCard({ initialQueueStatus }: Props) {
  const t = useTranslations('dashboard.liveQueue');
  const activeJob = useActiveJob();
  const counts = useQueueCounts();
  const activeJobs = counts.activeJobs ?? initialQueueStatus?.activeJobs ?? 0;
  const pendingJobs = counts.pendingJobs ?? initialQueueStatus?.pendingJobs ?? 0;

  const header = (
    <CardHeader>
      <div className="flex items-center gap-1.5">
        <CardTitle>{t('title')}</CardTitle>
        <SectionHint content={t('hint')} />
      </div>
    </CardHeader>
  );

  if (activeJobs > 0 && activeJob) {
    return (
      <Card>
        {header}
        <CardContent>
          <ActiveSlotCard activeJob={activeJob} />
        </CardContent>
      </Card>
    );
  }

  if (activeJobs === 0 && pendingJobs > 0) {
    return (
      <Card>
        {header}
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('idle', { count: pendingJobs })}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {header}
      <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
        <Coffee className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      </CardContent>
    </Card>
  );
}
