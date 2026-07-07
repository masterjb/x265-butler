'use client';

// 15-02 T2: Depth-Selector — DropdownMenu 1..5 (page-local state).
// Depth controls only the top-folders aggregation; share-filter stays
// orthogonal.

import { Check, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export const DEPTH_VALUES = [1, 2, 3, 4, 5] as const;
export type DepthValue = (typeof DEPTH_VALUES)[number];

export interface DepthSelectorProps {
  value: DepthValue;
  onChange: (next: DepthValue) => void;
}

export function DepthSelector({ value, onChange }: DepthSelectorProps) {
  const t = useTranslations('storage.toolbar');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="default"
            aria-label={t('depthAria', { depth: value })}
            className="min-h-[44px] gap-1.5 px-3"
          />
        }
      >
        <span className="text-sm font-medium">
          {t('depthLabel')}: <span className="font-mono tabular-nums">{value}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 opacity-60" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        {DEPTH_VALUES.map((n) => {
          const isActive = n === value;
          return (
            <DropdownMenuItem
              key={n}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => onChange(n)}
              className={cn('min-h-[44px]', isActive && 'bg-accent text-accent-foreground')}
            >
              <span className="flex-1">{t('depthOption', { depth: n })}</span>
              {isActive && <Check className="size-4" aria-hidden="true" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
