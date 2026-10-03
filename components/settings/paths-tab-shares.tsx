'use client';

// 14-04 Task 4: PathsTabShares — container component for the Settings → Paths
// tab. Replaces the legacy single-share form (gutted in Task 5).
//
// State machine = useReducer per audit-fix SR10 (discriminated-union actions).
// Single-edit invariant: at most one card is expanded at a time. When operator
// clicks [Edit] on card-B while card-A is dirty, the reducer transitions to
// `pendingEditSwitch` and PathsTabShares renders an AlertDialog (audit-fix SR5).
//
// API calls live here (NOT in ShareEditForm/ShareAddForm) so toasts + state
// mutation flow through one place. Path-change sonner toast carries an action
// button per audit-fix SR6 (AC-14): clicking [Re-scan now] router-pushes to
// /scan?from=share-edit.
//
// Empty-state copy + trailing <ShareAddForm> cover AC-10.

import { useCallback, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { ShareRow } from '@/src/lib/db/schema';
import type { ShareCreateBody } from '@/src/lib/api/shares-zod';
import { ShareCard } from './share-card';
import { ShareAddForm } from './share-add-form';
import type { ShareFormPatch, ShareSaveError, ShareSaveResult } from './share-edit-form';

type PathsState = {
  shares: ShareRow[];
  editingId: number | null;
  savingId: number | null;
  deletingId: number | null;
  dirtyByCard: Record<number, boolean>;
  pendingEditSwitch: { fromId: number; toId: number } | null;
  error: string | null;
};

type PathsAction =
  | {
      type: 'request_edit_start';
      id: number;
      otherCardDirty: boolean;
      otherCardId: number | null;
    }
  | { type: 'confirm_edit_switch' }
  | { type: 'cancel_edit_switch' }
  | { type: 'edit_cancel' }
  | { type: 'dirty_change'; id: number; dirty: boolean }
  | { type: 'save_start'; id: number }
  | { type: 'save_success'; share: ShareRow }
  | { type: 'save_fail'; error: string }
  | { type: 'delete_start'; id: number }
  | { type: 'delete_success'; id: number }
  | { type: 'add_success'; share: ShareRow }
  | { type: 'set_error'; error: string | null };

function reducer(state: PathsState, action: PathsAction): PathsState {
  switch (action.type) {
    case 'request_edit_start': {
      if (action.otherCardDirty && action.otherCardId !== null) {
        return {
          ...state,
          pendingEditSwitch: { fromId: action.otherCardId, toId: action.id },
        };
      }
      return {
        ...state,
        editingId: action.id,
        pendingEditSwitch: null,
        error: null,
      };
    }
    case 'confirm_edit_switch': {
      if (!state.pendingEditSwitch) return state;
      const { fromId, toId } = state.pendingEditSwitch;
      return {
        ...state,
        editingId: toId,
        pendingEditSwitch: null,
        dirtyByCard: { ...state.dirtyByCard, [fromId]: false },
      };
    }
    case 'cancel_edit_switch':
      return { ...state, pendingEditSwitch: null };
    case 'edit_cancel': {
      const id = state.editingId;
      const nextDirty = { ...state.dirtyByCard };
      if (id !== null) delete nextDirty[id];
      return { ...state, editingId: null, dirtyByCard: nextDirty };
    }
    case 'dirty_change':
      return {
        ...state,
        dirtyByCard: { ...state.dirtyByCard, [action.id]: action.dirty },
      };
    case 'save_start':
      return { ...state, savingId: action.id, error: null };
    case 'save_success': {
      const shares = state.shares.map((s) => (s.id === action.share.id ? action.share : s));
      const nextDirty = { ...state.dirtyByCard };
      delete nextDirty[action.share.id];
      return {
        ...state,
        shares,
        savingId: null,
        editingId: null,
        dirtyByCard: nextDirty,
      };
    }
    case 'save_fail':
      return { ...state, savingId: null, error: action.error };
    case 'delete_start':
      return { ...state, deletingId: action.id, error: null };
    case 'delete_success': {
      const shares = state.shares.filter((s) => s.id !== action.id);
      const nextDirty = { ...state.dirtyByCard };
      delete nextDirty[action.id];
      return {
        ...state,
        shares,
        deletingId: null,
        editingId: state.editingId === action.id ? null : state.editingId,
        dirtyByCard: nextDirty,
      };
    }
    case 'add_success':
      return {
        ...state,
        shares: [...state.shares, action.share].sort((a, b) => a.id - b.id),
      };
    case 'set_error':
      return { ...state, error: action.error };
    default:
      return state;
  }
}

function mapErrorBodyToShareSaveError(
  body: Record<string, unknown>,
  status: number,
): ShareSaveError {
  if (status === 409) {
    if (body.error === 'share_path_nested') {
      return {
        kind: 'nested',
        conflictingShareName: String(body.conflictingShareName ?? ''),
        conflictingSharePath: String(body.conflictingSharePath ?? ''),
      };
    }
    if (body.error === 'share_name_duplicate') {
      return { kind: 'duplicate', field: 'name' };
    }
    if (body.error === 'share_path_duplicate') {
      return { kind: 'duplicate', field: 'path' };
    }
    if (body.error === 'share_mutating_during_scan') {
      return { kind: 'scan_lock' };
    }
  }
  if (status === 400 && body.error === 'validation_failed') {
    return {
      kind: 'validation',
      fieldErrors: (body.fieldErrors as Record<string, string>) ?? {},
    };
  }
  return { kind: 'unknown', message: String(body.error ?? `http_${status}`) };
}

export type PathsTabSharesProps = {
  initialShares: ShareRow[];
};

export function PathsTabShares({ initialShares }: PathsTabSharesProps) {
  const t = useTranslations('settings.paths.shares');
  const router = useRouter();

  const [state, dispatch] = useReducer(reducer, {
    shares: [...initialShares].sort((a, b) => a.id - b.id),
    editingId: null,
    savingId: null,
    deletingId: null,
    dirtyByCard: {},
    pendingEditSwitch: null,
    error: null,
  });

  const handleEditStart = useCallback(
    (id: number) => {
      const otherId = state.editingId;
      if (otherId !== null && otherId !== id) {
        const otherDirty = Boolean(state.dirtyByCard[otherId]);
        dispatch({
          type: 'request_edit_start',
          id,
          otherCardDirty: otherDirty,
          otherCardId: otherId,
        });
      } else {
        dispatch({
          type: 'request_edit_start',
          id,
          otherCardDirty: false,
          otherCardId: null,
        });
      }
    },
    [state.editingId, state.dirtyByCard],
  );

  const handleEditCancel = useCallback(() => {
    dispatch({ type: 'edit_cancel' });
  }, []);

  const handleSave = useCallback(
    async (id: number, patch: ShareFormPatch): Promise<ShareSaveResult> => {
      dispatch({ type: 'save_start', id });
      try {
        const res = await fetch(`/api/shares/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const body = (await res.json()) as Record<string, unknown>;
        if (res.status === 200) {
          const share = body.share as ShareRow;
          dispatch({ type: 'save_success', share });
          const warnings = (body.warnings as string[] | undefined) ?? [];
          if (warnings.includes('rescan_recommended')) {
            toast.message(t('warning.rescanRecommended'), {
              action: {
                label: t('warning.rescanAction'),
                onClick: () => router.push('/scan?from=share-edit'),
              },
            });
          }
          return { ok: true };
        }
        const error = mapErrorBodyToShareSaveError(body, res.status);
        dispatch({ type: 'save_fail', error: String(error.kind) });
        return { ok: false, error };
      } catch (err) {
        dispatch({ type: 'save_fail', error: 'network' });
        return {
          ok: false,
          error: { kind: 'unknown', message: err instanceof Error ? err.message : 'network' },
        };
      }
    },
    [router, t],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      dispatch({ type: 'delete_start', id });
      try {
        const res = await fetch(`/api/shares/${id}`, { method: 'DELETE' });
        const body = (await res.json()) as Record<string, unknown>;
        if (res.status === 200) {
          dispatch({ type: 'delete_success', id });
          const orphanedCount = Number(body.orphanedFileCount ?? 0);
          toast.success(t('delete.success', { count: orphanedCount }));
          return;
        }
        if (res.status === 409 && body.error === 'share_mutating_during_scan') {
          toast.error(t('error.share_mutating_during_scan'));
          dispatch({ type: 'set_error', error: 'scan_lock' });
          return;
        }
        toast.error(t('error.validation_failed'));
        dispatch({ type: 'set_error', error: String(body.error ?? `http_${res.status}`) });
      } catch (err) {
        toast.error(t('error.validation_failed'));
        dispatch({
          type: 'set_error',
          error: err instanceof Error ? err.message : 'network',
        });
      }
    },
    [t],
  );

  const handleAdd = useCallback(
    async (input: ShareCreateBody): Promise<ShareSaveResult> => {
      try {
        const res = await fetch('/api/shares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        const body = (await res.json()) as Record<string, unknown>;
        if (res.status === 201) {
          const share = body.share as ShareRow;
          dispatch({ type: 'add_success', share });
          toast.success(t('add.success'));
          return { ok: true };
        }
        const error = mapErrorBodyToShareSaveError(body, res.status);
        return { ok: false, error };
      } catch (err) {
        return {
          ok: false,
          error: { kind: 'unknown', message: err instanceof Error ? err.message : 'network' },
        };
      }
    },
    [t],
  );

  const handleDirtyChange = useCallback((id: number, dirty: boolean) => {
    dispatch({ type: 'dirty_change', id, dirty });
  }, []);

  const dialogOpen = state.pendingEditSwitch !== null;
  const fromShare =
    state.pendingEditSwitch !== null
      ? state.shares.find((s) => s.id === state.pendingEditSwitch!.fromId)
      : null;

  return (
    <div className="flex flex-col gap-4" data-testid="paths-tab-shares">
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      {state.shares.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="paths-tab-empty">
          {t('emptyState')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {state.shares.map((share) => (
            <ShareCard
              key={share.id}
              share={share}
              isEditing={state.editingId === share.id}
              isSaving={state.savingId === share.id}
              isDeleting={state.deletingId === share.id}
              onEditStart={() => handleEditStart(share.id)}
              onEditCancel={handleEditCancel}
              onSave={(patch) => handleSave(share.id, patch)}
              onDelete={() => handleDelete(share.id)}
              onDirtyChange={(dirty) => handleDirtyChange(share.id, dirty)}
            />
          ))}
        </div>
      )}
      <ShareAddForm onAdd={handleAdd} />

      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) dispatch({ type: 'cancel_edit_switch' });
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />
              {t('discardDialog.title', { name: fromShare?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('discardDialog.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => dispatch({ type: 'cancel_edit_switch' })}>
              {t('discardDialog.stay')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => dispatch({ type: 'confirm_edit_switch' })}
            >
              {t('discardDialog.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
