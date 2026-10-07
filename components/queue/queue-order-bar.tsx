'use client';

// Toolbar above the pending list: the processing order (setting queue_order)
// as a select, how many jobs are pinned by hand, and a button to unpin them.
// The order is saved through the settings API; the server applies it at the
// next dispatch. Both actions reload the server-rendered list afterwards,
// because the list order and the pinned count come from the server.

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { QUEUE_ORDERS, isQueueOrder, type QueueOrder } from '@/src/lib/queue/queue-order';

export interface QueueOrderBarProps {
  order: QueueOrder;
  pinnedCount: number;
  // Reload the server-rendered queue (order, pins, count).
  onChanged: () => void;
}

export function QueueOrderBar({ order, pinnedCount, onChanged }: QueueOrderBarProps) {
  const t = useTranslations('queue.order');
  const labelId = useId();
  const [value, setValue] = useState<QueueOrder>(order);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  // A server reload brings the stored value; follow it.
  useEffect(() => {
    setValue(order);
  }, [order]);

  async function changeOrder(next: string): Promise<void> {
    if (!isQueueOrder(next) || next === value) return;
    const previous = value;
    setValue(next);
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { queue_order: next } }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      toast.success(t('toast.saved'));
      onChanged();
    } catch {
      setValue(previous);
      toast.error(t('toast.saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function clearManualOrder(): Promise<void> {
    setClearing(true);
    try {
      const res = await fetch('/api/queue/reorder', { method: 'DELETE' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      toast.success(t('toast.cleared'));
      onChanged();
    } catch {
      toast.error(t('toast.clearError'));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex w-full items-center gap-2 sm:w-auto">
        <span id={labelId} className="shrink-0 text-sm font-medium text-foreground">
          {t('label')}
        </span>
        <Select value={value} onValueChange={(v) => void changeOrder(String(v))} disabled={saving}>
          <SelectTrigger
            className="h-11 min-w-0 flex-1 text-sm sm:w-56 sm:flex-none"
            aria-labelledby={labelId}
          >
            {/* base-ui renders the raw value otherwise. */}
            <SelectValue>{t(`options.${value}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {QUEUE_ORDERS.map((o) => (
              <SelectItem key={o} value={o} className="min-h-11">
                {t(`options.${o}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {pinnedCount > 0 ? (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <span className="text-sm tabular-nums text-muted-foreground">
            {t('pinned', { count: pinnedCount })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-11 px-4"
            disabled={clearing}
            aria-busy={clearing}
            onClick={() => void clearManualOrder()}
          >
            {t('clear')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
