'use client';

// Phase 16-02 T2 + T4: collapsible "Advanced options" section inside the
// Auto-Scan status card. Surfaces 4 operator-tunable knobs via PUT /api/settings.
//
// Layout decisions baked-in from PLAN T3 (pre-resolved via /ui-ux-pro-max):
//   - Default-state COLLAPSED (a)
//   - ChevronDown 200ms rotate-180 motion-safe (b)
//   - Vertical stack: Switch row + 3 number-input rows (c)
//   - Suffix-inside-input for unit-labels (d)
//   - Explicit Save button bottom-right (e)
//   - Triple-channel dirty/error encoding (f, g)
//   - h-11 mobile / h-9 desktop touch targets (Constraint Z.103)
//   - Initial-prop server-drilled — no client SWR fetch (h hydration-lock)

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { mutate } from 'swr';
import { AlertCircle, ChevronDown, Circle } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { AUTOSCAN_RANGES } from '@/src/lib/watch/autoscan-ranges';

const SETTINGS_URL = '/api/settings';
const HEALTH_URL = '/api/health';

export interface AutoScanAdvancedInitial {
  bootScanOnStart: 'true' | 'false';
  stabilityThreshold: string;
  batchWindow: string;
  reconcileIntervalH: string;
}

interface FieldState {
  stabilityThreshold: string;
  batchWindow: string;
  reconcileIntervalH: string;
}

type FieldKey = keyof FieldState;

const FIELD_TO_SETTING_KEY: Record<FieldKey, string> = {
  stabilityThreshold: 'autoScan.stabilityThreshold',
  batchWindow: 'autoScan.batchWindow',
  reconcileIntervalH: 'autoScan.reconcileIntervalH',
};

const FIELD_TO_ERROR_KEY: Record<FieldKey, string> = {
  stabilityThreshold: 'errorStabilityThresholdOutOfRange',
  batchWindow: 'errorBatchWindowOutOfRange',
  reconcileIntervalH: 'errorReconcileIntervalOutOfRange',
};

function validateField(key: FieldKey, raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return FIELD_TO_ERROR_KEY[key];
  const range = AUTOSCAN_RANGES[key];
  const n = range.kind === 'int' ? parseInt(trimmed, 10) : parseFloat(trimmed);
  if (!Number.isFinite(n)) return FIELD_TO_ERROR_KEY[key];
  if (n < range.min || n > range.max) return FIELD_TO_ERROR_KEY[key];
  // Reject decimal in int fields (e.g. "5.5" for stabilityThreshold)
  if (range.kind === 'int' && !/^\d+$/.test(trimmed)) return FIELD_TO_ERROR_KEY[key];
  return null;
}

