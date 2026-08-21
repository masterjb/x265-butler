'use client';

import { useEffect, useMemo, useReducer, useRef } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { z } from 'zod/v4';
import { enqueueBenchRun } from '@/src/lib/api/bench-client';
import { useBenchRunState } from '@/src/lib/api/engine-events-client';
import type { BenchMode, BenchMatrix } from '@/src/lib/db/schema';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionHint } from '@/components/stats/charts/section-hint';
import { ENCODERS, PRESET_GROUPS } from '@/components/bench/bench-constants';
import type { BenchDefaults } from '@/components/bench/bench-defaults';

const SUMMARY_VALUES_MAX_LEN = 32;

const fileIdsSchema = z
  .string()
  .transform((s) => s.split(',').map((v) => parseInt(v.trim(), 10)))
  .pipe(z.array(z.number().int().positive()).min(1).max(50));

interface FormState {
  mode: BenchMode;
  fileIdsText: string;
  encoders: string[];
  presets: string[];
  valuesText: string;
  sampleCount: string;
  sampleDurationSec: string;
  vmafModel: string;
  error: string | null;
  submitting: boolean;
}

type FormAction =
  | { type: 'SET_MODE'; value: BenchMode }
  | {
      type: 'SET_FIELD';
      field: keyof Omit<FormState, 'mode' | 'encoders' | 'presets' | 'error' | 'submitting'>;
      value: string;
    }
  | { type: 'TOGGLE_ENCODER'; encoder: string }
  | { type: 'TOGGLE_PRESET'; preset: string }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_SUBMITTING'; value: boolean }
  | { type: 'RESET' }
  | { type: 'RESET_TO_DEFAULTS'; defaults: BenchDefaults };

function initState(defaults: BenchDefaults): FormState {
  return {
    mode: defaults.mode,
    fileIdsText: '',
    encoders: defaults.encoders.slice(),
    presets: defaults.presets.slice(),
    valuesText: defaults.mode === 'native-sweep' ? defaults.nativeValues : defaults.vmafBuckets,
    sampleCount: String(defaults.sampleCount),
    sampleDurationSec: String(defaults.sampleDurationSec),
    vmafModel: defaults.vmafModel,
    error: null,
    submitting: false,
  };
}

function reducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SET_MODE':
      return { ...state, mode: action.value };
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value };
    case 'TOGGLE_ENCODER': {
      const has = state.encoders.includes(action.encoder);
      const next = has
        ? state.encoders.filter((e) => e !== action.encoder)
        : [...state.encoders, action.encoder];
      return { ...state, encoders: next, error: null };
    }
    case 'TOGGLE_PRESET': {
      const has = state.presets.includes(action.preset);
      const next = has
        ? state.presets.filter((p) => p !== action.preset)
        : [...state.presets, action.preset];
      return { ...state, presets: next, error: null };
    }
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'SET_SUBMITTING':
      return { ...state, submitting: action.value };
    case 'RESET':
      return { ...state, fileIdsText: '', error: null, submitting: false };
    case 'RESET_TO_DEFAULTS':
      return {
        ...initState(action.defaults),
        fileIdsText: state.fileIdsText,
      };
    default:
      return state;
  }
}

function truncateValues(values: string): string {
  if (values.length > SUMMARY_VALUES_MAX_LEN) {
    return values.slice(0, SUMMARY_VALUES_MAX_LEN - 1) + '…';
  }
  return values;
}

interface Props {
  defaults: BenchDefaults;
  filePickerRef?: React.RefObject<HTMLInputElement | null>;
  onEnqueued?: (runId: number) => void;
}

