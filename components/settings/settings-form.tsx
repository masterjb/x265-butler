'use client';

import { useEffect, useState, useRef, useImperativeHandle, forwardRef } from 'react';
import * as React from 'react';
import { useForm, FormProvider, useWatch, type Control } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
// 05-13: shadcn Slider primitive for the new min_savings_percent threshold
// (Encoder tab). Imported directly to attach getAriaValueText on the Thumb
// for screen-reader announcement (audit S4) — generic Slider wrapper
// in components/ui/slider.tsx does not expose Thumb-level ARIA hooks.
import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApplyFromBenchButton, type SelectionMeta } from './apply-from-bench-button';
import { RunModePicker, type PickerMode, type PickerChange } from './run-mode-picker';
import { EncoderWarningsBadge } from './encoder-warnings-badge';
// 14-04: ExtensionsInput orphaned post-paths-block removal; import dropped.
// 05-14: Tooltip + AlertTriangle/HelpCircle for the output_container Select
// + warning banner (MP4 selected) + help-icon trigger.
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertTriangle, HelpCircle } from 'lucide-react';
// 05-14 audit-added (G5): queue-semantic advisory visibility gates on
// pending_count > 0. useQueueCounts is the existing live-update hook
// already wired to the SSE engine-events stream.
import { useQueueCounts } from '@/src/lib/api/engine-events-client';
import {
  serializeForApi,
  type FormValues,
  type EditableSettings,
} from '@/src/lib/api/settings-serialize';
import { cn } from '@/lib/utils';

// Source-of-truth schema for the form. Must align with API zod schema.
// 03-03 audit S5: client zod accepts ANY ENCODER_IDS value (including pinned-
// but-currently-unavailable). Operator may pin in anticipation of GPU swap;
// orchestrator handles fallback at dispatch via 03-01 ENCODER_IDS validation.
const formSchema = z.object({
  // 14-04 (Plan 14-04 Task 5): scan_root / extensions / min_size_mb /
  // max_depth retired — multi-share replaces them. cache_pool_path also
  // dropped from this form; setting still exists DB-side (default value)
  // and is operator-editable via PUT /api/settings (no UI surface yet —
  // follow-up plan slot).
  language: z.enum(['en', 'de']),
  theme_override: z.enum(['system', 'light', 'dark']),
  auto_enqueue_after_scan: z.boolean(),
  // 03-03 Encoder tab fields.
  encoder: z.enum(['auto', 'nvenc', 'qsv', 'vaapi', 'libx265']),
  concurrency: z.enum(['auto', '1', '2', '3', '4', '5', '6', '7', '8']),
  crf_libx265: z.number().int().min(0, { message: 'crfRange' }).max(51, { message: 'crfRange' }),
  crf_nvenc: z.number().int().min(0, { message: 'crfRange' }).max(51, { message: 'crfRange' }),
  crf_qsv: z.number().int().min(0, { message: 'crfRange' }).max(51, { message: 'crfRange' }),
  crf_vaapi: z.number().int().min(0, { message: 'crfRange' }).max(51, { message: 'crfRange' }),
  // 12-03: per-encoder preset override. Catalog source-of-truth is
  // PRESETS_BY_ENCODER (P10-W9). Mirror of API zod whitelist.
  preset_libx265: z.enum(PRESETS_BY_ENCODER.libx265 as unknown as readonly [string, ...string[]]),
  preset_nvenc: z.enum(PRESETS_BY_ENCODER.nvenc as unknown as readonly [string, ...string[]]),
  preset_qsv: z.enum(PRESETS_BY_ENCODER.qsv as unknown as readonly [string, ...string[]]),
  preset_vaapi: z.enum(PRESETS_BY_ENCODER.vaapi as unknown as readonly [string, ...string[]]),
  // 05-13: operator-tunable threshold separating done-smaller from done-not-worth.
  // Range 0..50 step 1 default 5 — already seeded via migration 0002:59 so the
  // settings cache has a value at first paint. zod-mirror of the API whitelist.
  min_savings_percent: z
    .number()
    .int()
    .min(0, { message: 'minSavingsRange' })
    .max(50, { message: 'minSavingsRange' }),
  // 05-bonus: encode-behavior toggles.
  delete_original_after_encode: z.boolean(),
  output_suffix: z
    .string()
    .min(1)
    .max(32)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^/\\\x00-\x1F\x7F]+$/, { message: 'outputSuffixFormat' }),
  // 05-14: operator-selectable container, mirror of API zod whitelist.
  // 05-15: extended with 'match-source' DWIM directive (resolves per source ext).
  output_container: z.enum(['mkv', 'mp4', 'match-source']),
});
// 14-04 (Plan 14-04 Task 5): legacy cache_pool ↔ scan_root cross-field
// refinement removed — both keys no longer flow through this form. The
// cache_pool vs share-paths collision check moved server-side to
// app/api/settings/route.ts (audit-fix M4 + AC-24).

// 03-03: Tab type extended with 'encoder' between 'paths' and 'general'.
type Tab = 'paths' | 'encoder' | 'general';

