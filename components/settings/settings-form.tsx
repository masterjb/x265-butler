'use client';

import { useEffect, useState, useRef, useImperativeHandle, forwardRef } from 'react';
import { useForm, FormProvider, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { FormField } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { type SelectionMeta } from './apply-from-bench-button';
import { type PickerMode, type PickerChange } from './run-mode-picker';
// Each section lives in its own sibling file; this component only composes them.
import { EncoderConfigCard } from './encoder-config-card';
import { CrfCard } from './crf-card';
import { MinSavingsCard } from './min-savings-card';
import { PreferencesCard } from './preferences-card';
import { OutputContainerField } from './output-container-field';
import { SidecarModeField } from './sidecar-mode-field';
import { TrashPathField } from './trash-path-field';
import { GpuDeviceField } from './gpu-device-field';
import { AutoCropField } from './auto-crop-field';
import { Force10BitField } from './force-10bit-field';
import { ColorPassthroughField } from './color-passthrough-field';
import { OutputModeField } from './output-mode-field';
import { type EncoderDetectionState } from './settings-form-shared';
import {
  serializeForApi,
  type FormValues,
  type EditableSettings,
  type RenderDeviceOption,
} from '@/src/lib/api/settings-serialize';
import { cn } from '@/lib/utils';
// Detection state passed in for the Detected pill row.
import type { EncoderId, QsvRateControl } from '@/src/lib/encode';
import { PRESETS_BY_ENCODER } from '@/src/lib/encode/presets';
// Dep-free crop validator (no node:* imports → client-safe) for the
// crop_override superRefine — single source with the server route zod.
import { parseCropGeometry } from '@/src/lib/encode/crop-geometry';

// Source-of-truth schema for the form. Must align with API zod schema.
// Client zod accepts ANY ENCODER_IDS value (including pinned-
// but-currently-unavailable). Operator may pin in anticipation of GPU swap;
// orchestrator handles fallback at dispatch via the ENCODER_IDS validation.
const formSchema = z
  .object({
    // scan_root / extensions / min_size_mb / max_depth are retired —
    // multi-share replaces them. cache_pool_path is also not part of this form;
    // the setting still exists DB-side (default value) and is operator-editable
    // via PUT /api/settings (no UI surface yet).
    language: z.enum(['en', 'de']),
    theme_override: z.enum(['system', 'light', 'dark']),
    auto_encode: z.boolean(),
    // Encoder tab fields.
    encoder: z.enum(['auto', 'nvenc', 'qsv', 'vaapi', 'libx265']),
    concurrency: z.enum(['auto', '1', '2', '3', '4', '5', '6', '7', '8']),
    crf_libx265: z.number().int().min(0, { message: 'crfRange' }).max(51, { message: 'crfRange' }),
    crf_nvenc: z.number().int().min(0, { message: 'crfRange' }).max(51, { message: 'crfRange' }),
    crf_qsv: z.number().int().min(0, { message: 'crfRange' }).max(51, { message: 'crfRange' }),
    crf_vaapi: z.number().int().min(0, { message: 'crfRange' }).max(51, { message: 'crfRange' }),
    // Per-encoder preset override. Catalog source of truth is
    // PRESETS_BY_ENCODER. Mirror of API zod whitelist.
    preset_libx265: z.enum(PRESETS_BY_ENCODER.libx265 as unknown as readonly [string, ...string[]]),
    preset_nvenc: z.enum(PRESETS_BY_ENCODER.nvenc as unknown as readonly [string, ...string[]]),
    preset_qsv: z.enum(PRESETS_BY_ENCODER.qsv as unknown as readonly [string, ...string[]]),
    preset_vaapi: z.enum(PRESETS_BY_ENCODER.vaapi as unknown as readonly [string, ...string[]]),
    // Operator-tunable threshold separating done-smaller from done-not-worth.
    // Range 0..50 step 1 default 5 — already seeded via migration 0002:59 so the
    // settings cache has a value at first paint. zod-mirror of the API whitelist.
    min_savings_percent: z
      .number()
      .int()
      .min(0, { message: 'minSavingsRange' })
      .max(50, { message: 'minSavingsRange' }),
    // Encode-behavior toggles.
    delete_original_after_encode: z.boolean(),
    output_suffix: z
      .string()
      .min(1)
      .max(32)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^/\\\x00-\x1F\x7F]+$/, { message: 'outputSuffixFormat' }),
    // Operator-selectable container, mirror of API zod whitelist, including the
    // 'match-source' directive (resolves per source ext).
    output_container: z.enum(['mkv', 'mp4', 'match-source']),
    // Output strategy — suffix-sibling (default) vs in-place replace.
    // The arm-confirm gate lives in the UI/onSubmit, not zod (zod can't
    // express "armed"); the enum here only mirrors the API contract.
    output_mode: z.enum(['suffix', 'replace']),
    // Sidecar location mode + central root. Cross-field rule below
    // (superRefine): central requires a non-empty, absolute, non-forbidden path.
    sidecar_mode: z.enum(['off', 'beside', 'central']),
    sidecar_central_path: z.string(),
    // Operator-configurable originals-trash root. Empty = auto (track
    // the cache stageRoot). Cross-field rule below validates a NON-empty value.
    trash_path: z.string(),
    // Operator-pinned GPU render node. Client mirror of the settings route
    // regex (''|/dev/dri/renderD<N>). The Select can only emit valid values, so
    // this is defensive — there is NO server fieldErrors→form.setError mapping
    // for gpu_device (by contract with the route — that path would be dead code).
    gpu_device: z.string().refine((v) => v === '' || /^\/dev\/dri\/renderD\d+$/.test(v), {
      message: 'gpuDeviceFormat',
    }),
    // Auto-crop toggle + crop_override geometry. The .max(32) mirrors the
    // server zod (the single source extends to length); the W:H:X:Y validity is
    // checked in the superRefine below via the SAME parseCropGeometry the server
    // uses (no inline duplicate regex, no client/server drift).
    auto_crop: z.boolean(),
    crop_override: z.string().max(32),
    // Force 10-bit HEVC Main10 output toggle (mirror auto_crop bool).
    force_10bit: z.boolean(),
    // Color-passthrough toggle (mirror force_10bit bool).
    color_passthrough: z.boolean(),
  })
  .superRefine((vals, ctx) => {
    // Client mirror of the trim-tolerant server crop_override
    // refine. Empty OR whitespace-only = auto/none (VALID — matches the server's
    // `v.trim() === ''`); only a non-empty, non-whitespace value that fails
    // parseCropGeometry is rejected. Using bare `!== ''` would block whitespace the
    // server accepts (drift). Single-source validity via parseCropGeometry.
    if (vals.crop_override.trim() !== '' && parseCropGeometry(vals.crop_override) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['crop_override'],
        message: 'cropOverrideFormat',
      });
    }
    // Client mirror of the trash_path server contract so the cause+fix
    // FormMessage surfaces AT the field. Independent of sidecar_mode (always
    // relevant), so checked BEFORE the central-only early-return below. Empty
    // is VALID (= auto) — only a NON-empty value is validated. The
    // nested-under-share guard is server-only (the form has no share list) and
    // arrives as a server fieldError mapped in onSubmit.
    const tp = vals.trash_path;
    if (tp.trim() !== '') {
      if (!tp.startsWith('/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['trash_path'],
          message: 'trashPathAbsolute',
        });
      } else if (isForbiddenSidecarPath(tp)) {
        // Reuse the sidecar forbidden-prefix helper (do NOT introduce a 3rd
        // copy of the prefix list — drift = silent guard divergence).
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['trash_path'],
          message: 'trashPathForbidden',
        });
      }
    }
    // Client mirror of the server contract so the cause+fix FormMessage
    // surfaces AT the central-path field (not just a server 400). Only enforced
    // when mode=central — the input is irrelevant otherwise.
    if (vals.sidecar_mode !== 'central') return;
    const p = vals.sidecar_central_path;
    if (p.trim() === '' || !p.startsWith('/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sidecar_central_path'],
        message: 'sidecarCentralPathAbsolute',
      });
      return;
    }
    if (isForbiddenSidecarPath(p)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sidecar_central_path'],
        message: 'sidecarCentralPathForbidden',
      });
    }
  });

