// With the trash turned off, a finished encode removes or replaces the
// original instead of moving it to the trash. The title is never missing,
// a failure before the last step leaves the original untouched, hardlinked
// sources are never deleted, and the output is synced to disk before an
// original goes away for good.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { loopOnce } from '@/src/lib/encode/orchestrator';
import * as realStaging from '@/src/lib/encode/staging';
import {
  OUTPUT_BYTES,
  SOURCE_BYTES,
  createHarness,
  disposeHarness,
  jobRow,
  logActions,
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

const OFF = { trash_enabled: 'false' };

function dotTemps(): string[] {
  return fs.readdirSync(h.mediaRoot).filter((n) => n.startsWith('.x265-butler-replace-'));
}

describe('suffix mode without trash', () => {
  it('deletes the original after the output is committed', async () => {
    const { jobId, sourcePath } = setupJob(h, { outputMode: 'suffix', settings: OFF });
    await loopOnce();
    expect(jobRow(h, jobId).status).toBe('done');
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.statSync(path.join(h.mediaRoot, 'movie-x265.mkv')).size).toBe(OUTPUT_BYTES);
    expect(trashRows(h)).toHaveLength(0);
    expect(logEntries(h.info, 'original_deleted_post_encode')[0]).toMatchObject({
      reason: 'trash_disabled',
      originalPath: sourcePath,
      sizeBytes: SOURCE_BYTES,
    });
  });

  it('keeps the original when committing the output fails', async () => {
    const { jobId, sourcePath, unlinked } = setupJob(h, {
      outputMode: 'suffix',
      settings: OFF,
      staging: {
        commitOutput: async () => {
          throw Object.assign(new Error('ENOSPC simulated'), { code: 'ENOSPC' });
        },
      },
    });
    await loopOnce();
    expect(jobRow(h, jobId).status).toBe('failed');
    expect(fs.statSync(sourcePath).size).toBe(SOURCE_BYTES);
    expect(unlinked).not.toContain(sourcePath);
  });

  it('syncs the output before unlinking the original', async () => {
    const events: string[] = [];
    const { sourcePath } = setupJob(h, {
      outputMode: 'suffix',
      settings: OFF,
      staging: {
        fsyncFile: async (p: string) => {
          events.push(`fsync:${path.basename(p)}`);
          return realStaging.fsyncFile(p);
        },
      },
      unlinkSync: (p) => {
        events.push(`unlink:${path.basename(String(p))}`);
        fs.unlinkSync(p);
      },
    });
    await loopOnce();
    expect(fs.existsSync(sourcePath)).toBe(false);
    const syncAt = events.indexOf('fsync:movie-x265.mkv');
    const unlinkAt = events.indexOf('unlink:movie.mkv');
    expect(syncAt).toBeGreaterThanOrEqual(0);
    expect(unlinkAt).toBeGreaterThan(syncAt);
  });

  it('keeps the original when syncing the output fails', async () => {
    const { jobId, sourcePath, unlinked } = setupJob(h, {
      outputMode: 'suffix',
      settings: OFF,
      staging: {
        fsyncFile: async () => {
          throw Object.assign(new Error('EIO simulated'), { code: 'EIO' });
        },
      },
    });
    await loopOnce();
    expect(jobRow(h, jobId).status).toBe('done');
    expect(fs.statSync(sourcePath).size).toBe(SOURCE_BYTES);
    expect(unlinked).not.toContain(sourcePath);
    expect(logActions(h.warn)).toContain('original_delete_skipped_fsync_failed');
  });

  it('also syncs before deleting when delete_original_after_encode is on', async () => {
    const synced: string[] = [];
    setupJob(h, {
      outputMode: 'suffix',
      settings: { delete_original_after_encode: 'true' },
      staging: {
        fsyncFile: async (p: string) => {
          synced.push(path.basename(p));
          return realStaging.fsyncFile(p);
        },
      },
    });
    await loopOnce();
    expect(synced).toContain('movie-x265.mkv');
    expect(logEntries(h.info, 'original_deleted_post_encode')[0]).toMatchObject({
      reason: 'setting',
    });
  });
});

