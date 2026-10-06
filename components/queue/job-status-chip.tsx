import {
  ListPlus,
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  PauseCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { JobStatus } from '@/src/lib/db/schema';

// queue.md §3.5 — maps JobStatus (NOT FileStatus) to visual.
type JobStatusVisual = {
  icon: LucideIcon;
  classes: string;
  iconClasses?: string;
};

const JOB_STATUS_VISUALS: Record<JobStatus, JobStatusVisual> = {
  queued: {
    icon: ListPlus,
    classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  },
  encoding: {
    icon: Loader2,
    classes: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
    iconClasses: 'animate-spin',
  },
  done: {
    icon: CheckCircle2,
    classes: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  },
  failed: {
    icon: XCircle,
    classes: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
  cancelled: {
    icon: Ban,
    classes: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  interrupted: {
    icon: PauseCircle,
    classes: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
};

export function JobStatusChip({
  status,
  label,
  className,
}: {
  status: JobStatus;
  label: string;
  className?: string;
}) {
  const visual = JOB_STATUS_VISUALS[status];
  const Icon = visual.icon;
  return (
    <span
      data-job-status={status}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        visual.classes,
        className,
      )}
    >
      <Icon className={cn('size-3 shrink-0', visual.iconClasses)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
