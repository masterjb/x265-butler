// Where an original goes when it is moved to the trash: an explicit
// trash_path wins, otherwise the location setting picks the share of the file
// (a hidden folder, so moving is a rename) or the cache path. A share that
// cannot be resolved or written falls back to the cache path; the job goes on.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { loopOnce } from '@/src/lib/encode/orchestrator';
import { isPurgeableTrashPath } from '@/src/lib/trash/purge';
import {
  SOURCE_BYTES,
  createHarness,
  disposeHarness,
  jobRow,
  logEntries,
  setupJob,
  trashRows,
  type Harness,
} from '../helpers/trash-commit-harness';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await disposeHarness(h);
});

function share(): number {
  return h.shareRepo.create({
    name: 'Movies',
    path: h.mediaRoot,
    min_size_mb: 0,
    extensions_csv: 'mkv,avi',
    max_depth: null,
  }).id;
}

const LAYOUT = /\/trash\/\d+-\d{14}\/movie\.mkv$/;

describe('share location', () => {
  it.each(['suffix', 'replace'] as const)(
    '%s: moves into <share>/.x265-butler-trash',
    async (mode) => {
      const { jobId, sourcePath } = setupJob(h, {
        outputMode: mode,
        shareId: share(),
        settings: { trash_location: 'share' },
      });
      await loopOnce();
      expect(jobRow(h, jobId).status).toBe('done');
      const [row] = trashRows(h);
      expect(row.trash_path.startsWith(path.join(h.mediaRoot, '.x265-butler-trash', 'trash'))).toBe(
        true,
      );
      expect(row.trash_path).toMatch(LAYOUT);
      expect(fs.statSync(row.trash_path).size).toBe(SOURCE_BYTES);
      expect(isPurgeableTrashPath(row.trash_path, sourcePath)).toBe(true);
    },
  );

  it('a file without share falls back to the cache path and warns', async () => {
    const { jobId } = setupJob(h, {
      outputMode: 'suffix',
      shareId: null,
      settings: { trash_location: 'share' },
    });
    await loopOnce();
    expect(jobRow(h, jobId).status).toBe('done');
    const [row] = trashRows(h);
    expect(row.trash_path.startsWith(path.join(h.stageRoot, 'trash'))).toBe(true);
    expect(logEntries(h.warn, 'trash_share_unresolved')[0]).toMatchObject({ jobId });
  });

  it('a share root that cannot be created falls back to the cache path and warns', async () => {
    const { jobId } = setupJob(h, {
      outputMode: 'replace',
      shareId: share(),
      settings: { trash_location: 'share' },
      staging: {
        ensureTrashRoot: async () => {
          throw Object.assign(new Error('EACCES simulated'), { code: 'EACCES' });
        },
      },
    });
    await loopOnce();
    expect(jobRow(h, jobId).status).toBe('done');
    const [row] = trashRows(h);
    expect(row.trash_path.startsWith(path.join(h.stageRoot, 'trash'))).toBe(true);
    expect(logEntries(h.warn, 'trash_share_unwritable')[0]).toMatchObject({
      jobId,
      errno: 'EACCES',
    });
  });
});

describe('precedence', () => {
  it('cache location ignores the share', async () => {
    setupJob(h, { outputMode: 'suffix', shareId: share(), settings: { trash_location: 'cache' } });
    await loopOnce();
    expect(trashRows(h)[0].trash_path.startsWith(path.join(h.stageRoot, 'trash'))).toBe(true);
  });

  it('a set trash_path wins over the share location', async () => {
    const custom = path.join(h.stageRoot, 'custom-trash');
    setupJob(h, {
      outputMode: 'suffix',
      shareId: share(),
      settings: { trash_location: 'share', trash_path: custom },
    });
    await loopOnce();
    expect(trashRows(h)[0].trash_path.startsWith(path.join(custom, 'trash'))).toBe(true);
  });

  it('a missing location setting keeps the cache path', async () => {
    h.db.prepare("DELETE FROM setting WHERE key = 'trash_location'").run();
    setupJob(h, { outputMode: 'suffix', shareId: share() });
    await loopOnce();
    expect(trashRows(h)[0].trash_path.startsWith(path.join(h.stageRoot, 'trash'))).toBe(true);
  });
});
