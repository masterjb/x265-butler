import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  EngineEventsProvider,
  useBenchRunState,
  useBenchComboFeed,
  useActiveJob,
  useRecentJobs,
  usePausedState,
  useQueueCounts,
} from '@/src/lib/api/engine-events-client';

// EventSource stub — same pattern as engine-events-client.test.tsx
type FakeEs = {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: ReturnType<typeof vi.fn>;
};

const captured: FakeEs[] = [];

const MockEventSource = vi.fn().mockImplementation(() => {
  const es: FakeEs = { onopen: null, onmessage: null, onerror: null, close: vi.fn() };
  captured.push(es);
  return es;
});

vi.stubGlobal('EventSource', MockEventSource);
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve({ ok: false })),
);

// --- Display helpers ---

function BenchStatusDisplay() {
  const b = useBenchRunState();
  return <div data-testid="bench-status">{b.status}</div>;
}

function BenchRunIdDisplay() {
  const b = useBenchRunState();
  return <div data-testid="bench-runid">{b.runId ?? 'null'}</div>;
}

function BenchProgressDisplay() {
  const b = useBenchRunState();
  return <div data-testid="bench-progress">{`${b.completedCombos}/${b.totalCombos}`}</div>;
}

function BenchErrorDisplay() {
  const b = useBenchRunState();
  return <div data-testid="bench-error">{b.errorReason ?? 'none'}</div>;
}

function OtherSlicesDisplay() {
  const activeJob = useActiveJob();
  const recentJobs = useRecentJobs();
  const paused = usePausedState();
  const counts = useQueueCounts();
  return (
    <div data-testid="other">
      {`${activeJob ? 'has-job' : 'no-job'}/${recentJobs.length}/${paused}/${counts.activeJobs}`}
    </div>
  );
}

function lastEs(): FakeEs {
  return captured[captured.length - 1];
}

function send(data: object) {
  act(() => {
    lastEs().onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  });
}

function renderProvider(ui: React.ReactNode) {
  return render(<EngineEventsProvider>{ui}</EngineEventsProvider>);
}

describe('bench SSE reducer — state transitions', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
  });

  it('test_bench_queued_event_transitions_status_to_queued_and_sets_runId', () => {
    renderProvider(
      <>
        <BenchStatusDisplay />
        <BenchRunIdDisplay />
      </>,
    );
    send({ type: 'bench.queued', runId: 5, mode: 'native-sweep', fileCount: 2, comboCount: 12 });
    expect(screen.getByTestId('bench-status').textContent).toBe('queued');
    expect(screen.getByTestId('bench-runid').textContent).toBe('5');
  });

  it('test_bench_started_event_transitions_status_to_running_when_runId_matches', () => {
    renderProvider(<BenchStatusDisplay />);
    send({ type: 'bench.queued', runId: 5, mode: 'native-sweep', fileCount: 1, comboCount: 4 });
    send({ type: 'bench.started', runId: 5, startedAt: 1000 });
    expect(screen.getByTestId('bench-status').textContent).toBe('running');
  });

  it('test_bench_started_event_ignored_when_runId_does_not_match', () => {
    renderProvider(<BenchStatusDisplay />);
    send({ type: 'bench.queued', runId: 5, mode: 'native-sweep', fileCount: 1, comboCount: 4 });
    send({ type: 'bench.started', runId: 99, startedAt: 1000 });
    expect(screen.getByTestId('bench-status').textContent).toBe('queued');
  });

  it('test_bench_progress_event_updates_combo_counts_when_runId_matches', () => {
    renderProvider(<BenchProgressDisplay />);
    send({ type: 'bench.queued', runId: 5, mode: 'native-sweep', fileCount: 1, comboCount: 12 });
    send({ type: 'bench.started', runId: 5, startedAt: 1000 });
    send({
      type: 'bench.progress',
      runId: 5,
      comboId: 1,
      fileId: 10,
      sampleIdx: 0,
      completedCombos: 3,
      totalCombos: 12,
      currentPhase: 'encoding',
    });
    expect(screen.getByTestId('bench-progress').textContent).toBe('3/12');
  });

  it('test_bench_completed_event_transitions_status_to_complete_when_runId_matches', () => {
    renderProvider(<BenchStatusDisplay />);
    send({ type: 'bench.queued', runId: 5, mode: 'native-sweep', fileCount: 1, comboCount: 4 });
    send({ type: 'bench.started', runId: 5, startedAt: 1000 });
    send({
      type: 'bench.completed',
      runId: 5,
      completedAt: 2000,
      paretoCount: 2,
      top3RoleCounts: { quality: 1, balanced: 1, size: 1 },
    });
    expect(screen.getByTestId('bench-status').textContent).toBe('complete');
  });

  it('test_bench_failed_event_transitions_status_to_failed_with_errorReason', () => {
    renderProvider(
      <>
        <BenchStatusDisplay />
        <BenchErrorDisplay />
      </>,
    );
    send({ type: 'bench.queued', runId: 5, mode: 'native-sweep', fileCount: 1, comboCount: 4 });
    send({ type: 'bench.failed', runId: 5, errorReason: 'ffmpeg crash' });
    expect(screen.getByTestId('bench-status').textContent).toBe('failed');
    expect(screen.getByTestId('bench-error').textContent).toBe('ffmpeg crash');
  });

  it('test_bench_cancelled_event_transitions_status_to_cancelled_when_runId_matches', () => {
    renderProvider(<BenchStatusDisplay />);
    send({ type: 'bench.queued', runId: 5, mode: 'native-sweep', fileCount: 1, comboCount: 4 });
    send({ type: 'bench.cancelled', runId: 5, cancelledAt: 1500 });
    expect(screen.getByTestId('bench-status').textContent).toBe('cancelled');
  });
});

