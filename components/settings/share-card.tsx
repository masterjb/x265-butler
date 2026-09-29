'use client';

// 14-04 Task 4: ShareCard — collapsed summary + expand-to-edit + P3 Delete.
//
// Collapsed-state summary follows the ASCII anatomy chosen in Task 1 D1:
//   "{name} · {path} · min {min_size_mb} MB · {extCount} ext · depth {depth}"
// Depth=null → ∞ glyph per AC-11.
//
// Delete-button is the existing 13-01a P3 ConfirmButton (inverted-cooldown)
// per Task 1 D2 — pre-armed → 3s hold/click → fire. P3 covers AC-13 +
// AC-26 audit-log surface (DELETE handler emits share_deleted server-side).

import { Pencil, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { ShareEditForm, type ShareSaveResult, type ShareFormPatch } from './share-edit-form';
import type { ShareRow } from '@/src/lib/db/schema';

export type ShareCardProps = {
  share: ShareRow;
  isEditing: boolean;
  isSaving?: boolean;
  isDeleting?: boolean;
  onEditStart: () => void;
  onEditCancel: () => void;
  onSave: (patch: ShareFormPatch) => Promise<ShareSaveResult>;
  onDelete: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
};

function extensionCount(csv: string): number {
  return csv.split(',').filter((s) => s.trim().length > 0).length;
}

export function ShareCard({
  share,
  isEditing,
  isSaving = false,
  isDeleting = false,
  onEditStart,
  onEditCancel,
  onSave,
  onDelete,
  onDirtyChange,
}: ShareCardProps) {
  const t = useTranslations('settings.paths.shares');
  const extCount = extensionCount(share.extensions_csv);
  const depthDisplay = share.max_depth === null ? t('depthUnlimited') : String(share.max_depth);

  return (
    <Card
      className="flex flex-col gap-3 p-4"
      data-testid={`share-card-${share.id}`}
      data-editing={isEditing ? 'true' : 'false'}
    >
      {!isEditing ? (
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <p className="text-sm leading-relaxed text-foreground" data-testid="share-summary">
            {t('summary', {
              name: share.name,
              path: share.path,
              minMb: share.min_size_mb,
              extCount,
              depth: depthDisplay,
            })}
          </p>
          <div className="flex flex-row gap-2 md:shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={onEditStart}
              disabled={isDeleting}
              aria-label={t('card.editAria', { name: share.name })}
              className="min-h-11"
              data-testid={`share-edit-btn-${share.id}`}
            >
              <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('edit.button')}
            </Button>
            <ConfirmButton
              variant="P3"
              size="md"
              label={t('delete.button')}
              cancelLabel={t('edit.cancel')}
              disabled={isDeleting}
              onConfirm={() => void onDelete()}
              className="min-h-11 border-destructive/40 hover:border-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
            </ConfirmButton>
          </div>
        </div>
      ) : (
        <ShareEditForm
          initial={share}
          onSave={onSave}
          onCancel={onEditCancel}
          onDirtyChange={onDirtyChange}
          isSaving={isSaving}
        />
      )}
    </Card>
  );
}
