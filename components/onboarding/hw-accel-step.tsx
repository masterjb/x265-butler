'use client';

// Phase 18 Plan 18-02 — Onboarding wizard Step 2 (PRE-quality).
// 4 vendor-keyed branches: active / nvidia / software / legacyIntel.
// Triple-channel a11y: color (Tailwind palette) + Lucide-icon (distinct
// shapes) + text-label. role="region" + aria-labelledby on every branch.
//
// audit M2 — React.StrictMode dev-double-mount: useRef<boolean> exactly-once
// guard prevents POST /api/encoders/refresh from firing twice on mount.
//
// audit M5 — submitLockRef synchronous double-click guard on Test-now + CTAs.
//
// audit M6 — AbortController(10000ms) on every fetch; `/dev/dri` kernel hang
// must NEVER freeze wizard.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, CheckCircle2, Copy, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { DetectionPayload } from '@/components/onboarding/encoder-step';
import type { RenderDeviceOption } from '@/src/lib/api/settings-serialize';
import { NVENC_REQUIREMENTS } from '@/lib/encode/nvenc-requirements';
import { cn } from '@/lib/utils';

type Branch = 'active' | 'nvidia' | 'software' | 'legacyIntel';
type EncoderId = 'libx265' | 'nvenc' | 'qsv' | 'vaapi';

const FETCH_TIMEOUT_MS = 10_000;
const COPY_FEEDBACK_MS = 1_500;

export function resolveBranch(p: DetectionPayload): Branch {
  const warnings = (p as DetectionPayload & { warnings?: Array<{ code: string }> }).warnings ?? [];
  if (warnings.some((w) => w.code === 'qsv_only_legacy_intel')) return 'legacyIntel';
  if (warnings.some((w) => w.code === 'nvenc_no_runtime')) return 'nvidia';
  if (p.detected.some((e) => e !== 'libx265')) return 'active';
  return 'software';
}

