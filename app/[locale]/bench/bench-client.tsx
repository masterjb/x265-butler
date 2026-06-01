'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Info } from 'lucide-react';
import { useBenchRunState, useBenchPass2Map } from '@/src/lib/api/engine-events-client';
import {
  getBenchRun,
  apiPass2,
  apiCancelPass2,
  apiApply,
  apiApplyRestore,
  cancelBenchRun,
} from '@/src/lib/api/bench-client';
import { showUndoToast } from '@/components/ui/undo-toast';
import { BenchEnqueueForm } from '@/components/bench/bench-enqueue-form';
import { TwoPassStepper, type Pass2State } from '@/components/bench/two-pass-stepper';
import { ParetoScatterChart } from '@/components/bench/pareto-scatter-chart';
import { Top3Cards } from '@/components/bench/top3-cards';
import { pickTop3 } from '@/src/lib/bench/pareto';
import { Pass2ComparisonTable } from '@/components/bench/pass2-comparison-table';
import { BenchProgressCard } from '@/components/bench/bench-progress-card';
import { Pass2ProgressCard } from '@/components/bench/pass2-progress-card';
import { BenchEmptyState } from '@/components/bench/bench-empty-state';
import { BenchHistoryTable } from '@/components/bench/bench-history-table';
import type { TopBalancedSummary } from '@/components/bench/bench-history-table';
import { PageHeader } from '@/components/page-layout';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { BenchRunRow, AggregatedComboView, BenchComboRow } from '@/src/lib/db/schema';
import type { TwoPassStepperProps } from '@/components/bench/two-pass-stepper';
import type { BenchDefaults } from '@/components/bench/bench-defaults';

interface BenchDetail {
  run: BenchRunRow;
  combos: BenchComboRow[];
  summary: AggregatedComboView[];
  // 11-02-FIX-V2 UAT-003: fileSizeMap for Top3Cards projected-full-file-savings.
  // Optional for legacy /api/bench/[runId] responses (pre-FIX-V2 deployed).
  fileSizeMap?: Record<number, number>;
}

export interface BenchClientProps {
  initialRuns: BenchRunRow[];
  defaults: BenchDefaults;
  locale: string;
  historyTotalCount: number;
  topBalancedByRunId: Record<number, TopBalancedSummary | null>;
}

type BenchTab = 'active' | 'history';

