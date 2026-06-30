import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  EngineEventsProvider,
  usePausedState,
  useActiveJob,
  useActiveJobs,
  useQueueCounts,
  useEngineEventsDisconnected,
  useRecentJobs,
  useEngineEvents,
} from '@/src/lib/api/engine-events-client';

// EventSource is not available in jsdom — stub it so EngineEventsProvider can mount.
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
// rebootstrap calls /api/queue/status on onopen — stub fetch to return !ok (no state drift).
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve({ ok: false })),
);

// --- Tiny display components for hook assertions ---

function PausedDisplay() {
  const paused = usePausedState();
  return <div data-testid="paused">{paused ? 'paused' : 'running'}</div>;
}

function ActiveJobDisplay() {
  const j = useActiveJob();
  return <div data-testid="active-job">{j ? `job-${j.jobId}` : 'no-job'}</div>;
}

function ActiveJobEncoderDisplay() {
  const j = useActiveJob();
  return <div data-testid="active-job-encoder">{j?.encoder ?? 'no-encoder'}</div>;
}

// 43-02 (audit MH-1): exposes ActiveJob.speed so AC-2's store-apply clause has
// coverage. Renders 'null' when speed is null, 'no-job' when no active job.
function ActiveJobSpeedDisplay() {
  const j = useActiveJob();
  return <div data-testid="active-job-speed">{j ? String(j.speed) : 'no-job'}</div>;
}

function CountsDisplay() {
  const c = useQueueCounts();
  return <div data-testid="counts">{`${c.activeJobs}/${c.pendingJobs}`}</div>;
}

// 36-02: renders the sorted active-jobs list as "10,11" + the lowest-jobId
// single (back-compat) so a single component asserts both hooks stay consistent.
function ActiveJobsDisplay() {
  const jobs = useActiveJobs();
  const single = useActiveJob();
  return (
    <div>
      <div data-testid="active-jobs">{jobs.map((j) => j.jobId).join(',') || 'none'}</div>
      <div data-testid="active-jobs-meta">
        {jobs.map((j) => `${j.jobId}:${j.outTimeMs ?? '-'}:${j.encoder ?? '-'}`).join('|') ||
          'none'}
      </div>
      <div data-testid="active-single">{single ? `job-${single.jobId}` : 'no-job'}</div>
    </div>
  );
}

// 36-02 (S-cache): records how many DISTINCT array refs useActiveJobs returns
// across renders, to prove reference-stability on no-change re-renders.
const seenRefs = new Set<unknown>();
function ActiveJobsRefTracker() {
  const jobs = useActiveJobs();
  seenRefs.add(jobs);
  return <div data-testid="ref-count">{seenRefs.size}</div>;
}

function DisconnectedDisplay() {
  const d = useEngineEventsDisconnected();
  return <div data-testid="disc">{d ? 'disconnected' : 'connected'}</div>;
}

function RecentJobsDisplay() {
  const jobs = useRecentJobs();
  return <div data-testid="recent">{jobs.length}</div>;
}

function AllSlicesDisplay() {
  const e = useEngineEvents();
  return (
    <div data-testid="all">
      {`${e.activeJob ? 'a' : 'na'}/${e.recentJobs.length}/${e.paused}/${e.queueCounts.activeJobs}/${e.disconnected}`}
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

function renderProvider(ui: React.ReactNode, opts?: { initialPaused?: boolean }) {
  return render(
    <EngineEventsProvider initialPaused={opts?.initialPaused}>{ui}</EngineEventsProvider>,
  );
}

describe('EngineEventsProvider', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
  });

  it('test_provider_when_mounted_then_opens_EventSource_with_withCredentials', () => {
    renderProvider(<div />);
    expect(MockEventSource).toHaveBeenCalledWith('/api/events', { withCredentials: true });
  });

  it('test_provider_when_mounted_then_renders_children', () => {
    renderProvider(<div data-testid="child">hello</div>);
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});

describe('useRecentJobs + useEngineEvents aggregator', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
  });

  it('test_useRecentJobs_when_initial_then_empty_list', () => {
    renderProvider(<RecentJobsDisplay />);
    expect(screen.getByTestId('recent').textContent).toBe('0');
  });

  it('test_useEngineEvents_when_called_then_returns_all_5_slices', () => {
    renderProvider(<AllSlicesDisplay />, { initialPaused: false });
    expect(screen.getByTestId('all').textContent).toBe('na/0/false/0/false');
  });
});

