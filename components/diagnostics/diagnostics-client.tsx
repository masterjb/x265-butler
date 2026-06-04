'use client';

// Phase 21 Plan 21-02 — Client wrapper for /diagnostics page.
//
// Owns the live DiagnosticsPayload state hydrated from Server Component
// initial render. RefreshButton mutates state; child sections render slices.
// /ui-ux-pro-max T0 D1=md: cards stack <md, grid 2-col >=md.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Container,
  Cpu,
  DatabaseZap,
  HardDrive,
  Info,
  MemoryStick,
  Package,
  ServerCog,
  ShieldX,
  Timer,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { AggregatedWarning, DiagnosticsPayload } from '@/src/lib/diagnostics/types';
import { DiagnosticsSection } from './diagnostics-section';
import { RefreshButton } from './refresh-button';
import { CopyReportButton } from './copy-report-button';
import { TestEncodeRunner } from './test-encode-runner';
import { EncoderReplayRunner } from './encoder-replay-runner';
import { FeedbackLinks } from './feedback-links';
import { RefreshContainerImageButton } from './refresh-container-image-button';
import type { TestEncodeResultSnapshot } from './test-encode-result-markdown';

// Plan 21-05: module-load kill-switch for the test-encode-evidence gate.
// Mirrors the 21-04 NEXT_PUBLIC_DIAGNOSTICS_BANNER_DISABLED module-load pattern
// so flipping the env var + container restart fully suppresses gate UX +
// copyReportGated / copyReportUnlocked audit emits.
const KILL_COPY_REPORT_GATE = process.env.NEXT_PUBLIC_DIAGNOSTICS_COPYREPORT_GATE_DISABLED === '1';

async function postLogEvent(event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/api/diagnostics/log-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
      keepalive: true,
    });
  } catch {
    // Best-effort audit-trail; never block UX on log-event failure.
  }
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Date(value).toISOString();
}

function severityIcon(severity: AggregatedWarning['severity']) {
  if (severity === 'error') return AlertCircle;
  return AlertTriangle;
}

// 24-03: map the hyphenated cache-resolution literal to the camelCase i18n key
// (S12 naming convention forbids hyphens in message keys).
const CACHE_RESOLUTION_I18N: Record<string, string> = {
  'mnt-cache': 'mntCache',
  'config-fallback': 'configFallback',
  'user-override': 'userOverride',
};

