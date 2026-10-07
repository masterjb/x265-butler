// @vitest-environment node
// The dispatch reads the processing order from the settings on every pass, so
// a changed order applies to the next claim without a restart.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __forTests_resetOrchestrator,
  __forTests_setDeps,
  __forTests_dispatchUntilFull,
  loopOnce,
} from '@/src/lib/encode/orchestrator';
import type { JobRow } from '@/src/lib/db/schema';
import type { DetectionResult } from '@/src/lib/encode/detection';

const QUEUED_JOB = { id: 1, file_id: 1, encoder: 'libx265', crf: null, status: 'queued' } as JobRow;

let settings: Record<string, string>;
let peekQueued: ReturnType<typeof vi.fn>;
let claimNext: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await __forTests_resetOrchestrator();
  settings = { encoder: 'libx265' };
  peekQueued = vi.fn(() => [QUEUED_JOB]);
  claimNext = vi.fn(() => undefined);
  __forTests_setDeps({
    jobRepo: () =>
      ({
        peekQueued,
        claimNext,
        // Claim race lost: the dispatch loop ends without spawning ffmpeg.
        claimById: () => undefined,
        listActive: () => [],
        countByStatus: () => 0,
      }) as never,
    settingRepo: () => ({ getAll: () => settings, get: (k: string) => settings[k] }) as never,
    detectEncoders: (async () =>
      ({ detected: ['libx265'] }) as unknown as DetectionResult) as never,
    events: { emit: vi.fn(), subscribe: vi.fn() } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  });
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
});

describe('processing order in the dispatch', () => {
  it('uses the default order when nothing is stored', async () => {
    await __forTests_dispatchUntilFull();
    expect(peekQueued).toHaveBeenCalledWith(100, 'oldest');
  });

  it('next dispatch follows a changed order', async () => {
    settings = { encoder: 'libx265', queue_order: 'largest' };
    await __forTests_dispatchUntilFull();
    expect(peekQueued).toHaveBeenLastCalledWith(100, 'largest');

    settings = { encoder: 'libx265', queue_order: 'newest' };
    await __forTests_dispatchUntilFull();
    expect(peekQueued).toHaveBeenLastCalledWith(100, 'newest');
  });

  it('an unknown stored order falls back to oldest', async () => {
    settings = { encoder: 'libx265', queue_order: 'random' };
    await __forTests_dispatchUntilFull();
    expect(peekQueued).toHaveBeenLastCalledWith(100, 'oldest');
  });

  it('the single-slot entry point claims in the same order', async () => {
    settings = { encoder: 'libx265', queue_order: 'smallest' };
    await loopOnce();
    expect(claimNext).toHaveBeenCalledWith('smallest');
  });
});
