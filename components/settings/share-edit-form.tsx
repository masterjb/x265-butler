'use client';

// 14-04 Task 4: ShareEditForm — react-hook-form + zod inline edit form.
//
// Owns ONLY: field state + dirty tracking + client-side validation +
// server-error → setError mapping. Parent owns: API call, toasts, collapse-on-
// success, list-state mutation. This split keeps unit-tests focused per AC-11
// (anatomy + Edit/Cancel toggle) and AC-14 (server-409 surfaces under field).
//
// Client-side schema mirrors shareUpdateSchema MINIMUM constraints. Server
// remains the authority for share_path_nested (409) + path-traversal/NUL-byte
// hardening (400 fieldErrors). On a server-rejected save we map fieldErrors
// → setError so error copy lands inline under the right field per
// /ui-ux-pro-max §8 error-placement rule.
//
// Dirty-discard contract (audit-fix SR5): every keystroke fires onDirtyChange
// so PathsTabShares can decide whether to show the AlertDialog when operator
// clicks [Edit] on a different card.

import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ShareRow } from '@/src/lib/db/schema';

const editFormSchema = z.object({
  name: z.string().trim().min(1).max(100),
  path: z.string().min(1).startsWith('/').max(4096),
  min_size_mb: z.number().int().min(0).max(102_400),
  extensions_csv: z.string().trim().min(1).max(512),
  max_depth: z.union([z.number().int().min(0).max(50), z.literal('')]),
});

export type ShareEditFormValues = z.infer<typeof editFormSchema>;

export type ShareFormPatch = {
  name?: string;
  path?: string;
  min_size_mb?: number;
  extensions_csv?: string;
  max_depth?: number | null;
};

export type ShareSaveError =
  | { kind: 'validation'; fieldErrors: Record<string, string> }
  | { kind: 'nested'; conflictingShareName: string; conflictingSharePath: string }
  | { kind: 'duplicate'; field: 'name' | 'path' }
  | { kind: 'scan_lock' }
  | { kind: 'unknown'; message?: string };

export type ShareSaveResult = { ok: true } | { ok: false; error: ShareSaveError };

export type ShareEditFormProps = {
  initial: ShareRow;
  onSave: (patch: ShareFormPatch) => Promise<ShareSaveResult>;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  isSaving?: boolean;
};

function maxDepthDefault(value: number | null): number | '' {
  return value === null ? '' : value;
}

function diffPatch(initial: ShareRow, values: ShareEditFormValues): ShareFormPatch {
  const patch: ShareFormPatch = {};
  if (values.name !== initial.name) patch.name = values.name;
  if (values.path !== initial.path) patch.path = values.path;
  if (values.min_size_mb !== initial.min_size_mb) patch.min_size_mb = values.min_size_mb;
  if (values.extensions_csv !== initial.extensions_csv) {
    patch.extensions_csv = values.extensions_csv;
  }
  const nextDepth: number | null = values.max_depth === '' ? null : values.max_depth;
  if (nextDepth !== initial.max_depth) patch.max_depth = nextDepth;
  return patch;
}

export function ShareEditForm({
  initial,
  onSave,
  onCancel,
  onDirtyChange,
  isSaving = false,
}: ShareEditFormProps) {
  const t = useTranslations('settings.paths.shares');

  const form = useForm<ShareEditFormValues>({
    resolver: zodResolver(editFormSchema),
    mode: 'onChange',
    defaultValues: {
      name: initial.name,
      path: initial.path,
      min_size_mb: initial.min_size_mb,
      extensions_csv: initial.extensions_csv,
      max_depth: maxDepthDefault(initial.max_depth),
    },
  });

  // audit-fix SR5: surface dirty state to parent reducer so PathsTabShares can
  // open the AlertDialog before discarding unsaved changes. Ref-pattern keeps
  // the effect dependency stable so an unstable inline callback from a re-
  // rendering parent does NOT trigger an effect-dispatch render loop.
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(form.formState.isDirty);
  }, [form.formState.isDirty]);

  async function handleSave(values: ShareEditFormValues): Promise<void> {
    const patch = diffPatch(initial, values);
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    const result = await onSave(patch);
    if (!result.ok) {
      const err = result.error;
      if (err.kind === 'validation') {
        for (const [field, message] of Object.entries(err.fieldErrors)) {
          if (field === 'name' || field === 'path' || field === 'extensions_csv') {
            form.setError(field, { type: 'server', message });
          } else if (field === 'min_size_mb' || field === 'max_depth') {
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
  }

  const nameError = form.formState.errors.name?.message;
  const pathError = form.formState.errors.path?.message;
  const minError = form.formState.errors.min_size_mb?.message;
  const extError = form.formState.errors.extensions_csv?.message;
  const depthError = form.formState.errors.max_depth?.message;

  const canSubmit = form.formState.isDirty && form.formState.isValid && !isSaving;

  return (
    <form
      onSubmit={form.handleSubmit(handleSave)}
      className="flex flex-col gap-4"
      data-testid="share-edit-form"
      aria-label={t('card.editAria', { name: initial.name })}
      noValidate
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`share-name-${initial.id}`} className="text-sm font-medium">
            {t('form.label.name')}
          </label>
          <Input
            id={`share-name-${initial.id}`}
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
          <label htmlFor={`share-path-${initial.id}`} className="text-sm font-medium">
            {t('form.label.path')}
          </label>
          <Input
            id={`share-path-${initial.id}`}
            type="text"
            autoComplete="off"
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
          <label htmlFor={`share-min-${initial.id}`} className="text-sm font-medium">
            {t('form.label.minSizeMb')}
          </label>
          <Input
            id={`share-min-${initial.id}`}
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
          <label htmlFor={`share-depth-${initial.id}`} className="text-sm font-medium">
            {t('form.label.maxDepth')}
          </label>
          <Input
            id={`share-depth-${initial.id}`}
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
          <label htmlFor={`share-ext-${initial.id}`} className="text-sm font-medium">
            {t('form.label.extensions')}
          </label>
          <Input
            id={`share-ext-${initial.id}`}
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
      <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSaving}
          aria-disabled={isSaving}
        >
          {t('edit.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={!canSubmit}
          aria-disabled={!canSubmit}
          data-testid="share-edit-save"
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {t('edit.save')}
        </Button>
      </div>
    </form>
  );
}