describe('replace mode without trash', () => {
  it('same extension: temp, sync, rename over the original', async () => {
    const { jobId, sourcePath } = setupJob(h, { outputMode: 'replace', settings: OFF });
    await loopOnce();
    expect(jobRow(h, jobId).status).toBe('done');
    expect(fs.statSync(sourcePath).size).toBe(OUTPUT_BYTES);
    expect(trashRows(h)).toHaveLength(0);
    expect(dotTemps()).toEqual([]);
    expect(logEntries(h.info, 'original_replaced_without_trash')[0]).toMatchObject({
      originalPath: sourcePath,
      outputPath: sourcePath,
      sizeBytes: SOURCE_BYTES,
    });
  });

  it('job fails and the original stays when the replace fails', async () => {
    const { jobId, sourcePath } = setupJob(h, {
      outputMode: 'replace',
      settings: OFF,
      staging: {
        replaceInPlace: async () => {
          throw Object.assign(new Error('EIO simulated'), { code: 'EIO' });
        },
      },
    });
    await loopOnce();
    expect(jobRow(h, jobId).status).toBe('failed');
    expect(fs.statSync(sourcePath).size).toBe(SOURCE_BYTES);
    expect(logActions(h.error)).toContain('replace_without_trash_failed');
  });

  it('other extension: writes the sibling, then deletes the original', async () => {
    const { jobId, sourcePath } = setupJob(h, {
      outputMode: 'replace',
      settings: OFF,
      sourceName: 'movie.avi',
    });
    await loopOnce();
    expect(jobRow(h, jobId).status).toBe('done');
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.statSync(path.join(h.mediaRoot, 'movie.mkv')).size).toBe(OUTPUT_BYTES);
    expect(trashRows(h)).toHaveLength(0);
  });

  it('other extension: an existing sibling fails the job and keeps the original', async () => {
    const sibling = path.join(h.mediaRoot, 'movie.mkv');
    fs.writeFileSync(sibling, 'operator file');
    const { jobId, sourcePath } = setupJob(h, {
      outputMode: 'replace',
      settings: OFF,
      sourceName: 'movie.avi',
    });
    await loopOnce();
    expect(jobRow(h, jobId)).toMatchObject({ status: 'failed', error_msg: 'output_path_exists' });
    expect(fs.statSync(sourcePath).size).toBe(SOURCE_BYTES);
    expect(fs.readFileSync(sibling, 'utf8')).toBe('operator file');
  });

  it('other extension: a failed delete keeps both files and warns', async () => {
    const { jobId, sourcePath } = setupJob(h, {
      outputMode: 'replace',
      settings: OFF,
      sourceName: 'movie.avi',
      unlinkSync: (p) => {
        if (String(p).endsWith('movie.avi')) {
          throw Object.assign(new Error('EACCES simulated'), { code: 'EACCES' });
        }
        fs.unlinkSync(p);
      },
    });
    await loopOnce();
    expect(jobRow(h, jobId).status).toBe('done');
    expect(fs.statSync(sourcePath).size).toBe(SOURCE_BYTES);
    expect(fs.statSync(path.join(h.mediaRoot, 'movie.mkv')).size).toBe(OUTPUT_BYTES);
    expect(logActions(h.warn)).toContain('original_delete_failed');
  });
});

describe('hardlinks are never deleted', () => {
  it('hardlink at dispatch keeps the original', async () => {
    const { sourcePath } = setupJob(h, { outputMode: 'replace', settings: OFF });
    fs.linkSync(sourcePath, path.join(h.mediaRoot, 'other-link.mkv'));
    await loopOnce();
    expect(fs.statSync(sourcePath).size).toBe(SOURCE_BYTES);
    expect(fs.statSync(path.join(h.mediaRoot, 'movie-x265.mkv')).size).toBe(OUTPUT_BYTES);
  });

  it('hardlink created during the encode keeps the original', async () => {
    const { sourcePath } = setupJob(h, {
      outputMode: 'replace',
      settings: OFF,
      duringEncode: ({ sourcePath: src }) => {
        fs.linkSync(src, path.join(h.mediaRoot, 'imported-link.mkv'));
      },
    });
    await loopOnce();
    expect(fs.statSync(sourcePath).size).toBe(SOURCE_BYTES);
    expect(fs.statSync(path.join(h.mediaRoot, 'movie-x265.mkv')).size).toBe(OUTPUT_BYTES);
    expect(logEntries(h.warn, 'replace_skipped_hardlink')[0]).toMatchObject({
      reason: 'commit_toctou',
    });
  });
});

describe('trash on keeps the trash path', () => {
  it.each([[undefined], ['true'], ['garbage']])('trash_enabled=%j', async (value) => {
    const settings: Record<string, string> = {};
    if (value !== undefined) settings.trash_enabled = value;
    const { sourcePath } = setupJob(h, { outputMode: 'replace', settings });
    await loopOnce();
    expect(fs.statSync(sourcePath).size).toBe(OUTPUT_BYTES);
    const rows = trashRows(h);
    expect(rows).toHaveLength(1);
    expect(fs.statSync(rows[0].trash_path).size).toBe(SOURCE_BYTES);
  });
});

describe('discarded encodes never touch the original', () => {
  it.each(['suffix', 'replace'] as const)('%s: output not smaller', async (outputMode) => {
    const { sourcePath, unlinked } = setupJob(h, {
      outputMode,
      settings: OFF,
      outputBytes: SOURCE_BYTES + 1000,
    });
    await loopOnce();
    expect(fs.statSync(sourcePath).size).toBe(SOURCE_BYTES);
    expect(unlinked).not.toContain(sourcePath);
    expect(dotTemps()).toEqual([]);
  });

  it.each(['suffix', 'replace'] as const)('%s: encode failed', async (outputMode) => {
    const { jobId, sourcePath, unlinked } = setupJob(h, {
      outputMode,
      settings: OFF,
      encodeExitCode: 1,
    });
    await loopOnce();
    expect(jobRow(h, jobId).status).toBe('failed');
    expect(fs.statSync(sourcePath).size).toBe(SOURCE_BYTES);
    expect(unlinked).not.toContain(sourcePath);
  });
});

describe('settings are read once per job', () => {
  it('turning the trash off during the encode applies to the next job', async () => {
    const { sourcePath } = setupJob(h, {
      outputMode: 'suffix',
      duringEncode: () => h.settingRepo.set('trash_enabled', 'false'),
    });
    await loopOnce();
    expect(fs.existsSync(sourcePath)).toBe(false);
    const rows = trashRows(h);
    expect(rows).toHaveLength(1);
    expect(fs.statSync(rows[0].trash_path).size).toBe(SOURCE_BYTES);
  });
});