// Client mirror of route.ts isForbiddenCachePath (FORBIDDEN_CACHE_PREFIXES).
// Kept in sync deliberately — server is the authority, this only drives early
// FormMessage feedback. /, /etc, /proc, /sys, /dev, /boot (+ sub-paths) → blocked.
const FORBIDDEN_SIDECAR_PREFIXES = ['/etc', '/proc', '/sys', '/dev', '/boot'];
function isForbiddenSidecarPath(raw: string): boolean {
  const norm = raw.replace(/\/+$/, '');
  if (norm === '' || norm === '/') return true;
  return FORBIDDEN_SIDECAR_PREFIXES.some((bad) => norm === bad || norm.startsWith(`${bad}/`));
}
// No cache_pool ↔ scan_root cross-field refinement here — neither key flows
// through this form. The cache_pool vs share-paths collision check lives
// server-side in app/api/settings/route.ts.

// Tab type: 'encoder' sits between 'paths' and 'general'.
type Tab = 'paths' | 'encoder' | 'general';

// ENCODER_FIELD_NAMES gates the `/api/encoders/refresh` side
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
  // Per-encoder preset overrides flow through dirtyFields like crf_<encoder>.
  'preset_libx265',
  'preset_nvenc',
  'preset_qsv',
  'preset_vaapi',
  // A device change must fire the post-save /api/encoders/refresh
  // re-detect so the Detected pill re-resolves for the new render node (the PUT
  // already invalidates the encoder cache on change).
  'gpu_device',
] as const;

