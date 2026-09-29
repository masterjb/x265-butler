'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Ban, Copy } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { PageHeader } from '@/components/page-layout';
import { ParetoScatterChart } from '@/components/bench/pareto-scatter-chart';
import { Top3Cards } from '@/components/bench/top3-cards';
import { Pass2ComparisonTable } from '@/components/bench/pass2-comparison-table';
import { Pass2ProgressCard } from '@/components/bench/pass2-progress-card';
import { useBenchRunState, useBenchPass2Map } from '@/src/lib/api/engine-events-client';
import { apiPass2, cancelBenchRun } from '@/src/lib/api/bench-client';
import { pickTop3 } from '@/src/lib/bench/pareto';
import { formatRelativeTime } from '@/src/lib/format';
import type { BenchRunRow, BenchComboRow, AggregatedComboView } from '@/src/lib/db/schema';

export interface RunDetailClientProps {
  run: BenchRunRow | null;
  combos: BenchComboRow[];
  summary: AggregatedComboView[];
  fileSizeMap: Record<number, number>;
  hasPass2: boolean;
  locale: string;
}

export function RunDetailClient({
  run,
  combos,
  summary,
  fileSizeMap,
  hasPass2,
  locale,
}: RunDetailClientProps) {
  const t = useTranslations('bench.runDetail');
  const tApply = useTranslations('bench.apply');
  const tCancel = useTranslations('bench.cancel');
  const router = useRouter();
  const benchRun = useBenchRunState();
  const pass2Map = useBenchPass2Map();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState(false);
  // audit M2: distinct from Pass-2 `pending` lock. Arm at click-time, reset in onConfirm.finally + onUndo.
  const [cancelArmed, setCancelArmed] = useState(false);

  const backHref = `/${locale}/bench?tab=history`;

  const balancedCombo = useMemo(() => {
    const front = summary.filter((c) => c.is_pareto).sort((a, b) => a.sizeBytes - b.sizeBytes);
    const top3 = pickTop3(front);
    if (!top3) return null;
    const id = top3.balanced.sampleIds[0];
    return id !== undefined ? (combos.find((c) => c.id === id) ?? null) : null;
  }, [summary, combos]);

  const handleCopyLink = useCallback(() => {
    if (typeof window === 'undefined') return;
    void navigator.clipboard.writeText(window.location.href).then(() => {
      toast.success(t('copied'));
    });
  }, [t]);

  const handlePass2Click = useCallback(() => {
    if (pending) return;
    setDialogOpen(true);
  }, [pending]);

  const handlePass2Confirm = useCallback(async () => {
    if (run === null || balancedCombo === null) return;
    setPending(true);
    setDialogOpen(false);
    const result = await apiPass2(run.id, balancedCombo.id);
    if ('error' in result) {
      toast.error(result.error);
      setPending(false);
    }
  }, [run, balancedCombo]);

  if (run === null) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('notFound')} />
        <Link href={backHref} className="text-primary hover:underline">
          {t('backToHistory')}
        </Link>
      </div>
    );
  }

  const globalBusy =
    (benchRun.status === 'running' || benchRun.status === 'queued') && benchRun.runId !== run.id;

  const pass2ForThisRun = Object.values(pass2Map).find((p) =>
    combos.some((c) => c.id === p.comboId),
  );
  const pass2Running = pass2ForThisRun?.status === 'running';

  const canShowPass2Cta = run.status === 'complete' && !hasPass2 && balancedCombo !== null;
  // 13-01c spec deviation: plan AC-1 wrote `'queued'` but BenchRunStatus union is
  // `'pending' | 'running' | 'complete' | 'failed' | 'cancelled'` — `'pending'` is the
  // schema name for "newly-created, awaiting orchestrator pickup" (== queued semantically).
  const canCancelRun = run.status === 'running' || run.status === 'pending';

  const sourceFileId = run.fileIds[0];
  const sourceFullFileSize = sourceFileId !== undefined ? (fileSizeMap[sourceFileId] ?? 0) : 0;

  const verifiedComboIds = new Set(
    combos.filter((c) => c.pass2_completed_at !== null).map((c) => c.id),
  );

  const top3Combos = (() => {
    const front = summary.filter((c) => c.is_pareto).sort((a, b) => a.sizeBytes - b.sizeBytes);
    const top3 = pickTop3(front);
    if (!top3) return null;
    return {
      size:
        top3.size.sampleIds[0] !== undefined
          ? combos.find((c) => c.id === top3.size.sampleIds[0])
          : undefined,
      balanced:
        top3.balanced.sampleIds[0] !== undefined
          ? combos.find((c) => c.id === top3.balanced.sampleIds[0])
          : undefined,
      quality:
        top3.quality.sampleIds[0] !== undefined
          ? combos.find((c) => c.id === top3.quality.sampleIds[0])
          : undefined,
    };
  })();

  const ctaDisabled = globalBusy || pending || pass2Running;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Run #${run.id}`}
        subhead={`${formatRelativeTime(run.created_at, Date.now() / 1000)} · ${run.status}`}
        actions={
          <>
            <Link href={backHref} className="text-sm text-muted-foreground hover:text-foreground">
              {t('backToHistory')}
            </Link>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyLink}
              data-testid="run-detail-copy-link"
            >
              <Copy className="size-4 mr-1" aria-hidden="true" />
              {t('copyLink')}
            </Button>
            {canCancelRun && (
              <span
                onClickCapture={(e) => {
                  if ((e.target as HTMLElement).closest('button')) setCancelArmed(true);
                }}
              >
                <ConfirmButton
                  variant="P2"
                  undoDelayMs={5000}
                  disabled={cancelArmed}
                  onUndo={() => setCancelArmed(false)}
                  onConfirm={async () => {
                    try {
                      const result = await cancelBenchRun(run.id);
                      if ('cancelled' in result) {
                        toast.success(tCancel('toast.success'));
                        router.refresh();
                      } else {
                        toast.error(tCancel('toast.error'));
                      }
                    } catch {
                      toast.error(tCancel('toast.error'));
                    } finally {
                      setCancelArmed(false);
                    }
                  }}
                  label={tCancel('button')}
                  successToastMessage={tCancel('undo.toastBody')}
                  className="shrink-0 border-red-500/40 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-500/30 dark:text-red-300 dark:hover:bg-red-950/30"
                >
                  <Ban className="size-4" aria-hidden="true" />
                </ConfirmButton>
              </span>
            )}
            {canShowPass2Cta && (
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={ctaDisabled}
                onClick={handlePass2Click}
                data-testid="run-detail-pass2-cta"
                title={globalBusy ? t('runPass2Disabled') : undefined}
              >
                {t('runPass2Cta')}
              </Button>
            )}
          </>
        }
      />

      {pass2Running && pass2ForThisRun && (
        <Pass2ProgressCard
          overallPct={pass2ForThisRun.overallPct ?? 0}
          combo={combos.find((c) => c.id === pass2ForThisRun.comboId)}
          onCancel={() => undefined}
        />
      )}

      <ParetoScatterChart runId={run.id} summary={summary} isRunning={false} />

      <Top3Cards
        summary={summary}
        mode={run.mode}
        fileIds={run.fileIds}
        fileSizeMap={fileSizeMap}
        runVerifiable={run.status === 'complete'}
        isPass2Verified={(cid) => verifiedComboIds.has(cid)}
        isPass2Running={(cid) => pass2Map[cid]?.status === 'running'}
        onUseThis={() => undefined}
        onApplyAsDefaults={() => undefined}
      />

      {hasPass2 && top3Combos && (
        <Pass2ComparisonTable combosByRole={top3Combos} sourceFullFileBytes={sourceFullFileSize} />
      )}

      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('runPass2Cta')}</AlertDialogTitle>
            <AlertDialogDescription>
              {balancedCombo
                ? `${balancedCombo.encoder}/${balancedCombo.preset ?? '—'} @ ${balancedCombo.native_quality_value}`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={pending}
            >
              {tApply('cancelCta')}
            </Button>
            <Button
              type="button"
              onClick={handlePass2Confirm}
              disabled={pending}
              data-testid="run-detail-pass2-confirm"
            >
              {t('runPass2Cta')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
