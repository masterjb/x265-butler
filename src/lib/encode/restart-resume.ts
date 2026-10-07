// Rules for putting jobs back in the queue after a container restart. Kept free
// of imports so the settings form can read the limit directly; the orchestrator
// applies these rules inside one database transaction.
//
// Counting works without a schema change: when a job is put back after a
// restart, its interrupted row gets the note `resumed_after_restart` in
// error_msg. A chain of such rows (stalled jobs in between are skipped) is the
// number of restarts the file went through in a row. Anything else ends the
// chain, including interrupted rows without the note, so rows from older
// versions or before a manual retry never count.

export const RESUME_AFTER_RESTART_SETTING_KEY = 'resume_after_restart';
// Internal key, written by the orchestrator and never accepted from the API.
export const QUEUE_PAUSED_SETTING_KEY = 'queue_paused';

export const MAX_RESTART_INTERRUPTIONS = 3;

export const RESUMED_AFTER_RESTART_NOTE = 'resumed_after_restart';
export const RESUME_SKIPPED_NOTE_PREFIX = 'resume_skipped:';
export const INTERRUPTED_REPEATEDLY = 'interrupted_repeatedly';

const STALLED = 'encode_stalled';

export type ResumeDecision = 'requeue' | 'fail_repeated' | 'none';

interface HistoryRow {
  status: string;
  error_msg: string | null;
}

function isResumed(row: HistoryRow): boolean {
  return row.status === 'interrupted' && row.error_msg === RESUMED_AFTER_RESTART_NOTE;
}

function isStalled(row: HistoryRow): boolean {
  return row.status === 'failed' && row.error_msg === STALLED;
}

// Marked interruptions at the start of `rows` (newest first), stalled jobs skipped.
function countResumedChain(rows: readonly HistoryRow[]): number {
  let n = 0;
  for (const row of rows) {
    if (isStalled(row)) continue;
    if (!isResumed(row)) break;
    n++;
  }
  return n;
}

/**
 * Interruptions in a row, including the one that just happened. `history` is
 * the file's finished jobs, newest first, starting with the row the restart
 * just marked interrupted.
 */
export function countConsecutiveInterruptions(history: readonly HistoryRow[]): number {
  if (history.length === 0) return 0;
  return 1 + countResumedChain(history.slice(1));
}

export function decideResume(input: { enabled: boolean; interruptions: number }): ResumeDecision {
  if (!input.enabled) return 'none';
  return input.interruptions >= MAX_RESTART_INTERRUPTIONS ? 'fail_repeated' : 'requeue';
}

/** Stored value to on/off. Only '0' switches it off; anything else is the default (on). */
export function resolveResumeAfterRestart(raw: string | null | undefined): boolean {
  return (raw ?? '').trim() !== '0';
}

/**
 * The job log line for a job created by a restart, or null. `previous` is the
 * new job's finished predecessors, newest first.
 */
export function resumeLogLine(previous: readonly HistoryRow[]): string | null {
  if (previous.length === 0 || !isResumed(previous[0])) return null;
  const n = countResumedChain(previous);
  return `Resumed after a container restart, interruption ${n} of ${MAX_RESTART_INTERRUPTIONS}, starting from the beginning`;
}
