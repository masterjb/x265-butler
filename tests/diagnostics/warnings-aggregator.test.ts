// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { aggregateWarnings } from '@/src/lib/diagnostics/warnings-aggregator';
import type { DetectionWarning } from '@/src/lib/encode/detection';
import type { MountProbeResult } from '@/src/lib/diagnostics/types';

const emptyEncoders = { warnings: [] as DetectionWarning[] };
const noMount: MountProbeResult[] = [];

describe('aggregateWarnings', () => {
  it('all 4 sources contributing → 4+ entries with stable shapes', () => {
    const result = aggregateWarnings({
      encoders: {
        warnings: [
          { code: 'vainfo_binary_missing', severity: 'warn', detail: 'vainfo not installed' },
        ],
      },
      mountProbe: [{ path: '/media', readable: false, writable: false, error: 'ENOENT' }],
      onboardingCompleted: false,
      hasShare: false,
    });
    expect(result).toHaveLength(4);
    const sources = result.map((w) => w.source).sort();
    expect(sources).toEqual(['encoder', 'mount', 'onboarding', 'onboarding']);
  });

  it('encoder severity info → mapped to warn', () => {
    const result = aggregateWarnings({
      encoders: {
        warnings: [{ code: 'qsv_only_legacy_intel', severity: 'info', detail: 'legacy' }],
      },
      mountProbe: noMount,
      onboardingCompleted: true,
      hasShare: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('warn');
    expect(result[0].source).toBe('encoder');
    expect(result[0].code).toBe('qsv_only_legacy_intel');
  });

  it('de-dupe by (source, code) — duplicate collapses to 1', () => {
    const result = aggregateWarnings({
      encoders: {
        warnings: [
          { code: 'vainfo_binary_missing', severity: 'warn', detail: 'first' },
          { code: 'vainfo_binary_missing', severity: 'warn', detail: 'second-wins' },
        ],
      },
      mountProbe: noMount,
      onboardingCompleted: true,
      hasShare: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('second-wins');
  });

  it('encoder source throws → aggregator-self error emitted, other sources still processed', () => {
    const explodingWarnings = new Proxy([] as DetectionWarning[], {
      get(target, prop) {
        if (prop === Symbol.iterator) {
          throw new Error('boom');
        }
        return Reflect.get(target, prop);
      },
    });
    const result = aggregateWarnings({
      encoders: { warnings: explodingWarnings },
      mountProbe: [],
      onboardingCompleted: false,
      hasShare: true,
    });
    expect(result.find((w) => w.code === 'aggregator_source_failed')).toBeDefined();
    expect(result.find((w) => w.code === 'onboarding_incomplete')).toBeDefined();
  });

  it('all OK inputs → empty array', () => {
    const result = aggregateWarnings({
      encoders: emptyEncoders,
      mountProbe: [{ path: '/media', readable: true, writable: true }],
      onboardingCompleted: true,
      hasShare: true,
    });
    expect(result).toEqual([]);
  });

  it('mount-probe: readable but not writable → mount entry', () => {
    const result = aggregateWarnings({
      encoders: emptyEncoders,
      mountProbe: [{ path: '/cache', readable: true, writable: false, error: 'EACCES' }],
      onboardingCompleted: true,
      hasShare: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('mount');
    expect(result[0].code).toBe('EACCES');
    expect(result[0].severity).toBe('error');
  });

  it('mount-probe entry without error field → code = mount_inaccessible', () => {
    const result = aggregateWarnings({
      encoders: emptyEncoders,
      mountProbe: [{ path: '/cache', readable: false, writable: false }],
      onboardingCompleted: true,
      hasShare: true,
    });
    expect(result[0].code).toBe('mount_inaccessible');
  });

  it('onboarding incomplete + share missing → two onboarding entries', () => {
    const result = aggregateWarnings({
      encoders: emptyEncoders,
      mountProbe: noMount,
      onboardingCompleted: false,
      hasShare: false,
    });
    expect(result).toHaveLength(2);
    const codes = result.map((w) => w.code).sort();
    expect(codes).toEqual(['no_share_configured', 'onboarding_incomplete']);
  });

  it('empty inputs → empty array (no throws)', () => {
    expect(() =>
      aggregateWarnings({
        encoders: emptyEncoders,
        mountProbe: noMount,
        onboardingCompleted: true,
        hasShare: true,
      }),
    ).not.toThrow();
  });

  it('message field truncated to 200 chars', () => {
    const longDetail = 'x'.repeat(500);
    const result = aggregateWarnings({
      encoders: {
        warnings: [{ code: 'nvenc_no_runtime', severity: 'warn', detail: longDetail }],
      },
      mountProbe: noMount,
      onboardingCompleted: true,
      hasShare: true,
    });
    expect(result[0].message.length).toBeLessThanOrEqual(200);
  });
});
