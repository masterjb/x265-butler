'use client';

// 11-02-FIX (UAT-001): V3 layout-a — bar fill bound to phasePct (NOT overallPct, audit M2)
// for live per-combo motion. Phase-transition uses key={currentPhase} snap (audit M3) so
// the 100→0 reset doesn't animate backwards. layout-a (single bg-primary) chosen at T5a
// to avoid color-collision with pareto-scatter chart-N tokens used below.
//
// 13-01c Route-1 scope-extend: optional onCancel prop renders an inline ConfirmButton P2
// (5s undo-window) inside the card footer. Co-locates the destructive action with the
// running-progress affordance (spatial-continuity) — pattern parity with Pass2ProgressCard.

import { useTranslations } from 'next-intl';
import { Ban, Loader2 } from 'lucide-react';
import { ConfirmButton } from '@/components/ui/confirm-button';

interface BenchProgressCardProps {
  completedCombos: number;
  totalCombos: number;
  currentPhase: string | null;
  fileCount?: number;
  // 11-02-FIX additive props
  currentComboPct?: number; // 0-100 — bar source (audit M2)
  currentComboOverallPct?: number; // 0-100 — informational, not bound to bar
  currentComboEncoder?: string | null;
  currentComboCrf?: number | null;
  currentFilename?: string | null;
  // 13-01c Route-1: parent-owned async cancel handler. Undefined → no cancel button.
  onCancel?: () => void | Promise<void>;
}

export function BenchProgressCard({
  completedCombos,
  totalCombos,
  currentPhase,
  fileCount,
  currentComboPct,
  currentComboEncoder,
  currentComboCrf,
  currentFilename,
  onCancel,
}: BenchProgressCardProps) {
  const t = useTranslations('bench.progress');
  const tCancel = useTranslations('bench.cancel');

  // Bar source — phasePct (current combo, current phase). Audit M2.
  const phasePct = Math.max(0, Math.min(100, currentComboPct ?? 0));

  // Macro run-% for subtext only.
  const runPct = totalCombos > 0 ? Math.round((completedCombos / totalCombos) * 100) : 0;

  // currentFile derivation (preserves pre-FIX behavior).
  let currentFile: number | null = null;
  if (fileCount && fileCount > 1 && totalCombos > 0) {
    const combosPerFile = totalCombos / fileCount;
    currentFile = Math.min(Math.floor(completedCombos / combosPerFile) + 1, fileCount);
  }
  const fileIdx = currentFile ?? 1;
  const fileTotal = fileCount ?? 1;

  // Combo counter — completedCombos+1 = current 1-based when running mid-combo.
  const comboCurrent = Math.min(completedCombos + 1, totalCombos);

  const phaseMap: Record<string, string> = {
    encode: t('phase.encode'),
    vmaf: t('phase.vmaf'),
    'sample-extraction': t('phase.sampleExtraction'),
    pareto: t('phase.pareto'),
  };
  const phaseLabel = currentPhase ? (phaseMap[currentPhase] ?? currentPhase) : null;

  // Encoder line: "libx265 @ CRF 22"
  const encoderLine =
    currentComboEncoder && currentComboCrf !== null && currentComboCrf !== undefined
      ? t('encoderLine', { encoder: currentComboEncoder, crf: currentComboCrf })
      : (currentComboEncoder ?? null);

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {/* Top row: combo title + encoder + phase, big % right */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm font-medium min-w-0">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
          <span className="tabular-nums">
            {t('combo', { current: comboCurrent, total: totalCombos })}
          </span>
          {encoderLine && (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="truncate text-muted-foreground">{encoderLine}</span>
            </>
          )}
          {phaseLabel && (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="text-muted-foreground">{phaseLabel}…</span>
            </>
          )}
        </div>
        <span className="text-xl font-semibold tabular-nums shrink-0">{phasePct}%</span>
      </div>

      {/* Bar — phasePct source, key={currentPhase} snap on phase change (audit M3) */}
      <div
        className="relative h-3 w-full overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-valuenow={phasePct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t('combo', { current: comboCurrent, total: totalCombos })}
      >
        <div
          key={currentPhase ?? 'idle'}
          className="h-full bg-primary motion-safe:transition-all motion-safe:duration-300 motion-safe:ease-out motion-reduce:transition-none"
          style={{ width: `${phasePct}%` }}
        />
      </div>

      {/* Subtext: file Z/M (only when fileCount > 1) + run % */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {fileTotal > 1 && (
          <>
            {currentFilename ? (
              <span className="tabular-nums truncate">
                {t('fileLine', { current: fileIdx, total: fileTotal, filename: currentFilename })}
              </span>
            ) : (
              <span className="tabular-nums">
                {t('fileOf', { current: fileIdx, total: fileTotal })}
              </span>
            )}
            <span aria-hidden="true">·</span>
          </>
        )}
        <span className="tabular-nums">
          {t('runLine', { pct: runPct, completed: completedCombos })}
        </span>
      </div>

      {onCancel && (
        <div className="flex justify-end pt-1">
          <ConfirmButton
            variant="P2"
            undoDelayMs={5000}
            onConfirm={async () => {
              await onCancel();
            }}
            label={tCancel('button')}
            successToastMessage={tCancel('undo.toastBody')}
            className="shrink-0 border-red-500/40 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-950/30"
          >
            <Ban className="size-4" aria-hidden="true" />
          </ConfirmButton>
        </div>
      )}
    </div>
  );
}
