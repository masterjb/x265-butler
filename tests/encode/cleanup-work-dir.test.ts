// 05-09 audit S9: staging.cleanupWorkDir + unlinkSidecarTmpAt — fire-and-forget
// hygiene helpers used by skipActive + cancelAllQueued. Idempotent on missing
// dirs; warn-log + no-throw on EACCES.
//
// 16-05 audit M4: cleanupSuffixesFor matrix — 4-pattern / 2-pattern /
// 1-pattern coverage per dual-sentinel + match-source semantics.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupWorkDir, unlinkSidecarTmpAt, workDirFor } from '@/src/lib/encode/staging';
import { cleanupSuffixesFor } from '@/src/lib/encode/orchestrator';
import type { OutputContainerSetting } from '@/src/lib/encode/output-container';

// Stub builder: cleanupSuffixesFor reads ONLY outputSuffix + outputContainer
// from the settings object; the rest of the readSettings shape is irrelevant
// to cleanup-pattern derivation. Test-side helper to keep call-sites lean.
type CleanupSettings = Parameters<typeof cleanupSuffixesFor>[0];
function s(outputSuffix: string, outputContainer: OutputContainerSetting): CleanupSettings {
  // Cast through unknown — the full readSettings type pulls in 6 other
  // fields none of which cleanupSuffixesFor reads. Structural typing on
  // the consumed subset is sufficient at runtime.
  return { outputSuffix, outputContainer } as unknown as CleanupSettings;
}

const tmpRoots: string[] = [];

function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-cleanup-test-'));
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tmpRoots.length = 0;
});

describe('staging.cleanupWorkDir', () => {
  it('test_cleanupWorkDir_when_dir_missing_then_no_throw_idempotent', async () => {
    const root = makeTmpRoot();
    const missingPath = path.join(root, 'never-existed', 'nope');
    await expect(cleanupWorkDir(missingPath)).resolves.toBeUndefined();
    expect(fs.existsSync(missingPath)).toBe(false);
  });

  it('test_cleanupWorkDir_when_dir_with_nested_files_then_recursive_removed', async () => {
    const root = makeTmpRoot();
    const stageRoot = path.join(root, 'stage');
    const work = workDirFor(stageRoot, 42);
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'input'), 'fake');
    fs.mkdirSync(path.join(work, 'subdir'));
    fs.writeFileSync(path.join(work, 'subdir', 'nested'), 'data');
    expect(fs.existsSync(work)).toBe(true);
    await cleanupWorkDir(work);
    expect(fs.existsSync(work)).toBe(false);
  });

  it('test_cleanupWorkDir_when_already_cleaned_then_idempotent', async () => {
    const root = makeTmpRoot();
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    await cleanupWorkDir(work);
    await expect(cleanupWorkDir(work)).resolves.toBeUndefined();
  });
});

describe('staging.unlinkSidecarTmpAt', () => {
  it('test_unlink_sidecar_tmp_when_file_missing_then_no_throw_idempotent', async () => {
    const root = makeTmpRoot();
    const finalOutput = path.join(root, 'movie.x265.mkv');
    await expect(unlinkSidecarTmpAt(finalOutput)).resolves.toBeUndefined();
  });

  it('test_unlink_sidecar_tmp_when_present_then_removed', async () => {
    const root = makeTmpRoot();
    const finalOutput = path.join(root, 'movie.x265.mkv');
    const tmp = `${finalOutput}.x265-butler.json.tmp`;
    fs.writeFileSync(tmp, '{"schema":"x265-butler/v2"}');
    expect(fs.existsSync(tmp)).toBe(true);
    await unlinkSidecarTmpAt(finalOutput);
    expect(fs.existsSync(tmp)).toBe(false);
  });
});

// 16-05 audit M4: cleanupSuffixesFor matrix — 4-pattern under match-source
// (covers both default-styles × both containers), 2-pattern under explicit
// container (both default-styles for THAT container), 1-pattern for
// operator-customized.
describe('orchestrator.cleanupSuffixesFor (16-05 audit M4)', () => {
  it('NEW default × match-source → 4-pattern sweep across both styles + both containers', () => {
    expect(cleanupSuffixesFor(s('-x265', 'match-source'))).toEqual([
      '-x265.mkv',
      '-x265.mp4',
      '.x265.mkv',
      '.x265.mp4',
    ]);
  });

  it('LEGACY default × match-source → SAME 4-pattern sweep (dual-sentinel)', () => {
    // audit S7: legacy-default sentinel triggers the same 4-pattern sweep
    // because the orchestrator cannot tell mid-encode whether a half-
    // migrated install will resolve to which extension.
    expect(cleanupSuffixesFor(s('.x265.mkv', 'match-source'))).toEqual([
      '-x265.mkv',
      '-x265.mp4',
      '.x265.mkv',
      '.x265.mp4',
    ]);
  });

  it('NEW default × explicit mp4 → 2-pattern (both default-styles, mp4 only)', () => {
    expect(cleanupSuffixesFor(s('-x265', 'mp4'))).toEqual(['-x265.mp4', '.x265.mp4']);
  });

  it('NEW default × explicit mkv → 2-pattern (both default-styles, mkv only)', () => {
    expect(cleanupSuffixesFor(s('-x265', 'mkv'))).toEqual(['-x265.mkv', '.x265.mkv']);
  });

  it('LEGACY default × explicit mp4 → 2-pattern (defensive safety-net)', () => {
    expect(cleanupSuffixesFor(s('.x265.mkv', 'mp4'))).toEqual(['-x265.mp4', '.x265.mp4']);
  });

  it('operator-customized × mp4 → 1-pattern (single custom suffix only)', () => {
    expect(cleanupSuffixesFor(s('_h265', 'mp4'))).toEqual(['_h265']);
  });

  it('operator-customized × match-source → 1-pattern (single custom suffix only)', () => {
    expect(cleanupSuffixesFor(s('_h265', 'match-source'))).toEqual(['_h265']);
  });
});