describe('usePausedState', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
  });

  it('test_usePausedState_when_initialPaused_false_then_returns_false', () => {
    renderProvider(<PausedDisplay />, { initialPaused: false });
    expect(screen.getByTestId('paused').textContent).toBe('running');
  });

  it('test_usePausedState_when_initialPaused_true_then_returns_true', () => {
    renderProvider(<PausedDisplay />, { initialPaused: true });
    expect(screen.getByTestId('paused').textContent).toBe('paused');
  });
});

describe('useActiveJob — SSE reducer', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
  });

  it('test_useActiveJob_when_initial_then_null', () => {
    renderProvider(<ActiveJobDisplay />);
    expect(screen.getByTestId('active-job').textContent).toBe('no-job');
  });

  it('test_useActiveJob_when_job_started_event_then_sets_active_job', () => {
    renderProvider(<ActiveJobDisplay />);
    send({ type: 'job.started', jobId: 42, fileId: 7, encoder: 'libx265' });
    expect(screen.getByTestId('active-job').textContent).toBe('job-42');
  });

  // 2026-04-27 hotfix regression gate: encoder field from SSE payload populates
  // ActiveJob.encoder (was hardcoded null pre-fix; ActiveSlotCard badge never rendered).
  it('test_useActiveJob_when_job_started_event_with_encoder_then_active_job_encoder_set', () => {
    renderProvider(<ActiveJobEncoderDisplay />);
    send({ type: 'job.started', jobId: 99, fileId: 1, encoder: 'nvenc' });
    expect(screen.getByTestId('active-job-encoder').textContent).toBe('nvenc');
  });

  it('test_useActiveJob_when_job_progress_event_then_retains_active_job', () => {
    renderProvider(<ActiveJobDisplay />);
    send({ type: 'job.started', jobId: 5, fileId: 3, encoder: 'libx265' });
    send({
      type: 'job.progress',
      jobId: 5,
      fileId: 3,
      outTimeMs: 60_000,
      fps: 25,
      totalSize: 1024,
      frame: null,
      progress: 'continue',
    });
    expect(screen.getByTestId('active-job').textContent).toBe('job-5');
  });

  it('test_useActiveJob_when_job_completed_event_then_clears_active_job', () => {
    renderProvider(<ActiveJobDisplay />);
    send({ type: 'job.started', jobId: 1, fileId: 1, encoder: 'libx265' });
    send({
      type: 'job.completed',
      jobId: 1,
      fileId: 1,
      outcome: 'done-smaller',
      bytesIn: 1000,
      bytesOut: 500,
      durationMs: 1000,
    });
    expect(screen.getByTestId('active-job').textContent).toBe('no-job');
  });

  it('test_useActiveJob_when_job_failed_event_then_clears_active_job', () => {
    renderProvider(<ActiveJobDisplay />);
    send({ type: 'job.started', jobId: 2, fileId: 2, encoder: 'libx265' });
    send({ type: 'job.failed', jobId: 2, fileId: 2, exitCode: 1, errorMsg: 'crash' });
    expect(screen.getByTestId('active-job').textContent).toBe('no-job');
  });

  it('test_useActiveJob_when_job_cancelled_event_then_clears_active_job', () => {
    renderProvider(<ActiveJobDisplay />);
    send({ type: 'job.started', jobId: 3, fileId: 3, encoder: 'libx265' });
    send({ type: 'job.cancelled', jobId: 3, fileId: 3 });
    expect(screen.getByTestId('active-job').textContent).toBe('no-job');
  });

  // 05-13 UAT-fix: reducer must check identity before clearing activeJob.
  // Pre-fix bug: skipping a QUEUED Job B (not active) emitted job.cancelled
  // for B → reducer cleared activeJob unconditionally → encoding Job A's
  // progress bar froze in idle until Job A completed (job.progress events
  // for A were ignored because activeJob was null + early-return guard at
  // case 'job.progress'). Fix: only clear when event.jobId === activeJob.jobId.
  it('test_useActiveJob_when_job_cancelled_for_non_active_job_then_activeJob_unchanged', () => {
    renderProvider(<ActiveJobDisplay />);
    send({ type: 'job.started', jobId: 10, fileId: 1, encoder: 'libx265' });
    // Job 10 is now active. Cancelling Job 20 (queued-skip scenario) MUST NOT
    // touch activeJob — it's not the running job.
    send({ type: 'job.cancelled', jobId: 20, fileId: 2 });
    expect(screen.getByTestId('active-job').textContent).toBe('job-10');
  });

  it('test_useActiveJob_when_job_completed_for_non_active_job_then_activeJob_unchanged', () => {
    renderProvider(<ActiveJobDisplay />);
    send({ type: 'job.started', jobId: 11, fileId: 1, encoder: 'libx265' });
    // job.completed for Job 21 (defensive — should never happen in practice
    // since only encoding jobs complete, and only one is active. But the
    // reducer must be defensive against out-of-order or future changes.)
    send({
      type: 'job.completed',
      jobId: 21,
      fileId: 2,
      outcome: 'done-smaller',
      bytesIn: 1,
      bytesOut: 1,
      durationMs: 1,
    });
    expect(screen.getByTestId('active-job').textContent).toBe('job-11');
  });

  it('test_useActiveJob_when_job_failed_for_non_active_job_then_activeJob_unchanged', () => {
    renderProvider(<ActiveJobDisplay />);
    send({ type: 'job.started', jobId: 12, fileId: 1, encoder: 'libx265' });
    send({ type: 'job.failed', jobId: 22, fileId: 2, exitCode: 1, errorMsg: 'x' });
    expect(screen.getByTestId('active-job').textContent).toBe('job-12');
  });

  it('test_useActiveJob_when_job_cancelled_with_no_active_job_then_state_unchanged', () => {
    // Defensive: if activeJob is already null and a stray cancellation arrives,
    // the reducer must not throw and must keep state at null.
    renderProvider(<ActiveJobDisplay />);
    send({ type: 'job.cancelled', jobId: 99, fileId: 99 });
    expect(screen.getByTestId('active-job').textContent).toBe('no-job');
  });

  // 43-02 (AC-2): job.started inits ActiveJob.speed=null; job.progress applies speed.
  it('test_useActiveJob_when_job_started_then_speed_initialized_null', () => {
    renderProvider(<ActiveJobSpeedDisplay />);
    send({ type: 'job.started', jobId: 8, fileId: 4, encoder: 'libx265' });
    expect(screen.getByTestId('active-job-speed').textContent).toBe('null');
  });

  it('test_useActiveJob_when_job_progress_with_speed_then_applied_to_store', () => {
    renderProvider(<ActiveJobSpeedDisplay />);
    send({ type: 'job.started', jobId: 8, fileId: 4, encoder: 'libx265' });
    send({
      type: 'job.progress',
      jobId: 8,
      fileId: 4,
      outTimeMs: 60_000,
      fps: 25,
      totalSize: 1024,
      frame: null,
      speed: 2.0,
      progress: 'continue',
    });
    expect(screen.getByTestId('active-job-speed').textContent).toBe('2');
  });

  // 43-02 (AC-2): create-on-unknown branch (mid-join progress with no prior
  // job.started) rebuilds all fields incl. speed.
  it('test_useActiveJob_when_progress_for_unknown_job_then_speed_applied', () => {
    renderProvider(<ActiveJobSpeedDisplay />);
    send({
      type: 'job.progress',
      jobId: 77,
      fileId: 5,
      outTimeMs: 1000,
      fps: 24,
      totalSize: null,
      frame: null,
      speed: 1.5,
      progress: 'continue',
    });
    expect(screen.getByTestId('active-job-speed').textContent).toBe('1.5');
  });

  it('test_useActiveJob_when_progress_for_wrong_jobId_then_no_change', () => {
    renderProvider(<ActiveJobDisplay />);
    send({ type: 'job.started', jobId: 10, fileId: 5, encoder: 'libx265' });
    send({
      type: 'job.progress',
      jobId: 99,
      fileId: 5,
      outTimeMs: 1000,
      fps: 24,
      totalSize: null,
      frame: null,
      progress: 'continue',
    });
    // activeJob is still job-10 (different jobId ignored)
    expect(screen.getByTestId('active-job').textContent).toBe('job-10');
  });
});

