import { type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Size = 'default' | 'lg';

type Props = {
  icon: LucideIcon;
  title: string;
  body?: string;
  // Optional right- or left-aligned slot for primary action button(s).
  action?: ReactNode;
  // Secondary informational badge / hint above the title (e.g. "Verfügbar in v1.2").
  hint?: ReactNode;
  size?: Size;
  className?: string;
};

const SIZE_CONFIG: Record<Size, { wrap: string; icon: string; title: string; body: string }> = {
  default: {
    wrap: 'min-h-[40vh] gap-4 px-4',
    icon: 'size-12',
    title: 'text-2xl',
    body: 'text-base',
  },
  lg: {
    wrap: 'min-h-[50vh] gap-5 px-6 py-12',
    icon: 'size-16 md:size-20',
    title: 'text-2xl md:text-3xl',
    body: 'text-base md:text-lg',
  },
};

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  hint,
  size = 'default',
  className,
}: Props) {
  const cfg = SIZE_CONFIG[size];
  return (
    <div
      className={cn('flex flex-col items-center justify-center text-center', cfg.wrap, className)}
    >
      {hint && (
        <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
          {hint}
        </span>
      )}
      <Icon className={cn('text-muted-foreground', cfg.icon)} aria-hidden="true" />
      <h2 className={cn('font-semibold tracking-tight text-foreground', cfg.title)}>{title}</h2>
      {body && <p className={cn('max-w-prose text-muted-foreground', cfg.body)}>{body}</p>}
      {action && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div>
      )}
    </div>
  );
}
