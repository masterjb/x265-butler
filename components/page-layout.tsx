import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Geteiltes Page-Layout — alle Masken (Library, Settings, Queue/Stats/Trash/Logs,
// NotFound, Error) konsumieren PageContainer + PageHeader für visuelle
// Konsistenz. Source-of-truth für Page-Hierarchie laut MASTER §11.

type PageVariant = 'form' | 'data' | 'centered';

const VARIANT_CLASSES: Record<PageVariant, string> = {
  // Schmaler, zentriert — für Forms wie Settings.
  form: 'mx-auto w-full max-w-3xl',
  // Daten-Pane — volle Breite für alle Datenseiten.
  data: 'w-full',
  // Zentriert mit Hero-Anmutung — für leere Stub-Pages, NotFound, Error.
  centered: 'mx-auto w-full max-w-2xl',
};

export function PageContainer({
  variant = 'data',
  className,
  children,
}: {
  variant?: PageVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-6', VARIANT_CLASSES[variant], className)}>{children}</div>
  );
}

export function PageHeader({
  title,
  subhead,
  actions,
  className,
}: {
  title: string;
  subhead?: ReactNode;
  // Rechts-bündige Aktions-Slot (Buttons, Badges) — auf <md unter Title gestapelt.
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn('flex flex-col gap-3 md:flex-row md:items-end md:justify-between', className)}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          {title}
        </h1>
        {subhead && <p className="text-sm text-muted-foreground md:text-base">{subhead}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
