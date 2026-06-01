import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import {
  EngineEventsProvider,
  usePausedState,
  useActiveJob,
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

function CountsDisplay() {
  const c = useQueueCounts();
  return <div data-testid="counts">{`${c.activeJobs}/${c.pendingJobs}`}</div>;
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