// 36-02: multi-slot store — activeJobs map keyed by jobId fixes the parallelism>=2
// disappear bug. Each jobId owns its own slot; a sibling completing deletes only
// its key; an unknown-jobId progress CREATES a slot (mid-join reconstruct).
describe('useActiveJobs — multi-slot SSE reducer (36-02)', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
    seenRefs.clear();
  });

  it('test_useActiveJobs_when_two_job_started_then_both_tracked_independently', () => {
    renderProvider(<ActiveJobsDisplay />);
    send({ type: 'job.started', jobId: 10, fileId: 1, encoder: 'libx265' });
    send({ type: 'job.started', jobId: 11, fileId: 2, encoder: 'qsv' });
    expect(screen.getByTestId('active-jobs').textContent).toBe('10,11');
    // AC-1: 11's start does NOT overwrite 10.
    send({
      type: 'job.progress',
      jobId: 10,
      fileId: 1,
      outTimeMs: 5000,
      fps: 24,
      totalSize: 100,
      frame: null,
      progress: 'continue',
    });
    send({
      type: 'job.progress',
      jobId: 11,
      fileId: 2,
      outTimeMs: 9000,
      fps: 30,
      totalSize: 200,
      frame: null,
      progress: 'continue',
    });
    expect(screen.getByTestId('active-jobs-meta').textContent).toBe('10:5000:libx265|11:9000:qsv');
  });

  it('test_useActiveJobs_when_one_completes_then_other_persists_and_updates', () => {
    // THE BUG FIX (AC-2): completing 11 must leave 10 visible + updating.
    renderProvider(<ActiveJobsDisplay />);
    send({ type: 'job.started', jobId: 10, fileId: 1, encoder: 'libx265' });
    send({ type: 'job.started', jobId: 11, fileId: 2, encoder: 'qsv' });
    send({
      type: 'job.completed',
      jobId: 11,
      fileId: 2,
      outcome: 'done-smaller',
      bytesIn: 1,
      bytesOut: 1,
      durationMs: 1,
    });
    expect(screen.getByTestId('active-jobs').textContent).toBe('10');
    send({
      type: 'job.progress',
      jobId: 10,
      fileId: 1,
      outTimeMs: 7000,
      fps: 25,
      totalSize: 300,
      frame: null,
      progress: 'continue',
    });
    expect(screen.getByTestId('active-jobs-meta').textContent).toBe('10:7000:libx265');
  });

  it('test_useActiveJobs_when_progress_for_unknown_jobId_then_creates_slot', () => {
    // AC-6: mid-join reconnect — progress with no prior job.started CREATES the
    // slot (encoder null) so the bar reconstructs from server replay.
    renderProvider(<ActiveJobsDisplay />);
    send({
      type: 'job.progress',
      jobId: 77,
      fileId: 9,
      outTimeMs: 4000,
      fps: 20,
      totalSize: 50,
      frame: null,
      progress: 'continue',
    });
    expect(screen.getByTestId('active-jobs').textContent).toBe('77');
    expect(screen.getByTestId('active-jobs-meta').textContent).toBe('77:4000:-');
  });

  it('test_useActiveJobs_when_terminal_for_unknown_jobId_then_no_change', () => {
    renderProvider(<ActiveJobsDisplay />);
    send({ type: 'job.started', jobId: 10, fileId: 1, encoder: 'libx265' });
    send({ type: 'job.cancelled', jobId: 999, fileId: 99 });
    expect(screen.getByTestId('active-jobs').textContent).toBe('10');
  });

  it('test_useActiveJob_when_multiple_active_then_returns_lowest_jobId', () => {
    // Back-compat: useActiveJob === useActiveJobs[0] (lowest jobId).
    renderProvider(<ActiveJobsDisplay />);
    send({ type: 'job.started', jobId: 11, fileId: 2, encoder: 'qsv' });
    send({ type: 'job.started', jobId: 10, fileId: 1, encoder: 'libx265' });
    expect(screen.getByTestId('active-jobs').textContent).toBe('10,11');
    expect(screen.getByTestId('active-single').textContent).toBe('job-10');
    // Lowest completes → single advances to next-lowest.
    send({
      type: 'job.completed',
      jobId: 10,
      fileId: 1,
      outcome: 'done-smaller',
      bytesIn: 1,
      bytesOut: 1,
      durationMs: 1,
    });
    expect(screen.getByTestId('active-single').textContent).toBe('job-11');
  });

  it('test_useActiveJobs_when_map_unchanged_then_returns_stable_array_ref', () => {
    // S-cache: a no-change re-render (unrelated slice update) must NOT mint a new
    // array → exactly ONE distinct ref seen across renders.
    renderProvider(<ActiveJobsRefTracker />);
    send({ type: 'job.started', jobId: 10, fileId: 1, encoder: 'libx265' });
    const afterStart = Number(screen.getByTestId('ref-count').textContent);
    // queue.updated changes a DIFFERENT slice — activeJobs map ref is untouched.
    send({ type: 'queue.updated', activeJobs: 1, pendingJobs: 0 });
    send({ type: 'queue.updated', activeJobs: 1, pendingJobs: 2 });
    // No new activeJobs array ref minted by the unrelated updates.
    expect(Number(screen.getByTestId('ref-count').textContent)).toBe(afterStart);
  });
});