// Imperative handle exposing the in-flight submit() Promise contract
// for the parent <SettingsClient> AlertDialog Save-and-switch flow.
// Threads a signal for the AlertDialog-only AbortController, plus an
// 'in-flight' reason when the sync guard rejects a second submit.
export type SubmitOpts = { signal?: AbortSignal };
export type SubmitResult =
  { ok: true } | { ok: false; reason: 'validation' | 'network' | 'in-flight' };
export type SettingsFormHandle = {
  submit: (opts?: SubmitOpts) => Promise<SubmitResult>;
  getIsSubmitting: () => boolean;
};

type SettingsFormProps = {
  defaultValues: FormValues;
  tab: Tab;
  scanRootExists: boolean;
  cachePathExists: boolean;
  // Live /dev/dri/renderD* probe list for the GPU-Device picker (server-
  // probed in page.tsx, prop-fed = zero client fetch on Settings). [] on
  // a single-GPU / no-DRI host → the picker shows Auto only.
  renderDevices?: RenderDeviceOption[];
  // Reports dirty state up to the parent so the parent can
  // gate the unsaved-changes confirmation dialog and the beforeunload listener.
  onDirtyChange?: (dirty: boolean) => void;
  // Detection state for the Encoder tab Detected pill row + Active line.
  // onDetectionRefreshed fires after POST /api/encoders/refresh succeeds,
  // letting the parent SettingsClient re-render with fresh resolution.
  detection?: EncoderDetectionState;
  onDetectionRefreshed?: (next: EncoderDetectionState) => void;
};