export function BenchEnqueueForm({ defaults, filePickerRef, onEnqueued }: Props) {
  const t = useTranslations('bench.form');
  const locale = useLocale();
  const [state, dispatch] = useReducer(reducer, defaults, initState);
  const benchRun = useBenchRunState();
  const isRunActive = benchRun.status === 'queued' || benchRun.status === 'running';

  const localFilePickerRef = useRef<HTMLInputElement>(null);
  const resolvedRef = (filePickerRef as React.RefObject<HTMLInputElement>) ?? localFilePickerRef;
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const encodersFirstRef = useRef<HTMLInputElement | null>(null);
  const presetsFirstRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    dispatch({ type: 'RESET' });
  }, []);

  const isDisabled = isRunActive || state.submitting;

  const stateEqualsDefaults = useMemo(() => {
    const defaultsValuesSource =
      defaults.mode === 'native-sweep' ? defaults.nativeValues : defaults.vmafBuckets;
    return (
      state.mode === defaults.mode &&
      state.encoders.length === defaults.encoders.length &&
      state.encoders.every((e) => defaults.encoders.includes(e)) &&
      state.presets.length === defaults.presets.length &&
      state.presets.every((p) => defaults.presets.includes(p)) &&
      state.valuesText === defaultsValuesSource &&
      state.sampleCount === String(defaults.sampleCount) &&
      state.sampleDurationSec === String(defaults.sampleDurationSec) &&
      state.vmafModel === defaults.vmafModel
    );
  }, [state, defaults]);

  const summaryText = useMemo(() => {
    const modeKey = state.mode === 'native-sweep' ? 'native' : 'vmaf';
    return t(`disclosure.summary.${modeKey}`, {
      encCount: state.encoders.length,
      presetCount: state.presets.length,
      values: truncateValues(state.valuesText),
    });
  }, [state.mode, state.encoders.length, state.presets.length, state.valuesText, t]);

  function buildMatrix(): BenchMatrix {
    const presets = state.presets;
    if (state.mode === 'native-sweep') {
      const nativeValues = state.valuesText
        .split(',')
        .map((v) => parseInt(v.trim(), 10))
        .filter((n) => !isNaN(n));
      return { encoders: state.encoders, presets, nativeValues };
    } else {
      const vmafTargets = state.valuesText
        .split(',')
        .map((v) => parseFloat(v.trim()))
        .filter((n) => !isNaN(n));
      return { encoders: state.encoders, presets, vmafTargets };
    }
  }

  function validate(): string | null {
    const parsedIds = fileIdsSchema.safeParse(state.fileIdsText);
    if (!parsedIds.success) return t('errors.outOfRange');
    if (state.encoders.length === 0) return t('errors.encoderRequired');
    if (state.presets.length === 0) return t('errors.presetRequired');
    return null;
  }

  function handleReset() {
    if (isDisabled || stateEqualsDefaults) return;
    dispatch({ type: 'RESET_TO_DEFAULTS', defaults });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      const needsExpand = state.encoders.length === 0 || state.presets.length === 0;
      if (needsExpand && detailsRef.current && !detailsRef.current.open) {
        detailsRef.current.open = true;
      }
      const target: HTMLInputElement | null =
        state.encoders.length === 0
          ? encodersFirstRef.current
          : state.presets.length === 0
            ? presetsFirstRef.current
            : null;
      if (target) {
        const reduceMotion =
          typeof window !== 'undefined' &&
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({
          block: 'center',
          behavior: reduceMotion ? 'auto' : 'smooth',
        });
        target.focus();
      }
      dispatch({ type: 'SET_ERROR', error: validationError });
      return;
    }
    const parsedIds = fileIdsSchema.safeParse(state.fileIdsText);
    if (!parsedIds.success) return;

    dispatch({ type: 'SET_SUBMITTING', value: true });
    dispatch({ type: 'SET_ERROR', error: null });

    try {
      const result = await enqueueBenchRun({
        mode: state.mode,
        fileIds: parsedIds.data,
        matrix: buildMatrix(),
        sampleCount: parseInt(state.sampleCount, 10) || undefined,
        sampleDurationSeconds: parseInt(state.sampleDurationSec, 10) || undefined,
        vmafModel: state.vmafModel || undefined,
      });

      if ('error' in result) {
        dispatch({ type: 'SET_ERROR', error: result.error });
        dispatch({ type: 'SET_SUBMITTING', value: false });
      } else {
        dispatch({ type: 'RESET' });
        onEnqueued?.(result.runId);
      }
    } catch {
      dispatch({ type: 'SET_ERROR', error: t('errors.submitFailed') });
      dispatch({ type: 'SET_SUBMITTING', value: false });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-label="bench-enqueue-form">
      {/* File IDs — Primary path (top, always visible) */}
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <label htmlFor="bench-file-ids" className="text-sm font-medium">
            {t('files.label')}
          </label>
          <SectionHint content={t('files.hint')} />
        </div>
        <Input
          id="bench-file-ids"
          ref={resolvedRef}
          value={state.fileIdsText}
          onChange={(e) =>
            dispatch({ type: 'SET_FIELD', field: 'fileIdsText', value: e.target.value })
          }
          placeholder={t('files.placeholder')}
          disabled={isDisabled}
          aria-describedby="bench-file-ids-help"
        />
        <p id="bench-file-ids-help" className="text-xs text-muted-foreground">
          {t('files.help')}
        </p>
      </div>

      {/* Disclosure — Defaults review/override */}
      <details ref={detailsRef} className="rounded-md border border-border bg-muted/30 px-3 py-2">
        <summary
          aria-disabled={isDisabled}
          className={`cursor-pointer select-none text-sm font-medium py-1 ${
            isDisabled ? 'cursor-not-allowed opacity-60' : ''
          }`}
          onClick={(e) => {
            if (isDisabled) {
              e.preventDefault();
            }
          }}
        >
          {t('disclosure.label')}
          <div className="text-xs text-muted-foreground mt-0.5 font-normal">{summaryText}</div>
        </summary>
        <div className="space-y-4 pt-3 pl-2">
          {/* Mode */}
          <fieldset>
            <legend className="text-sm font-medium mb-2">
              <span className="inline-flex items-center gap-1.5">
                {t('mode.label')}
                <SectionHint content={t('mode.hint')} />
              </span>
            </legend>
            <div className="space-y-1">
              {(['native-sweep', 'vmaf-anchored'] as BenchMode[]).map((m) => (
                <label key={m} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="mode"
                    value={m}
                    checked={state.mode === m}
                    onChange={() => dispatch({ type: 'SET_MODE', value: m })}
                    disabled={isDisabled}
                  />
                  {t(`mode.${m === 'native-sweep' ? 'native' : 'vmafAnchored'}`)}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Encoders */}
          <fieldset>
            <legend className="text-sm font-medium mb-2">
              <span className="inline-flex items-center gap-1.5">
                {t('encoders.label')}
                <SectionHint content={t('encoders.hint')} />
              </span>
            </legend>
            <div className="flex flex-wrap gap-3">
              {ENCODERS.map((enc, idx) => (
                <label key={enc} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    value={enc}
                    checked={state.encoders.includes(enc)}
                    onChange={() => dispatch({ type: 'TOGGLE_ENCODER', encoder: enc })}
                    disabled={isDisabled}
                    ref={(el) => {
                      if (idx === 0) encodersFirstRef.current = el;
                    }}
                  />
                  {enc}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Presets */}
          <fieldset>
            <legend className="text-sm font-medium mb-2">
              <span className="inline-flex items-center gap-1.5">
                {t('presets.label')}
                <SectionHint content={t('presets.hint')} />
              </span>
            </legend>
            <div className="grid grid-cols-3 gap-x-6 gap-y-0">
              {PRESET_GROUPS.map((group, gIdx) => (
                <div key={group.key}>
                  <p className="text-xs text-muted-foreground mb-1">{t(`presets.${group.key}`)}</p>
                  <div className="space-y-1">
                    {group.presets.map((preset, pIdx) => (
                      <label
                        key={preset}
                        className="flex items-center gap-1.5 text-sm cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          value={preset}
                          checked={state.presets.includes(preset)}
                          onChange={() => dispatch({ type: 'TOGGLE_PRESET', preset })}
                          disabled={isDisabled}
                          ref={(el) => {
                            if (gIdx === 0 && pIdx === 0) presetsFirstRef.current = el;
                          }}
                        />
                        {preset}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>

          {/* Quality values / VMAF targets */}
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <label htmlFor="bench-values" className="text-sm font-medium">
                {state.mode === 'native-sweep' ? t('nativeValues.label') : t('vmafTargets.label')}
              </label>
              <SectionHint
                content={
                  state.mode === 'native-sweep' ? t('nativeValues.hint') : t('vmafTargets.hint')
                }
              />
            </div>
            <Input
              id="bench-values"
              value={state.valuesText}
              onChange={(e) =>
                dispatch({ type: 'SET_FIELD', field: 'valuesText', value: e.target.value })
              }
              placeholder={
                state.mode === 'native-sweep'
                  ? t('nativeValues.placeholder')
                  : t('vmafTargets.placeholder')
              }
              disabled={isDisabled}
            />
          </div>

          {/* Sample configuration section */}
          <h4 className="text-sm font-medium pt-1">{t('sampleSection')}</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="bench-sample-count" className="text-sm font-medium">
                {t('advanced.sampleCount')}
              </label>
              <Input
                id="bench-sample-count"
                type="number"
                min={1}
                max={10}
                value={state.sampleCount}
                onChange={(e) =>
                  dispatch({ type: 'SET_FIELD', field: 'sampleCount', value: e.target.value })
                }
                disabled={isDisabled}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="bench-sample-duration" className="text-sm font-medium">
                {t('advanced.sampleDuration')}
              </label>
              <Input
                id="bench-sample-duration"
                type="number"
                min={5}
                max={60}
                value={state.sampleDurationSec}
                onChange={(e) =>
                  dispatch({
                    type: 'SET_FIELD',
                    field: 'sampleDurationSec',
                    value: e.target.value,
                  })
                }
                disabled={isDisabled}
              />
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor="bench-vmaf-model" className="text-sm font-medium">
              {t('advanced.vmafModel')}
            </label>
            <Input
              id="bench-vmaf-model"
              value={state.vmafModel}
              onChange={(e) =>
                dispatch({ type: 'SET_FIELD', field: 'vmafModel', value: e.target.value })
              }
              disabled={isDisabled}
            />
          </div>

          {/* Divider + Reset + Settings-Link */}
          <hr className="border-t border-border" />
          <div className="space-y-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleReset}
              disabled={isDisabled || stateEqualsDefaults}
              aria-disabled={isDisabled || stateEqualsDefaults}
            >
              {t('reset.cta')}
            </Button>
            {stateEqualsDefaults && !isDisabled && (
              <p className="text-xs text-muted-foreground">{t('reset.disabledHint')}</p>
            )}
            <div>
              <Link
                href={`/${locale}/settings?tab=bench`}
                className={`text-sm text-muted-foreground hover:text-foreground ${
                  isDisabled ? 'pointer-events-none opacity-60' : ''
                }`}
                tabIndex={isDisabled ? -1 : 0}
                aria-disabled={isDisabled}
              >
                {t('settingsLink')}
              </Link>
            </div>
          </div>
        </div>
      </details>

      {state.error && (
        <p role="alert" aria-live="assertive" className="text-sm text-destructive">
          {state.error}
        </p>
      )}

      <Button type="submit" disabled={isDisabled} className="w-full sm:w-auto">
        {state.submitting ? '…' : t('submit')}
      </Button>
    </form>
  );
}
