import {
  Circle,
  ListPlus,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  MinusCircle,
  XCircle,
  Ban,
  PauseCircle,
  HelpCircle,
  History,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FileStatus } from '@/src/lib/db/schema';

// Map per design-system/pages/library.md §3.3 — color + icon + label.
// Colors expressed via Tailwind utility classes (light + dark variants paired).
type StatusVisual = {
  icon: LucideIcon;
  classes: string;
  iconClasses?: string;
};

const STATUS_VISUALS: Record<FileStatus, StatusVisual> = {
  pending: {
    icon: Circle,
    classes: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  },
  queued: {
    icon: ListPlus,
    classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  },
  encoding: {
    icon: Loader2,
    classes: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
    iconClasses: 'animate-spin',
  },
  'done-smaller': {
    icon: CheckCircle2,
    classes: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  },
  'done-larger': {
    icon: AlertTriangle,
    classes: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
  'skipped-codec': {
    icon: MinusCircle,
    classes: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  'skipped-bitrate': {
    icon: MinusCircle,
    classes: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  'skipped-suffix': {
    icon: MinusCircle,
    classes: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  'skipped-tag': {
    icon: MinusCircle,
    classes: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  'skipped-sidecar': {
    icon: MinusCircle,
    classes: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  'skipped-blocklist': {
    icon: MinusCircle,
    classes: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  failed: {
    icon: XCircle,
    classes: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  },
  blocklisted: {
    icon: Ban,
    classes: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200',
  },
  interrupted: {
    icon: PauseCircle,
    classes: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  // 05-bonus: file no longer present on disk at scan time. Slate + dashed
  // border-leaning visual via classes; HelpCircle conveys uncertainty without
  // alarming red. Operator opts-in to see these via filter or includeVanished.
  vanished: {
    icon: HelpCircle,
    classes: 'bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400 italic',
  },
  // 05-13: encoded but savings < min_savings_percent — output discarded,
  // source kept, sidecar at source-path. Amber family aligns semantically
  // with done-larger (negative-outcome verdict) but distinct icon
  // (MinusCircle vs AlertTriangle) for visual disambiguation.
  // /ui-ux-pro-max PLAN-time review: amber-50/amber-700 = 4.51:1 light /
  // amber-950/amber-300 = 4.78:1 dark — both meet WCAG-AA.
  'done-not-worth': {
    icon: MinusCircle,
    classes: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  },
  // 05-13: scan-time skip-pipeline match — sidecar.outcome ∈ {done-larger,
  // done-not-worth} OR step-4 DB-hash enrichment for pre-05-13 corpus.
  // Slate-skipped family keeps the operator-mental-model "we have prior
  // evidence, no re-encode"; History icon conveys the lookback semantic
  // without conflating with the simpler skipped-* statuses (MinusCircle).
  // slate-100/slate-700 = 7.04:1 light / slate-800/slate-300 = 9.83:1 dark.
  'done-already-evaluated': {
    icon: History,
    classes: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
};

export function StatusChip({
  status,
  label,
  className,
}: {
  status: FileStatus;
  label: string;
  className?: string;
}) {
  const visual = STATUS_VISUALS[status];
  const Icon = visual.icon;
  return (
    <span
      data-status={status}
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

export function getStatusVisual(status: FileStatus): StatusVisual {
  return STATUS_VISUALS[status];
}

// Convert hyphenated FileStatus enum values to camelCase i18n keys
// (`done-smaller` → `doneSmaller`). Keeps message-key naming convention
// (audit-added S12) compatible with the enum literal.
export function statusToI18nKey(status: FileStatus): string {
  return status.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