export const SettingsForm = forwardRef<SettingsFormHandle, SettingsFormProps>(function SettingsForm(
  {
    defaultValues,
    tab,
    // scanRootExists / cachePathExists kept on the prop type for caller
    // back-compat (settings-client.tsx still passes them) but unused since the
    // paths-tab JSX block was retired. Prefix with _ to silence the lint rule.
    scanRootExists: _scanRootExists,
    cachePathExists: _cachePathExists,
    onDirtyChange,
    detection,
    onDetectionRefreshed,
    renderDevices = [],
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

  // When the Server Component re-renders with new defaultValues
  // (after router.refresh), reset the form's underlying state so values stay
  // in sync. Keyed on JSON-stringify so deep changes trigger reset.
  const defaultsKey = JSON.stringify(defaultValues);
  useEffect(() => {
    form.reset(defaultValues);
  }, [defaultsKey, form, defaultValues]);

  useEffect(() => {
    onDirtyChange?.(form.formState.isDirty);
  }, [form.formState.isDirty, onDirtyChange]);

  // Arm state for the in-place replace one-way-door. The
  // operator must explicitly arm via the ConfirmButton before a save persists
  // 'replace'. Reset on any return to suffix (so re-selecting replace re-arms)
  // and whenever the server defaults reset the form.
  const [replaceArmed, setReplaceArmed] = useState(false);
  const watchedOutputMode = useWatch({ control: form.control, name: 'output_mode' });
  useEffect(() => {
    if (watchedOutputMode !== 'replace') setReplaceArmed(false);
  }, [watchedOutputMode]);
  useEffect(() => {
    setReplaceArmed(false);
  }, [defaultsKey]);

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
      // Central-path validation messages (cause+fix wording).
      sidecarCentralPathAbsolute: tValidation('sidecarCentralPathAbsolute'),
      sidecarCentralPathForbidden: tValidation('sidecarCentralPathForbidden'),
      // Trash-path client validation + the server-only nested-share key.
      trashPathAbsolute: tValidation('trashPathAbsolute'),
      trashPathForbidden: tValidation('trashPathForbidden'),
      trash_path_nested_under_share: tValidation('trash_path_nested_under_share'),
      // Client-mirror device-format message (defensive; Select-constrained).
      gpuDeviceFormat: tValidation('gpuDeviceFormat'),
      cropOverrideFormat: tValidation('cropOverrideFormat'),
    };
    return known[message] ?? message;
  }

  // Tracks outcome of the in-flight submit so the imperative handle
  // can resolve Promise<{ ok, reason }> for the AlertDialog Save-and-switch
  // flow. Set inside each branch of onSubmit; reset to null at submit start.
  // null after handleSubmit resolves means RHF rejected client-validation
  // pre-fetch (onSubmit body never ran) → consumer treats as 'validation'.
  const submitOutcomeRef = useRef<'success' | 'validation' | 'network' | null>(null);

  // AlertDialog Save-and-switch threads an AbortSignal
  // through the imperative submit({signal}) call so cancelSwitch() can abort
  // the in-flight PUT. Stored in a ref because RHF's handleSubmit(onSubmit)
  // wrapper doesn't accept extra args — onSubmit must read the signal from
  // module-component-instance state. Sticky-bar `<form onSubmit>` path
  // bypasses the imperative handle, so submitSignalRef stays undefined and
  // fetch fires without a signal (known limitation).
  const submitSignalRef = useRef<AbortSignal | undefined>(undefined);

  // Sync-guard ref covering both entry points. Acquired at onSubmit body
  // top; both entry points (imperative submit() and sticky-bar native form
  // submit-event) collapse to exactly 1 POST in rapid-double scenarios.
  // Release via queueMicrotask mirrors the ApplyFromBenchButton pattern.
  const submitInFlightRef = useRef(false);

  async function onSubmit(values: FormValues) {
    if (submitInFlightRef.current) return; // sync guard against a double submit from both entry points
    submitInFlightRef.current = true;
    // Sync-guard at the single entry point that BOTH the imperative submit()
    // AND the sticky-bar native form-submit hit. Rapid double-call collapses
    // to 1 POST. Release via queueMicrotask in the outer finally{} block
    // mirrors the ApplyFromBenchButton pattern.
    submitOutcomeRef.current = null;
    try {
      // dirtyFields-driven partial body — encoder tab only sends
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
      // One-way-door gate. If 'replace' is selected but the
      // operator has not armed it via the ConfirmButton, strip output_mode
      // from the write (every OTHER changed field still saves) and surface the
      // requirement. The form stays dirty on output_mode so the save-bar keeps
      // prompting until the operator arms + saves again.
      if (body.settings.output_mode === 'replace' && !replaceArmed) {
        delete body.settings.output_mode;
        toast.error(t('field.outputMode.armRequired'));
      }
      try {
        const res = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          // Signal threaded from AlertDialog saveAndSwitch
          // only. Sticky-bar path leaves this undefined → fetch fires without
          // an AbortSignal, matching today's behavior.
          signal: submitSignalRef.current,
        });
        if (res.ok) {
          submitOutcomeRef.current = 'success';
          // If encoder tab fields changed, fire the
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
                  // This object is rebuilt from scratch, so a field
                  // missing HERE silently reverts the QSV helper to its
                  // "tier not verified" wording after every encoder-tab save.
                  qsvRateControl?: QsvRateControl;
                };
                if (refreshBody.refreshed) {
                  onDetectionRefreshed?.({
                    detectedEncoders: refreshBody.detected,
                    activeEncoder: refreshBody.active,
                    encoderResolution: refreshBody.resolution,
                    requestedButUnavailable: refreshBody.requestedButUnavailable,
                    vaapiDevice: refreshBody.devicePath,
                    qsvRateControl: refreshBody.qsvRateControl,
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

          // Keep client stores in sync with the persisted DB row.
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
            // Server field-level rejections that cannot be
            // client-validated (e.g. nested-under-share — the form has no share
            // list). Maps the field error onto the field so the operator sees
            // the cause AT the input (mirror share-add-form.tsx).
            error?: string;
            fieldErrors?: Record<string, string>;
          } | null;
          toast.error(t('error.save'));
          // Surface server fieldErrors at their fields. The message key
          // (e.g. 'trash_path_nested_under_share') flows through localizeError
          // via FormMessage. Focus the first such field for keyboard users.
          const fieldErrors = data?.fieldErrors;
          let focusedFromServer: keyof FormValues | null = null;
          if (fieldErrors) {
            for (const [field, message] of Object.entries(fieldErrors)) {
              if (field in values) {
                form.setError(field as keyof FormValues, { type: 'server', message });
                if (!focusedFromServer) focusedFromServer = field as keyof FormValues;
              }
            }
          }
          if (focusedFromServer) {
            form.setFocus(focusedFromServer);
          } else {
            const firstField = data?.details?.[0]?.path?.[1];
            if (firstField && firstField in values) {
              form.setFocus(firstField as keyof FormValues);
            }
          }
        } else {
          submitOutcomeRef.current = 'network';
          // 5xx → toast error + preserve dirty state
          toast.error(t('error.save'));
        }
      } catch (err) {
        // AbortError fires when AlertDialog Cancel aborts the
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
      // Sync-guard release — queueMicrotask matches the ApplyFromBenchButton
      // pattern so the React render flush sees the lock released after the
      // current microtask drains.
      queueMicrotask(() => {
        submitInFlightRef.current = false;
      });
    }
  }

  // Imperative handle for parent <SettingsClient> AlertDialog
  // Save-and-switch path. submit() resolves with discriminated-union outcome;
  // getIsSubmitting() exposes form.formState.isSubmitting reactively for the
  // parent's submitInFlight guard.
  useImperativeHandle(
    ref,
    () => ({
      // Signal threaded into submitSignalRef so onSubmit's fetch
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
  // Save disabled while !isDirty (and during in-flight submit)
  const saveDisabled = !isDirty || submitting;

  // Lifted RunModePicker state — both RunModePicker and
  // ApplyFromBenchButton read/write through this single source of truth.
  // selectedRunId=null until the picker resolves the run list (the
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
        {/* No paths-tab block here: the
            paths tab is rendered by <PathsTabShares /> in settings-client.tsx;
            SettingsForm only handles 'encoder' + 'general'. */}

        {tab === 'encoder' && (
          <>
            {/* Each encoder-tab section is its own sibling file. The three
                Output-Container / Sidecar / Output-Mode wrapper Cards keep their
                <Card> shell in the orchestrator and host the relocated
                field-components (single thin composition seam). */}
            <EncoderConfigCard
              control={form.control}
              t={t}
              localizeError={localizeError}
              detection={detection}
            />

            {/* GPU-Device picker — own Card directly AFTER the
                Encoder card. Surfaces the live /dev/dri/renderD* probe so a
                multi-GPU operator can pin the Arc dGPU instead of the first-
                enumerated iGPU. Auto / single-GPU / unset = no device pin at all. */}
            <Card>
              <CardHeader>
                <CardTitle>{t('section.gpuDevice.title')}</CardTitle>
                <CardDescription>{t('section.gpuDevice.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <GpuDeviceField control={form.control} t={t} renderDevices={renderDevices} />
              </CardContent>
            </Card>

            {/* Auto-crop, 10-bit and colour passthrough share one
                Encoding-Profile card; id anchors preserved as sub-sections
                (#auto-crop load-bearing per settings-client.tsx hash-scroll). */}
            <Card>
              <CardHeader>
                <CardTitle>{t('section.encodingProfile.title')}</CardTitle>
                <CardDescription>{t('section.encodingProfile.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Auto-Crop sub-section — id anchor preserved for the onboarding deep-link */}
                <div id="auto-crop" className="scroll-mt-20 space-y-2">
                  <h3 className="text-sm font-medium">{t('section.autoCrop.title')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t('section.autoCrop.description')}
                  </p>
                  <AutoCropField control={form.control} t={t} localizeError={localizeError} />
                </div>
                {/* Force-10bit sub-section */}
                <div id="force-10bit" className="scroll-mt-20 space-y-2">
                  <h3 className="text-sm font-medium">{t('section.force10bit.title')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t('section.force10bit.description')}
                  </p>
                  <Force10BitField control={form.control} t={t} />
                </div>
                {/* Colour/HDR10 sub-section */}
                <div id="color-passthrough" className="scroll-mt-20 space-y-2">
                  <h3 className="text-sm font-medium">{t('section.colorPassthrough.title')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t('section.colorPassthrough.description')}
                  </p>
                  <ColorPassthroughField control={form.control} t={t} />
                </div>
              </CardContent>
            </Card>

            <CrfCard
              form={form}
              t={t}
              localizeError={localizeError}
              // Both come from the SAME EncoderDetectionState — the tier
              // drives the QSV helper's parameter name, the detected list gates
              // the legacy-default advisory.
              qsvRateControl={detection?.qsvRateControl}
              detectedEncoders={detection?.detectedEncoders}
              pickerRunId={pickerRunId}
              pickerMode={pickerMode}
              pickerSource={pickerSource}
              pickerModeSource={pickerModeSource}
              onPickerChange={handlePickerChange}
              applyButtonRunId={applyButtonRunId}
              applyButtonMeta={applyButtonMeta}
            />

            {/* Output Container — operator-selectable enum (MKV
                default, MP4 opt-in). Placed BETWEEN per-encoder CRF and
                min_savings_percent: operator mental-model "codec → quality
                → output format → savings gate". Warning banner amber-info
                (NOT red-destructive) on MP4 — operator-intent warning, not
                a blocking error. Queue-semantic advisory visible whenever
                queue is non-empty (dispatch-time read makes
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

            {/* Sidecar location — off / beside (default) / central.
                Placed after Output Container: operator mental-model "where does
                the output go → where does its sidecar metadata go". The central
                path input is progressively disclosed (mounted always to preserve
                RHF state, disabled + de-emphasized when mode≠central). */}
            <Card>
              <CardHeader>
                <CardTitle>{t('section.sidecar.title')}</CardTitle>
                <CardDescription>{t('section.sidecar.description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <SidecarModeField control={form.control} t={t} localizeError={localizeError} />
                {/* Originals-trash LOCATION (storage-routing field grouped
                    with the structurally-identical central-sidecar path). */}
                <TrashPathField control={form.control} t={t} localizeError={localizeError} />
              </CardContent>
            </Card>

            {/* Output strategy — suffix sibling (default) vs in-place
                replace. Placed after Sidecar: operator mental-model "where the
                output + its sidecar go → whether it replaces the original". */}
            <Card>
              <CardHeader>
                <CardTitle>{t('section.outputMode.title')}</CardTitle>
                <CardDescription>{t('section.outputMode.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <OutputModeField
                  control={form.control}
                  t={t}
                  localizeError={localizeError}
                  replaceArmed={replaceArmed}
                  onArm={() => setReplaceArmed(true)}
                />
              </CardContent>
            </Card>

            {/* Minimum Savings Threshold — separates done-smaller from
                done-not-worth at the verify-step. Slider primitive used inline
                so getAriaValueText lands on the Thumb for SR
                announcement. The card is below per-encoder CRF, above the
                section's bottom — operator-mental-model: "after I pick CRF,
                I tune what counts as worth keeping". */}
            <MinSavingsCard control={form.control} t={t} localizeError={localizeError} />
          </>
        )}

        {tab === 'general' && (
          <PreferencesCard control={form.control} t={t} localizeError={localizeError} />
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

// Barrel re-exports preserve the public import surface of
// '@/components/settings/settings-form' — the field-component test files and
// settings-client.tsx import from this path.
export { OutputContainerField } from './output-container-field';
export { SidecarModeField } from './sidecar-mode-field';
export { OutputModeField } from './output-mode-field';
export { OutputSuffixField } from './output-suffix-field';
