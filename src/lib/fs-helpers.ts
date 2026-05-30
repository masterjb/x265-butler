import fs from 'node:fs';

// Extracted from src/lib/encode/staging.ts commitOutput EXDEV-fallback pattern.
// Used by restore endpoint (app/api/trash/[id]/restore) and any future caller
// needing atomic cross-filesystem move with explicit fsync (audit 02-02 M3).
export function moveAcrossFilesystems(srcPath: string, dstPath: string): void {
  try {
    fs.renameSync(srcPath, dstPath);
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code !== 'EXDEV') {
      throw err;
    }
    // EXDEV: src and dst on different filesystems — fallback to copy+fsync+rename+unlink.
    // S8 (02-02): unlink tmp first to clear prior crash debris.
    const tmp = `${dstPath}.x265-butler.move.tmp`;
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    try {
      fs.copyFileSync(srcPath, tmp);
      // M3 (02-02): explicit fd-fsync pattern — fsync(O_RDONLY) flushes OS write-back cache.
      const fd = fs.openSync(tmp, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, dstPath);
      fs.unlinkSync(srcPath);
    } catch (innerErr) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
      throw innerErr;
    }
  }
}
