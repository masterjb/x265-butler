// Phase 21 Plan 21-01 — composes warnings from four sources:
//   - encoder detection (DetectionWarning[])
//   - mount-probe results
//   - onboarding-completed flag
//   - share-configured flag
//
// Never throws upward. Per-source failure becomes an `aggregator_source_failed`
// entry (AC-4). De-dupes by `${source}:${code}` (last-write-wins).

import type { DetectionWarning } from '@/src/lib/encode/detection';
import type { AggregatedWarning, MountProbeResult } from './types';

const MESSAGE_CAP = 200;

export interface AggregateInput {
  encoders: { warnings: DetectionWarning[] };
  mountProbe: MountProbeResult[];
  onboardingCompleted: boolean;
  hasShare: boolean;
}

export function aggregateWarnings(input: AggregateInput): AggregatedWarning[] {
  const map = new Map<string, AggregatedWarning>();
  const put = (entry: AggregatedWarning): void => {
    map.set(`${entry.source}:${entry.code}`, entry);
  };
  const pushAggregatorFailure = (sourceLabel: string, err: unknown): void => {
    const detail = err instanceof Error ? err.message : String(err);
    map.set(`aggregator:${sourceLabel}_failed`, {
      severity: 'error',
      source: 'aggregator',
      code: 'aggregator_source_failed',
      message: `${sourceLabel}: ${detail}`.slice(0, MESSAGE_CAP),
    });
  };

  try {
    for (const w of input.encoders.warnings) {
      const severity: AggregatedWarning['severity'] = w.severity === 'info' ? 'warn' : w.severity;
      put({
        severity,
        source: 'encoder',
        code: w.code,
        message: (w.detail ?? w.code).slice(0, MESSAGE_CAP),
      });
    }
  } catch (err) {
    pushAggregatorFailure('encoder', err);
  }

  try {
    for (const m of input.mountProbe) {
      if (m.readable && m.writable) continue;
      const code = m.error ?? 'mount_inaccessible';
      put({
        severity: 'error',
        source: 'mount',
        code,
        message:
          `${m.path} readable=${m.readable} writable=${m.writable}` +
          (m.error ? ` error=${m.error}` : ''),
      });
    }
  } catch (err) {
    pushAggregatorFailure('mount', err);
  }

  try {
    if (!input.onboardingCompleted) {
      put({
        severity: 'warn',
        source: 'onboarding',
        code: 'onboarding_incomplete',
        message: 'First-run wizard has not been completed',
      });
    }
    if (!input.hasShare) {
      put({
        severity: 'warn',
        source: 'onboarding',
        code: 'no_share_configured',
        message: 'No media share configured — scan will fail',
      });
    }
  } catch (err) {
    pushAggregatorFailure('onboarding', err);
  }

  return Array.from(map.values());
}