export function AutoScanAdvanced({ initial }: { initial: AutoScanAdvancedInitial }) {
  const t = useTranslations('settings.autoScan');
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState<AutoScanAdvancedInitial>(initial);
  const [bootScanOnStart, setBootScanOnStart] = useState<'true' | 'false'>(initial.bootScanOnStart);
  const [fields, setFields] = useState<FieldState>({
    stabilityThreshold: initial.stabilityThreshold,
    batchWindow: initial.batchWindow,
    reconcileIntervalH: initial.reconcileIntervalH,
  });
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  // 20-02: hash-detection auto-open. When operator deeplinks from onboarding
  // AutoScanAwareness via /${locale}/settings#auto-scan-advanced, the
  // settings-client hash-handler (app/[locale]/settings/settings-client.tsx)
  // sets tab=general + scrollIntoView the Collapsible root; this effect
  // opens the Collapsible without an extra operator click. SSR-safe via
  // typeof window guard; single-fire on mount (no hashchange listener).
  // StrictMode dev double-mount is safe — setOpen(true) is idempotent when
  // the Collapsible is already open (Base UI Collapsible onOpenChange not
  // fired on same-value setState).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash === '#auto-scan-advanced') {
      setOpen(true);
    }
  }, []);

  const dirty =
    bootScanOnStart !== baseline.bootScanOnStart ||
    fields.stabilityThreshold !== baseline.stabilityThreshold ||
    fields.batchWindow !== baseline.batchWindow ||
    fields.reconcileIntervalH !== baseline.reconcileIntervalH;

  const hasErrors = Object.values(errors).some(Boolean);

  function onFieldChange(key: FieldKey, raw: string): void {
    setFields((prev) => ({ ...prev, [key]: raw }));
    // Clear error on edit; re-validate on blur.
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function onFieldBlur(key: FieldKey): void {
    const err = validateField(key, fields[key]);
    setErrors((prev) => ({ ...prev, [key]: err ?? undefined }));
  }

  async function onSave(): Promise<void> {
    // Pre-flight: validate all changed numeric fields.
    const next: Partial<Record<FieldKey, string>> = {};
    (Object.keys(fields) as FieldKey[]).forEach((k) => {
      if (fields[k] !== baseline[k]) {
        const err = validateField(k, fields[k]);
        if (err) next[k] = err;
      }
    });
    if (Object.keys(next).length > 0) {
      setErrors((prev) => ({ ...prev, ...next }));
      return;
    }

    const payload: Record<string, string> = {};
    if (bootScanOnStart !== baseline.bootScanOnStart) {
      payload['autoScan.bootScanOnStart'] = bootScanOnStart;
    }
    (Object.keys(fields) as FieldKey[]).forEach((k) => {
      if (fields[k] !== baseline[k]) {
        payload[FIELD_TO_SETTING_KEY[k]] = fields[k].trim();
      }
    });
    if (Object.keys(payload).length === 0) return;

    setSaving(true);
    try {
      const res = await fetch(SETTINGS_URL, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: payload }),
      });
      if (!res.ok) {
        if (res.status === 400) {
          const body = (await res.json().catch(() => null)) as {
            details?: Array<{ path?: string[]; message?: string }>;
          } | null;
          if (body?.details) {
            const fieldErrors: Partial<Record<FieldKey, string>> = {};
            for (const issue of body.details) {
              const settingKey = issue.path?.[1];
              for (const fk of Object.keys(FIELD_TO_SETTING_KEY) as FieldKey[]) {
                if (FIELD_TO_SETTING_KEY[fk] === settingKey) {
                  fieldErrors[fk] = FIELD_TO_ERROR_KEY[fk];
                }
              }
            }
            setErrors((prev) => ({ ...prev, ...fieldErrors }));
          }
          throw new Error('validation');
        }
        throw new Error(`status_${res.status}`);
      }
      toast.success(t('advancedSavedToast'));
      startTransition(() => {
        void mutate(SETTINGS_URL);
        void mutate(HEALTH_URL);
      });
      // Adopt saved values as the new baseline so dirty-flag clears.
      setBaseline({
        bootScanOnStart,
        stabilityThreshold: fields.stabilityThreshold,
        batchWindow: fields.batchWindow,
        reconcileIntervalH: fields.reconcileIntervalH,
      });
    } catch {
      toast.error(t('advancedSaveFailedToast'));
    } finally {
      setSaving(false);
    }
  }

  const saveDisabled = !dirty || hasErrors || saving;

  return (
    <Collapsible
      id="auto-scan-advanced"
      open={open}
      onOpenChange={setOpen}
      className="rounded-md border scroll-mt-20"
    >
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium',
          'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'h-11 md:h-auto md:py-2',
        )}
        aria-controls="auto-scan-advanced-panel"
      >
        <ChevronDown
          className={cn(
            'size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
            open ? 'rotate-180' : 'rotate-0',
          )}
          aria-hidden
        />
        <span>{t('advancedSectionTitle')}</span>
      </CollapsibleTrigger>
      <CollapsibleContent
        id="auto-scan-advanced-panel"
        className="border-t px-4 py-4"
        data-slot="auto-scan-advanced-panel"
      >
        <p className="text-muted-foreground mb-4 text-sm">{t('advancedSectionDescription')}</p>
        <div className="flex flex-col gap-6">
          {/* Row 1: bootScanOnStart Switch */}
          <div className="flex items-start justify-between gap-4 py-2">
            <label
              htmlFor="autoScan-bootScanOnStart"
              className="flex flex-1 flex-col gap-1 text-sm font-medium leading-none"
            >
              <span>{t('bootScanOnStartLabel')}</span>
              <span className="text-muted-foreground text-sm font-normal">
                {t('bootScanOnStartHelp')}
              </span>
            </label>
            <Switch
              id="autoScan-bootScanOnStart"
              checked={bootScanOnStart === 'true'}
              onCheckedChange={(v) => setBootScanOnStart(v ? 'true' : 'false')}
              aria-label={t('bootScanOnStartLabel')}
            />
          </div>

          {/* Rows 2-4: numeric inputs with suffix-unit */}
          <NumericField
            id="autoScan-stabilityThreshold"
            label={t('stabilityThresholdLabel')}
            help={t('stabilityThresholdHelp')}
            unit={t('stabilityThresholdUnit')}
            inputMode="numeric"
            pattern="\d+"
            min={AUTOSCAN_RANGES.stabilityThreshold.min}
            max={AUTOSCAN_RANGES.stabilityThreshold.max}
            value={fields.stabilityThreshold}
            error={errors.stabilityThreshold ? t(errors.stabilityThreshold) : null}
            onChange={(v) => onFieldChange('stabilityThreshold', v)}
            onBlur={() => onFieldBlur('stabilityThreshold')}
          />
          <NumericField
            id="autoScan-batchWindow"
            label={t('batchWindowLabel')}
            help={t('batchWindowHelp')}
            unit={t('batchWindowUnit')}
            inputMode="numeric"
            pattern="\d+"
            min={AUTOSCAN_RANGES.batchWindow.min}
            max={AUTOSCAN_RANGES.batchWindow.max}
            value={fields.batchWindow}
            error={errors.batchWindow ? t(errors.batchWindow) : null}
            onChange={(v) => onFieldChange('batchWindow', v)}
            onBlur={() => onFieldBlur('batchWindow')}
          />
          <NumericField
            id="autoScan-reconcileIntervalH"
            label={t('reconcileIntervalLabel')}
            help={t('reconcileIntervalHelp')}
            unit={t('reconcileIntervalUnit')}
            inputMode="decimal"
            pattern="\d+(\.\d+)?"
            min={AUTOSCAN_RANGES.reconcileIntervalH.min}
            max={AUTOSCAN_RANGES.reconcileIntervalH.max}
            step={0.05}
            value={fields.reconcileIntervalH}
            error={errors.reconcileIntervalH ? t(errors.reconcileIntervalH) : null}
            onChange={(v) => onFieldChange('reconcileIntervalH', v)}
            onBlur={() => onFieldBlur('reconcileIntervalH')}
          />

          <div className="mt-2 flex items-center justify-end gap-3 border-t pt-4">
            {dirty && (
              <span
                className="text-amber-700 dark:text-amber-300 inline-flex items-center gap-1.5 text-xs"
                data-slot="dirty-hint"
              >
                <Circle
                  className="size-2 fill-amber-500 text-amber-500 dark:fill-amber-400 dark:text-amber-400"
                  aria-hidden
                />
                <span>{t('advancedDirtyHint')}</span>
              </span>
            )}
            <Button
              type="button"
              onClick={() => void onSave()}
              disabled={saveDisabled}
              className="h-11 md:h-9"
              data-slot="autoScan-advanced-save"
            >
              {saving ? t('advancedSaveSavingButton') : t('advancedSaveButton')}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface NumericFieldProps {
  id: string;
  label: string;
  help: string;
  unit: string;
  inputMode: 'numeric' | 'decimal';
  pattern: string;
  min: number;
  max: number;
  step?: number;
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onBlur: () => void;
}

function NumericField(props: NumericFieldProps) {
  const errorId = `${props.id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={props.id} className="text-sm font-medium leading-none">
        {props.label}
      </label>
      <div className="relative">
        <Input
          id={props.id}
          type="number"
          inputMode={props.inputMode}
          pattern={props.pattern}
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={props.onBlur}
          aria-invalid={props.error ? 'true' : 'false'}
          aria-describedby={props.error ? errorId : undefined}
          className={cn(
            'h-11 pr-12 md:h-9',
            props.error && 'border-destructive focus-visible:ring-destructive',
          )}
        />
        <span className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm">
          {props.unit}
        </span>
      </div>
      {props.error ? (
        <div id={errorId} role="alert" className="text-destructive flex items-center gap-1 text-xs">
          <AlertCircle className="size-3.5 shrink-0" aria-hidden />
          <span>{props.error}</span>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{props.help}</p>
      )}
    </div>
  );
}
