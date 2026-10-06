'use client';

// RunModePicker — operator chooses (a) source bench_run and (b) tradeoff
// mode (quality|balanced|size) for the recommendation that ApplyFromBenchButton
// applies. Sits left of ApplyButton in the per-encoder CRF Card header.
//
// Design choices:
//   picker primitive  = shadcn <Select>           (no Combobox)
//   mode-toggle       = <RadioGroup>              (semantic radio, WCAG 1.4.1)
//   mobile stack      = RunPicker → ModeToggle → ApplyButton (decision-flow order)
//   default indicator = (latest) hint + "default" caption
//
// Server-side ?status=complete filter (NOT client-side) — relies on the
// /api/bench listRecent(limit, offset, status?) overload.
// Once the run-list resolves, picker emits onChange with the
// default head row (selectedRunId, source='default') so ApplyFromBenchButton
// can re-fetch with EXPLICIT ?runId= (closes implicit-default race).
//
// Purity: browser-bundle. NO node:* / db / encode imports.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { logger } from '@/src/lib/logger';

export type PickerMode = 'quality' | 'balanced' | 'size';
export type PickerSelectionSource = 'default' | 'operator';

export interface PickerChange {
  selectedRunId: number | null;
  mode: PickerMode;
  selectionSource: PickerSelectionSource;
  selectionMode: PickerSelectionSource;
}

interface CompletedRunSummary {
  id: number;
  completed_at: number | null;
  created_at: number;
  encoderCount: number;
}

interface ListRow {
  id: number;
  status: string;
  matrix?: { encoders?: string[] } | null;
  completed_at: number | null;
  created_at: number;
}

interface FetchState {
  kind: 'idle' | 'loaded' | 'empty' | 'error';
  rows: CompletedRunSummary[];
}

const LIST_LIMIT = 10;

