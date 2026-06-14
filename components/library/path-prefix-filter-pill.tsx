'use client';

// 15-02 T5: Library `pathPrefix` filter pill. Sibling to the 14-03
// share-pill — same visual language (outline button, dismiss-X on the
// right) so operators recognise both pills as scope filters. Degenerate-
// hides when pathPrefix is missing.

import { Folder, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface PathPrefixFilterPillProps {
  pathPrefix?: string | null;
  onClear: () => void;
  className?: string;
}

const MAX_CHARS = 40;

// D5 ui-ux-pro-max: middle-ellipsis preserves both share-relative head and
// the leaf directory name (the part operators actually recognize).
export function truncateMiddleEllipsis(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 4) return value.slice(0, max - 1) + '…';
  const half = Math.floor((max - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(value.length - (max - 1 - half))}`;
}

export function PathPrefixFilterPill({
  pathPrefix,
  onClear,
  className,
}: PathPrefixFilterPillProps) {
  const t = useTranslations('library.pathPrefixPill');

  if (!pathPrefix) return null;
  const display = truncateMiddleEllipsis(pathPrefix, MAX_CHARS);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs',
        'min-h-[36px]',
        className,
      )}
      title={pathPrefix}
      aria-label={t('aria', { path: pathPrefix })}
    >
      <Folder className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <span className="text-muted-foreground">{t('label')}:</span>
      <code className="font-mono text-foreground" data-testid="path-prefix-pill-value">
        {display}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onClear}
        className="size-5 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={t('clear')}
      >
        <X className="size-3" aria-hidden="true" />
      </Button>
    </span>
  );
}
