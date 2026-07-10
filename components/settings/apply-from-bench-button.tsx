'use client';

// 12-02: ApplyFromBenchButton — operator-facing UI for "Apply Top-1-Quality
// CRF per encoder from latest completed bench-run". Plug-in to Settings →
// Encoder tab → Per-encoder CRF Card header (right-aligned action slot).
//
// 12-04 V3: extends with operator-selected runId + mode from RunModePicker.
//   - URL: /api/bench/recommendation?runId=<n>&mode=<quality|balanced|size>
//   - AbortController + cancelled-ref dual race-guard (audit M3)
//   - 150ms debounce on (runId, mode) change (audit SR7)
//   - Empty-mode {} response → DISABLED + tooltipNoRecommendationsForMode +
//     once-per-(runId,mode) logger.info('bench_recommendation_empty_mode')
//     (audit M2 + AC-13)
//   - Dynamic label: "Apply from Run #N (Mode)" when operator-changed; collapses
//     to "Apply from bench" when both pickers default + recs non-empty (AC-9)
//   - Audit-log payload (bench_recommendation_applied) carries:
//       selection_source, selectedRunId, resolvedRunId, selectionMode, mode,
//       completedAt, encoders, count, presetCount
//     (12-02 `runId` field REPLACED by `resolvedRunId` — breaking log shape
//     documented in SUMMARY per audit M4)
//
// 5 explicit fetch states (idle-loading / ready / no-data / auth-required /
// fetch-error). Click → form.setValue('crf_<encoder>', recommended.crf,
// { shouldDirty:true }) → existing sticky save-bar takes over persistence.
//
// PURITY: browser-bundle component. NO node:* / db / encode imports. The
// logger import resolves to pino's browser shim transparently (logger.ts:8-15).

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { Path, UseFormReturn } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { RecommendationByEncoder } from '@/src/lib/bench';
import { logger } from '@/src/lib/logger';
import type { FormValues } from '@/src/lib/api/settings-serialize';
import { isValidPreset } from '@/src/lib/encode/presets';

type PickerMode = 'quality' | 'balanced' | 'size';
type SelectionSource = 'default' | 'operator';

type FetchState =
  | { kind: 'idle-loading' }
  | { kind: 'ready'; runId: number; completedAt: number; recommendations: RecommendationByEncoder }
  | { kind: 'no-data' }
  | { kind: 'auth-required' }
  | { kind: 'fetch-error'; status: number | 'network' };

export interface SelectionMeta {
  selectionSource: SelectionSource;
  selectedRunId: number | null;
  selectionMode: SelectionSource;
}

interface Props {
  form: UseFormReturn<FormValues>;
  // 12-04 V3 additive props. All optional for 12-02 back-compat (caller may
  // omit them and the button preserves the latest-complete + quality path).
  runId?: number;
  mode?: 'quality' | 'balanced' | 'size';
  selectionMeta?: SelectionMeta;
}

const ENCODER_FIELD_BY_ID: Record<'libx265' | 'nvenc' | 'qsv' | 'vaapi', Path<FormValues>> = {
  libx265: 'crf_libx265',
  nvenc: 'crf_nvenc',
  qsv: 'crf_qsv',
  vaapi: 'crf_vaapi',
};

// 12-03 V2: per-encoder preset form-field map (mirrors ENCODER_FIELD_BY_ID).
const ENCODER_PRESET_FIELD_BY_ID: Record<
  'libx265' | 'nvenc' | 'qsv' | 'vaapi',
  Path<FormValues>
> = {
  libx265: 'preset_libx265',
  nvenc: 'preset_nvenc',
  qsv: 'preset_qsv',
  vaapi: 'preset_vaapi',
};

// audit SR7: 150ms debounce on rapid picker changes
const DEBOUNCE_MS = 150;

const MODE_LABEL_KEY: Record<PickerMode, string> = {
  quality: 'mode.quality.label',
  balanced: 'mode.balanced.label',
  size: 'mode.size.label',
};