// 03-03 audit S1: detection state passed in for the Detected pill row.
import type { EncoderId } from '@/src/lib/encode';
import { PRESETS_BY_ENCODER } from '@/src/lib/encode/presets';
type EncoderDetectionState = {
  detectedEncoders: EncoderId[];
  activeEncoder: EncoderId;
  encoderResolution: 'auto' | 'override' | 'fallback';
  requestedButUnavailable?: EncoderId;
  vaapiDevice?: string;
};

const ENCODER_DISPLAY_ORDER: EncoderId[] = ['nvenc', 'qsv', 'vaapi', 'libx265'];
// 05-13 audit S2: ENCODER_FIELD_NAMES gates the `/api/encoders/refresh` side
// effect (~2-second encoder re-detection round-trip via spawn libx265 -h)
// after PUT. `min_savings_percent` is INTENTIONALLY EXCLUDED — it is a verdict
// threshold, not an encoder property; including it here would fire a costly
// refresh on every Slider drag step. Future maintainers: do NOT add
// 'min_savings_percent' here. The threshold flows through dirtyFields like
// any other Encoder-tab field but does not trigger the refresh.
const ENCODER_FIELD_NAMES = [
  'encoder',
  'concurrency',
  'crf_libx265',
  'crf_nvenc',
  'crf_qsv',
  'crf_vaapi',
  // 12-03: per-encoder preset overrides flow through dirtyFields like crf_<encoder>.
  'preset_libx265',
  'preset_nvenc',
  'preset_qsv',
  'preset_vaapi',
] as const;

// 44px on mobile (touch-target floor) + 36px on lg (pointer-precise).
const INPUT_HEIGHT_CLASSES = 'h-11 lg:h-9 text-base lg:text-sm';

// 05-19: imperative handle exposing the in-flight submit() Promise contract
// for the parent <SettingsClient> AlertDialog Save-and-switch flow.
// 12-05 D1+D3: signal-threading for AlertDialog-only AbortController (M1
// scope) + 'in-flight' reason for sync-guard rejection (M2 dual-coverage).
export type SubmitOpts = { signal?: AbortSignal };
export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: 'validation' | 'network' | 'in-flight' };
export type SettingsFormHandle = {
  submit: (opts?: SubmitOpts) => Promise<SubmitResult>;
  getIsSubmitting: () => boolean;
};

type SettingsFormProps = {
  defaultValues: FormValues;
  tab: Tab;
  scanRootExists: boolean;
  cachePathExists: boolean;
  // audit-added M2: reports dirty state up to the parent so the parent can
  // gate the unsaved-changes confirmation dialog and the beforeunload listener.
  onDirtyChange?: (dirty: boolean) => void;
  // 03-03: detection state for the Encoder tab Detected pill row + Active line.
  // onDetectionRefreshed fires after POST /api/encoders/refresh succeeds,
  // letting the parent SettingsClient re-render with fresh resolution.
  detection?: EncoderDetectionState;
  onDetectionRefreshed?: (next: EncoderDetectionState) => void;
};

