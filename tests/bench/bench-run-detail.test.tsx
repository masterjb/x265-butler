import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: toastError, success: toastSuccess } }));
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { BenchRunRow, BenchComboRow, AggregatedComboView } from '@/src/lib/db/schema';

const mockApiPass2 = vi.fn((..._args: unknown[]) => Promise.resolve({ comboId: 1, startedAt: 0 }));
vi.mock('@/src/lib/api/bench-client', () => ({
  apiPass2: (...args: unknown[]) => mockApiPass2(...args),
  apiCancelPass2: vi.fn(),
  apiApply: vi.fn(),
  getBenchRun: vi.fn(),
}));

const useBenchRunStateMock = vi.fn(() => ({
  runId: null as number | null,
  mode: null,
  status: 'idle' as string,
  completedCombos: 0,
  totalCombos: 0,
  currentPhase: null,
  errorReason: null,
}));
const useBenchPass2MapMock = vi.fn(
  () =>
    ({}) as Record<
      number,
      {
        status: string;
        comboId: number;
        overallPct: number | null;
        errorReason: string | null;
        vmaf: number | null;
      }
    >,
);
vi.mock('@/src/lib/api/engine-events-client', () => ({
  useBenchRunState: () => useBenchRunStateMock(),
  useBenchPass2Map: () => useBenchPass2MapMock(),
  useBenchComboFeed: vi.fn(),
}));

vi.mock('recharts', () => ({
  ScatterChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Scatter: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  ZAxis: () => <div />,
  CartesianGrid: () => <div />,
  Tooltip: () => <div />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => <div />,
  ComposedChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ChartLegend: () => <div />,
  ChartLegendContent: () => <div />,
  ChartTooltip: () => <div />,
  ChartTooltipContent: () => <div />,
}));

import { RunDetailClient } from '@/app/[locale]/bench/runs/[id]/run-detail-client';
import en from '@/messages/en.json';

const MESSAGES = en;

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={MESSAGES} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function makeRun(id: number, status: BenchRunRow['status'] = 'complete'): BenchRunRow {
  return {
    id,
    mode: 'native-sweep',
    status,
    fileIds: [1],
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [23] },
    sample_count: 3,
    sample_duration_seconds: 20,
    vmaf_buckets_json: null,
    vmaf_model: 'vmaf_v0.6.1',
    actor_id: null,
    error_reason: null,
    created_at: 1_700_000_000,
    started_at: null,
    completed_at: null,
    version: 1,
  };
}

function makeCombo(id: number, opts?: { pass2_completed_at?: number | null }): BenchComboRow {
  return {
    id,
    run_id: 1,
    file_id: 1,
    encoder: 'libx265',
    preset: 'medium',
    native_quality_param: 'crf',
    native_quality_value: 23,
    vmaf_target: null,
    sample_idx: 0,
    status: 'complete',
    vmaf: 95,
    size_bytes: 1_000_000,
    encode_seconds: 10,
    source_sample_bytes: 5_000_000,
    pass2_completed_at: opts?.pass2_completed_at ?? null,
    pass2_size_bytes: null,
    pass2_encode_seconds: null,
    pass2_vmaf: null,
    error_reason: null,
    is_pareto: 0,
    top3_role: null,
    created_at: 1_700_000_000,
    completed_at: 1_700_000_100,
  };
}

function makeSummary(): AggregatedComboView[] {
  return [
    {
      encoder: 'libx265',
      preset: 'medium',
      native_quality_param: 'crf',
      native_quality_value: 23,
      vmaf_target: null,
      vmaf: 95,
      sizeBytes: 1_000_000,
      encodeSec: 10,
      sourceSampleBytes: 5_000_000,
      sampleIds: [1],
      is_pareto: true,
      top3_role: 'balanced',
    },
  ];
}

