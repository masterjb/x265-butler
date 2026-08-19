'use client';

import { useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\./, '');
}

export function ExtensionsInput({
  value,
  onChange,
  id,
  ...rest
}: {
  value: string[];
  onChange: (next: string[]) => void;
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}) {
  const t = useTranslations('settings');
  const [draft, setDraft] = useState('');

  function commit(raw: string) {
    const normalized = normalize(raw);
    if (!normalized) return;
    if (value.includes(normalized)) {
      setDraft('');
      return;
    }
    onChange([...value, normalized]);
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  function remove(ext: string) {
    onChange(value.filter((e) => e !== ext));
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
      )}
    >
      {value.map((ext) => (
        <span
          key={ext}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
        >
          {ext}
          <button
            type="button"
            onClick={() => remove(ext)}
            aria-label={t('field.extensions.removeAria', { ext })}
            className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <Input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft && commit(draft)}
        placeholder={t('field.extensions.placeholder')}
        className="h-7 flex-1 border-0 bg-transparent px-1 text-sm focus-visible:ring-0"
        id={id}
        aria-describedby={rest['aria-describedby']}
        aria-invalid={rest['aria-invalid']}
      />
    </div>
  );
}
