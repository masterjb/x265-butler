'use client';

import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { logger } from '@/src/lib/logger';
import type { OutputPathProbe } from '@/src/lib/onboarding/probe-output-path';

// 03-05 Plan Task 2 — wizard step 2 (Scan path).
// audit S2 focus-management: scan_root input auto-focused on mount.
// audit M5: in-flight button-disable on Continue + Back.
//
// 23-03 — writable-gate: probe scan_root on Continue. When the probe reports
// writable:false, render an amber warning + override checkbox and gate Continue
// behind an explicit acknowledgment (design B). Fail-open on probe infra error;
// negative gate (block ONLY on writable===false); kill-switch bypass.

// 23-03 kill-switch (audit-added:SR3) — module-load constant, checked BEFORE any
// state/effect (mirrors the repo onboarding-surface kill-switch convention in
// CLAUDE.md). When '1', the Continue handler skips the probe entirely: no fetch,
// no warning, no checkbox, no events. NEXT_PUBLIC_* is build/start-baked, so a
// flip requires a container restart.
const WRITABLE_GATE_DISABLED = process.env.NEXT_PUBLIC_ONBOARDING_WRITABLE_GATE_DISABLED === '1';

const PROBE_TIMEOUT_MS = 10_000;

// Local copy of onboarding-client's fetchWithTimeout (NOT exported from the
// client — PathsStep stays self-contained per the onboarding-client boundary).
async function fetchWithTimeout(
  input: string,
  init: RequestInit & { method: string },
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

const pathsSchema = z.object({
  scan_root: z.string().min(1).startsWith('/', 'pathAbsolute'),
  min_size_mb: z.number().int().min(1).max(10000),
});

export type PathsStepValues = z.infer<typeof pathsSchema>;

export function PathsStep({
  initialValues,
  onContinue,
  onBack,
  isSubmitting,
}: {
  initialValues: { scan_root: string; min_size_mb: string };
  onContinue: (values: PathsStepValues) => void;
  onBack: () => void;
  isSubmitting: boolean;
}) {
  const t = useTranslations('onboarding');
  const tValidation = useTranslations('onboarding.validation');
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const submitLockRef = useRef(false);

  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<OutputPathProbe | null>(null);
  const [override, setOverride] = useState(false);

  const form = useForm<PathsStepValues>({
    resolver: zodResolver(pathsSchema),
    mode: 'onChange',
    defaultValues: {
      scan_root: initialValues.scan_root,
      min_size_mb: Number(initialValues.min_size_mb),
    },
  });

  useEffect(() => {
    // audit S2: auto-focus first input on mount.
    firstFieldRef.current?.focus();
  }, []);

  // When the operator edits the path, drop a stale non-writable verdict so a
  // fresh Continue re-probes (never trap the operator on an old result).
  const scanRoot = form.watch('scan_root');
  useEffect(() => {
    setProbeResult(null);
    setOverride(false);
  }, [scanRoot]);

  const scanRootError = form.formState.errors.scan_root?.message;
  const minSizeError = form.formState.errors.min_size_mb?.message;

  function localizeError(msg: string | undefined): string | undefined {
    if (!msg) return undefined;
    if (msg === 'pathAbsolute') return tValidation('scanRootRequired');
    return tValidation('minSizeRange');
  }

  const gated = probeResult?.writable === false;

  async function handleGatedSubmit(values: PathsStepValues): Promise<void> {
    // Single-flight guard (audit-added:SR6): wraps the WHOLE async body, released
    // in finally on EVERY exit path. A click while probing is a no-op.
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setProbing(true);
    try {
      // 0. Kill-switch — bypass the whole gate.
      if (WRITABLE_GATE_DISABLED) {
        onContinue(values);
        return;
      }

      // 2. Override already acknowledged → durable server ack trail (fail-open),
      //    emit the browser event once, then advance.
      if (override) {
        try {
          await fetchWithTimeout('/api/onboarding/probe-path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: values.scan_root, acknowledged: true }),
          });
        } catch {
          // fail-open: the browser event below + onContinue still proceed.
        }
        logger.info({ event: 'onboarding.pathsStep.writableOverrideAcknowledged' });
        onContinue(values);
        return;
      }

      // 3. First click → probe.
      let json: Partial<OutputPathProbe> | null = null;
      try {
        const res = await fetchWithTimeout('/api/onboarding/probe-path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: values.scan_root }),
        });
        if (!res.ok) {
          // Non-2xx → fail-open (AC-5).
          logger.warn({ event: 'onboarding.pathsStep.probeFailed', status: res.status });
          onContinue(values);
          return;
        }
        json = (await res.json()) as Partial<OutputPathProbe>;
      } catch {
        // Abort / network throw → fail-open (AC-5).
        logger.warn({ event: 'onboarding.pathsStep.probeFailed' });
        onContinue(values);
        return;
      }

      // NEGATIVE GATE (audit-added:SR2): block ONLY on writable===false; every
      // other 2xx outcome (writable:true, skip-stub, partial/malformed) advances.
      if (json?.writable === false) {
        setProbeResult(json as OutputPathProbe);
        return; // do NOT advance — render warning + checkbox.
      }
      onContinue(values);
    } finally {
      setProbing(false);
      submitLockRef.current = false;
    }
  }

  const { ref: scanRootHookRef, ...scanRootRest } = form.register('scan_root');
  const busy = isSubmitting || probing;

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 p-8">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {t('step3.headline')}
          </h1>
          <p className="text-base text-muted-foreground">{t('step3.body')}</p>
        </div>
        <form
          onSubmit={form.handleSubmit(handleGatedSubmit)}
          className="flex flex-col gap-5"
          noValidate
        >
          <div className="flex flex-col gap-2">
            <label htmlFor="scan_root" className="text-sm font-medium">
              {t('step3.field.scanRoot.label')}
            </label>
            <Input
              id="scan_root"
              type="text"
              placeholder={t('step3.field.scanRoot.placeholder')}
              autoComplete="off"
              {...scanRootRest}
              ref={(el) => {
                scanRootHookRef(el);
                firstFieldRef.current = el;
              }}
              aria-invalid={Boolean(scanRootError)}
              aria-describedby="scan_root-helper"
            />
            <p id="scan_root-helper" className="text-xs text-muted-foreground">
              {t('step3.field.scanRoot.helper')}
            </p>
            {scanRootError && (
              <p className="text-xs text-destructive" role="alert">
                {localizeError(scanRootError)}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="min_size_mb" className="text-sm font-medium">
              {t('step3.field.minSizeMb.label')}
            </label>
            <Input
              id="min_size_mb"
              type="number"
              min={1}
              max={10000}
              step={1}
              {...form.register('min_size_mb', { valueAsNumber: true })}
              aria-invalid={Boolean(minSizeError)}
              aria-describedby="min_size_mb-helper"
            />
            <p id="min_size_mb-helper" className="text-xs text-muted-foreground">
              {t('step3.field.minSizeMb.helper')}
            </p>
            {minSizeError && (
              <p className="text-xs text-destructive" role="alert">
                {localizeError(minSizeError)}
              </p>
            )}
          </div>

          {/* 23-03 writable-gate warning — amber callout (icon + text, never
              color alone; WCAG AA both themes). Mirrors hw-accel-step token shape. */}
          {gated && (
            <div
              role="alert"
              className="flex flex-col gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-4"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle
                  className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                  aria-hidden="true"
                />
                <h2 className="text-base font-semibold text-amber-900 dark:text-amber-200">
                  {t('step3.writableGate.warningHeading')}
                </h2>
              </div>
              <p className="text-sm text-foreground">{t('step3.writableGate.warningBody')}</p>
              <p className="text-sm text-muted-foreground">{t('step3.writableGate.fixHint')}</p>
              <label
                htmlFor="writable-gate-override"
                className="flex items-center gap-2 text-sm font-medium text-foreground"
              >
                <Checkbox
                  id="writable-gate-override"
                  checked={override}
                  onCheckedChange={(checked) => setOverride(checked === true)}
                />
                {t('step3.writableGate.overrideLabel')}
              </label>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={onBack}
              disabled={busy}
              aria-disabled={busy}
            >
              {t('nav.back')}
            </Button>
            <Button
              type="submit"
              disabled={busy || !form.formState.isValid || (gated && !override)}
              aria-disabled={busy || !form.formState.isValid || (gated && !override)}
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {t('nav.continue')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