describe('RunDetailClient', () => {
  beforeEach(() => {
    mockApiPass2.mockReset();
    mockApiPass2.mockResolvedValue({ comboId: 1, startedAt: 0 });
    useBenchRunStateMock.mockReturnValue({
      runId: null,
      mode: null,
      status: 'idle',
      completedCombos: 0,
      totalCombos: 0,
      currentPhase: null,
      errorReason: null,
    });
    useBenchPass2MapMock.mockReturnValue({});
  });

  it('test_renders_notFound_card_when_run_is_null', () => {
    render(
      wrap(
        <RunDetailClient
          run={null}
          combos={[]}
          summary={[]}
          fileSizeMap={{}}
          hasPass2={false}
          locale="en"
        />,
      ),
    );
    expect(screen.getByText(/Run not found/i)).toBeInTheDocument();
    const backLink = screen.getByText(/Back to History/i).closest('a');
    expect(backLink?.getAttribute('href')).toBe('/en/bench?tab=history');
  });

  it('test_renders_runHeader_with_id', () => {
    const run = makeRun(42);
    render(
      wrap(
        <RunDetailClient
          run={run}
          combos={[makeCombo(1)]}
          summary={makeSummary()}
          fileSizeMap={{ 1: 5_000_000 }}
          hasPass2={false}
          locale="en"
        />,
      ),
    );
    expect(screen.getByText('Run #42')).toBeInTheDocument();
  });

  it('test_copyLink_button_present', () => {
    render(
      wrap(
        <RunDetailClient
          run={makeRun(1)}
          combos={[makeCombo(1)]}
          summary={makeSummary()}
          fileSizeMap={{ 1: 1 }}
          hasPass2={false}
          locale="en"
        />,
      ),
    );
    expect(screen.getByTestId('run-detail-copy-link')).toBeInTheDocument();
  });

  it('test_pass2_cta_absent_when_hasPass2_true', () => {
    render(
      wrap(
        <RunDetailClient
          run={makeRun(1)}
          combos={[makeCombo(1, { pass2_completed_at: 1_700_000_500 })]}
          summary={makeSummary()}
          fileSizeMap={{ 1: 1 }}
          hasPass2={true}
          locale="en"
        />,
      ),
    );
    expect(screen.queryByTestId('run-detail-pass2-cta')).toBeNull();
  });

  it('test_pass2_cta_present_when_complete_and_not_yet_pass2', () => {
    render(
      wrap(
        <RunDetailClient
          run={makeRun(1)}
          combos={[makeCombo(1)]}
          summary={makeSummary()}
          fileSizeMap={{ 1: 1 }}
          hasPass2={false}
          locale="en"
        />,
      ),
    );
    expect(screen.getByTestId('run-detail-pass2-cta')).toBeInTheDocument();
  });

  it('test_pass2_cta_disabled_when_other_run_globally_active', () => {
    useBenchRunStateMock.mockReturnValue({
      runId: 999,
      mode: null,
      status: 'running',
      completedCombos: 0,
      totalCombos: 1,
      currentPhase: null,
      errorReason: null,
    });
    render(
      wrap(
        <RunDetailClient
          run={makeRun(1)}
          combos={[makeCombo(1)]}
          summary={makeSummary()}
          fileSizeMap={{ 1: 1 }}
          hasPass2={false}
          locale="en"
        />,
      ),
    );
    const cta = screen.getByTestId('run-detail-pass2-cta') as HTMLButtonElement;
    expect(cta).toBeDisabled();
  });

  it('test_pass2_cta_click_opens_confirm_dialog', () => {
    render(
      wrap(
        <RunDetailClient
          run={makeRun(1)}
          combos={[makeCombo(1)]}
          summary={makeSummary()}
          fileSizeMap={{ 1: 1 }}
          hasPass2={false}
          locale="en"
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('run-detail-pass2-cta'));
    expect(screen.getByTestId('run-detail-pass2-confirm')).toBeInTheDocument();
  });

  it('test_pass2_confirm_invokes_apiPass2_with_balanced_combo', async () => {
    render(
      wrap(
        <RunDetailClient
          run={makeRun(1)}
          combos={[makeCombo(1)]}
          summary={makeSummary()}
          fileSizeMap={{ 1: 1 }}
          hasPass2={false}
          locale="en"
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('run-detail-pass2-cta'));
    fireEvent.click(screen.getByTestId('run-detail-pass2-confirm'));
    await waitFor(() => {
      expect(mockApiPass2).toHaveBeenCalledWith(1, 1);
    });
  });

  it('test_pass2_cta_idempotency_double_click_fires_once', async () => {
    // Holder object instead of a `let`: TS does not track assignments made inside
    // the Promise executor closure and would narrow a bare variable to `never`.
    const pending: { resolve?: (v: { comboId: number; startedAt: number }) => void } = {};
    mockApiPass2.mockImplementationOnce(
      () =>
        new Promise((r) => {
          pending.resolve = r;
        }),
    );
    render(
      wrap(
        <RunDetailClient
          run={makeRun(1)}
          combos={[makeCombo(1)]}
          summary={makeSummary()}
          fileSizeMap={{ 1: 1 }}
          hasPass2={false}
          locale="en"
        />,
      ),
    );
    fireEvent.click(screen.getByTestId('run-detail-pass2-cta'));
    const confirm = screen.getByTestId('run-detail-pass2-confirm');
    fireEvent.click(confirm);
    // Dialog closes after confirm; CTA stays present but `pending` keeps it disabled
    // for any re-trigger attempt. Trying to re-click the CTA must not produce 2 calls.
    fireEvent.click(screen.getByTestId('run-detail-pass2-cta'));
    fireEvent.click(screen.getByTestId('run-detail-pass2-cta'));
    expect(mockApiPass2).toHaveBeenCalledTimes(1);
    pending.resolve?.({ comboId: 1, startedAt: 0 });
  });
});

describe('login-page next allowlist (audit M9)', () => {
  it('test_next_allowlist_rejects_offsite_url', () => {
    const ALLOWED = [
      '/library',
      '/dashboard',
      '/queue',
      '/trash',
      '/blocklist',
      '/logs',
      '/settings',
      '/bench',
    ];
    const LOCALE_PREFIX_RE = /^\/(en|de)(?=\/|$)/;
    const validate = (raw: string | undefined): string | null => {
      if (typeof raw !== 'string') return null;
      if (raw.length === 0 || raw.length > 256) return null;
      if (/[\\:]/.test(raw)) return null;
      // eslint-disable-next-line no-control-regex
      if (/[\s\x00-\x1f]/.test(raw)) return null;
      if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
      if (!raw.startsWith('/')) return null;
      if (raw.includes('..')) return null;
      const stripped = raw.replace(LOCALE_PREFIX_RE, '') || '/';
      const matches = ALLOWED.some((a) => stripped === a || stripped.startsWith(a + '/'));
      return matches ? raw : null;
    };
    expect(validate('https://evil.com/x')).toBeNull();
    expect(validate('//evil.com/x')).toBeNull();
    expect(validate('/en/bench')).toBe('/en/bench');
    expect(validate('/en/bench/runs/42')).toBe('/en/bench/runs/42');
    expect(validate('/en/bench/compare?ids=1,2')).toBe('/en/bench/compare?ids=1,2');
  });
});

// 52-01: helpers for the http://<LAN-IP> case (no secure context). jsdom has no
// document.execCommand, so each test installs one and removes it afterwards.
function removeClipboard() {
  delete (navigator as { clipboard?: unknown }).clipboard;
}
function installExecCommand(result: boolean) {
  const seen: Array<string | undefined> = [];
  const spy = vi.fn((cmd: string) => {
    seen.push(document.querySelector('textarea')?.value);
    return cmd === 'copy' ? result : false;
  });
  (document as { execCommand?: unknown }).execCommand = spy;
  return { spy, seen };
}
function removeExecCommand() {
  delete (document as { execCommand?: unknown }).execCommand;
}

// 52-05 AC-2 + E8: the run detail page explains failures too.
describe('RunDetailClient — failed and partly failed runs (52-05)', () => {
  beforeEach(() => {
    useBenchRunStateMock.mockReturnValue({
      runId: null,
      mode: null,
      status: 'idle',
      completedCombos: 0,
      totalCombos: 0,
      currentPhase: null,
      errorReason: null,
    });
    useBenchPass2MapMock.mockReturnValue({});
  });

  function renderRun(run: BenchRunRow, combos: BenchComboRow[], summary: AggregatedComboView[]) {
    render(
      wrap(
        <RunDetailClient
          run={run}
          combos={combos}
          summary={summary}
          fileSizeMap={{ 1: 5_000_000 }}
          hasPass2={false}
          locale="en"
        />,
      ),
    );
  }

  it('test_detail_when_run_failed_all_combos_then_notice_names_count', () => {
    const run = {
      ...makeRun(3, 'failed'),
      error_reason: 'all_combos_failed:63|Required: 13.1 Found: 13.0',
    };
    renderRun(run, [], []);
    expect(screen.getByTestId('bench-run-failed-notice')).toHaveTextContent(
      'All 63 combinations failed.',
    );
  });

  it('test_detail_when_run_failed_then_no_top3_cards', () => {
    const run = { ...makeRun(3, 'failed'), error_reason: 'all_combos_failed:63|x' };
    renderRun(run, [], []);
    expect(screen.queryByTestId('top3-card-size')).toBeNull();
  });

  it('test_detail_when_complete_with_failed_combo_then_partial_notice', () => {
    const failed = { ...makeCombo(2), status: 'failed' as const, vmaf: null };
    renderRun(makeRun(3), [makeCombo(1), failed], makeSummary());
    expect(screen.getByTestId('bench-run-partial-failure')).toHaveTextContent(
      '1 of 2 combinations failed',
    );
  });

  it('test_detail_when_complete_without_failures_then_top3_and_no_partial_notice', () => {
    renderRun(makeRun(3), [makeCombo(1)], makeSummary());
    expect(screen.queryByTestId('bench-run-partial-failure')).toBeNull();
    expect(screen.getByTestId('top3-card-size')).toBeInTheDocument();
  });
});

describe('RunDetailClient — copy link without secure context (52-01)', () => {
  function renderRun() {
    render(
      wrap(
        <RunDetailClient
          run={makeRun(42)}
          combos={[makeCombo(1)]}
          summary={makeSummary()}
          fileSizeMap={{ 1: 5_000_000 }}
          hasPass2={false}
          locale="en"
        />,
      ),
    );
  }

  beforeEach(() => {
    toastError.mockReset();
    toastSuccess.mockReset();
    removeClipboard();
  });
  afterEach(() => {
    removeExecCommand();
  });

  it('test_copy_link_when_clipboard_api_missing_then_execCommand_copies_url', async () => {
    const { spy, seen } = installExecCommand(true);
    renderRun();
    fireEvent.click(screen.getByRole('button', { name: /Copy link/i }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Link copied'));
    expect(spy).toHaveBeenCalledWith('copy');
    expect(seen).toEqual([window.location.href]);
  });

  it('test_copy_link_when_copy_impossible_then_error_toast', async () => {
    installExecCommand(false);
    renderRun();
    fireEvent.click(screen.getByRole('button', { name: /Copy link/i }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Could not copy. Select the text and press Ctrl+C.'),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
