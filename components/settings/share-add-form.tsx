'use client';

// 14-04 Task 4: ShareAddForm — bottom-of-list add affordance.
//
// Same 5 fields as ShareEditForm but empty defaults + reset-on-success.
// Parent owns POST + toast emission; this component only collects input.
//
// Server-error → setError mapping mirrors ShareEditForm so 409 share_path_nested
// surfaces inline under the `path` field rather than at the top of the page.

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ShareCreateBody } from '@/src/lib/api/shares-zod';
import type { ShareSaveResult } from '@/components/settings/share-edit-form';

const addFormSchema = z.object({
  name: z.string().trim().min(1).max(100),
  path: z.string().min(1).startsWith('/').max(4096),
  min_size_mb: z.number().int().min(0).max(102_400),
  extensions_csv: z.string().trim().min(1).max(512),
  max_depth: z.union([z.number().int().min(0).max(50), z.literal('')]),
});

export type ShareAddFormValues = z.infer<typeof addFormSchema>;

export type ShareAddFormProps = {
  onAdd: (input: ShareCreateBody) => Promise<ShareSaveResult>;
  isAdding?: boolean;
};

function toCreateBody(values: ShareAddFormValues): ShareCreateBody {
  return {
    name: values.name,
    path: values.path,
    min_size_mb: values.min_size_mb,
    extensions_csv: values.extensions_csv,
    max_depth: values.max_depth === '' ? null : values.max_depth,
  };
}

export function ShareAddForm({ onAdd, isAdding = false }: ShareAddFormProps) {
  const t = useTranslations('settings.paths.shares');

  const form = useForm<ShareAddFormValues>({
    resolver: zodResolver(addFormSchema),
    mode: 'onChange',
    defaultValues: {
      name: '',
      path: '',
      min_size_mb: 50,
      extensions_csv: 'mkv,mp4,avi',
      max_depth: '',
    },
  });

  async function handleSubmit(values: ShareAddFormValues): Promise<void> {
    const result = await onAdd(toCreateBody(values));
    if (result.ok) {
      form.reset();
      return;
    }
    const err = result.error;
    if (err.kind === 'validation') {
      for (const [field, message] of Object.entries(err.fieldErrors)) {
        if (
          field === 'name' ||
          field === 'path' ||
          field === 'extensions_csv' ||
          field === 'min_size_mb' ||
          field === 'max_depth'
        ) {
          form.setError(field, { type: 'server', message });
        }
      }
    } else if (err.kind === 'nested') {
      form.setError('path', {
        type: 'server',
        message: t('error.share_path_nested', {
          conflictingShareName: err.conflictingShareName,
          conflictingSharePath: err.conflictingSharePath,
        }),
      });
    } else if (err.kind === 'duplicate') {
      form.setError(err.field, {
        type: 'server',
        message: t(`error.share_${err.field}_duplicate`),
      });
    } else if (err.kind === 'scan_lock') {
      form.setError('root' as 'name', {
        type: 'server',
        message: t('error.share_mutating_during_scan'),
      });
    } else {
      form.setError('root' as 'name', {
        type: 'server',
        message: err.message ?? t('error.validation_failed'),
      });
    }
  }

  const nameError = form.formState.errors.name?.message;
  const pathError = form.formState.errors.path?.message;
  const minError = form.formState.errors.min_size_mb?.message;
  const extError = form.formState.errors.extensions_csv?.message;
  const depthError = form.formState.errors.max_depth?.message;

  const canSubmit = form.formState.isValid && !isAdding;

  return (
    <form
      onSubmit={form.handleSubmit(handleSubmit)}
      className="flex flex-col gap-4 rounded-lg border border-dashed border-border bg-card/50 p-4"
      aria-label={t('add.button')}
      data-testid="share-add-form"
      noValidate
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="share-add-name" className="text-sm font-medium">
            {t('form.label.name')}
          </label>
          <Input
            id="share-add-name"
            type="text"
            autoComplete="off"
            {...form.register('name')}
            aria-invalid={Boolean(nameError)}
          />
          {nameError && (
            <p className="text-xs text-destructive" role="alert">
              {nameError}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="share-add-path" className="text-sm font-medium">
            {t('form.label.path')}
          </label>
          <Input
            id="share-add-path"
            type="text"
            autoComplete="off"
            placeholder="/media/movies"
            {...form.register('path')}
            aria-invalid={Boolean(pathError)}
          />
          {pathError && (
            <p className="text-xs text-destructive" role="alert">
              {pathError}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="share-add-min" className="text-sm font-medium">
            {t('form.label.minSizeMb')}
          </label>
          <Input
            id="share-add-min"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            {...form.register('min_size_mb', { valueAsNumber: true })}
            aria-invalid={Boolean(minError)}
          />
          {minError && (
            <p className="text-xs text-destructive" role="alert">
              {minError}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="share-add-depth" className="text-sm font-medium">
            {t('form.label.maxDepth')}
          </label>
          <Input
            id="share-add-depth"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            {...form.register('max_depth', {
              setValueAs: (v: unknown) => (v === '' || v == null ? '' : Number(v)),
            })}
            aria-invalid={Boolean(depthError)}
          />
          <p className="text-xs text-muted-foreground">{t('form.helper.maxDepthEmpty')}</p>
          {depthError && (
            <p className="text-xs text-destructive" role="alert">
              {depthError}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <label htmlFor="share-add-ext" className="text-sm font-medium">
            {t('form.label.extensions')}
          </label>
          <Input
            id="share-add-ext"
            type="text"
            autoComplete="off"
            {...form.register('extensions_csv')}
            aria-invalid={Boolean(extError)}
          />
          <p className="text-xs text-muted-foreground">{t('form.helper.extensions')}</p>
          {extError && (
            <p className="text-xs text-destructive" role="alert">
              {extError}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-row justify-end">
        <Button
          type="submit"
          disabled={!canSubmit}
          aria-disabled={!canSubmit}
          data-testid="share-add-submit"
        >
          {isAdding ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {t('add.button')}
        </Button>
      </div>
    </form>
  );
}