function relativeTime(unixSec: number, nowMs: number): string {
  const deltaSec = Math.max(1, Math.floor(nowMs / 1000) - unixSec);
  if (deltaSec < 60) return `${deltaSec}s`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)}h`;
  return `${Math.floor(deltaSec / 86_400)}d`;
}

interface Props {
  // Controlled values lifted up to SettingsForm.
  selectedRunId: number | null;
  mode: PickerMode;
  selectionSource: PickerSelectionSource;
  selectionMode: PickerSelectionSource;
  onChange: (next: PickerChange) => void;
  // Optional trailing control (the CrfCard passes its ApplyFromBench
  // button), rendered last and right-aligned. Omitted → nothing is rendered.
  action?: ReactNode;
}

export function RunModePicker({
  selectedRunId,
  mode,
  selectionSource,
  selectionMode,
  onChange,
  action,
}: Props) {
  const t = useTranslations('settings.section.crf.applyFromBench');
  const [state, setState] = useState<FetchState>({ kind: 'idle', rows: [] });
  const emittedDefaultRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        // Server-side ?status=complete filter (NOT client-side).
        const res = await fetch('/api/bench?status=complete&limit=' + LIST_LIMIT + '&offset=0', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setState({ kind: 'error', rows: [] });
          return;
        }
        const body = (await res.json()) as { runs?: ListRow[] };
        const rows = (body.runs ?? []).map((r) => ({
          id: r.id,
          completed_at: r.completed_at,
          created_at: r.created_at,
          encoderCount: Array.isArray(r.matrix?.encoders) ? r.matrix.encoders.length : 0,
        }));
        if (rows.length === 0) {
          setState({ kind: 'empty', rows: [] });
          return;
        }
        setState({ kind: 'loaded', rows });

        // Emit explicit default-resolve so ApplyFromBenchButton re-fetches with ?runId=
        if (!emittedDefaultRef.current && selectedRunId === null) {
          emittedDefaultRef.current = true;
          onChange({
            selectedRunId: rows[0].id,
            mode,
            selectionSource: 'default',
            selectionMode,
          });
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        try {
          logger.warn({ err: String(err) }, 'run_mode_picker_fetch_failed');
        } catch {
          /* observability never blocks UX */
        }
        setState({ kind: 'error', rows: [] });
      }
    })();
    return () => {
      controller.abort();
    };
    // mode/onChange/selectedRunId/selectionMode intentionally NOT deps:
    // emit-default-once guarded by ref; remount triggers re-fetch (desired).
  }, []);

  const isEmpty = state.kind === 'empty';
  const isError = state.kind === 'error';
  const isIdle = state.kind === 'idle';
  const disabledSelect = isEmpty || isIdle || isError;
  const nowMs = Date.now();
  const headId = state.rows[0]?.id ?? null;
  const effectiveSelectedId = selectedRunId ?? headId ?? null;

  function handleRunChange(value: string | null) {
    if (value === null) return;
    const next = Number(value);
    if (!Number.isInteger(next) || next <= 0) return;
    onChange({
      selectedRunId: next,
      mode,
      selectionSource: 'operator',
      selectionMode,
    });
  }

  function handleModeChange(value: unknown) {
    if (value !== 'quality' && value !== 'balanced' && value !== 'size') return;
    onChange({
      selectedRunId,
      mode: value,
      selectionSource,
      selectionMode: 'operator',
    });
  }

  const modeOptions: ReadonlyArray<PickerMode> = ['quality', 'balanced', 'size'];

  return (
    // Three plain rows, run select, mode, hint, then the optional action
    // bottom-right. A one-row grid does not work: the `auto` mode track shrank to min-content inside the card and
    // the flex-wrap segments broke into 2 + 1. The segments are therefore a fixed
    // 3-column grid, equal width, never wrapping.
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="run-mode-picker-run" className="text-sm font-medium text-foreground">
          {t('runPicker.label')}
        </label>
        <Select
          value={effectiveSelectedId !== null ? String(effectiveSelectedId) : ''}
          onValueChange={handleRunChange}
          disabled={disabledSelect}
        >
          <SelectTrigger
            id="run-mode-picker-run"
            aria-label={t('runPicker.label')}
            className="h-11 w-full lg:h-9 text-base lg:text-sm"
          >
            <SelectValue
              placeholder={
                isIdle
                  ? t('runPicker.loading')
                  : isEmpty
                    ? t('runPicker.empty')
                    : isError
                      ? t('runPicker.error')
                      : undefined
              }
            />
          </SelectTrigger>
          <SelectContent>
            {state.rows.map((row, idx) => (
              <SelectItem key={row.id} value={String(row.id)}>
                {t('runPicker.optionPattern', {
                  runId: row.id,
                  relativeTime: relativeTime(row.completed_at ?? row.created_at, nowMs),
                  encoders: row.encoderCount,
                })}
                {idx === 0 ? ` ${t('runPicker.defaultHint')}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isEmpty && <p className="text-xs text-muted-foreground">{t('runPicker.empty')}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <span id="run-mode-picker-mode-label" className="text-sm font-medium text-foreground">
          {t('mode.label')}
        </span>
        <RadioGroup
          aria-labelledby="run-mode-picker-mode-label"
          value={mode}
          onValueChange={handleModeChange}
          className="grid grid-cols-3 gap-2"
        >
          {modeOptions.map((opt) => {
            const labelId = `run-mode-picker-mode-${opt}-label`;
            const descId = `run-mode-picker-mode-${opt}-desc`;
            const isDefault = opt === 'quality' && selectionMode === 'default';
            return (
              <label
                key={opt}
                htmlFor={`run-mode-picker-mode-${opt}`}
                className="flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-md border border-input px-3 py-2 text-center text-sm font-medium cursor-pointer hover:bg-accent/40 has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary/5 transition-colors lg:min-h-9"
              >
                <RadioGroupItem
                  id={`run-mode-picker-mode-${opt}`}
                  value={opt}
                  aria-labelledby={labelId}
                  aria-describedby={descId}
                />
                <span id={labelId} className="leading-tight">
                  {t(`mode.${opt}.label`)}
                  {isDefault ? (
                    <span className="ml-1 text-xs text-muted-foreground font-normal">
                      {t('mode.defaultHint')}
                    </span>
                  ) : null}
                </span>
                {/* SR-only description for aria-describedby; visible copy
                    surfaced as dynamic helper-text below the row. */}
                <span id={descId} className="sr-only">
                  {t(`mode.${opt}.description`)}
                </span>
              </label>
            );
          })}
        </RadioGroup>
        <p className="text-xs text-muted-foreground leading-relaxed" aria-live="polite">
          {t(`mode.${mode}.description`)}
        </p>
      </div>
      {action ? <div className="flex justify-end">{action}</div> : null}
    </div>
  );
}
