'use client';

import { BarChart3 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Props {
  onStartBenchmark?: () => void;
}

export function BenchEmptyState({ onStartBenchmark }: Props) {
  const t = useTranslations('bench.page.emptyState');

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <BarChart3 className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-semibold">{t('title')}</p>
          <p className="text-sm text-muted-foreground max-w-sm">{t('body')}</p>
        </div>
        <Button variant="default" onClick={onStartBenchmark}>
          {t('cta')}
        </Button>
      </CardContent>
    </Card>
  );
}
