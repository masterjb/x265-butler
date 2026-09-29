'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BenchMode } from '@/src/lib/db/schema';
import type { BenchDefaults } from '@/components/bench/bench-defaults';
import { ENCODERS, PRESET_GROUPS } from '@/components/bench/bench-constants';
import { logger } from '@/src/lib/logger';

interface Props {
  defaults: BenchDefaults;
}

// 12-05 T3 Fix-B (M9 NaN guard): strict parse of legacy csv-format
// `bench_vmaf_buckets`. Returns null when the stored value does not satisfy
// the contract. Null triggers the legacy-recovery surface (banner + logger
// audit event) per AC-12 so a silent client-side migration is observable.
// 16-04: post-contract narrowed to exactly 3 integers in [0,100], strictly
// descending — pre-16-04 4-element values (e.g. '95,92,88,85') now return
// null and route through the existing recover-banner path.
type BucketTuple = [number, number, number];
function parseCsvBuckets(csv: string): BucketTuple | null {
  if (typeof csv !== 'string' || csv.trim() === '') return null;
  const parts = csv.replace(/\s+/g, '').split(',');
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number(p));
  // Number('') === 0 silently passes a typeof===number gate — Number.isFinite
  // + Number.isInteger reject empty / NaN / float in a single pass.
  if (nums.some((n) => !Number.isFinite(n) || !Number.isInteger(n))) return null;
  if (nums.some((n) => n < 0 || n > 100)) return null;
  if (!nums.every((n, i) => i === 0 || nums[i - 1] > n)) return null;
  return nums as BucketTuple;
}

type BucketError = null | 'outOfRange' | 'notDescending';
function validateBuckets(b: BucketTuple): BucketError[] {
  return b.map<BucketError>((v, i) => {
    if (v < 0 || v > 100) return 'outOfRange';
    if (i > 0 && v >= b[i - 1]) return 'notDescending';
    return null;
  });
}