function BenchClientInner({
  initialRuns,
  defaults,
  locale,
  historyTotalCount,
  topBalancedByRunId,
}: BenchClientProps) {
  const t = useTranslations('bench');
  const tTabs = useTranslations('bench.tabs');
  const tPass2 = useTranslations('bench.pass2');
  const tApply = useTranslations('bench.apply');
  const tCancel = useTranslations('bench.cancel');
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab: BenchTab = searchParams.get('tab') === 'history' ? 'history' : 'active';
  const [tab, setTab] = useState<BenchTab>(initialTab);

  const handleTabChange = useCallback(
    (next: string) => {
      const nextTab: BenchTab = next === 'history' ? 'history' : 'active';
      setTab(nextTab);
      const sp = new URLSearchParams(searchParams.toString());
      if (nextTab === 'active') {
        sp.delete('tab');
      } else {
        sp.set('tab', nextTab);
      }
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : '?');
    },
    [router, searchParams],
  );
  const benchRun = useBenchRunState();
  const pass2Map = useBenchPass2Map();

  const [runs] = useState<BenchRunRow[]>(initialRuns);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [detail, setDetail] = useState<BenchDetail | null>(null);
  // 13-01b T5: AlertDialog removed. ConfirmButton P1 inside Top3Cards calls
  // handleApplyAsDefaults(comboId) directly (Variant-B fire-immediate flow).
  const loadedRef = useRef(false);

  // Load ?runId=N from URL on mount (one-shot)
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const rawId = searchParams.get('runId');
    if (!rawId) return;
    const parsedId = parseInt(rawId, 10);
    if (isNaN(parsedId)) {
      router.replace('?');
      toast.error(t('errors.runNotFound'));
      return;
    }
    setSelectedRunId(parsedId);
    console.log('[bench-client] mount: loading run from URL', { runId: parsedId });
    getBenchRun(parsedId)
      .then((result) => {
        if (!result) {
          console.warn('[bench-client] mount: getBenchRun returned null', { runId: parsedId });
          setSelectedRunId(null);
          router.replace('?');
          toast.error(t('errors.runNotFound'));
        } else {
          console.log('[bench-client] mount: detail loaded', {
            runId: parsedId,
            summaryLength: (result as BenchDetail).summary.length,
          });
          setDetail(result as BenchDetail);
        }
      })
      .catch((err) => {
        console.error('[bench-client] mount: getBenchRun threw', { runId: parsedId, err });
      });
  }, []); // one-shot on mount — intentional empty deps

  // Fetch authoritative summary when bench run reaches a terminal state via SSE
  useEffect(() => {
    if (benchRun.runId === null) return;
    if (
      benchRun.status === 'complete' ||
      benchRun.status === 'failed' ||
      benchRun.status === 'cancelled'
    ) {
      console.log('[bench-client] terminal status — refetching detail', {
        runId: benchRun.runId,
        status: benchRun.status,
      });
      getBenchRun(benchRun.runId)
        .then((result) => {
          if (result) {
            console.log('[bench-client] terminal detail loaded', {
              runId: benchRun.runId,
              summaryLength: (result as BenchDetail).summary.length,
            });
            setDetail(result as BenchDetail);
          } else {
            console.warn('[bench-client] terminal getBenchRun returned null', {
              runId: benchRun.runId,
            });
          }
        })
        .catch((err) => {
          console.error('[bench-client] terminal getBenchRun threw', {
            runId: benchRun.runId,
            err,
          });
        });
    }
  }, [benchRun.status, benchRun.runId]);

  // 11-03 UAT regression: Pass-2 complete writes pass2_* metrics to DB but
  // the bench-run.status itself doesn't change (Pass-2 is a sibling op,
  // not part of the Pass-1 matrix-sweep lifecycle). Without an explicit
  // refetch, detail.combos stays stale → Pass2ResultPanel can't render
  // verified metrics and Top-3 button doesn't switch to "Apply as defaults".
  // Trigger: SSE pass2_complete OR pass2_failed (failed also writes the
  // attempt record we want surfaced via failure-state UI in a future plan).
  const lastSyncedPass2ComboRef = useRef<number | null>(null);
  useEffect(() => {
    const completed = Object.values(pass2Map).find((p) => p.status === 'complete');
    if (!completed) return;
    if (lastSyncedPass2ComboRef.current === completed.comboId) return;
    lastSyncedPass2ComboRef.current = completed.comboId;

    const activeRunId = benchRun.runId ?? selectedRunId;
    if (activeRunId === null) return;
    getBenchRun(activeRunId)
      .then((result) => {
        if (result) setDetail(result as BenchDetail);
      })
      .catch(() => undefined);
  }, [pass2Map, benchRun.runId, selectedRunId]);

  // Diagnostic: log every state transition that affects render gates
  useEffect(() => {
    console.log('[bench-client] state', {
      status: benchRun.status,
      runId: benchRun.runId,
      completedCombos: benchRun.completedCombos,
      totalCombos: benchRun.totalCombos,
      currentPhase: benchRun.currentPhase,
      errorReason: benchRun.errorReason,
      selectedRunId,
      detailRunId: detail?.run.id ?? null,
      detailStatus: detail?.run.status ?? null,
      summaryLength: detail?.summary.length ?? 0,
    });
  }, [benchRun, selectedRunId, detail]);

  const handleEnqueued = useCallback(
    (runId: number) => {
      setSelectedRunId(runId);
      router.replace(`?runId=${runId}`);
      console.log('[bench-client] handleEnqueued: fetching detail', { runId });
      getBenchRun(runId)
        .then((result) => {
          if (result) {
            console.log('[bench-client] handleEnqueued: detail loaded', {
              runId,
              summaryLength: (result as BenchDetail).summary.length,
            });
            setDetail(result as BenchDetail);
          } else {
            console.warn('[bench-client] handleEnqueued: getBenchRun returned null', { runId });
          }
        })
        .catch((err) => {
          console.error('[bench-client] handleEnqueued: getBenchRun threw', { runId, err });
        });
    },
    [router],
  );

  const isIdle = benchRun.status === 'idle';
  const isRunning = benchRun.status === 'running' || benchRun.status === 'queued';
  const isFailed = benchRun.status === 'failed';
  const isCancelled = benchRun.status === 'cancelled';

  const pass1State: TwoPassStepperProps['pass1State'] =
    benchRun.status === 'queued'
      ? 'queued'
      : benchRun.status === 'running'
        ? 'running'
        : benchRun.status === 'complete'
          ? 'complete'
          : benchRun.status === 'failed'
            ? 'failed'
            : benchRun.status === 'cancelled'
              ? 'cancelled'
              : 'idle';

  const pass1Progress =
    benchRun.totalCombos > 0
      ? { completed: benchRun.completedCombos, total: benchRun.totalCombos }
      : undefined;

  const showStepper = selectedRunId !== null || !isIdle;

  // 11-03 AC-7: run is Pass-2 verifiable when the bench run is in completed state.
  // pass2_completed_at lookups come from the BenchComboRow array in detail.combos.
  const runVerifiable = detail?.run.status === 'complete';
  const verifiedComboIds = new Set(
    (detail?.combos ?? [])
      .filter((c): c is BenchComboRow => c.pass2_completed_at !== null)
      .map((c) => c.id),
  );

  // Pick the "most recent" Pass-2 entry from the SSE map to drive the Stepper.
  // Tie-break: latest comboId (numeric max).
  const latestPass2 = (() => {
    const entries = Object.values(pass2Map);
    if (entries.length === 0) return null;
    return entries.reduce((acc, cur) => (cur.comboId > acc.comboId ? cur : acc));
  })();

  const pass2State: Pass2State = !runVerifiable
    ? 'disabled'
    : latestPass2?.status === 'running'
      ? 'running'
      : latestPass2?.status === 'complete'
        ? 'complete'
        : latestPass2?.status === 'failed'
          ? 'failed'
          : latestPass2?.status === 'cancelled'
            ? 'cancelled'
            : 'idle';

  const handleUseThis = useCallback(
    async (comboId: number) => {
      const activeRunId = benchRun.runId ?? selectedRunId;
      if (activeRunId === null) return;
      const result = await apiPass2(activeRunId, comboId);
      if ('error' in result) {
        toast.error(tPass2(result.error === 'pass2_busy' ? 'failed' : 'failed'));
      }
    },
    [benchRun.runId, selectedRunId, tPass2],
  );

  const handlePass2Cancel = useCallback(async () => {
    const activeRunId = benchRun.runId ?? selectedRunId;
    if (activeRunId === null || !latestPass2) return;
    await apiCancelPass2(activeRunId, latestPass2.comboId);
  }, [benchRun.runId, selectedRunId, latestPass2]);

  // 13-01c Route-1 scope-extend: bench-run cancel for BenchProgressCard inline action.
  // Mirrors run-detail-client onConfirm semantics — try/catch covers fetch-throw (audit M5).
  const handleBenchCancel = useCallback(async () => {
    const activeRunId = benchRun.runId;
    if (activeRunId === null) return;
    try {
      const result = await cancelBenchRun(activeRunId);
      if ('cancelled' in result) {
        toast.success(tCancel('toast.success'));
        router.refresh();
      } else {
        toast.error(tCancel('toast.error'));
      }
    } catch {
      toast.error(tCancel('toast.error'));
    }
  }, [benchRun.runId, tCancel, router]);

  const handlePass2Retry = useCallback(async () => {
    const activeRunId = benchRun.runId ?? selectedRunId;
    if (activeRunId === null || !latestPass2) return;
    await apiPass2(activeRunId, latestPass2.comboId);
  }, [benchRun.runId, selectedRunId, latestPass2]);

  // Build the per-combo BenchComboRow lookup.
  const comboById = new Map<number, BenchComboRow>((detail?.combos ?? []).map((c) => [c.id, c]));

  // 13-01b T5 (audit M1+M3 Variant-B fire-immediate + compensating Undo):
  // ConfirmButton P1 inside Top3Cards fires this directly per-combo. The Undo
  // path POSTs the same route in restore-mode with the priorValues snapshot.
  const handleApplyAsDefaults = useCallback(
    async (comboId: number): Promise<void> => {
      const activeRunId = benchRun.runId ?? selectedRunId;
      if (activeRunId === null) return;
      const result = await apiApply(activeRunId, comboId);
      if ('error' in result) {
        if (result.error === 'not_verified' || result.error === 'invalid_body') {
          toast.error(tApply('errorValidation'));
        } else if (result.error === 'auth_required') {
          toast.error(tApply('errorUnauthorized'));
        } else {
          toast.error(tApply('errorNetwork'));
        }
        return;
      }
      // M8 idempotent fast-path — suppress UndoToast; plain "no change" toast.
      if (result.idempotent) {
        toast.success(tApply('noChange'));
        return;
      }
      showUndoToast({
        message: tApply('undoToast', {
          encoder: result.defaultEncoder,
          crf: result.crf,
          preset: result.preset ?? '—',
        }),
        durationMs: 10_000,
        onUndo: async () => {
          const restore = await apiApplyRestore(activeRunId, result.priorValues);
          if ('error' in restore) {
            // SR12: explicit "manual revert needed" copy.
            toast.error(tApply('undo.error'));
            return;
          }
          toast.success(tApply('undo.success'));
          router.refresh();
        },
      });
      router.refresh();
    },
    [benchRun.runId, selectedRunId, router, tApply],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('page.title')}
        subhead={t('page.subhead')}
        actions={
          <Dialog>
            <DialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('page.infoButton')}
                  className="text-muted-foreground hover:text-foreground"
                />
              }
            >
              <Info className="size-4" aria-hidden="true" />
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>{t('page.info.title')}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 text-sm text-muted-foreground">
                <section>
                  <h3 className="mb-1 font-medium text-foreground">
                    {t('page.info.what.heading')}
                  </h3>
                  <p>{t('page.info.what.body')}</p>
                </section>
                <section>
                  <h3 className="mb-1 font-medium text-foreground">
                    {t('page.info.modes.heading')}
                  </h3>
                  <ul className="space-y-1 pl-4 list-disc">
                    <li>{t('page.info.modes.native')}</li>
                    <li>{t('page.info.modes.vmaf')}</li>
                  </ul>
                </section>
                <section>
                  <h3 className="mb-1 font-medium text-foreground">
                    {t('page.info.pareto.heading')}
                  </h3>
                  <p>{t('page.info.pareto.body')}</p>
                </section>
                <section>
                  <h3 className="mb-1 font-medium text-foreground">
                    {t('page.info.top3.heading')}
                  </h3>
                  <ul className="space-y-1 pl-4 list-disc">
                    <li>{t('page.info.top3.size')}</li>
                    <li>{t('page.info.top3.balanced')}</li>
                    <li>{t('page.info.top3.quality')}</li>
                  </ul>
                </section>
                <section>
                  <h3 className="mb-1 font-medium text-foreground">
                    {t('page.info.samples.heading')}
                  </h3>
                  <p>{t('page.info.samples.body')}</p>
                </section>
                <section>
                  <h3 className="mb-1 font-medium text-foreground">
                    {t('page.info.passes.heading')}
                  </h3>
                  <p>{t('page.info.passes.body')}</p>
                </section>
              </div>
            </DialogContent>
          </Dialog>
        }
      />

      <Tabs value={tab} onValueChange={(v) => handleTabChange(String(v))}>
        <TabsList>
          <TabsTrigger value="active">{tTabs('active')}</TabsTrigger>
          <TabsTrigger value="history">
            {tTabs('history')} ({historyTotalCount})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="active" className="space-y-6">
          {runs.length === 0 && isIdle ? (
            <BenchEmptyState
              onStartBenchmark={() => {
                /* focus form — handled in BenchEnqueueForm via ref */
              }}
            />
          ) : null}

          <BenchEnqueueForm defaults={defaults} onEnqueued={handleEnqueued} />

          {showStepper && (
            <TwoPassStepper
              pass1State={pass1State}
              pass1Progress={pass1Progress}
              pass1ErrorReason={benchRun.errorReason ?? undefined}
              pass2State={pass2State}
              pass2VerifiedVmaf={latestPass2?.vmaf ?? undefined}
              pass2ErrorReason={latestPass2?.errorReason ?? undefined}
              onPass2Retry={
                pass2State === 'failed' || pass2State === 'cancelled' ? handlePass2Retry : undefined
              }
            />
          )}

          {(isFailed || isCancelled) && (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm"
            >
              <p className="font-semibold text-destructive">
                {isFailed ? t('terminal.failed.title') : t('terminal.cancelled.title')}
              </p>
              {isFailed && benchRun.errorReason && (
                <p className="mt-1 text-destructive">{benchRun.errorReason}</p>
              )}
            </div>
          )}

          {isRunning && (
            <BenchProgressCard
              completedCombos={benchRun.completedCombos}
              totalCombos={benchRun.totalCombos}
              currentPhase={benchRun.currentPhase}
              fileCount={detail?.run.fileIds.length}
              currentComboPct={benchRun.currentComboPct}
              currentComboOverallPct={benchRun.currentComboOverallPct}
              onCancel={benchRun.runId !== null ? handleBenchCancel : undefined}
            />
          )}

          {pass2State === 'running' && (
            <Pass2ProgressCard
              overallPct={latestPass2?.overallPct ?? 0}
              combo={latestPass2 ? comboById.get(latestPass2.comboId) : undefined}
              onCancel={handlePass2Cancel}
            />
          )}

          {(() => {
            const activeRunId = selectedRunId ?? benchRun.runId;
            if (activeRunId === null || !detail || detail.run.id !== activeRunId) return null;
            const sourceFileId = detail.run.fileIds[0];
            const sourceFullFileSize =
              sourceFileId !== undefined ? (detail.fileSizeMap?.[sourceFileId] ?? 0) : 0;
            return (
              <>
                <ParetoScatterChart
                  runId={activeRunId}
                  summary={detail.summary}
                  isRunning={isRunning}
                />
                <Top3Cards
                  summary={detail.summary}
                  mode={detail.run.mode}
                  fileIds={detail.run.fileIds}
                  fileSizeMap={detail.fileSizeMap ?? {}}
                  runVerifiable={runVerifiable}
                  isPass2Verified={(cid) => verifiedComboIds.has(cid)}
                  isPass2Running={(cid) => pass2Map[cid]?.status === 'running'}
                  onUseThis={handleUseThis}
                  onApplyAsDefaults={handleApplyAsDefaults}
                />
                {runVerifiable &&
                  verifiedComboIds.size > 0 &&
                  (() => {
                    const paretoFront = detail.summary
                      .filter((c) => c.is_pareto)
                      .sort((a, b) => a.sizeBytes - b.sizeBytes);
                    const top3 = pickTop3(paretoFront);
                    const combosByRole = {
                      size:
                        top3?.size?.sampleIds[0] !== undefined
                          ? comboById.get(top3.size.sampleIds[0])
                          : undefined,
                      balanced:
                        top3?.balanced?.sampleIds[0] !== undefined
                          ? comboById.get(top3.balanced.sampleIds[0])
                          : undefined,
                      quality:
                        top3?.quality?.sampleIds[0] !== undefined
                          ? comboById.get(top3.quality.sampleIds[0])
                          : undefined,
                    };
                    return (
                      <Pass2ComparisonTable
                        combosByRole={combosByRole}
                        sourceFullFileBytes={sourceFullFileSize}
                      />
                    );
                  })()}
              </>
            );
          })()}
        </TabsContent>
        <TabsContent value="history">
          <BenchHistoryTable
            initialRuns={runs}
            topBalancedByRunId={topBalancedByRunId}
            totalCount={historyTotalCount}
            locale={locale}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function BenchClient(props: BenchClientProps) {
  return (
    <Suspense fallback={null}>
      <BenchClientInner {...props} />
    </Suspense>
  );
}