export function DiagnosticsClient({ initialPayload }: { initialPayload: DiagnosticsPayload }) {
  const t = useTranslations('diagnostics');
  const [payload, setPayload] = useState<DiagnosticsPayload>(initialPayload);
  // 21-02 UAT-extension B: lift last test-encode result to share with CopyReport
  // + FeedbackLinks so 3rd-party bug reports include functional-encoder evidence.
  const [lastTestEncodeResult, setLastTestEncodeResult] = useState<TestEncodeResultSnapshot | null>(
    null,
  );

  // Plan 21-05: derived gate-state (single source of truth = lastTestEncodeResult +
  // module-load constant). No useState; no useMemo (cheap boolean).
  const gated = !KILL_COPY_REPORT_GATE && lastTestEncodeResult === null;

  // StrictMode-safe once-emit refs (mirrors 21-03 app/error.tsx emittedRef pattern).
  const gatedEmitRef = useRef(false);
  const unlockEmitRef = useRef(false);

  useEffect(() => {
    if (KILL_COPY_REPORT_GATE) return;
    if (gated && !gatedEmitRef.current) {
      gatedEmitRef.current = true;
      void postLogEvent('copyReportGated', { source: 'diagnostics-client' });
    }
    if (!gated && lastTestEncodeResult !== null && !unlockEmitRef.current) {
      unlockEmitRef.current = true;
      void postLogEvent('copyReportUnlocked', {
        source: 'diagnostics-client',
        outcome: lastTestEncodeResult.outcome,
        encoderPicked: lastTestEncodeResult.encoderPicked,
      });
    }
  }, [gated, lastTestEncodeResult]);

  const {
    app,
    runtime,
    mounts,
    cache,
    devices,
    encoders,
    warnings,
    recentErrors,
    onboarding,
    cpu,
    blocklist,
    containerImage,
    slowRequests,
    slowQueries,
    webVitals,
  } = payload;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary" className="font-mono">
            {app.version} · {app.gitHash}
          </Badge>
          <span aria-hidden="true">·</span>
          <span>
            {t('generatedAt')}: {payload.generatedAt}
          </span>
        </div>
        <RefreshButton onPayload={setPayload} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DiagnosticsSection title={t('section.appInfo')} icon={Package}>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('app.version')}</dt>
            <dd className="font-mono">{app.version}</dd>
            <dt className="text-muted-foreground">{t('app.gitHash')}</dt>
            <dd className="font-mono">{app.gitHash}</dd>
            <dt className="text-muted-foreground">{t('app.committedAt')}</dt>
            <dd className="font-mono">{app.committedAtCET ?? formatBytes(app.committedAt)}</dd>
          </dl>
        </DiagnosticsSection>

        <DiagnosticsSection title={t('section.runtime')} icon={ServerCog}>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Node</dt>
            <dd className="font-mono">{runtime.nodeVersion}</dd>
            <dt className="text-muted-foreground">{t('runtime.platform')}</dt>
            <dd className="font-mono">
              {runtime.platform} / {runtime.arch}
            </dd>
            <dt className="text-muted-foreground">{t('runtime.uptime')}</dt>
            <dd className="font-mono">{runtime.uptimeSec}s</dd>
            <dt className="text-muted-foreground">PID</dt>
            <dd className="font-mono">{runtime.pid}</dd>
            <dt className="text-muted-foreground">{t('onboarding.completed')}</dt>
            <dd className="font-mono">{onboarding.completed ? '✓' : '○'}</dd>
            <dt className="text-muted-foreground">{t('onboarding.hasShare')}</dt>
            <dd className="font-mono">{onboarding.hasShare ? '✓' : '○'}</dd>
          </dl>
          <div className="mt-3">
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">
              {t('mounts.heading')}
            </h3>
            <ul className="space-y-1 text-sm">
              {mounts.length === 0 && (
                <li className="text-muted-foreground italic">{t('mounts.none')}</li>
              )}
              {mounts.map((m) => (
                <li key={m.path} className="flex items-center justify-between gap-2 font-mono">
                  <span>{m.path}</span>
                  <span className="text-xs">
                    {m.readable ? 'R' : '·'}
                    {m.writable ? 'W' : '·'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </DiagnosticsSection>

        {/* 24-03 (F2): DC-B cache resolution surface. Mount-adjacent — placed
            after Runtime/Mounts. Evidence-only; resolution badge uses text not
            colour-only. amber advisory line iff config-fallback. */}
        <DiagnosticsSection title={t('cache.title')} icon={HardDrive}>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('cache.labelEffective')}</dt>
            <dd className="font-mono break-all">{cache.effectivePath || '—'}</dd>
            <dt className="text-muted-foreground">{t('cache.labelResolution')}</dt>
            <dd>
              <Badge
                variant={cache.resolution === 'config-fallback' ? 'warning' : 'secondary'}
                data-testid="diagnostics-cache-resolution"
              >
                {t(`cache.resolution.${CACHE_RESOLUTION_I18N[cache.resolution]}`)}
              </Badge>
            </dd>
            <dt className="text-muted-foreground">{t('cache.labelSetting')}</dt>
            <dd className="font-mono break-all">{cache.settingValue ?? t('cache.autoValue')}</dd>
            <dt className="text-muted-foreground">{t('cache.labelWritable')}</dt>
            <dd className="font-mono">{cache.writable ? '✓' : '✗'}</dd>
          </dl>
          {cache.advisory === 'config-fallback-space' && (
            <div
              role="status"
              className="mt-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-100 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{t('cache.advisory')}</span>
            </div>
          )}
        </DiagnosticsSection>

        <DiagnosticsSection
          title={t('section.encoders')}
          icon={Cpu}
          actions={<EncoderReplayRunner initialPayload={payload} onPayload={setPayload} />}
        >
          <p className="text-sm">
            <span className="text-muted-foreground">{t('encoders.detected')}: </span>
            <span className="font-mono">
              {encoders.detected.length > 0 ? encoders.detected.join(', ') : t('encoders.none')}
            </span>
          </p>
          <p className="mt-1 text-sm">
            <span className="text-muted-foreground">{t('encoders.devices')}: </span>
            <span className="font-mono">
              dri={devices.dri.length}, nvidia={devices.nvidia.length}
            </span>
          </p>
          {encoders.warnings.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {encoders.warnings.map((w, i) => (
                <li key={`${w.code}-${i}`} className="flex items-start gap-2">
                  <AlertTriangle
                    className="mt-0.5 size-4 shrink-0 text-amber-500"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="font-mono text-xs text-muted-foreground">{w.code}</span>
                    {w.message && <span className="ml-2">{w.message}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DiagnosticsSection>

        {/* 22-00 IMP-11 T0-decision D2: ContainerImage slot 4th cell right-of Encoders. */}
        <DiagnosticsSection
          title={t('containerImage.title')}
          icon={Container}
          actions={<RefreshContainerImageButton onPayload={setPayload} />}
        >
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('containerImage.labelOS')}</dt>
            <dd className="font-mono break-all">{containerImage.os.prettyName ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('containerImage.labelGlibc')}</dt>
            <dd className="font-mono">{containerImage.glibc.version ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('containerImage.labelIntelMediaDriver')}</dt>
            <dd className="font-mono break-all">
              {containerImage.drivers.intelMediaDriver.version ?? '—'} (
              {containerImage.drivers.intelMediaDriver.source ?? '—'})
            </dd>
            <dt className="text-muted-foreground">{t('containerImage.labelLibva')}</dt>
            <dd className="font-mono">{containerImage.drivers.libva.version ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('containerImage.labelLibdrm')}</dt>
            <dd className="font-mono">{containerImage.drivers.libdrm.version ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('containerImage.labelFfmpeg')}</dt>
            <dd className="font-mono">{containerImage.ffmpeg.version ?? '—'}</dd>
          </dl>
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {t('containerImage.labelConfigFlags')}
            </summary>
            <code className="mt-1 block break-all font-mono text-xs whitespace-pre-wrap">
              {containerImage.ffmpeg.configurationFlags?.join(' ') ?? '—'}
            </code>
          </details>
        </DiagnosticsSection>

        {/* 23-05: CPU/iGPU gen capability — adjacent to ContainerImage (both
            hardware/image capability surfaces). Evidence-only. HEVC-QSV value
            carries icon + text (never color-alone, WCAG AA). No animation →
            reduced-motion safe. */}
        <DiagnosticsSection title={t('cpu.title')} icon={Cpu}>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('cpu.labelVendor')}</dt>
            <dd className="font-mono">
              {cpu.vendorId ?? '—'}
              {cpu.isIntel ? ' (Intel)' : ''}
            </dd>
            <dt className="text-muted-foreground">{t('cpu.labelModelName')}</dt>
            <dd className="font-mono break-all">{cpu.modelName ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('cpu.labelFamilyModel')}</dt>
            <dd className="font-mono">
              {cpu.family ?? '—'} / {cpu.model ?? '—'}
            </dd>
            <dt className="text-muted-foreground">{t('cpu.labelMicroarch')}</dt>
            <dd className="font-mono">{cpu.microarch ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('cpu.labelGraphicsGen')}</dt>
            <dd className="font-mono">{cpu.graphicsGen ?? '—'}</dd>
            <dt className="text-muted-foreground">{t('cpu.labelHevcQsv')}</dt>
            <dd className="inline-flex items-center gap-1 font-mono">
              {cpu.hevcQsv === 'none' && (
                <AlertTriangle
                  className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
              )}
              <span
                className={
                  cpu.hevcQsv === 'none' ? 'text-amber-600 dark:text-amber-400' : undefined
                }
              >
                {t(`cpu.hevcQsv.${cpu.hevcQsv}`)}
              </span>
            </dd>
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">{t('cpu.gentableNote')}</p>
        </DiagnosticsSection>

        {/* 23-02: Render Devices — full-width row-list directly after ContainerImage
            (both GPU/driver-related). Evidence-only; mismatch row → amber + icon +
            text (never color-alone, WCAG AA). No animation → reduced-motion safe. */}
        <DiagnosticsSection
          title={t('renderDevices.title')}
          icon={MemoryStick}
          className="md:col-span-2"
        >
          {devices.renderDevices.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">{t('renderDevices.emptyState')}</p>
          ) : (
            <>
              <ul className="space-y-1">
                {devices.renderDevices.map((d, i) => (
                  <li key={`${d.path}-${i}`} className="break-all font-mono text-xs">
                    <span className="text-muted-foreground">{d.path}</span> ·{' '}
                    <span>
                      gid={d.gid ?? '—'}
                      {d.groupName ? `(${d.groupName})` : ''}
                    </span>{' '}
                    ·{' '}
                    <span>
                      {d.readable ? 'R' : '·'}
                      {d.writable ? 'W' : '·'}
                    </span>{' '}
                    ·{' '}
                    {!d.exists ? (
                      <span className="text-muted-foreground">{d.error ?? '—'}</span>
                    ) : d.inRenderGroup ? (
                      <span className="text-muted-foreground">✓ {t('renderDevices.inGroup')}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />✗{' '}
                        {t('renderDevices.notInGroup')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">{t('renderDevices.groupNote')}</p>
            </>
          )}
        </DiagnosticsSection>

        <DiagnosticsSection title={t('section.warnings')} icon={AlertTriangle}>
          {warnings.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">{t('warnings.none')}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {warnings.map((w, i) => {
                const Icon = severityIcon(w.severity);
                return (
                  <li key={`${w.source}-${w.code}-${i}`} className="flex items-start gap-2">
                    <Icon
                      className={`mt-0.5 size-4 shrink-0 ${w.severity === 'error' ? 'text-red-500' : 'text-amber-500'}`}
                      aria-hidden="true"
                    />
                    <div className="flex flex-col">
                      <span className="font-mono text-xs text-muted-foreground">
                        {w.source} · {w.code}
                      </span>
                      <span>{w.message}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </DiagnosticsSection>

        <DiagnosticsSection
          title={t('section.recentErrors')}
          icon={AlertCircle}
          className="md:col-span-2"
        >
          {recentErrors.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">{t('recentErrors.none')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {recentErrors.map((e, i) => (
                <li key={`${e.ts}-${i}`} className="flex flex-col gap-0 font-mono text-xs">
                  <span className="text-muted-foreground">
                    {new Date(e.ts).toISOString()} · lvl={e.level}
                    {e.source ? ` · ${e.source}` : ''}
                  </span>
                  <span className="break-all">{e.msg}</span>
                </li>
              ))}
            </ul>
          )}
        </DiagnosticsSection>

        {/* 22-00 IMP-8 T0-decision D3+D4: BlocklistEval full-width row-list
            (md:col-span-2); matched rows → amber text-prefix, PASS → muted. */}
        <DiagnosticsSection title={t('blocklist.title')} icon={ShieldX} className="md:col-span-2">
          <p className="mb-2 text-sm text-muted-foreground">
            {t('blocklist.pathDisclosureWarning')}
          </p>
          <p className="mb-2 text-sm text-muted-foreground">
            <span className="font-mono">{blocklist.totalEntries}</span>{' '}
            {t('blocklist.entriesLabel')} · {t('blocklist.cachedAtLabel')}:{' '}
            <span className="font-mono">{blocklist.patternCachedAt ?? '—'}</span>
          </p>
          {blocklist.recentEvaluations.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">{t('blocklist.emptyState')}</p>
          ) : (
            <ul className="space-y-1">
              {blocklist.recentEvaluations.map((entry, i) => (
                <li
                  key={`${entry.path}-${entry.matchedAt}-${i}`}
                  className="break-all font-mono text-xs"
                >
                  <span className="text-muted-foreground">{entry.matchedAt}</span> ·{' '}
                  <span>{entry.path}</span> ·{' '}
                  <span
                    className={
                      entry.matchedEntry
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground'
                    }
                  >
                    {entry.matchedEntry
                      ? `→ ${entry.matchedEntry.pattern ?? `id:${entry.matchedEntry.id}`}`
                      : 'PASS'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DiagnosticsSection>

        {/* 22-01 IMP-2 T0-decision D1=B: SlowRequests full-width row-list
            (md:col-span-2); 2-line shape mirrors RecentErrors (timestamp/msg)
            for breakdown-on-line-2 readability. D5=A plain muted-foreground
            v1 (threshold-coloring deferred to consumer-plan). */}
        <DiagnosticsSection title={t('slowRequests.title')} icon={Timer} className="md:col-span-2">
          {slowRequests.topN.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">{t('slowRequests.emptyState')}</p>
          ) : (
            <ul className="space-y-1">
              {slowRequests.topN.map((r, i) => (
                <li
                  key={`${r.atIso}-${r.route}-${i}`}
                  className="flex flex-col gap-0 font-mono text-xs"
                >
                  <span className="text-muted-foreground">
                    {r.atIso} · {r.route} · {r.durationMs.toFixed(0)}ms
                  </span>
                  {r.breakdown && Object.keys(r.breakdown).length > 0 && (
                    <span className="text-muted-foreground/70 break-all pl-4">
                      {Object.entries(r.breakdown)
                        .map(([k, v]) => `${k} ${v.toFixed(0)}`)
                        .join(' · ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DiagnosticsSection>

        {/* 22-01 IMP-3 T0-decision D2=A: SlowQueries full-width row-list
            (md:col-span-2); 1-line BlocklistEval-mirror — 3 fields = perfect
            pattern-match. */}
        <DiagnosticsSection
          title={t('slowQueries.title')}
          icon={DatabaseZap}
          className="md:col-span-2"
        >
          {slowQueries.topN.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">{t('slowQueries.emptyState')}</p>
          ) : (
            <ul className="space-y-1">
              {slowQueries.topN.map((q, i) => (
                <li
                  key={`${q.atIso}-${q.queryName}-${i}`}
                  className="break-all font-mono text-xs text-muted-foreground"
                >
                  {q.atIso} · {q.queryName} · {q.durationMs.toFixed(0)}ms
                </li>
              ))}
            </ul>
          )}
        </DiagnosticsSection>

        {/* 22-01 IMP-4 T0-decision D3=A: WebVitals row-list sibling-consistent
            with slow_requests/slow_queries (md:col-span-2 + per-route 1-line:
            route · TTFB · LCP · INP · n). D5=A plain muted-foreground v1. */}
        <DiagnosticsSection title={t('webVitals.title')} icon={Activity} className="md:col-span-2">
          {Object.keys(webVitals.byRoute).length === 0 ? (
            <p className="text-sm text-muted-foreground italic">{t('webVitals.emptyState')}</p>
          ) : (
            <ul className="space-y-1">
              {Object.entries(webVitals.byRoute)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([route, rv]) => {
                  const samples = Math.max(
                    rv.ttfb?.sampleSize ?? 0,
                    rv.lcp?.sampleSize ?? 0,
                    rv.inp?.sampleSize ?? 0,
                  );
                  const ttfb = rv.ttfb ? `${rv.ttfb.p75.toFixed(0)}ms` : '—';
                  const lcp = rv.lcp ? `${rv.lcp.p75.toFixed(0)}ms` : '—';
                  const inp = rv.inp ? `${rv.inp.p75.toFixed(0)}ms` : '—';
                  return (
                    <li key={route} className="break-all font-mono text-xs text-muted-foreground">
                      {route} · TTFB {ttfb} · LCP {lcp} · INP {inp} · n={samples}
                    </li>
                  );
                })}
            </ul>
          )}
        </DiagnosticsSection>

        {/* 21-02 UAT-extension: TestEncode + CopyReport side-by-side 50/50 >=md
            per /ui-ux-pro-max review. Mobile stays single-column via auto-flow. */}
        <DiagnosticsSection title={t('section.testEncode')} icon={Info}>
          <TestEncodeRunner onResult={setLastTestEncodeResult} />
        </DiagnosticsSection>

        <DiagnosticsSection title={t('section.copyReport')} icon={HardDrive}>
          <p className="mb-3 text-sm text-muted-foreground">{t('copyReport.description')}</p>
          <CopyReportButton
            lastTestEncodeResult={lastTestEncodeResult}
            generatedAt={payload.generatedAt}
            gated={gated}
          />
        </DiagnosticsSection>

        <DiagnosticsSection
          title={t('feedback.sectionHeading')}
          icon={Info}
          className="md:col-span-2"
        >
          <FeedbackLinks
            app={app}
            lastTestEncodeResult={lastTestEncodeResult}
            generatedAt={payload.generatedAt}
            gated={gated}
          />
        </DiagnosticsSection>
      </div>
    </div>
  );
}