describe('useQueueCounts — queue.updated reducer', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
  });

  it('test_useQueueCounts_when_initial_then_zero_zero', () => {
    renderProvider(<CountsDisplay />);
    expect(screen.getByTestId('counts').textContent).toBe('0/0');
  });

  it('test_useQueueCounts_when_queue_updated_then_reflects_new_counts', () => {
    renderProvider(<CountsDisplay />);
    send({ type: 'queue.updated', activeJobs: 1, pendingJobs: 3 });
    expect(screen.getByTestId('counts').textContent).toBe('1/3');
  });
});

describe('useEngineEventsDisconnected', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
  });

  it('test_useEngineEventsDisconnected_when_initial_then_connected', () => {
    renderProvider(<DisconnectedDisplay />);
    expect(screen.getByTestId('disc').textContent).toBe('connected');
  });
});

// 28-02 R7 — unmount-cleanup PRESERVATION guards.
// NOTE (audit MH-2/MH-3): these are PRESERVATION/SMOKE guards, GREEN both before
// AND after the decouple. They do NOT pin the R7 change — they pin that the
// decouple did not regress unmount-cleanup. The actual R7 deliverable (the
// dedicated `[]`-dep banner-timer cleanup, decoupled from the visibility effect)
// is verified STRUCTURALLY by grep in the plan's <verification> block, not here.
const RECONNECT_BANNER_DELAY_MS = 5_000;