export const SettingsForm = forwardRef<SettingsFormHandle, SettingsFormProps>(function SettingsForm(
  {
    defaultValues,
    tab,
    // 14-04: scanRootExists / cachePathExists kept on the prop type for caller
    // back-compat (settings-client.tsx still passes them) but unused since the
    // paths-tab JSX block was retired. Prefix with _ to silence the lint rule.
    scanRootExists: _scanRootExists,
    cachePathExists: _cachePathExists,
    onDirtyChange,
    detection,
    onDetectionRefreshed,
  },
  ref,
) {
  const t = useTranslations('settings');
  const tValidation = useTranslations('settings.validation');
  const router = useRouter();
  const { setTheme } = useTheme();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues,
    mode: 'onBlur',
  });

  // audit-added M5: when the Server Component re-renders with new defaultValues
  // (after router.refresh), reset the form's underlying state so values stay
  // in sync. Keyed on JSON-stringify so deep changes trigger reset.
  const defaultsKey = JSON.stringify(defaultValues);
  useEffect(() => {
    form.reset(defaultValues);
  }, [defaultsKey, form, defaultValues]);

  useEffect(() => {
    onDirtyChange?.(form.formState.isDirty);
  }, [form.formState.isDirty, onDirtyChange]);

  function localizeError(message: string | undefined): string | undefined {
    if (!message) return undefined;
    const known: Record<string, string> = {
      required: tValidation('required'),
      pathAbsolute: tValidation('pathAbsolute'),
      extensionsRequired: tValidation('extensionsRequired'),
      cachePathCollidesWithScanRoot: tValidation('cachePathCollidesWithScanRoot'),
      crfRange: tValidation('crfRange'),
      outputSuffixFormat: tValidation('outputSuffixFormat'),
      minSavingsRange: tValidation('minSavingsRange'),
    };
    return known[message] ?? message;
  }

  // 05-19: tracks outcome of the in-flight submit so the imperative handle
  // can resolve Promise<{ ok, reason }> for the AlertDialog Save-and-switch
  // flow. Set inside each branch of onSubmit; reset to null at submit start.
  // null after handleSubmit resolves means RHF rejected client-validation
  // pre-fetch (onSubmit body never ran) → consumer treats as 'validation'.
  const submitOutcomeRef = useRef<'success' | 'validation' | 'network' | null>(null);

  // 12-05 D1 (M1 scope): AlertDialog Save-and-switch threads an AbortSignal
  // through the imperative submit({signal}) call so cancelSwitch() can abort
  // the in-flight PUT. Stored in a ref because RHF's handleSubmit(onSubmit)
  // wrapper doesn't accept extra args — onSubmit must read the signal from
  // module-component-instance state. Sticky-bar `<form onSubmit>` path
  // bypasses the imperative handle, so submitSignalRef stays undefined and
  // fetch fires without a signal (documented limitation in PLAN boundaries).
  const submitSignalRef = useRef<AbortSignal | undefined>(undefined);

  // 12-05 D3 (M2 dual-coverage): sync-guard ref. Acquired at onSubmit body
  // top; both entry points (imperative submit() and sticky-bar native form
  // submit-event) collapse to exactly 1 POST in rapid-double scenarios.
  // Release via queueMicrotask mirrors 12-02 ApplyFromBenchButton pattern.
  const submitInFlightRef = useRef(false);

  async function onSubmit(values: FormValues) {
    if (submitInFlightRef.current) return; // 12-05 D3 M2 sync-guard (both entry points)
    submitInFlightRef.current = true;
    // Sync-guard at the single entry point that BOTH the imperative submit()
    // AND the sticky-bar native form-submit hit. Rapid double-call collapses
    // to 1 POST. Release via queueMicrotask in the outer finally{} block
    // mirrors the 12-02 ApplyFromBenchButton pattern.
    submitOutcomeRef.current = null;
    try {
      // 03-03 audit S6: dirtyFields-driven partial body — encoder tab only sends
      // the fields the operator actually changed. Path + General tabs already
      // benefit from formState.dirtyFields shape (mode='onBlur' is reliable for
      // formState.dirtyFields per react-hook-form docs).
      const dirtyFields = form.formState.dirtyFields as Partial<Record<keyof FormValues, boolean>>;
      const dirtyOnly: Partial<FormValues> = {};
      for (const k of Object.keys(values) as Array<keyof FormValues>) {
        if (dirtyFields[k]) {
          // narrow assignment per key
          (dirtyOnly as Record<string, unknown>)[k] = values[k];
        }
      }
      const partial = Object.keys(dirtyOnly).length > 0 ? dirtyOnly : values;
      const encoderTabDirty = ENCODER_FIELD_NAMES.some((k) => dirtyFields[k] === true);

      const body: { settings: Partial<EditableSettings> } = { settings: serializeForApi(partial) };
      try {
        const res = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          // 12-05 D1 (M1 scope): signal threaded from AlertDialog saveAndSwitch
          // only. Sticky-bar path leaves this undefined → fetch fires without
          // an AbortSignal, matching today's behavior.
          signal: submitSignalRef.current,
        });
        if (res.ok) {
          submitOutcomeRef.current = 'success';
          // 03-03 audit M3 + S2 + S7: if encoder tab fields changed, fire the
          // refresh endpoint so the orchestrator picks up the new values
          // immediately. Toast secondary line announces the post-refresh active
          // resolution; aria-live="polite" inherited from sonner default.
          let savedToast = t('action.saved');
          if (encoderTabDirty) {
            try {
              const refreshRes = await fetch('/api/encoders/refresh', { method: 'POST' });
              if (refreshRes.ok) {
                const refreshBody = (await refreshRes.json()) as {
                  refreshed: boolean;
                  detected: EncoderId[];
                  active: EncoderId;
                  resolution: 'auto' | 'override' | 'fallback';
                  requestedButUnavailable?: EncoderId;
                  devicePath?: string;
                };
                if (refreshBody.refreshed) {
                  onDetectionRefreshed?.({
                    detectedEncoders: refreshBody.detected,
                    activeEncoder: refreshBody.active,
                    encoderResolution: refreshBody.resolution,
                    requestedButUnavailable: refreshBody.requestedButUnavailable,
                    vaapiDevice: refreshBody.devicePath,
                  });
                  savedToast = t('action.savedEncoder');
                  toast.success(savedToast, {
                    description: t('action.savedEncoderActive', {
                      encoder: refreshBody.active,
                    }),
                  });
                } else {
                  toast.success(savedToast);
                }
              } else {
                toast.success(savedToast);
              }
            } catch {
              toast.success(savedToast);
            }
          } else {
            toast.success(savedToast);
          }

          // audit-added S9: keep client stores in sync with the persisted DB row.
          if (values.theme_override) setTheme(values.theme_override);
          if (values.language) {
            document.cookie = `NEXT_LOCALE=${values.language}; path=/; max-age=31536000; samesite=lax`;
          }
          form.reset(values);
          router.refresh();
        } else if (res.status === 400) {
          submitOutcomeRef.current = 'validation';
          const data = (await res.json().catch(() => null)) as {
            details?: Array<{ path?: string[]; message?: string }>;
          } | null;
          toast.error(t('error.save'));
          const firstField = data?.details?.[0]?.path?.[1];
          if (firstField && firstField in values) {
            form.setFocus(firstField as keyof FormValues);
          }
        } else {
          submitOutcomeRef.current = 'network';
          // audit-added S14: 5xx → toast error + preserve dirty state
          toast.error(t('error.save'));
        }
      } catch (err) {
        // 12-05 D1: AbortError fires when AlertDialog Cancel aborts the
        // in-flight save. Silent return — saveAndSwitch's stale-closure guard
        // (pendingTabRef !== targetTab) already detects the operator's cancel
        // intent and skips state mutation. Leaving submitOutcomeRef = null
        // here propagates as the imperative submit's 'in-flight' default
        // when the wasInFlight pre-check matches.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        submitOutcomeRef.current = 'network';
        toast.error(t('error.save'));
      }
    } finally {
      // 12-05 D3 release — queueMicrotask matches the 12-02 ApplyFromBenchButton
      // pattern so the React render flush sees the lock released after the
      // current microtask drains.
      queueMicrotask(() => {
        submitInFlightRef.current = false;
      });
    }
  }

  // 05-19: imperative handle for parent <SettingsClient> AlertDialog
  // Save-and-switch path. submit() resolves with discriminated-union outcome;
  // getIsSubmitting() exposes form.formState.isSubmitting reactively for the
  // parent's submitInFlight guard (audit M4).
  useImperativeHandle(
    ref,
    () => ({
      // 12-05 D1+D3: signal threaded into submitSignalRef so onSubmit's fetch
      // call honors AbortController.abort() from saveAndSwitch. wasInFlight
      // captures the lock pre-state — if a prior submit is still releasing
      // (queueMicrotask not yet drained) and onSubmit early-returns on the
      // guard, submitOutcomeRef stays null → distinguish 'in-flight' from
      // 'validation' (which also leaves outcomeRef null when RHF rejects).
      submit: async (opts?: SubmitOpts) => {
        submitSignalRef.current = opts?.signal;
        const wasInFlight = submitInFlightRef.current;
        submitOutcomeRef.current = null;
        try {
          await form.handleSubmit(onSubmit)();
        } finally {
          submitSignalRef.current = undefined;
        }
        const outcome = submitOutcomeRef.current;
        if (outcome === 'success') return { ok: true } as const;
        if (outcome === 'network') return { ok: false, reason: 'network' } as const;
        if (wasInFlight && outcome === null) return { ok: false, reason: 'in-flight' } as const;
        return { ok: false, reason: 'validation' } as const;
      },
      getIsSubmitting: () => form.formState.isSubmitting,
    }),
    [form, onSubmit],
  );

  const submitting = form.formState.isSubmitting;
  const isDirty = form.formState.isDirty;
  // audit-added S10: Save disabled while !isDirty (and during in-flight submit)
  const saveDisabled = !isDirty || submitting;

  // 12-04: lifted RunModePicker state — both RunModePicker and
  // ApplyFromBenchButton read/write through this single source of truth.
  // selectedRunId=null until the picker resolves the run list (audit SR5 —
  // picker emits an explicit default-resolve callback shortly after mount).
  const [pickerRunId, setPickerRunId] = useState<number | null>(null);
  const [pickerMode, setPickerMode] = useState<PickerMode>('quality');
  const [pickerSource, setPickerSource] = useState<'default' | 'operator'>('default');
  const [pickerModeSource, setPickerModeSource] = useState<'default' | 'operator'>('default');

  const handlePickerChange = (next: PickerChange) => {
    setPickerRunId(next.selectedRunId);
    setPickerMode(next.mode);
    setPickerSource(next.selectionSource);
    setPickerModeSource(next.selectionMode);
  };

  const applyButtonRunId = pickerRunId ?? undefined;
  const applyButtonMeta: SelectionMeta = {
    selectionSource: pickerSource,
    selectedRunId: pickerSource === 'operator' ? pickerRunId : null,
    selectionMode: pickerModeSource,
  };

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
        {/* 14-04 (Plan 14-04 Task 5): paths-tab JSX block removed. The
            paths tab is now rendered by <PathsTabShares /> in settings-client.tsx;
            SettingsForm only handles 'encoder' + 'general'. */}

        {tab === 'encoder' && (
          <>
            {/* Encoder selection section. 18-01: `id="encoder-config"` is the
                deeplink anchor for /{locale}/settings#encoder-config — opened
                by the topbar NotificationBell + any other future surface that
                wants to land an operator on the encoder configuration. */}
            <Card id="encoder-config">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <CardTitle>{t('section.encoder.title')}</CardTitle>
                    <CardDescription>{t('section.encoder.description')}</CardDescription>
                  </div>
                  {/* 18-01: badge surfaces structured detection-warnings adjacent
                      to the section header. Hidden (returns null) when there are
                      no warnings, so the layout stays identical for happy-path. */}
                  <EncoderWarningsBadge />
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                {/* 03-03 audit S1: Detected pill row above the encoder Select.
                    Each pill carries an explicit aria-label for screen readers. */}
                {detection && (
                  <div className="flex flex-col gap-2">
                    <p className="text-sm font-medium text-foreground">
                      {t('encoder.detected.heading')}
                    </p>
                    <div
                      role="list"
                      className="flex flex-wrap items-center gap-2"
                      aria-label={t('encoder.detected.heading')}
                    >
                      {ENCODER_DISPLAY_ORDER.map((id) => {
                        const present = detection.detectedEncoders.includes(id);
                        const isLibx265 = id === 'libx265';
                        const ariaLabel = isLibx265
                          ? t('encoder.detected.pill.libx265')
                          : present
                            ? t('encoder.detected.pill.available', { encoder: id })
                            : t('encoder.detected.pill.unavailable', { encoder: id });
                        return (
                          <span
                            key={id}
                            role="listitem"
                            aria-label={ariaLabel}
                            className={cn(
                              'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium font-mono',
                              present
                                ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                                : 'border border-border bg-muted text-muted-foreground line-through opacity-70',
                            )}
                          >
                            <span aria-hidden="true">{present ? '✓' : '✗'}</span>
                            {id}
                          </span>
                        );
                      })}
                    </div>
                    <p
                      className="text-sm text-muted-foreground"
                      aria-label={t('encoder.active.aria', {
                        encoder: detection.activeEncoder,
                        resolution: detection.encoderResolution,
                      })}
                    >
                      {t('encoder.active.line', {
                        encoder: detection.activeEncoder,
                        resolution: detection.encoderResolution,
                      })}
                      {detection.vaapiDevice && detection.activeEncoder === 'vaapi' && (
                        <>
                          {' '}
                          <span className="font-mono">[{detection.vaapiDevice}]</span>
                        </>
                      )}
                    </p>
                    {detection.encoderResolution === 'fallback' &&
                      detection.requestedButUnavailable && (
                        <p
                          role="alert"
                          className="text-sm font-medium text-amber-600 dark:text-amber-400"
                        >
                          ⚠{' '}
                          {t('encoder.active.fallbackLine', {
                            requested: detection.requestedButUnavailable,
                          })}
                        </p>
                      )}
                  </div>
                )}

                <FormField
                  control={form.control}
                  name="encoder"
                  render={({ field, fieldState }) => (
                    <FormItem>
                      <FormLabel>{t('field.encoder.label')}</FormLabel>
                      <FormControl>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className={INPUT_HEIGHT_CLASSES}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">{t('field.encoder.option.auto')}</SelectItem>
                            <SelectItem value="nvenc">{t('field.encoder.option.nvenc')}</SelectItem>
                            <SelectItem value="qsv">{t('field.encoder.option.qsv')}</SelectItem>
                            <SelectItem value="vaapi">{t('field.encoder.option.vaapi')}</SelectItem>
                            <SelectItem value="libx265">
                              {t('field.encoder.option.libx265')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormDescription className="text-sm">
                        {t('field.encoder.helper')}
                      </FormDescription>
                      <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="concurrency"
                  render={({ field, fieldState }) => (
                    <FormItem>
                      <FormLabel>{t('field.concurrency.label')}</FormLabel>
                      <FormControl>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className={INPUT_HEIGHT_CLASSES}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">
                              {t('field.concurrency.option.auto')}
                            </SelectItem>
                            {(['1', '2', '3', '4', '5', '6', '7', '8'] as const).map((n) => (
                              <SelectItem key={n} value={n}>
                                {n}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormDescription className="text-sm">
                        {t('field.concurrency.helper')}
                      </FormDescription>
                      <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Per-encoder CRF section */}
            <Card>
              <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex-1 space-y-1.5">
                  <CardTitle>{t('section.crf.title')}</CardTitle>
                  <CardDescription>{t('section.crf.description')}</CardDescription>
                </div>
                {/* 12-04 T0 sub-3: mobile stack-order RunPicker → ModeToggle → ApplyButton.
                    On lg+ the picker sits left of the action button. */}
                <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-end lg:gap-4">
                  <RunModePicker
                    selectedRunId={pickerRunId}
                    mode={pickerMode}
                    selectionSource={pickerSource}
                    selectionMode={pickerModeSource}
                    onChange={handlePickerChange}
                  />
                  <div className="flex justify-end lg:justify-start">
                    <ApplyFromBenchButton
                      form={form}
                      runId={applyButtonRunId}
                      mode={pickerMode}
                      selectionMeta={applyButtonMeta}
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {/* 12-03 T0 sub-2=A side-by-side flex + sub-3=A CRF-above-Preset
                    on ≤640px stack. Each row pairs a CRF number-input with the
                    encoder's Preset-Select (shadcn Select per T0 sub-1=A). On
                    desktop the row uses a 2-col grid (CRF compact + Preset
                    fills); on mobile both fields stack with CRF first. */}
                <div className="space-y-5">
                  {(['libx265', 'nvenc', 'qsv', 'vaapi'] as const).map((encoder) => {
                    const crfName = `crf_${encoder}` as const;
                    const presetName = `preset_${encoder}` as const;
                    const presetOptions = PRESETS_BY_ENCODER[encoder];
                    return (
                      <div
                        key={encoder}
                        className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_1fr] sm:items-start"
                      >
                        <FormField
                          control={form.control}
                          name={crfName}
                          render={({ field, fieldState }) => (
                            <FormItem>
                              <FormLabel>{t(`field.${crfName}.label`)}</FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  inputMode="numeric"
                                  min={0}
                                  max={51}
                                  {...field}
                                  onChange={(e) => field.onChange(e.target.valueAsNumber)}
                                  className={INPUT_HEIGHT_CLASSES}
                                />
                              </FormControl>
                              <FormDescription className="text-sm">
                                {t(`field.${crfName}.helper`)}
                              </FormDescription>
                              <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={presetName}
                          render={({ field, fieldState }) => (
                            <FormItem>
                              <FormLabel>{t('section.crf.preset.label')}</FormLabel>
                              <FormControl>
                                <Select
                                  value={typeof field.value === 'string' ? field.value : ''}
                                  onValueChange={field.onChange}
                                >
                                  <SelectTrigger
                                    className={INPUT_HEIGHT_CLASSES}
                                    aria-label={t('section.crf.preset.label')}
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {presetOptions.map((value) => (
                                      <SelectItem key={value} value={value}>
                                        {t(`section.crf.preset.option.${encoder}.${value}`)}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </FormControl>
                              <FormDescription className="text-sm">
                                {t(`section.crf.preset.helper.${encoder}`)}
                              </FormDescription>
                              <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
                            </FormItem>
                          )}
                        />
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* 05-14: Output Container — operator-selectable enum (MKV
                default, MP4 opt-in). Placed BETWEEN per-encoder CRF and
                min_savings_percent: operator mental-model "codec → quality
                → output format → savings gate". Warning banner amber-info
                (NOT red-destructive) on MP4 — operator-intent warning, not
                a blocking error. Queue-semantic advisory visible whenever
                queue is non-empty per audit G5 (dispatch-time read makes
                queued jobs honor new container post-save). */}
            <Card>
              <CardHeader>
                <CardTitle>{t('section.outputContainer.title')}</CardTitle>
                <CardDescription>{t('section.outputContainer.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <FormField
                  control={form.control}
                  name="output_container"
                  render={({ field, fieldState }) => (
                    <OutputContainerField field={field} fieldState={fieldState} t={t} />
                  )}
                />
              </CardContent>
            </Card>

            {/* 05-13: Minimum Savings Threshold — separates done-smaller from
                done-not-worth at the verify-step. Slider primitive used inline
                so getAriaValueText (audit S4) lands on the Thumb for SR
                announcement. The card is below per-encoder CRF, above the
                section's bottom — operator-mental-model: "after I pick CRF,
                I tune what counts as worth keeping". */}
            <Card>
              <CardHeader>
                <CardTitle>{t('section.minSavings.title')}</CardTitle>
                <CardDescription>{t('section.minSavings.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <FormField
                  control={form.control}
                  name="min_savings_percent"
                  render={({ field, fieldState }) => {
                    const v = typeof field.value === 'number' ? field.value : 5;
                    return (
                      <FormItem>
                        <FormLabel>{t('field.minSavings.label')}</FormLabel>
                        <FormControl>
                          {/* 05-13 UAT-fix (option-F): cross-color-family contrast for
                              track-vs-indicator. Pre-fix: track bg-secondary (Blue 500) +
                              indicator bg-primary (Blue 800) — both blue, low fill/empty
                              separation. Post-fix: track in slate-300 / dark:slate-600
                              (neutral gray ≥4:1 in both modes), indicator stays bg-primary
                              (blue) — clear color-family swap so the filled portion is
                              visually distinct from the rail. Track height h-3 (12px) +
                              token-compliant thumb (bg-background border-2 border-primary).
                              Tick scale below shows operator the granularity (0/10/20/30/40/50). */}
                          {/* 05-13 UAT-fix round 3: drop `data-horizontal:` Tailwind
                              prefixes — globals.css defines no custom variant for it
                              (only `dark`), and base-ui Slider emits `data-orientation`,
                              not `data-horizontal`. Result was track height resolving to
                              0 → invisible. Fixed by using plain h-3 / w-full / h-full. */}
                          <div className="space-y-2">
                            <SliderPrimitive.Root
                              min={0}
                              max={50}
                              step={1}
                              value={[v]}
                              onValueChange={(next) => {
                                const arr = Array.isArray(next) ? next : [next];
                                field.onChange(arr[0]);
                              }}
                              className="w-full"
                              aria-label={t('field.minSavings.label')}
                            >
                              <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none py-3">
                                <SliderPrimitive.Track className="relative h-3 w-full grow overflow-hidden rounded-full bg-slate-300 select-none dark:bg-slate-600">
                                  <SliderPrimitive.Indicator
                                    data-slot="slider-range"
                                    className="h-full bg-primary select-none"
                                  />
                                </SliderPrimitive.Track>
                                <SliderPrimitive.Thumb
                                  data-slot="slider-thumb"
                                  getAriaValueText={(value) =>
                                    t('field.minSavings.aria.valuetext', { value })
                                  }
                                  className="relative block size-5 shrink-0 rounded-full border-2 border-primary bg-background ring-ring/50 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-50"
                                />
                              </SliderPrimitive.Control>
                            </SliderPrimitive.Root>
                            {/* Tick scale — 6 marks at 0/10/20/30/40/50% of range
                                (= values 0/10/20/30/40/50). flex-justify-between
                                aligns endpoints with track ends; px-[10px] offsets the
                                inner ticks so they sit visually under the track-pixel
                                positions (matches Thumb size-5/2 = 10px center offset). */}
                            <div
                              aria-hidden="true"
                              className="flex w-full justify-between px-[10px] text-xs text-muted-foreground"
                            >
                              {[0, 10, 20, 30, 40, 50].map((mark) => (
                                <span
                                  key={mark}
                                  className="flex flex-col items-center gap-1 leading-none"
                                >
                                  <span className="block h-1.5 w-px bg-muted-foreground/50" />
                                  <span className="font-mono tabular-nums">{mark}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        </FormControl>
                        <FormDescription className="text-sm" aria-live="polite" aria-atomic="true">
                          <span className="font-mono tabular-nums tracking-tight mr-2 text-foreground">
                            {v}%
                          </span>
                          {t('field.minSavings.helper.template', { value: v })}
                        </FormDescription>
                        <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
                      </FormItem>
                    );
                  }}
                />
              </CardContent>
            </Card>
          </>
        )}

        {tab === 'general' && (
          <Card>
            <CardHeader>
              <CardTitle>{t('section.preferences.title')}</CardTitle>
              <CardDescription>{t('section.preferences.description')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="language"
                  render={({ field, fieldState }) => (
                    <FormItem>
                      <FormLabel>{t('field.language.label')}</FormLabel>
                      <FormControl>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className="w-full h-11 lg:h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="en">English</SelectItem>
                            <SelectItem value="de">Deutsch</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="theme_override"
                  render={({ field, fieldState }) => (
                    <FormItem>
                      <FormLabel>{t('field.theme.label')}</FormLabel>
                      <FormControl>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger className="w-full h-11 lg:h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="system">{t('field.theme.system')}</SelectItem>
                            <SelectItem value="light">{t('field.theme.light')}</SelectItem>
                            <SelectItem value="dark">{t('field.theme.dark')}</SelectItem>
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="auto_enqueue_after_scan"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
                    <div className="space-y-1">
                      <FormLabel className="text-base">
                        {t('field.autoEnqueueAfterScan.label')}
                      </FormLabel>
                      <FormDescription className="text-sm">
                        {t('field.autoEnqueueAfterScan.helper')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        aria-label={t('field.autoEnqueueAfterScan.label')}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              {/* 05-bonus: hard-delete original after successful encode (skip trash). */}
              <FormField
                control={form.control}
                name="delete_original_after_encode"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
                    <div className="space-y-1">
                      <FormLabel className="text-base">
                        {t('field.deleteOriginalAfterEncode.label')}
                      </FormLabel>
                      <FormDescription className="text-sm">
                        {t('field.deleteOriginalAfterEncode.helper')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        aria-label={t('field.deleteOriginalAfterEncode.label')}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              {/* 05-bonus: configurable output filename suffix. */}
              <FormField
                control={form.control}
                name="output_suffix"
                render={({ field, fieldState }) => (
                  <OutputSuffixField
                    field={field}
                    fieldState={fieldState}
                    control={form.control}
                    t={t}
                    localizeError={localizeError}
                  />
                )}
              />
            </CardContent>
          </Card>
        )}

        {/* Action bar — sticky to viewport on <md, inline below cards on ≥md.
            On mobile we add a translucent backdrop so it visually separates
            from the last card without a full-width hard border. */}
        <div
          className={cn(
            'sticky bottom-0 z-10 -mx-4 flex justify-end',
            'border-t border-border bg-background/95 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)] backdrop-blur',
            'md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:pt-2 md:pb-0 md:backdrop-blur-none',
          )}
        >
          <Button
            type="submit"
            size="lg"
            disabled={saveDisabled}
            className="w-full md:w-auto md:min-w-32"
          >
            {submitting ? t('action.saving') : t('action.save')}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
});

SettingsForm.displayName = 'SettingsForm';

// 14-04 (Plan 14-04 Task 5): parseExtensions retired with the paths-tab
// legacy form; re-export removed.

// 05-14: output-container field — Select + amber-info warning banner
// on MP4 + Tooltip help-icon + queue-semantic advisory gated on
// pendingJobs > 0. Extracted to a sub-component so the Settings tab JSX
// stays readable and the queue-counts hook has a stable mount/unmount
// boundary.
type OutputContainerFieldProps = {
  // react-hook-form passes a typed ControllerRenderProps; we accept a
  // narrower shape to keep the boundary explicit and test-friendly.
  // 05-15 audit M1: widened to the 3-value setting union — without this,
  // the form schema's `z.enum(['mkv','mp4','match-source'])` resolves to a
  // wider type than the props accepted, breaking `pnpm tsc --noEmit`.
  field: {
    value: 'mkv' | 'mp4' | 'match-source';
    onChange: (v: 'mkv' | 'mp4' | 'match-source') => void;
    onBlur: () => void;
    name: string;
    ref: React.Ref<unknown>;
  };
  fieldState: {
    error?: { message?: string };
  };
  t: ReturnType<typeof useTranslations<'settings'>>;
};

export function OutputContainerField({
  field,
  fieldState,
}: OutputContainerFieldProps): React.ReactElement {
  const t = useTranslations('settings');
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const queueCounts = useQueueCounts();

  // Reset Esc-dismiss state when operator toggles back to MKV — banner
  // re-appears on next MP4 selection without keeping stale-dismissed state.
  useEffect(() => {
    if (field.value !== 'mp4') setBannerDismissed(false);
  }, [field.value]);

  const showBanner = field.value === 'mp4' && !bannerDismissed;
  const showQueueAdvisory = queueCounts.pendingJobs > 0;

  return (
    <FormItem>
      <div className="flex items-center gap-2">
        <FormLabel htmlFor="output_container">{t('field.outputContainer.label')}</FormLabel>
        <Tooltip>
          <TooltipTrigger
            render={(triggerProps) => (
              <button
                {...triggerProps}
                type="button"
                aria-label={t('field.outputContainer.tooltip.trigger')}
                className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <HelpCircle aria-hidden="true" className="size-4" />
              </button>
            )}
          />
          <TooltipContent>
            <span className="block max-w-xs text-xs leading-relaxed">
              {t('field.outputContainer.description')}
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
      <FormControl>
        <Select
          value={field.value}
          onValueChange={(v) => {
            // 05-15: accept the 3-value setting union; reject everything else.
            if (v === 'mkv' || v === 'mp4' || v === 'match-source') field.onChange(v);
          }}
        >
          <SelectTrigger
            id="output_container"
            className="w-full h-11 lg:h-9"
            aria-label={t('field.outputContainer.aria.label')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mkv">{t('field.outputContainer.options.mkv')}</SelectItem>
            <SelectItem value="mp4">{t('field.outputContainer.options.mp4')}</SelectItem>
            <SelectItem value="match-source">
              {t('field.outputContainer.options.matchSource')}
            </SelectItem>
          </SelectContent>
        </Select>
      </FormControl>
      {showBanner && (
        <div
          role="alert"
          aria-live="polite"
          aria-label={t('field.outputContainer.aria.warning')}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setBannerDismissed(true);
            }
          }}
          className="mt-3 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <div className="flex-1 leading-relaxed">{t('field.outputContainer.warning.mp4')}</div>
          <button
            type="button"
            aria-label={t('field.outputContainer.warning.dismiss')}
            onClick={() => setBannerDismissed(true)}
            className="text-amber-700 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
      {showQueueAdvisory && (
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
          {t('field.outputContainer.advisory.queueSemantic')}
        </p>
      )}
      {field.value === 'match-source' && (
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
          {t('field.outputContainer.advisory.matchSource')}
        </p>
      )}
      <FormMessage>{fieldState.error?.message}</FormMessage>
    </FormItem>
  );
}

// 05-18 / 16-05: container-aware suffix field. Subscribes to
// output_container via useWatch INSIDE its own body (audit S3 from 05-17 —
// Hook-rules clean; no useWatch in FormField render-prop closure). Drives
// both the Input placeholder (16-05: -x265.mkv | -x265.mp4 | -x265 in the
// new infix-label style) and the FormDescription helper-text key
// (helper.{mkv,mp4,matchSource}).
//
// 16-05 audit M5 invariant: the placeholder string MUST equal
// sanitizeOutputSuffix('-x265', container) (with match-source mapping to
// the bare label '-x265' since composition happens upstream at dispatch).
// Pinned by the placeholder-vs-sanitizer drift-guard test in
// tests/components/settings-output-suffix-field.test.tsx.
type OutputSuffixFieldProps = {
  field: {
    value: string;
    // APPLY-time deviation D1 (05-18): plan declared `(v: string) => void`,
    // but native <Input>'s `onChange` expects ChangeEventHandler. RHF's
    // field.onChange is broadly typed to accept either an event or a value;
    // narrowing to ChangeEventHandler keeps the Input prop satisfied while
    // still compatible at runtime (RHF inspects target.value).
    onChange: React.ChangeEventHandler<HTMLInputElement>;
    onBlur: () => void;
    name: string;
    ref: React.Ref<unknown>;
  };
  fieldState: { error?: { message?: string } };
  control: Control<FormValues>;
  t: ReturnType<typeof useTranslations<'settings'>>;
  // audit M1 (05-18): localizeError is closure-scoped inside SettingsForm
  // body (line 196) — captures tValidation closure. OutputSuffixField is
  // module-scoped + exported, so it cannot reach the closure-scoped helper.
  // Pass it as a prop, parallel to how `t` is passed.
  localizeError: (message: string | undefined) => string | undefined;
};

export function OutputSuffixField({
  field,
  fieldState,
  control,
  t,
  localizeError,
}: OutputSuffixFieldProps): React.ReactElement {
  const containerRaw = useWatch({ control, name: 'output_container' });
  // 05-18 AC-8 defensive default — useWatch can return undefined transiently
  // before RHF defaultValues populate. Mirrors OutputSuffixPreview AC-9 guard.
  const container: 'mkv' | 'mp4' | 'match-source' =
    containerRaw === 'mkv' || containerRaw === 'mp4' || containerRaw === 'match-source'
      ? containerRaw
      : 'mkv';

  const placeholder = container === 'match-source' ? '-x265' : `-x265.${container}`;

  // audit S3 (05-18): i18n key uses camelCase ('matchSource'); container
  // enum value uses kebab ('match-source') per 05-15 contract. Translation
  // point is intentional — do not "fix" the casing without also touching
  // messages/*.json.
  const helperKey =
    container === 'match-source'
      ? 'field.outputSuffix.helper.matchSource'
      : container === 'mp4'
        ? 'field.outputSuffix.helper.mp4'
        : 'field.outputSuffix.helper.mkv';

  return (
    <FormItem>
      <FormLabel>{t('field.outputSuffix.label')}</FormLabel>
      <FormControl>
        <Input
          type="text"
          value={field.value}
          onChange={field.onChange}
          onBlur={field.onBlur}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          placeholder={placeholder}
        />
      </FormControl>
      <FormDescription className="text-sm">{t(helperKey)}</FormDescription>
      <FormMessage>{localizeError(fieldState.error?.message)}</FormMessage>
    </FormItem>
  );
}