export function HwAccelStep({
  cachedDetection,
  onDetectionResolved,
  onContinue,
  onBack,
  isSubmitting,
  selectedDevice = '',
  onDeviceSelected,
}: {
  cachedDetection: DetectionPayload | null;
  onDetectionResolved: (payload: DetectionPayload | 'error') => void;
  onContinue: () => void;
  onBack: () => void;
  isSubmitting: boolean;
  // 34-02: controlled GPU-device pick (Auto = ''). Owned by the parent wizard
  // so the choice survives step navigation. Optional — the 18-02 call-sites that
  // predate the picker keep compiling; the picker only renders once the device
  // list fetch returns nodes.
  selectedDevice?: string;
  onDeviceSelected?: (gpuDevice: string) => void;
}) {
  const t = useTranslations('onboarding.hwAccel');
  const tNav = useTranslations('onboarding.nav');
  const tRoot = useTranslations('onboarding');
  const [state, setState] = useState<DetectionPayload | 'error' | null>(cachedDetection);
  const [testInflight, setTestInflight] = useState(false);
  const probeFiredRef = useRef(false);
  const submitLockRef = useRef(false);
  // 34-02: render-node list for the device picker. SEPARATE state + fetch from
  // the detection probe (audit SR-1) so it is NOT gated by cachedDetection.
  const [devices, setDevices] = useState<RenderDeviceOption[]>([]);
  const devicesFiredRef = useRef(false);

  // 34-02 (audit SR-1): the device-list fetch lives in its OWN useEffect with a
  // fresh exactly-once guard. It MUST NOT be folded into the detection effect
  // below, which early-returns when cachedDetection is truthy — on a back-nav
  // return to step 2 the parent's detection is already non-null, so a folded
  // fetch would short-circuit and the picker would silently vanish on revisit.
  useEffect(() => {
    if (devicesFiredRef.current) return;
    devicesFiredRef.current = true;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    (async () => {
      try {
        const res = await fetch('/api/encoders/render-devices', { signal: controller.signal });
        if (!res.ok) return;
        const payload = (await res.json()) as unknown;
        // Empty / non-array → render NO picker (Auto-only = byte-identical default).
        if (Array.isArray(payload) && payload.length > 0) {
          setDevices(payload as RenderDeviceOption[]);
        }
      } catch {
        // Non-fatal: never block the wizard (audit M6 carry-forward). A failed
        // device probe simply leaves the picker hidden → Auto = pre-34 default.
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    if (cachedDetection) {
      setState(cachedDetection);
      return;
    }
    if (probeFiredRef.current) return;
    probeFiredRef.current = true;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    (async () => {
      try {
        const res = await fetch('/api/encoders/refresh', {
          method: 'POST',
          signal: controller.signal,
        });
        if (!res.ok) {
          setState('error');
          onDetectionResolved('error');
          return;
        }
        const payload = (await res.json()) as DetectionPayload;
        setState(payload);
        onDetectionResolved(payload);
      } catch {
        setState('error');
        onDetectionResolved('error');
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      clearTimeout(timeoutId);
      // No controller.abort() here: React.StrictMode dev-double-mount runs this
      // cleanup BETWEEN the two effect-fires that share probeFiredRef. Aborting
      // would error-out the in-flight fetch that should complete normally.
      // 10s timeout-abort still guards `/dev/dri` kernel hang (audit M6 carry-
      // forward). On real component unmount, React garbage-collects the
      // controller + setState becomes a no-op (React 18+ suppresses warning).
    };
  }, [cachedDetection, onDetectionResolved]);

  const handleTestNow = async () => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setTestInflight(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch('/api/encoders/refresh', {
        method: 'POST',
        signal: controller.signal,
      });
      if (!res.ok) {
        setState('error');
        onDetectionResolved('error');
        return;
      }
      const payload = (await res.json()) as DetectionPayload;
      setState(payload);
      onDetectionResolved(payload);
    } catch {
      setState('error');
      onDetectionResolved('error');
    } finally {
      clearTimeout(timeoutId);
      setTestInflight(false);
      submitLockRef.current = false;
    }
  };

  const handleContinue = () => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    try {
      onContinue();
    } finally {
      submitLockRef.current = false;
    }
  };

  const probing = state === null;
  const errored = state === 'error';
  const payload = !probing && !errored ? (state as DetectionPayload) : null;
  const branch: Branch | null = payload ? resolveBranch(payload) : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 p-8">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {tRoot('step2.headline')}
          </h1>
          <p className="text-base text-muted-foreground">{t('intent.body')}</p>
        </div>

        {/* 34-02 (audit SR-3): the device picker renders in the main body ABOVE
            the branch-panel aria-live block, so it precedes EVERY branch's
            continue affordance — including the nvidia branch's in-panel "Continue
            Anyway" (the generic Continue is suppressed for branch==='nvidia').
            Visible on ALL branches (multi-GPU is orthogonal to the vendor branch);
            only rendered once the fetch returns nodes. */}
        {devices.length > 0 && (
          <div className="flex flex-col gap-2">
            <label htmlFor="onboarding-gpu-device" className="text-sm font-medium">
              {t('device.label')}
            </label>
            <Select value={selectedDevice} onValueChange={(v) => onDeviceSelected?.(v ?? '')}>
              <SelectTrigger
                id="onboarding-gpu-device"
                className="w-full h-11"
                aria-label={t('device.label')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t('device.autoOption')}</SelectItem>
                {devices.map((d) => (
                  <SelectItem key={d.path} value={d.path}>
                    {d.node}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{t('device.description')}</p>
          </div>
        )}

        <div aria-live="polite" className="flex flex-col gap-3">
          {probing && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>{t('branch.nvidia.testNow.inflight')}</span>
            </div>
          )}

          {errored && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
                aria-hidden="true"
              />
              <span>{t('branch.nvidia.testNow.error')}</span>
            </div>
          )}

          {branch === 'active' && payload && <ActiveBranch payload={payload} />}

          {branch === 'nvidia' && (
            <NvidiaBranch
              testInflight={testInflight}
              onTestNow={handleTestNow}
              onContinueAnyway={handleContinue}
              isSubmitting={isSubmitting}
            />
          )}

          {branch === 'software' && <SoftwareBranch />}

          {branch === 'legacyIntel' && <LegacyIntelBranch />}
        </div>

        <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            disabled={isSubmitting}
            aria-disabled={isSubmitting}
          >
            {tNav('back')}
          </Button>
          {branch !== 'nvidia' && (
            <Button
              type="button"
              onClick={handleContinue}
              disabled={isSubmitting || probing}
              aria-disabled={isSubmitting || probing}
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {tNav('continue')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ActiveBranch({ payload }: { payload: DetectionPayload }) {
  const t = useTranslations('onboarding.hwAccel');
  const headingId = 'hw-accel-active-title';
  const hwEncoders = payload.detected.filter((e) => e !== 'libx265') as EncoderId[];
  return (
    <div
      role="region"
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-4"
    >
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />
        <h2
          id={headingId}
          className="text-base font-semibold text-emerald-900 dark:text-emerald-200"
        >
          {t('branch.active.title')}
        </h2>
      </div>
      <p className="text-sm text-foreground">{t('branch.active.body')}</p>
      <ul className="ml-1 flex flex-col gap-1 text-sm">
        {hwEncoders.map((enc) => (
          <li key={enc} className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
            {t(`branch.active.encoderLabel.${enc}`)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NvidiaBranch({
  testInflight,
  onTestNow,
  onContinueAnyway,
  isSubmitting,
}: {
  testInflight: boolean;
  onTestNow: () => void;
  onContinueAnyway: () => void;
  isSubmitting: boolean;
}) {
  const t = useTranslations('onboarding.hwAccel');
  const headingId = 'hw-accel-nvidia-title';
  return (
    <div
      role="region"
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-4"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
        <h2 id={headingId} className="text-base font-semibold text-amber-900 dark:text-amber-200">
          {t('branch.nvidia.title')}
        </h2>
      </div>
      <p className="text-sm text-foreground">{t('branch.nvidia.body')}</p>
      <ol className="ml-5 list-decimal space-y-1 text-sm text-foreground">
        <li>{t('branch.nvidia.steps.1')}</li>
        <li>{t('branch.nvidia.steps.2')}</li>
        <li>{t('branch.nvidia.steps.3')}</li>
        <li>{t('branch.nvidia.steps.4')}</li>
      </ol>
      <NvencRequirementsBlock />
      <div className="flex flex-col-reverse gap-2 pt-1 md:flex-row md:justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={onContinueAnyway}
          disabled={isSubmitting}
          aria-disabled={isSubmitting}
        >
          {t('branch.nvidia.continueAnyway')}
        </Button>
        <Button
          type="button"
          onClick={onTestNow}
          disabled={isSubmitting || testInflight}
          aria-disabled={isSubmitting || testInflight}
        >
          {testInflight && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {testInflight ? t('branch.nvidia.testNow.inflight') : t('branch.nvidia.testNow.label')}
        </Button>
      </div>
    </div>
  );
}

function SoftwareBranch() {
  const t = useTranslations('onboarding.hwAccel');
  const headingId = 'hw-accel-software-title';
  return (
    <div
      role="region"
      aria-labelledby={headingId}
      className={cn(
        'flex flex-col gap-3 rounded-md border p-4',
        'border-blue-500/40 bg-blue-500/10',
      )}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />
        <h2 id={headingId} className="text-base font-semibold text-blue-900 dark:text-blue-200">
          {t('branch.software.title')}
        </h2>
      </div>
      <p className="text-sm text-foreground">{t('branch.software.body')}</p>
      <a
        href="/README.md#hardware-acceleration"
        className="self-start text-sm text-primary underline-offset-4 hover:underline"
      >
        {t('branch.software.readmeLink')}
      </a>

      {/* 23-06 D1=A: opt-in NVIDIA hint — info/muted (NOT amber), subordinate to
          the primary software-encoding message. Renders ONLY on this branch. */}
      <div className="mt-1 flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold text-foreground">
              {t('branch.software.nvidiaHint.title')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('branch.software.nvidiaHint.body')}</p>
          </div>
        </div>
        <NvencRequirementsBlock />
      </div>
    </div>
  );
}

function LegacyIntelBranch() {
  const t = useTranslations('onboarding.hwAccel');
  const headingId = 'hw-accel-legacy-intel-title';
  return (
    <div
      role="region"
      aria-labelledby={headingId}
      className={cn(
        'flex flex-col gap-3 rounded-md border p-4',
        'border-blue-500/40 bg-blue-500/10',
      )}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 rotate-180" aria-hidden="true" />
        <h2 id={headingId} className="text-base font-semibold text-blue-900 dark:text-blue-200">
          {t('branch.legacyIntel.title')}
        </h2>
      </div>
      <p className="text-sm text-foreground">{t('branch.legacyIntel.body')}</p>
    </div>
  );
}

// 23-06 — single shared NVENC requirements block, consumed by SoftwareBranch
// (opt-in hint) AND NvidiaBranch (nvenc_no_runtime remediation). Renders the
// Extra-Parameter (one copy) + the two unRAID Variables, each exposing Name and
// Value as SEPARATE bare copy targets (AUDIT-M1 — never a joined KEY=value).
function NvencRequirementsBlock() {
  const t = useTranslations('onboarding.hwAccel');
  // Per-button feedback keyed by field-id (NOT a shared boolean): up to 5 copy
  // buttons coexist across the two surfaces, so one copy must flip only its own
  // checkmark (audit-S2). Single timer; cleared on unmount — no setState-after-
  // unmount, consistent with this file's timeout discipline.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopiedId(null), COPY_FEEDBACK_MS);
    } catch {
      // Non-fatal: clipboard API unavailable — operator copies from the visible
      // <code> block. No state flip so no false success-feedback.
    }
  };

  const copyButton = (id: string, text: string, ariaLabel: string) => (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => handleCopy(id, text)}
      aria-label={ariaLabel}
      className="min-h-[44px] shrink-0"
    >
      {copiedId === id ? (
        <Check className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  );

  const codeClass =
    'flex-1 break-all rounded border border-border bg-background px-2 py-1 font-mono text-xs';

  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {/* Extra-Parameter row — single bare copy target. */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t('nvenc.fieldLabel.extraParam')}
        </span>
        <div className="flex items-center gap-2">
          <code className={codeClass}>{NVENC_REQUIREMENTS.extraParam}</code>
          {copyButton(
            'extraParam',
            NVENC_REQUIREMENTS.extraParam,
            t('nvenc.copy.extraParam', { value: NVENC_REQUIREMENTS.extraParam }),
          )}
        </div>
      </div>

      {/* Variable rows — Name + Value as SEPARATE bare copy targets (AUDIT-M1). */}
      {NVENC_REQUIREMENTS.envVars.map((ev, i) => (
        <div key={ev.key} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t('nvenc.fieldLabel.envVar')}
          </span>
          <div className="flex items-center gap-2">
            <code className={codeClass}>
              <span className="text-muted-foreground">{t('nvenc.fieldLabel.name')}: </span>
              {ev.key}
            </code>
            {copyButton(`env-${i}-key`, ev.key, t('nvenc.copy.name', { value: ev.key }))}
          </div>
          <div className="flex items-center gap-2">
            <code className={codeClass}>
              <span className="text-muted-foreground">{t('nvenc.fieldLabel.value')}: </span>
              {ev.value}
            </code>
            {copyButton(`env-${i}-value`, ev.value, t('nvenc.copy.value', { value: ev.value }))}
          </div>
        </div>
      ))}
    </div>
  );
}
