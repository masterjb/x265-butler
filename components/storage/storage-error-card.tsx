'use client';

// 15-02 T4: shared error-state card. Widgets fail independently; this card
// surfaces the structured error.code from the backend and offers a Retry
// (SWR mutate) that disables itself during isValidating to prevent spam.

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { StorageFetchError } from './use-storage-data';

export interface StorageErrorCardProps {
  endpoint: string;
  error: StorageFetchError | Error;
  onRetry: () => void;
  isRetrying?: boolean;
}

export function StorageErrorCard({
  endpoint,
  error,
  onRetry,
  isRetrying = false,
}: StorageErrorCardProps) {
  const t = useTranslations('storage.errors');
  const code = error instanceof StorageFetchError ? error.code : 'unknown';
  const localizedCode = t.has(`code.${code}`) ? t(`code.${code}`) : code;

  return (
    <Card role="alert" aria-live="polite" className="border-destructive/40 bg-destructive/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="size-4" aria-hidden="true" />
          {t('loadFailed', { endpoint })}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground font-mono">{localizedCode}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={isRetrying}
          className="self-start gap-2"
        >
          <RefreshCw className={isRetrying ? 'size-3 animate-spin' : 'size-3'} aria-hidden="true" />
          {t('tryAgain')}
        </Button>
      </CardContent>
    </Card>
  );
}
