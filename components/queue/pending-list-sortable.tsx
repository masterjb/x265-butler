'use client';

// Plan 05-12 (B3 Queue Reorder) — LEFT pane: drag-reorder pending queue list.
// Direction B layout (per design-system/pages/queue.md §10): edge-gripzone
// (24px left strip), `h-10` compact rows, dnd-kit sensors (Pointer + Touch
// long-press 250ms + Keyboard arrow-key alt), i18n'd announcements, drop
// animation suppressed under `prefers-reduced-motion: reduce` (M6).

import { useEffect, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, MoonStar } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { JobStatusChip } from './job-status-chip';
import { SkipRowAction } from './skip-row-action';
import { useReorderQueue } from './use-reorder-queue';
import { fileNameOf, parentOf } from '@/src/lib/format/job-path';
import type { JobRow } from '@/src/lib/db/schema';

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setReduce(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return reduce;
}

interface PendingRowProps {
  job: JobRow;
  filePath: string | undefined;
  prefersReducedMotion: boolean;
}

function PendingRow({ job, filePath, prefersReducedMotion }: PendingRowProps) {
  const t = useTranslations('queue');
  const tRow = useTranslations('queue.row');
  const tReorder = useTranslations('queue.reorder');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: job.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: prefersReducedMotion ? 'none' : transition,
    opacity: isDragging ? 0.6 : 1,
  } as React.CSSProperties;

  const filename = filePath ? fileNameOf(filePath) : `#${job.file_id}`;
  const parent = filePath ? parentOf(filePath) : null;
  const parentDisplay = parent === '(root)' ? tRow('atRoot') : parent;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={
        'flex h-10 items-center gap-2 rounded-md border border-border bg-card transition-colors ' +
        (isDragging ? 'ring-1 ring-violet-500/50' : 'hover:bg-muted/50')
      }
    >
      {/* Edge-gripzone: 24px wide left strip, 8px pl-2 safe-gutter outside.
          B-layout per design-system/pages/queue.md §10.2. */}
      <button
        type="button"
        className="ml-2 flex h-full min-h-[44px] w-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing group-hover:text-muted-foreground"
        style={{ touchAction: 'none' }}
        {...attributes}
        {...listeners}
        aria-label={tReorder('handle.label', { filename })}
        aria-roledescription={tReorder('handle.roledescription')}
      >
        <GripVertical className="size-4" aria-hidden="true" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm" title={filePath ?? `#${job.file_id}`}>
            {filename}
          </span>
          {parentDisplay && (
            <span
              className="truncate font-mono text-xs text-muted-foreground"
              title={filePath ?? undefined}
            >
              {parentDisplay}
            </span>
          )}
        </div>
      </div>
      <JobStatusChip status={job.status} label={t(`status.${job.status}`)} />
      <div className="mr-2 shrink-0">
        <SkipRowAction job={job} />
      </div>
    </li>
  );
}

export interface PendingListSortableProps {
  initialPending: JobRow[];
  livePending: JobRow[];
  pathByFileId?: Record<number, string>;
}

export function PendingListSortable({
  initialPending,
  livePending,
  pathByFileId,
}: PendingListSortableProps) {
  const t = useTranslations('queue.pending');
  const tReorder = useTranslations('queue.reorder');
  const prefersReducedMotion = usePrefersReducedMotion();
  const { orderedPending, reorder } = useReorderQueue({ initialPending, livePending });
  const announceRef = useRef<HTMLDivElement | null>(null);

  // PointerSensor + TouchSensor (long-press 250ms) + KeyboardSensor (arrow-key alt).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function filenameFor(id: number): string {
    const job = orderedPending.find((j) => j.id === id);
    if (!job) return `#${id}`;
    const p = pathByFileId?.[job.file_id];
    return p ? fileNameOf(p) : `#${job.file_id}`;
  }

  // S1: i18n'd dnd-kit announcements (replaces dnd-kit's English-only defaults).
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      tReorder('announceStart', { filename: filenameFor(Number(active.id)) }),
    onDragOver: ({ active, over }) => {
      if (!over) return undefined;
      const overIdx = orderedPending.findIndex((j) => j.id === Number(over.id));
      if (overIdx < 0) return undefined;
      return tReorder('announceOver', {
        filename: filenameFor(Number(active.id)),
        position: overIdx + 1,
      });
    },
    onDragEnd: ({ active, over }) => {
      if (!over) return tReorder('announceCancel', { filename: filenameFor(Number(active.id)) });
      const overIdx = orderedPending.findIndex((j) => j.id === Number(over.id));
      return tReorder('announceEnd', {
        filename: filenameFor(Number(active.id)),
        position: overIdx + 1,
        total: orderedPending.length,
      });
    },
    onDragCancel: ({ active }) =>
      tReorder('announceCancel', { filename: filenameFor(Number(active.id)) }),
  };

  function handleDragEnd(ev: DragEndEvent): void {
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    const fromIdx = orderedPending.findIndex((j) => j.id === Number(active.id));
    const toIdx = orderedPending.findIndex((j) => j.id === Number(over.id));
    if (fromIdx < 0 || toIdx < 0) return;
    const next = arrayMove(orderedPending, fromIdx, toIdx).map((j) => j.id);
    reorder(next);
    // aria-live announcer (legacy single-message — complements dnd-kit announcements).
    if (announceRef.current) {
      const filename = filenameFor(Number(active.id));
      announceRef.current.textContent = tReorder('announce', {
        filename,
        position: toIdx + 1,
        total: orderedPending.length,
      });
    }
  }

  if (orderedPending.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        <MoonStar className="size-8" aria-hidden="true" />
        <span className="font-medium text-foreground">{t('empty.title')}</span>
        <span>{t('empty.helper')}</span>
      </div>
    );
  }

  const itemIds = orderedPending.map((j) => j.id);

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {t('title')} ({orderedPending.length})
      </h2>
      {/* aria-live region for screen-reader feedback after a drop. */}
      <div ref={announceRef} role="status" aria-live="polite" className="sr-only" />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        accessibility={{ announcements }}
        // M6: drop-overlay snap animation suppressed under prefers-reduced-motion.
        // Item-level transition.duration=0 alone is insufficient — DragOverlay is
        // a separate render path; passing null disables the snap entirely.
        {...(prefersReducedMotion ? { dropAnimation: null } : {})}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          <ul className="group flex flex-col gap-2">
            {orderedPending.map((job) => (
              <PendingRow
                key={job.id}
                job={job}
                filePath={pathByFileId?.[job.file_id]}
                prefersReducedMotion={prefersReducedMotion}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}