describe('bench SSE reducer — existing slices unchanged', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
  });

  it('test_bench_events_do_not_mutate_activeJob_recentJobs_paused_counts', () => {
    renderProvider(<OtherSlicesDisplay />);
    // Verify initial state
    expect(screen.getByTestId('other').textContent).toBe('no-job/0/false/0');
    // Send several bench events
    send({ type: 'bench.queued', runId: 1, mode: 'native-sweep', fileCount: 1, comboCount: 4 });
    send({ type: 'bench.started', runId: 1, startedAt: 1000 });
    send({
      type: 'bench.progress',
      runId: 1,
      comboId: 1,
      fileId: 10,
      sampleIdx: 0,
      completedCombos: 1,
      totalCombos: 4,
      currentPhase: 'encoding',
    });
    // Other slices must remain byte-identical
    expect(screen.getByTestId('other').textContent).toBe('no-job/0/false/0');
  });
});

// 11-02-FIX (UAT-001): per-combo progress reducer cases.
function BenchComboPctDisplay() {
  const b = useBenchRunState();
  return (
    <div data-testid="combo-pct">{`${b.currentComboPct}/${b.currentComboOverallPct}/${b.currentComboId ?? 'null'}/${b.currentPhase ?? 'null'}`}</div>
  );
}

describe('bench SSE reducer — bench.combo_progress (11-02-FIX)', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
  });

  it('test_combo_progress_updates_pct_phase_comboId_when_runId_matches', () => {
    renderProvider(
      <>
        <BenchRunIdDisplay />
        <BenchComboPctDisplay />
      </>,
    );
    send({ type: 'bench.queued', runId: 7, mode: 'native-sweep', fileCount: 1, comboCount: 9 });
    send({
      type: 'bench.combo_progress',
      runId: 7,
      comboId: 3,
      phase: 'encode',
      phasePct: 42,
      overallPct: 35,
    });
    expect(screen.getByTestId('combo-pct').textContent).toBe('42/35/3/encode');
  });

  it('test_combo_progress_accepts_null_runId_race_and_latches_runId', () => {
    // Audit M4: bench.combo_progress can arrive before bench.queued (SSE buffer ordering).
    // Reducer must accept and latch ev.runId on null state.
    renderProvider(
      <>
        <BenchRunIdDisplay />
        <BenchComboPctDisplay />
      </>,
    );
    expect(screen.getByTestId('bench-runid').textContent).toBe('null');
    send({
      type: 'bench.combo_progress',
      runId: 7,
      comboId: 1,
      phase: 'encode',
      phasePct: 10,
      overallPct: 16,
    });
    expect(screen.getByTestId('bench-runid').textContent).toBe('7');
    expect(screen.getByTestId('combo-pct').textContent).toBe('10/16/1/encode');
  });

  it('test_combo_progress_rejected_when_state_runId_differs_from_event_runId', () => {
    renderProvider(
      <>
        <BenchRunIdDisplay />
        <BenchComboPctDisplay />
      </>,
    );
    send({ type: 'bench.queued', runId: 5, mode: 'native-sweep', fileCount: 1, comboCount: 4 });
    send({
      type: 'bench.combo_progress',
      runId: 99, // stale tab — different run
      comboId: 1,
      phase: 'vmaf',
      phasePct: 50,
      overallPct: 82,
    });
    expect(screen.getByTestId('bench-runid').textContent).toBe('5');
    expect(screen.getByTestId('combo-pct').textContent).toBe('0/0/null/null');
  });
});

describe('useBenchComboFeed — imperative fan-out', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
  });

  it('test_useBenchComboFeed_fires_callback_only_for_matching_runId', () => {
    const calls: number[] = [];

    function FeedConsumer({ runId }: { runId: number | null }) {
      useBenchComboFeed(runId, (ev) => {
        calls.push(ev.comboId);
      });
      return null;
    }

    render(
      <EngineEventsProvider>
        <FeedConsumer runId={5} />
      </EngineEventsProvider>,
    );

    // Matching runId — should fire
    act(() => {
      lastEs().onmessage?.({
        data: JSON.stringify({
          type: 'bench.combo_complete',
          runId: 5,
          comboId: 11,
          vmaf: 94.5,
          sizeBytes: 100000,
          encodeSec: 3.2,
        }),
      } as MessageEvent);
    });

    // Non-matching runId — must NOT fire
    act(() => {
      lastEs().onmessage?.({
        data: JSON.stringify({
          type: 'bench.combo_complete',
          runId: 99,
          comboId: 22,
          vmaf: 90.0,
          sizeBytes: 200000,
          encodeSec: 2.1,
        }),
      } as MessageEvent);
    });

    expect(calls).toEqual([11]);
  });
});
