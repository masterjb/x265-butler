// @vitest-environment node
//
// Every place that creates an encode job is
// either AUTOMATIC (must sit behind the auto_encode master switch) or MANUAL
// (an explicit operator action). A new caller fails this test until someone
// decides which of the two it is and, if automatic, gates it.
//
// Compares the sorted PATH LIST, not a count, so an empty scan result can never
// pass vacuously. The pattern matches `.enqueue(` on a repo handle and excludes
// the stream-controller `controller.enqueue(` used by SSE/CSV routes.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const AUTOMATIC = [
  'app/api/scan/route.ts',
  'src/lib/queue/scan-enqueue.ts',
  'src/lib/watch/ingest.ts',
  'src/lib/watch/reconcile.ts',
];

const MANUAL = [
  'app/api/library/[id]/retry/route.ts',
  'app/api/library/bulk-encode/route.ts',
  'app/api/queue/route.ts',
];

// Continuations of a job that was already in the queue. They are automatic but
// deliberately NOT behind the master switch: the operator (or an automatic path
// that passed the switch) already queued this work. The orchestrator queues a
// stalled encode once more.
const CONTINUATION = ['src/lib/encode/orchestrator.ts'];

const JOB_ENQUEUE_CALL = /(?<!controller)\.enqueue\(/;

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(abs);
    }
  }
}

function jobEnqueueCallers(): string[] {
  const files: string[] = [];
  walk(path.join(ROOT, 'src'), files);
  walk(path.join(ROOT, 'app'), files);
  return files
    .map((abs) => path.relative(ROOT, abs).split(path.sep).join('/'))
    .filter((rel) => rel !== 'src/lib/db/repos/job.ts')
    .filter((rel) =>
      fs
        .readFileSync(path.join(ROOT, rel), 'utf8')
        .split('\n')
        .some((line) => !line.trim().startsWith('//') && JOB_ENQUEUE_CALL.test(line)),
    )
    .sort();
}

describe('job enqueue callers inventory', () => {
  it('test_enqueue_callers_when_scanned_then_match_classified_inventory', () => {
    expect(jobEnqueueCallers()).toEqual([...AUTOMATIC, ...MANUAL, ...CONTINUATION].sort());
  });

  it('test_automatic_callers_when_read_then_each_consults_master_switch', () => {
    const ungated = AUTOMATIC.filter(
      (rel) => !fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('isAutoEncodeEnabled('),
    );
    expect(ungated).toEqual([]);
  });
});
