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
// 28-10: L2 god-component split — each section now lives in its own sibling file.
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
// 03-03 audit S1: detection state passed in for the Detected pill row.
import type { EncoderId } from '@/src/lib/encode';
import { PRESETS_BY_ENCODER } from '@/src/lib/encode/presets';
// 35-02: dep-free crop validator (no node:* imports → client-safe) for the
// crop_override superRefine — single-source with the server route zod (AC-5).
import { parseCropGeometry } from '@/src/lib/encode/crop-geometry';

// Source-of-truth schema for the form. Must align with API zod schema.
// 03-03 audit S5: client zod accepts ANY ENCODER_IDS value (including pinned-
// but-currently-unavailable). Operator may pin in anticipation of GPU swap;
// orchestrator handles fallback at dispatch via 03-01 ENCODER_IDS validation.
const formSchema = z
  .object({
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
    // 26-02 (F5): output strategy — suffix-sibling (default) vs in-place replace.
    // The P3 arm-confirm gate (AC-9) lives in the UI/onSubmit, not zod (zod can't
    // express "armed"); the enum here only mirrors the API contract.
    output_mode: z.enum(['suffix', 'replace']),
    // 26-01 (F3): sidecar location mode + central root. Cross-field rule below
    // (superRefine): central requires a non-empty, absolute, non-forbidden path.
    sidecar_mode: z.enum(['off', 'beside', 'central']),
    sidecar_central_path: z.string(),
    // 33-02: operator-configurable originals-trash root. Empty = auto (track
    // the cache stageRoot). Cross-field rule below validates a NON-empty value.
    trash_path: z.string(),
    // 34-02: operator-pinned GPU render node. Client-mirror of the 34-01 route
    // regex (''|/dev/dri/renderD<N>). The Select can only emit valid values, so
    // this is defensive — there is NO server fieldErrors→form.setError mapping
    // for gpu_device (34-01 AC-5 contract — that path would be dead code).
    gpu_device: z.string().refine((v) => v === '' || /^\/dev\/dri\/renderD\d+$/.test(v), {
      message: 'gpuDeviceFormat',
    }),
    // 35-02: auto-crop toggle + crop_override geometry. The .max(32) mirrors the
    // server zod (AC-5 single-source extends to length); the W:H:X:Y validity is
    // checked in the superRefine below via the SAME parseCropGeometry the server
    // uses (no inline duplicate regex, no client/server drift).
    auto_crop: z.boolean(),
    crop_override: z.string().max(32),
    // 43-01: force 10-bit HEVC Main10 output toggle (mirror auto_crop bool).
    force_10bit: z.boolean(),
    // 43-03: color-passthrough toggle (mirror force_10bit bool).
    color_passthrough: z.boolean(),
  })
  .superRefine((vals, ctx) => {
    // 35-02 (audit SR-1): client-mirror of the trim-tolerant server crop_override
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
    // 33-02: client-mirror of the trash_path server contract so the cause+fix
    // FormMessage surfaces AT the field. Independent of sidecar_mode (always
    // relevant), so checked BEFORE the central-only early-return below. Empty
    // is VALID (= auto) per D1 — only a NON-empty value is validated. The
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
    // 26-01 (F3): client-mirror of the server contract so the cause+fix FormMessage
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

// 26-01 (F3): client-mirror of route.ts isForbiddenCachePath (FORBIDDEN_CACHE_PREFIXES).
// Kept in sync deliberately — server is the authority, this only drives early
// FormMessage feedback. /, /etc, /proc, /sys, /dev, /boot (+ sub-paths) → blocked.
const FORBIDDEN_SIDECAR_PREFIXES = ['/etc', '/proc', '/sys', '/dev', '/boot'];
function isForbiddenSidecarPath(raw: string): boolean {
  const norm = raw.replace(/\/+$/, '');
  if (norm === '' || norm === '/') return true;
  return FORBIDDEN_SIDECAR_PREFIXES.some((bad) => norm === bad || norm.startsWith(`${bad}/`));
}
// 14-04 (Plan 14-04 Task 5): legacy cache_pool ↔ scan_root cross-field
// refinement removed — both keys no longer flow through this form. The
// cache_pool vs share-paths collision check moved server-side to
// app/api/settings/route.ts (audit-fix M4 + AC-24).

// 03-03: Tab type extended with 'encoder' between 'paths' and 'general'.
type Tab = 'paths' | 'encoder' | 'general';

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
  // 34-02: a device change must fire the post-save /api/encoders/refresh
  // re-detect so the Detected pill re-resolves for the new render node (the PUT
  // already invalidates the encoder cache on change — 34-01 MH-2).
  'gpu_device',
] as const;

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
  // 34-02: live /dev/dri/renderD* probe list for the GPU-Device picker (server-
  // probed in page.tsx, prop-fed = zero client fetch on Settings — D1=A). [] on
  // a single-GPU / no-DRI host → the picker shows Auto only.
  renderDevices?: RenderDeviceOption[];
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

  // 26-02 (F5, AC-9): P3 arm-state for the in-place replace one-way-door. The
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
      // 26-01 (F3): central-path validation messages (cause+fix wording).
      sidecarCentralPathAbsolute: tValidation('sidecarCentralPathAbsolute'),
      sidecarCentralPathForbidden: tValidation('sidecarCentralPathForbidden'),
      // 33-02: trash-path client validation + the server-only nested-share key.
      trashPathAbsolute: tValidation('trashPathAbsolute'),
      trashPathForbidden: tValidation('trashPathForbidden'),
      trash_path_nested_under_share: tValidation('trash_path_nested_under_share'),
      // 34-02: client-mirror device-format message (defensive; Select-constrained).
      gpuDeviceFormat: tValidation('gpuDeviceFormat'),
      cropOverrideFormat: tValidation('cropOverrideFormat'),
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
      // 26-02 (F5, AC-9): one-way-door gate. If 'replace' is selected but the
      // operator has not armed it via the P3 ConfirmButton, strip output_mode
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
            // 33-02 (audit-SR-2): server field-level rejections that cannot be
            // client-validated (e.g. nested-under-share — the form has no share
            // list). Maps the field error onto the field so the operator sees
            // the cause AT the input (mirror share-add-form.tsx).
            error?: string;
            fieldErrors?: Record<string, string>;
          } | null;
          toast.error(t('error.save'));
          // 33-02: surface server fieldErrors at their fields. The message key
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
            {/* 28-10: each encoder-tab section is its own sibling file. The three
                Output-Container / Sidecar / Output-Mode wrapper Cards keep their
                <Card> shell in the orchestrator and host the relocated
                field-components (single thin composition seam). */}
            <EncoderConfigCard
              control={form.control}
              t={t}
              localizeError={localizeError}
              detection={detection}
            />

            {/* 34-02 (D3=A): GPU-Device picker — own Card directly AFTER the
                Encoder card. Surfaces the live /dev/dri/renderD* probe so a
                multi-GPU operator can pin the Arc dGPU instead of the first-
                enumerated iGPU. Auto / single-GPU / unset = byte-identical pre-34. */}
            <Card>
              <CardHeader>
                <CardTitle>{t('section.gpuDevice.title')}</CardTitle>
                <CardDescription>{t('section.gpuDevice.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <GpuDeviceField control={form.control} t={t} renderDevices={renderDevices} />
              </CardContent>
            </Card>

            {/* 44-01 (G1): consolidate 35-02 auto-crop + 43-01 10bit + 43-03 colour
                into one Encoding-Profile card; id anchors preserved as sub-sections
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
              pickerRunId={pickerRunId}
              pickerMode={pickerMode}
              pickerSource={pickerSource}
              pickerModeSource={pickerModeSource}
              onPickerChange={handlePickerChange}
              applyButtonRunId={applyButtonRunId}
              applyButtonMeta={applyButtonMeta}
            />

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

            {/* 26-01 (F3): Sidecar location — off / beside (default) / central.
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
                {/* 33-02: originals-trash LOCATION (storage-routing field grouped
                    with the structurally-identical central-sidecar path). */}
                <TrashPathField control={form.control} t={t} localizeError={localizeError} />
              </CardContent>
            </Card>

            {/* 26-02 (F5): Output strategy — suffix sibling (default) vs in-place
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

            {/* 05-13: Minimum Savings Threshold — separates done-smaller from
                done-not-worth at the verify-step. Slider primitive used inline
                so getAriaValueText (audit S4) lands on the Thumb for SR
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

// 28-10: barrel re-exports preserve the public import surface of
// '@/components/settings/settings-form' after the L2 split — the 4 field-component
// test files and settings-client.tsx import from this path UNCHANGED (AC-3).
export { OutputContainerField } from './output-container-field';
export { SidecarModeField } from './sidecar-mode-field';
export { OutputModeField } from './output-mode-field';
export { OutputSuffixField } from './output-suffix-field';