export function ApplyFromBenchButton({ form, runId, mode = 'quality', selectionMeta }: Props) {
  const t = useTranslations('settings.section.crf.applyFromBench');
  const [state, setState] = useState<FetchState>({ kind: 'idle-loading' });
  const [applyInFlight, setApplyInFlight] = useState(false);
  const applyLockRef = useRef(false);
  const lastEmptyEmittedRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    // audit SR7: 150ms debounce — operator rapid-clicking picker yields ONE
    // fetch (the last stable selection) instead of one per click.
    const timer = setTimeout(() => {
      (async () => {
        try {
          const params = new URLSearchParams();
          if (typeof runId === 'number') params.set('runId', String(runId));
          params.set('mode', mode);
          const url = '/api/bench/recommendation?' + params.toString();
          const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
          if (cancelled || controller.signal.aborted) return;
          if (res.status === 200) {
            const body = (await res.json()) as {
              runId: number;
              completedAt: number;
              recommendations?: RecommendationByEncoder;
            };
            if (cancelled || controller.signal.aborted) return;
            setState({
              kind: 'ready',
              runId: body.runId,
              completedAt: body.completedAt,
              recommendations: body.recommendations ?? {},
            });
          } else if (res.status === 404) {
            setState({ kind: 'no-data' });
            try {
              logger.info('bench_recommendation_fetch_no_data');
            } catch {
              /* observability never blocks UX */
            }
          } else if (res.status === 401) {
            setState({ kind: 'auth-required' });
            try {
              logger.warn('bench_recommendation_fetch_unauthorized');
            } catch {
              /* observability never blocks UX */
            }
          } else {
            setState({ kind: 'fetch-error', status: res.status });
            try {
              logger.error({ status: res.status }, 'bench_recommendation_fetch_failed');
            } catch {
              /* observability never blocks UX */
            }
          }
        } catch (err) {
          if (cancelled || controller.signal.aborted) return;
          // AbortError is expected when a new fetch supersedes; suppress.
          if (err instanceof Error && err.name === 'AbortError') return;
          setState({ kind: 'fetch-error', status: 'network' });
          try {
            logger.error({ status: 'network' }, 'bench_recommendation_fetch_failed');
          } catch {
            /* observability never blocks UX */
          }
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, mode]);

  // audit M2 + AC-13: empty-mode detection + once-per-(runId,mode) logger
  const recsCount = state.kind === 'ready' ? Object.keys(state.recommendations).length : -1;
  const isReadyEmpty = state.kind === 'ready' && recsCount === 0;
  const readyRunId = state.kind === 'ready' ? state.runId : null;

  useEffect(() => {
    if (!isReadyEmpty || readyRunId === null) return;
    const key = readyRunId + ':' + mode;
    if (lastEmptyEmittedRef.current === key) return;
    lastEmptyEmittedRef.current = key;
    try {
      logger.info(
        { runId: readyRunId, mode, reason: 'no_combos_with_role' },
        'bench_recommendation_empty_mode',
      );
    } catch {
      /* observability never blocks UX */
    }
  }, [isReadyEmpty, readyRunId, mode]);

  const disabled = state.kind !== 'ready' || applyInFlight || isReadyEmpty;

  function handleClick() {
    if (state.kind !== 'ready') return;
    if (isReadyEmpty) return;
    if (applyLockRef.current) return;
    applyLockRef.current = true;
    setApplyInFlight(true);
    try {
      const appliedEncoders: string[] = [];
      let presetCount = 0;
      for (const [encoderId, fieldName] of Object.entries(ENCODER_FIELD_BY_ID) as Array<
        [keyof typeof ENCODER_FIELD_BY_ID, Path<FormValues>]
      >) {
        const rec = state.recommendations[encoderId];
        if (rec) {
          form.setValue(fieldName, rec.crf as never, {
            shouldDirty: true,
            shouldValidate: true,
          });
          appliedEncoders.push(encoderId);
          // 12-03 V2: also setValue preset_<encoder> when Catalog-valid.
          if (rec.preset != null) {
            if (isValidPreset(encoderId, rec.preset)) {
              form.setValue(ENCODER_PRESET_FIELD_BY_ID[encoderId], rec.preset as never, {
                shouldDirty: true,
                shouldValidate: true,
              });
              presetCount++;
            } else {
              try {
                logger.info(
                  { encoder: encoderId, requested: rec.preset },
                  'bench_recommendation_preset_skipped',
                );
              } catch {
                /* observability never blocks UX */
              }
            }
          }
        }
      }
      // audit M4 — AC-11: emit selection_source + selectedRunId + resolvedRunId
      // + selectionMode + mode. The 12-02 `runId` field is REPLACED by
      // `resolvedRunId` (breaking log shape, footnoted in SUMMARY).
      const selection_source: SelectionSource = selectionMeta?.selectionSource ?? 'default';
      const selectedRunId: number | null = selectionMeta?.selectedRunId ?? null;
      const selectionMode: SelectionSource = selectionMeta?.selectionMode ?? 'default';
      try {
        logger.info(
          {
            selection_source,
            selectedRunId,
            resolvedRunId: state.runId,
            selectionMode,
            mode,
            completedAt: state.completedAt,
            encoders: appliedEncoders,
            count: appliedEncoders.length,
            presetCount,
          },
          'bench_recommendation_applied',
        );
      } catch {
        /* observability never blocks UX */
      }
      toast.success(
        t('success.toast', {
          runId: state.runId,
          crfCount: appliedEncoders.length,
          presetCount,
        }),
      );
    } finally {
      setApplyInFlight(false);
      queueMicrotask(() => {
        applyLockRef.current = false;
      });
    }
  }

  // AC-9: dynamic label. Collapse to base when BOTH defaults held AND recs non-empty.
  function computeLabel(): string {
    if (applyInFlight) return t('loading');
    if (state.kind === 'idle-loading') return t('initialLoading');
    if (isReadyEmpty) return t('label'); // AC-13: collapse to base when empty
    if (state.kind !== 'ready') return t('label');
    const operatorChanged =
      (selectionMeta?.selectedRunId ?? null) !== null ||
      (selectionMeta?.selectionMode ?? 'default') === 'operator';
    if (!operatorChanged) return t('label');
    return t('labelWithRunAndMode', {
      runId: state.runId,
      modeLabel: t(MODE_LABEL_KEY[mode]),
    });
  }

  const buttonLabel = computeLabel();

  const ButtonEl = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-disabled={disabled}
      aria-busy={state.kind === 'idle-loading' || applyInFlight}
      aria-label={t('aria.label')}
      onClick={handleClick}
    >
      {buttonLabel}
    </Button>
  );

  function withTooltip(content: string) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <span tabIndex={0} className="inline-block">
                {ButtonEl}
              </span>
            }
          />
          <TooltipContent>{content}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (isReadyEmpty) return withTooltip(t('tooltipNoRecommendationsForMode'));
  if (state.kind === 'no-data') return withTooltip(t('tooltipNoBench'));
  if (state.kind === 'auth-required') return withTooltip(t('tooltipAuthRequired'));
  if (state.kind === 'fetch-error') return withTooltip(t('tooltipFetchError'));
  if (state.kind === 'idle-loading') return withTooltip(t('tooltipInitialLoading'));

  return ButtonEl;
}
