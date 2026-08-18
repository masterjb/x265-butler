'use client';

import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function SearchInput({
  value,
  onChange,
  onClear,
}: {
  value: string;
  onChange: (next: string) => void;
  onClear: () => void;
}) {
  const t = useTranslations('library');
  return (
    <div className="relative w-full sm:max-w-xs">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        className="h-9 pl-8 pr-8"
      />
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('search.clear')}
          onClick={onClear}
          className="absolute right-1 top-1/2 -translate-y-1/2"
        >
          <X />
        </Button>
      )}
    </div>
  );
}