export function BenchSettingsTab({ defaults }: Props) {
  const t = useTranslations('bench.settings');
  const router = useRouter();
  const [mode, setMode] = useState<BenchMode>(defaults.mode);
  const [encoders, setEncoders] = useState<string[]>(defaults.encoders);
  const [presets, setPresets] = useState<string[]>(defaults.presets);
  const [nativeValues, setNativeValues] = useState(defaults.nativeValues);
  const [sampleCount, setSampleCount] = useState(defaults.sampleCount);
  const [sampleDuration, setSampleDuration] = useState(defaults.sampleDurationSec);
  const [vmafModel, setVmafModel] = useState(defaults.vmafModel);
  // 12-05 T3 Fix-B: dedicated number-Inputs replace the single text-Input
  // csv-state. parseCsvBuckets() validates the persisted DB value; on null
  // the legacy-recovery surface (M4) fires once on mount + a banner gives
  // the operator a one-tap dismiss.
  // 16-04: count narrowed from 4 → 3; fallback default `[95, 92, 88]`.
  const parsedBuckets = parseCsvBuckets(defaults.vmafBuckets);
  const legacyRecovered = parsedBuckets === null;
  const initialBuckets: BucketTuple = parsedBuckets ?? [95, 92, 88];
  const [buckets, setBuckets] = useState<BucketTuple>(initialBuckets);
  const [legacyNoticeVisible, setLegacyNoticeVisible] = useState(legacyRecovered);
  const [saving, setSaving] = useState(false);

  const validationErrors = useMemo(() => validateBuckets(buckets), [buckets]);
  const allValid = validationErrors.every((e) => e === null);

  // 12-05 T3 AC-12 (M4 audit-trail): emit observable log event on mount when
  // a legacy/malformed bench_vmaf_buckets was recovered. SOC2 post-incident
  // reconstruction can correlate the row change with this client-side
  // migration instead of treating it as an unattributed operator edit.
  // try/catch guards the logger — observability must never block UX.
  // 16-04 audit-M1: useRef-guard ensures exactly-once emission under
  // React.StrictMode dev-double-mount (vitest case asserts call-count === 1).
  const legacyLoggedRef = useRef(false);
  useEffect(() => {
    if (!legacyRecovered || legacyLoggedRef.current) return;
    legacyLoggedRef.current = true;
    try {
      logger.info(
        { legacyValue: defaults.vmafBuckets },
        'bench_vmaf_buckets_legacy_format_recovered',
      );
    } catch {
      /* observability never blocks UX */
    }
    // Mount-only audit emission; capturing legacyRecovered/defaults.vmafBuckets
    // at first render is the intended semantic (one observable event per
    // legacy-recovery, not one-per-render).
  }, [legacyRecovered, defaults.vmafBuckets]);

  function updateBucket(i: number, raw: number) {
    setBuckets((prev) => {
      const next = [...prev] as BucketTuple;
      next[i] = raw;
      return next;
    });
    // First operator-edit clears the legacy banner so it never re-surfaces
    // post-edit (banner intent is "you didn't change this — defaults loaded").
    if (legacyNoticeVisible) setLegacyNoticeVisible(false);
  }

  function toggleEncoder(enc: string) {
    setEncoders((prev) => (prev.includes(enc) ? prev.filter((e) => e !== enc) : [...prev, enc]));
  }

  function togglePreset(p: string) {
    setPresets((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            bench_default_mode: mode,
            bench_default_encoders: encoders.join(','),
            bench_default_presets: presets.join(','),
            bench_default_native_values: nativeValues,
            bench_sample_count: String(sampleCount),
            bench_sample_duration_seconds: String(sampleDuration),
            bench_vmaf_model: vmafModel,
            // 12-05 T3 AC-6: csv-serialization preserves the API back-compat
            // contract (zod-validator at app/api/settings/route.ts:153-168
            // accepts the same csv-string shape).
            bench_vmaf_buckets: buckets.join(','),
          },
        }),
      });
      if (res.ok) {
        // 11-06 T6 fix: invalidate Next.js RSC cache so /bench server-component
        // re-reads the new settings on next navigation (otherwise EnqueueForm
        // stays pre-populated with stale defaults until hard-refresh).
        router.refresh();
        toast.success(t('saved'));
      } else {
        // Surface server-side zod validation issues to operator instead of
        // generic "save failed" so input-format errors (e.g. wrong count of
        // vmaf buckets) are actionable.
        try {
          const body = (await res.json()) as {
            details?: Array<{ path?: (string | number)[]; message?: string }>;
          };
          const first = body.details?.[0];
          const fieldKey = first?.path?.[first.path.length - 1];
          if (fieldKey === 'bench_vmaf_buckets') {
            toast.error(t('errors.vmafBuckets'));
          } else if (first?.message) {
            toast.error(`${t('saveFailed')}: ${first.message}`);
          } else {
            toast.error(t('saveFailed'));
          }
        } catch {
          toast.error(t('saveFailed'));
        }
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-8 max-w-2xl">
      {/* === Section: Sampling === */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground border-b pb-1.5 mb-3">
          {t('section.sampling')}
        </h3>
        <div className="space-y-1.5">
          <label htmlFor="bench-sample-count" className="text-sm font-medium">
            {t('sampleCount.label')}
          </label>
          <Input
            id="bench-sample-count"
            type="number"
            min={1}
            max={10}
            value={sampleCount}
            onChange={(e) => setSampleCount(parseInt(e.target.value, 10))}
          />
          <p className="text-xs text-muted-foreground">{t('sampleCount.help')}</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="bench-sample-duration" className="text-sm font-medium">
            {t('sampleDurationSeconds.label')}
          </label>
          <Input
            id="bench-sample-duration"
            type="number"
            min={5}
            max={60}
            value={sampleDuration}
            onChange={(e) => setSampleDuration(parseInt(e.target.value, 10))}
          />
          <p className="text-xs text-muted-foreground">{t('sampleDurationSeconds.help')}</p>
        </div>
      </section>

      {/* === Section: Default Matrix === */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground border-b pb-1.5 mb-3">
          {t('section.matrix')}
        </h3>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium mb-1">{t('mode.label')}</legend>
          <div className="space-y-1">
            {(['native-sweep', 'vmaf-anchored'] as BenchMode[]).map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="bench-default-mode"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                />
                {t(`mode.${m === 'native-sweep' ? 'native' : 'vmafAnchored'}`)}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('mode.help')}</p>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium mb-1">{t('encoders.label')}</legend>
          <div className="flex flex-wrap gap-3">
            {ENCODERS.map((enc) => (
              <label key={enc} className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  value={enc}
                  checked={encoders.includes(enc)}
                  onChange={() => toggleEncoder(enc)}
                />
                {enc}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('encoders.help')}</p>
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium mb-1">{t('presets.label')}</legend>
          <div className="grid grid-cols-3 gap-x-6 gap-y-0">
            {PRESET_GROUPS.map((group) => (
              <div key={group.key}>
                <p className="text-xs text-muted-foreground mb-1">{t(`presets.${group.key}`)}</p>
                <div className="space-y-1">
                  {group.presets.map((p) => (
                    <label key={p} className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        value={p}
                        checked={presets.includes(p)}
                        onChange={() => togglePreset(p)}
                      />
                      {p}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('presets.help')}</p>
        </fieldset>

        <div className="space-y-1.5">
          <label htmlFor="bench-native-values" className="text-sm font-medium">
            {t('nativeValues.label')}
          </label>
          <Input
            id="bench-native-values"
            type="text"
            value={nativeValues}
            onChange={(e) => setNativeValues(e.target.value)}
            placeholder="23,28"
          />
          <p className="text-xs text-muted-foreground">{t('nativeValues.help')}</p>
        </div>
      </section>

      {/* === Section: VMAF === */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground border-b pb-1.5 mb-3">
          {t('section.vmaf')}
        </h3>
        <div className="space-y-1.5">
          <label htmlFor="bench-vmaf-model" className="text-sm font-medium">
            {t('vmafModel.label')}
          </label>
          <Input
            id="bench-vmaf-model"
            type="text"
            maxLength={64}
            value={vmafModel}
            onChange={(e) => setVmafModel(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('vmafModel.help')}</p>
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t('vmafBuckets.label')}</p>
          {legacyNoticeVisible && (
            <div
              role="status"
              aria-live="polite"
              className="mb-2 flex items-start justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
            >
              <span className="flex-1">{t('vmafBuckets.legacyFormatRecovered')}</span>
              <button
                type="button"
                onClick={() => setLegacyNoticeVisible(false)}
                aria-label={t('vmafBuckets.dismissLegacyNotice')}
                className="shrink-0 underline hover:no-underline"
              >
                {t('vmafBuckets.dismissAction')}
              </button>
            </div>
          )}
          {/* 16-04 T1=1x3 horizontal row + M14 a11y binding carry-forward:
              DOM-order anchors to descending semantic via map-index 0→2
              (supersedes 12-05 T0=2x2-grid for 4-bucket). Tab traversal
              now reads 1→2→3 in single-row visual flow @ 375px viewport
              (~110px/col, h-9 touch-target meets WCAG-AA min via gap-3). */}
          <div className="grid grid-cols-3 gap-3">
            {([0, 1, 2] as const).map((i) => {
              const err = validationErrors[i];
              const inputId = `bench-vmaf-bucket-${i + 1}`;
              const errorId = `${inputId}-error`;
              return (
                <div key={i} className="space-y-1">
                  <label htmlFor={inputId} className="text-xs font-medium">
                    {t(`vmafBuckets.bucket${i + 1}.label`)}
                  </label>
                  {/* M14 (a) DOM-order anchored to descending semantic via the
                      natural map index 0→2 (16-04: was 0→3 pre-bucket-reduce);
                      M14 (b) sequence-position carried by the bucket{N}.label
                      translation itself (e.g. "Bucket 1 (höchste Qualität)") +
                      <label htmlFor> association — screen readers announce both
                      the descending semantic and the sequence position without
                      a separate aria-label key. */}
                  <Input
                    id={inputId}
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={buckets[i]}
                    onChange={(e) => updateBucket(i, Number(e.target.value))}
                    aria-invalid={err != null}
                    aria-describedby={err != null ? errorId : undefined}
                  />
                  {err != null && (
                    <p id={errorId} role="alert" className="text-xs text-destructive">
                      {t(`vmafBuckets.errors.${err}`)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">{t('vmafBuckets.help')}</p>
        </div>
      </section>

      <Button type="submit" disabled={saving || !allValid}>
        {t('save')}
      </Button>
    </form>
  );
}