describe('EngineEventsProvider — unmount cleanup (28-02 R7)', () => {
  beforeEach(() => {
    captured.length = 0;
    MockEventSource.mockClear();
  });
  afterEach(() => {
    // SR-1: the onerror path fires probeAuth → fetch(HEAD) → a Math.random-jittered
    // reconnect timer that pushes a NEW EventSource to captured[]. Restore real
    // timers + clear captured so that reconnect cycle cannot leak into adjacent tests.
    vi.useRealTimers();
    captured.length = 0;
  });

  // AC-1 (PRESERVATION guard): banner timer scheduled by onerror does NOT fire
  // after the provider unmounts before RECONNECT_BANNER_DELAY_MS elapses.
  it('test_provider_when_unmounted_before_banner_delay_then_timer_does_not_flip_disconnected', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderProvider(<DisconnectedDisplay />);

    // Drive onerror — EngineEventsProvider.handleError schedules the 5s banner timer.
    // SR-1: capture the onerror-time EventSource BEFORE side-effects shift lastEs().
    const erroredEs = lastEs();
    act(() => {
      erroredEs.onerror?.(new Event('error'));
    });
    // Flush the probeAuth microtask (fetch stubbed {ok:false} → 'reconnect') while
    // still mounted, so its reconnect timer is registered and then cleared by unmount.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Unmount BEFORE the banner delay elapses → both the banner timer (this plan's
    // dedicated cleanup) and the reconnect timer (useSseSubscription.cleanup) clear.
    unmount();

    // Advance past the banner delay — nothing should fire after unmount.
    act(() => {
      vi.advanceTimersByTime(RECONNECT_BANNER_DELAY_MS + 500);
    });

    // The display is gone (unmounted); the contract is "no post-unmount store flip
    // / no act-warning". On React 19 a stray setState is a silent no-op, so the
    // observable signal is: no React act() error logged + no throw.
    expect(screen.queryByTestId('disc')).toBeNull();
    const actWarnings = consoleError.mock.calls.filter((c) =>
      String(c[0]).includes('not wrapped in act'),
    );
    expect(actWarnings).toHaveLength(0);
    consoleError.mockRestore();
  });

  // AC-1 control (RED-discipline counterpart): when STILL mounted, the same banner
  // timer DOES flip disconnected — proves the timer is genuinely pending (so the
  // unmount case above is meaningfully neutralizing a live timer, not a no-op).
  it('test_provider_when_mounted_and_banner_delay_elapses_then_flips_disconnected', async () => {
    vi.useFakeTimers();
    renderProvider(<DisconnectedDisplay />);
    const erroredEs = lastEs();
    act(() => {
      erroredEs.onerror?.(new Event('error'));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(RECONNECT_BANNER_DELAY_MS + 100);
    });
    // openedAt === 0 (onopen never driven) → handleError flips disconnected.
    expect(screen.getByTestId('disc').textContent).toBe('disconnected');
  });

  // AC-2 (PRESERVATION guard, CLEAN path — no onerror): EventSource.close() is
  // called on unmount by useSseSubscription.cleanup (a slice this plan does NOT
  // touch). Driving NO onerror keeps close() attributable to the unmount.
  it('test_provider_when_unmounted_clean_then_eventsource_closed', () => {
    const { unmount } = renderProvider(<div />);
    const es = lastEs();
    expect(es.close).not.toHaveBeenCalled();
    unmount();
    expect(es.close).toHaveBeenCalled();
  });
});
