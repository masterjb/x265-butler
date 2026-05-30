// 15-01: Storage-Analyzer aggregation repo. Read-only — 5 functions over
// file × shares × job join. Live-SQL (no cache) per CONTEXT A5=c.
//
// share-axis: shareId='all' → cross-share aggregation; shareId=<num> → WHERE
// share_id = ?. Orphan (share_id IS NULL) only surfaces explicitly in
// getSharesTable (one fixed orphan-row appended last).
//
// Top-folders aggregation uses SQL row-fetch + JS Map-aggregation (single
// SELECT bounded by SR1 LIMIT 50_000 pre-aggregate). Plan T1 step-2 originally
// asked for 5 precomputed depth-prefix SQL templates; deviated to JS aggregation
// for clarity (SQLite has no native split-on-separator and nested substr/instr
// chains for depth=5 became un-reviewable). Behavior identical — verified by
// AC-5 tests.
//
// Savings-by-share reuses the file.status JOIN job pattern from 10-01
// SavingsBuckets (see stats.ts:614+); inlined here per CONTEXT Q3 DRY decision
// (helper-extraction would force a stats-repo signature change for a single
// downstream caller).

import type Database from 'better-sqlite3';
import type { ShareRepo } from './share';

type Db = InstanceType<typeof Database>;

// 15-01 audit SR1: pre-aggregate row-cap for getTopFolders. Caps worst-case
// scan under cross-share + depth=5 + pathological-corpus before the JS
// Map-aggregation pass. Post-aggregate LIMIT 10 unchanged.
const TOP_FOLDERS_PREAGGREGATE_LIMIT = 50_000;

// Fixed size-bucket boundaries (AC-2). MAX_SAFE bound used as sentinel — SQLite
// CASE WHEN size_bytes >= 10*1024^3 catches the open-ended bucket.
const BUCKET_BOUNDARIES = [
  { label: '<100MB', minBytes: 0, maxBytes: 100 * 1024 ** 2 - 1 },
  { label: '100MB-1GB', minBytes: 100 * 1024 ** 2, maxBytes: 1024 ** 3 - 1 },
  { label: '1-10GB', minBytes: 1024 ** 3, maxBytes: 10 * 1024 ** 3 - 1 },
  { label: '10GB+', minBytes: 10 * 1024 ** 3, maxBytes: Number.MAX_SAFE_INTEGER },
] as const;

export type ShareIdParam = number | 'all';

export interface KpiResult {
  totalSizeBytes: number;
  largestFolder: { shareId: number | null; path: string; sizeBytes: number } | null;
  mostOptimizedShare: { shareId: number; hevcPercent: number } | null;
  legacyCodecPercent: number;
}

export interface BucketResult {
  label: string;
  minBytes: number;
  maxBytes: number;
  fileCount: number;
  totalBytes: number;
}

export interface CodecSlice {
  codec: string;
  fileCount: number;
  totalBytes: number;
}

export interface ShareTableRow {
  shareId: number | null;
  sharePath: string | null;
  totalSizeBytes: number;
  hevcPercent: number;
  savingsBytes: number;
  largestFolder: { path: string; sizeBytes: number } | null;
}

export interface TopFolderRow {
  shareId: number | null;
  path: string;
  sizeBytes: number;
  fileCount: number;
}

export interface TopFoldersResult {
  rows: TopFolderRow[];
  truncated: boolean;
}

export interface StorageRepo {
  getKpis(opts: { shareId: ShareIdParam }): KpiResult;
  getSizeBuckets(opts: { shareId: ShareIdParam }): BucketResult[];
  getCodecPie(opts: { shareId: ShareIdParam }): CodecSlice[];
  getSharesTable(): ShareTableRow[];
  getTopFolders(opts: { shareId: ShareIdParam; depth: number; limit?: number }): TopFoldersResult;
}

export interface StorageRepoDeps {
  shareRepo: ShareRepo;
}

