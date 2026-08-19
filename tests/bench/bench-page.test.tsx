import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { BenchRunRow } from '@/src/lib/db/schema';

// Mock engine-events-client
vi.mock('@/src/lib/api/engine-events-client', () => ({
  useBenchRunState: vi.fn(() => ({
    runId: null,
    mode: null,
    status: 'idle',
    completedCombos: 0,
    totalCombos: 0,
    currentPhase: null,
    errorReason: null,
  })),
  useBenchComboFeed: vi.fn(),
  // 11-03: Pass-2 SSE slice
  useBenchPass2Map: vi.fn(() => ({})),
}));

// Mock bench-client fetch helpers
const mockGetBenchRun = vi.fn();
vi.mock('@/src/lib/api/bench-client', () => ({
  enqueueBenchRun: vi.fn(),
  listBenchRuns: vi.fn(() => Promise.resolve([])),
  getBenchRun: (...args: unknown[]) => mockGetBenchRun(...args),
  cancelBenchRun: vi.fn(),
  // 11-03: Pass-2 + apply wrappers
  apiPass2: vi.fn(),
  apiCancelPass2: vi.fn(),
  apiApply: vi.fn(),
}));

// Mock next/navigation
const mockGet = vi.fn(() => null as string | null);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => ({ get: mockGet }),
}));

// Mock recharts (used by ParetoScatterChart)
vi.mock('recharts', () => ({
  ScatterChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Scatter: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  ZAxis: () => <div />,
  CartesianGrid: () => <div />,
  Tooltip: () => <div />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { BenchClient } from '@/app/[locale]/bench/bench-client';

const MESSAGES = {
  bench: {
    form: {
      submit: 'Start Pass 1',
      mode: { label: 'Mode', native: 'Native Sweep', vmafAnchored: 'VMAF-anchored', help: '' },
      files: { label: 'File IDs', placeholder: '', help: '' },
      encoders: { label: 'Encoders', help: '' },
      presets: { label: 'Presets', placeholder: '', help: '' },
      nativeValues: { label: 'Native values', placeholder: '', help: '' },
      vmafTargets: { label: 'VMAF targets', placeholder: '', help: '' },
      advanced: {
        label: 'Advanced',
        sampleCount: 'Samples per file',
        sampleDuration: 'Sample duration',
        vmafModel: 'VMAF model',
      },
      errors: {
        required: 'Required',
        outOfRange: 'Out of range',
        tooMany: 'Too many',
        submitFailed: 'Submit failed',
      },
    },
    stepper: {
      pass1: { label: 'Pass 1' },
      pass2: { label: 'Pass 2', comingIn11_03: 'Coming in 11-03' },
      state: {
        idle: 'Idle',
        queued: 'Queued',
        running: 'Running',
        complete: 'Complete',
        failed: 'Failed',
        cancelled: 'Cancelled',
      },
      progressPill: '{completed} of {total} combos',
    },
    page: { emptyState: { title: 'No benchmarks yet', body: '', cta: 'Start a benchmark' } },
    errors: { runNotFound: 'Run not found' },
    terminal: {
      failed: { title: 'Run failed', body: '' },
      cancelled: { title: 'Cancelled', body: '' },
      newRun: 'Start new run',
    },
  },
};

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={MESSAGES} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const DEFAULTS = {
  mode: 'native-sweep' as const,
  encoders: ['libx265'],
  presets: ['veryfast', 'medium', 'slow'],
  nativeValues: '23,28',
  sampleCount: 3,
  sampleDurationSec: 20,
  vmafModel: 'vmaf_v0.6.1',
  vmafBuckets: '95,92,88',
};

function makeRun(id: number): BenchRunRow {
  return {
    id,
    mode: 'native-sweep',
    status: 'complete',
    fileIds: [1],
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [23] },
    sample_count: 3,
    sample_duration_seconds: 20,
    vmaf_buckets_json: null,
    vmaf_model: 'vmaf_v0.6.1',
    actor_id: null,
    error_reason: null,
    created_at: Math.floor(Date.now() / 1000) - 60,
    started_at: null,
    completed_at: null,
    version: 1,
  };
}

describe('BenchClient', () => {
  beforeEach(() => {
    mockGet.mockReturnValue(null);
    mockGetBenchRun.mockReset();
  });

  it('test_benchClient_renders_with_initialRuns_and_defaults', () => {
    const runs = [makeRun(1), makeRun(2)];
    render(
      wrap(
        <BenchClient
          initialRuns={runs}
          defaults={DEFAULTS}
          locale="en"
          historyTotalCount={runs.length}
          topBalancedByRunId={{}}
        />,
      ),
    );
    // Regression-defense: BenchRunList strip removed in 11-09; no listitem must render despite >=1 run
    expect(screen.queryByRole('listitem')).toBeNull();
    // Form submit button present
    expect(screen.getByRole('button', { name: 'Start Pass 1' })).toBeInTheDocument();
  });

  it('test_benchClient_url_runId_triggers_getBenchRun_on_mount', async () => {
    mockGet.mockReturnValue('7');
    mockGetBenchRun.mockResolvedValue({
      run: makeRun(7),
      combos: [],
      summary: [],
    });
    render(
      wrap(
        <BenchClient
          initialRuns={[makeRun(7)]}
          defaults={DEFAULTS}
          locale="en"
          historyTotalCount={1}
          topBalancedByRunId={{}}
        />,
      ),
    );
    await waitFor(() => {
      expect(mockGetBenchRun).toHaveBeenCalledWith(7);
    });
  });
});