export function makeStorageRepo(db: Db, deps: StorageRepoDeps): StorageRepo {
  // 15-01: Prepared statements at module init. Two variants per query: with
  // and without share-filter. Statement.get/all binds at call-site.

  const sumSizeAllStmt = db.prepare<[], { total: number | null }>(
    'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM file',
  );
  const sumSizeShareStmt = db.prepare<[number], { total: number | null }>(
    'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM file WHERE share_id = ?',
  );

  // SR2: HAVING hevcRatio > 0 — drop all-zero-HEVC shares so ORDER BY DESC
  // LIMIT 1 returns NULL when no share has any HEVC bytes (not a misleading
  // 0%-share). Always cross-share per A6 (filter is for highlight, not scope).
  const mostOptimizedShareStmt = db.prepare<[], { share_id: number; hevcRatio: number }>(
    `SELECT share_id,
            SUM(CASE WHEN LOWER(codec) = 'hevc' THEN size_bytes ELSE 0 END) * 1.0
              / NULLIF(SUM(size_bytes), 0) AS hevcRatio
     FROM file
     WHERE share_id IS NOT NULL
     GROUP BY share_id
     HAVING hevcRatio > 0
     ORDER BY hevcRatio DESC
     LIMIT 1`,
  );

  const legacyCodecPercentAllStmt = db.prepare<[], { pct: number | null }>(
    `SELECT SUM(CASE WHEN LOWER(codec) != 'hevc' OR codec IS NULL THEN size_bytes ELSE 0 END) * 100.0
              / NULLIF(SUM(size_bytes), 0) AS pct
     FROM file`,
  );
  const legacyCodecPercentShareStmt = db.prepare<[number], { pct: number | null }>(
    `SELECT SUM(CASE WHEN LOWER(codec) != 'hevc' OR codec IS NULL THEN size_bytes ELSE 0 END) * 100.0
              / NULLIF(SUM(size_bytes), 0) AS pct
     FROM file WHERE share_id = ?`,
  );

  // AC-2: size-buckets via CASE WHEN. Single SELECT, 4-row GROUP BY ensures
  // operational simplicity (no JS post-processing for the 4 standard buckets).
  // canonical-empty-state (SR4): when DB has 0 files, fileCount=0 + totalBytes=0
  // is filled in by the JS-side merge below (SQL returns empty rowset for
  // unmatched buckets).
  const bucketsAllStmt = db.prepare<[], { label: string; fileCount: number; totalBytes: number }>(
    `SELECT
       CASE
         WHEN size_bytes < ${100 * 1024 ** 2} THEN '<100MB'
         WHEN size_bytes < ${1024 ** 3} THEN '100MB-1GB'
         WHEN size_bytes < ${10 * 1024 ** 3} THEN '1-10GB'
         ELSE '10GB+'
       END AS label,
       COUNT(*) AS fileCount,
       COALESCE(SUM(size_bytes), 0) AS totalBytes
     FROM file
     GROUP BY label`,
  );
  const bucketsShareStmt = db.prepare<
    [number],
    { label: string; fileCount: number; totalBytes: number }
  >(
    `SELECT
       CASE
         WHEN size_bytes < ${100 * 1024 ** 2} THEN '<100MB'
         WHEN size_bytes < ${1024 ** 3} THEN '100MB-1GB'
         WHEN size_bytes < ${10 * 1024 ** 3} THEN '1-10GB'
         ELSE '10GB+'
       END AS label,
       COUNT(*) AS fileCount,
       COALESCE(SUM(size_bytes), 0) AS totalBytes
     FROM file WHERE share_id = ?
     GROUP BY label`,
  );

  // AC-3: codec-pie. COALESCE(LOWER(codec), 'unknown') groups NULL into a
  // single 'unknown' bucket. Pre/post-encode codec deferred per Q2.
  const codecPieAllStmt = db.prepare<[], { codec: string; fileCount: number; totalBytes: number }>(
    `SELECT COALESCE(LOWER(codec), 'unknown') AS codec,
            COUNT(*) AS fileCount,
            COALESCE(SUM(size_bytes), 0) AS totalBytes
     FROM file
     GROUP BY codec
     ORDER BY totalBytes DESC`,
  );
  const codecPieShareStmt = db.prepare<
    [number],
    { codec: string; fileCount: number; totalBytes: number }
  >(
    `SELECT COALESCE(LOWER(codec), 'unknown') AS codec,
            COUNT(*) AS fileCount,
            COALESCE(SUM(size_bytes), 0) AS totalBytes
     FROM file WHERE share_id = ?
     GROUP BY codec
     ORDER BY totalBytes DESC`,
  );

  // AC-4 per-share aggregates. hevcPercent = HEVC bytes / total bytes * 100.
  const sharesAggregateStmt = db.prepare<
    [number],
    {
      totalSize: number;
      hevcBytes: number;
    }
  >(
    `SELECT
       COALESCE(SUM(size_bytes), 0) AS totalSize,
       COALESCE(SUM(CASE WHEN LOWER(codec) = 'hevc' THEN size_bytes ELSE 0 END), 0) AS hevcBytes
     FROM file WHERE share_id = ?`,
  );
  const orphanAggregateStmt = db.prepare<
    [],
    { totalSize: number; hevcBytes: number; rowCount: number }
  >(
    `SELECT
       COALESCE(SUM(size_bytes), 0) AS totalSize,
       COALESCE(SUM(CASE WHEN LOWER(codec) = 'hevc' THEN size_bytes ELSE 0 END), 0) AS hevcBytes,
       COUNT(*) AS rowCount
     FROM file WHERE share_id IS NULL`,
  );

  // savings-by-share via file.status='done-smaller' JOIN job — mirror 10-01
  // SavingsBuckets.realized pattern (see stats.ts:617) but scoped per share.
  const savingsByShareStmt = db.prepare<[number], { savings: number }>(
    `SELECT COALESCE(SUM(j.bytes_in - j.bytes_out), 0) AS savings
     FROM file f
     JOIN job j ON j.file_id = f.id AND j.status = 'done'
     WHERE f.status = 'done-smaller'
       AND f.share_id = ?
       AND j.bytes_in IS NOT NULL AND j.bytes_out IS NOT NULL`,
  );

  // Top-folders pre-aggregate fetch — bounded by SR1 LIMIT 50_000. The query
  // pulls (share_id, path, size_bytes) joined with shares to surface the
  // share root path for prefix-stripping. ORDER BY size_bytes DESC ensures
  // the largest contributors stay inside the cap if truncation hits.
  const topFoldersAllStmt = db.prepare<
    [number],
    { share_id: number | null; size_bytes: number; path: string; share_path: string | null }
  >(
    `SELECT f.share_id AS share_id,
            f.size_bytes AS size_bytes,
            f.path AS path,
            s.path AS share_path
       FROM file f
       LEFT JOIN shares s ON s.id = f.share_id
      ORDER BY f.size_bytes DESC
      LIMIT ?`,
  );
  const topFoldersShareStmt = db.prepare<
    [number, number],
    { share_id: number | null; size_bytes: number; path: string; share_path: string | null }
  >(
    `SELECT f.share_id AS share_id,
            f.size_bytes AS size_bytes,
            f.path AS path,
            s.path AS share_path
       FROM file f
       LEFT JOIN shares s ON s.id = f.share_id
      WHERE f.share_id = ?
      ORDER BY f.size_bytes DESC
      LIMIT ?`,
  );

  // SR1 evidence: the same fetch but counting whether the cap was hit. Cheaper
  // than a second COUNT(*) on the filtered set in the worst case; we count
  // post-limit via the rows.length comparison.

  function buildPrefix(rel: string, depth: number): string | null {
    // Compute the depth-N folder prefix of a share-relative path.
    // Examples (depth=2):
    //   'A/B/C/file.mkv'  → 'A/B'
    //   'A/B/file.mkv'    → 'A/B'   (file's directory is depth-2; cap holds)
    //   'A/file.mkv'      → 'A'     (file's parent is the only directory)
    //   'file.mkv'        → null    (file in root; no folder to aggregate by)
    //   ''                → null
    if (!rel) return null;
    const segments = rel.split('/');
    if (segments.length < 2) return null;
    // Folder segments = everything except the last element (filename).
    const folderSegments = segments.slice(0, -1);
    const effective = Math.min(depth, folderSegments.length);
    return folderSegments.slice(0, effective).join('/');
  }

  function shareRelative(filePath: string, sharePath: string | null): string {
    if (!sharePath) return filePath; // orphan — fall back to absolute path
    if (filePath === sharePath) return '';
    const withSlash = sharePath.endsWith('/') ? sharePath : sharePath + '/';
    if (filePath.startsWith(withSlash)) return filePath.slice(withSlash.length);
    // root share '/' edge: stripping '/' gives the file path sans leading '/'
    if (sharePath === '/' && filePath.startsWith('/')) return filePath.slice(1);
    return filePath;
  }

  function getTopFoldersImpl(
    shareId: ShareIdParam,
    depth: number,
    limit: number,
  ): TopFoldersResult {
    const rawRows =
      shareId === 'all'
        ? topFoldersAllStmt.all(TOP_FOLDERS_PREAGGREGATE_LIMIT)
        : topFoldersShareStmt.all(shareId, TOP_FOLDERS_PREAGGREGATE_LIMIT);

    const truncated = rawRows.length >= TOP_FOLDERS_PREAGGREGATE_LIMIT;

    // JS Map-aggregation by (share_id, depth-N-prefix). Key includes share_id
    // so cross-share aggregation keeps the share-axis distinguishable for
    // operator deep-link (Q7).
    type AggKey = string;
    const agg = new Map<
      AggKey,
      { shareId: number | null; path: string; sizeBytes: number; fileCount: number }
    >();

    for (const row of rawRows) {
      const rel = shareRelative(row.path, row.share_path);
      const prefix = buildPrefix(rel, depth);
      if (prefix === null) continue; // file in root of share — no folder to aggregate
      // For cross-share view, prefix is RELATIVE to share-root; the operator
      // resolves it via the row-level share_id. Avoid joining absolute path
      // here — that would collide A/Movies with B/Movies under share=all.
      const key = `${row.share_id ?? 'null'}::${prefix}`;
      const hit = agg.get(key);
      if (hit) {
        hit.sizeBytes += row.size_bytes;
        hit.fileCount += 1;
      } else {
        agg.set(key, {
          shareId: row.share_id,
          path: prefix,
          sizeBytes: row.size_bytes,
          fileCount: 1,
        });
      }
    }

    const sorted = Array.from(agg.values()).sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { rows: sorted.slice(0, limit), truncated };
  }

  return {
    getKpis({ shareId }): KpiResult {
      const totalRow = shareId === 'all' ? sumSizeAllStmt.get() : sumSizeShareStmt.get(shareId);
      const totalSizeBytes = totalRow?.total ?? 0;

      const topFolder = getTopFoldersImpl(shareId, 1, 1);
      const largestFolder =
        topFolder.rows.length > 0
          ? {
              shareId: topFolder.rows[0].shareId,
              path: topFolder.rows[0].path,
              sizeBytes: topFolder.rows[0].sizeBytes,
            }
          : null;

      const optimizedRow = mostOptimizedShareStmt.get();
      const mostOptimizedShare = optimizedRow
        ? {
            shareId: optimizedRow.share_id,
            hevcPercent: Math.round(optimizedRow.hevcRatio * 10000) / 100,
          }
        : null;

      const legacyRow =
        shareId === 'all'
          ? legacyCodecPercentAllStmt.get()
          : legacyCodecPercentShareStmt.get(shareId);
      const legacyCodecPercent = legacyRow?.pct == null ? 0 : Math.round(legacyRow.pct * 100) / 100;

      return {
        totalSizeBytes,
        largestFolder,
        mostOptimizedShare,
        legacyCodecPercent,
      };
    },

    getSizeBuckets({ shareId }): BucketResult[] {
      const dbRows = shareId === 'all' ? bucketsAllStmt.all() : bucketsShareStmt.all(shareId);
      const byLabel = new Map(dbRows.map((r) => [r.label, r]));
      // SR4 canonical empty-state: ALWAYS return 4 fixed rows, even when DB is
      // empty — UI tables expect a stable shape.
      return BUCKET_BOUNDARIES.map((b) => {
        const hit = byLabel.get(b.label);
        return {
          label: b.label,
          minBytes: b.minBytes,
          maxBytes: b.maxBytes,
          fileCount: hit?.fileCount ?? 0,
          totalBytes: hit?.totalBytes ?? 0,
        };
      });
    },

    getCodecPie({ shareId }): CodecSlice[] {
      const dbRows = shareId === 'all' ? codecPieAllStmt.all() : codecPieShareStmt.all(shareId);
      return dbRows.map((r) => ({
        codec: r.codec,
        fileCount: r.fileCount,
        totalBytes: r.totalBytes,
      }));
    },

    getSharesTable(): ShareTableRow[] {
      const shares = deps.shareRepo.listAll();
      const rows: ShareTableRow[] = [];

      for (const s of shares) {
        const agg = sharesAggregateStmt.get(s.id);
        const totalSize = agg?.totalSize ?? 0;
        const hevcBytes = agg?.hevcBytes ?? 0;
        const hevcPercent = totalSize > 0 ? Math.round((hevcBytes / totalSize) * 10000) / 100 : 0;
        const savingsRow = savingsByShareStmt.get(s.id);
        const largestFolder = getTopFoldersImpl(s.id, 1, 1);
        rows.push({
          shareId: s.id,
          sharePath: s.path,
          totalSizeBytes: totalSize,
          hevcPercent,
          savingsBytes: savingsRow?.savings ?? 0,
          largestFolder:
            largestFolder.rows.length > 0
              ? {
                  path: largestFolder.rows[0].path,
                  sizeBytes: largestFolder.rows[0].sizeBytes,
                }
              : null,
        });
      }

      // SR3 orphan-bucket-row PINNED shape — appended last after named-shares.
      // savingsBytes = 0: orphan-files lack share-anchored job audit-trail;
      // largestFolder = null: depth-aggregate over orphans not semantically
      // meaningful (deep-link impossible without share-root context).
      const orphanRow = orphanAggregateStmt.get();
      if (orphanRow && orphanRow.rowCount > 0) {
        const totalSize = orphanRow.totalSize;
        const hevcBytes = orphanRow.hevcBytes;
        const hevcPercent = totalSize > 0 ? Math.round((hevcBytes / totalSize) * 10000) / 100 : 0;
        rows.push({
          shareId: null,
          sharePath: null,
          totalSizeBytes: totalSize,
          hevcPercent,
          savingsBytes: 0,
          largestFolder: null,
        });
      }

      return rows;
    },

    getTopFolders({ shareId, depth, limit }): TopFoldersResult {
      return getTopFoldersImpl(shareId, depth, limit ?? 10);
    },
  };
}
