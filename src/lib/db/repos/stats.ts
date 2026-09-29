// 03-04 Plan Task 1: aggregation-only repo for the Dashboard.
// Recompute-on-read from existing `job` table — no rollup table (deferred to
// Milestone 2 per 03-04 CONTEXT §2 + §4). Audit M1 single-now signature.
//
// Audit D-statsrepo-di: simpler-by-design. No JobRepoDeps because this repo
// performs READ-ONLY aggregation queries with no cross-repo writes.

import type Database from 'better-sqlite3';
import type { FileStatus, JobRow } from '../schema';
import { withQueryTiming } from '@/src/lib/db/timing';

type Db = InstanceType<typeof Database>;

const SECONDS_PER_DAY = 86400;
const TREND_DAYS = 30;

// 28-01 P7/M5: trend-30d query extracted to a module-scope EXPORTED const so the
// AC-4 EXPLAIN-QUERY-PLAN test asserts against the REAL production string (not a
// retyped copy). Pure extraction — byte-identical to the former inline
// db.prepare('...') below; ZERO query-logic change. The WHERE filters
// `status = 'done' AND finished_at >= ?` with the column RAW → the composite
// idx_job_status_finished_at (migration 0006) serves it via SEARCH. The
// date(finished_at,'unixepoch') expression is in the SELECT + GROUP BY d ONLY,
// not the WHERE, so it does NOT defeat the index (the plan also shows
// USE TEMP B-TREE FOR GROUP BY — expected for the date-bucket aggregation).
export const TREND_30D_SQL = `SELECT date(finished_at, 'unixepoch') AS d,
            COALESCE(SUM(bytes_in), 0) AS bytesIn,
            COALESCE(SUM(bytes_out), 0) AS bytesOut
     FROM job
     WHERE status = 'done' AND finished_at >= ?
     GROUP BY d
     ORDER BY d ASC`;

export interface StatsKpis {
  totalSaved: number;
  filesProcessed: number;
  avgSavingsPercent: number;
  cumulativeThroughputPerDay: number;
  byEncoder: Record<string, { count: number; saved: number }>;
}

export interface StatsTrendPoint {
  date: string; // YYYY-MM-DD UTC
  bytesIn: number;
  bytesOut: number;
  savings: number;
}

// 07-01: LEFT JOIN file surfaces filename basename for Recent-Activity row click-nav.
// `file_path` nullable as defense-in-depth (FK CASCADE makes orphan unreachable in
// production with PRAGMA foreign_keys=ON; null branch covers PRAGMA-off tests +
// raw-SQL bypass + future schema relaxations).
export type RecentActivityRow = JobRow & { file_path: string | null };

// 07-02 A4: Library codec mix + container distribution. Buckets are defined
// SQL-side via CASE WHEN — single source of truth for the aggregation contract.
// Zero-count buckets are OMITTED from the arrays (GROUP BY semantics); component
// renders only buckets actually present.
export type CodecBucketKey = 'hevc' | 'h264' | 'av1' | 'vp9' | 'other' | 'unknown';
export type ContainerBucketKey = 'mkv' | 'mp4' | 'other';

export interface CodecBucket {
  bucket: CodecBucketKey;
  count: number;
  bytes: number;
}

export interface ContainerBucket {
  bucket: ContainerBucketKey;
  count: number;
}

export interface CodecDistribution {
  codec: CodecBucket[];
  container: ContainerBucket[];
  totalFiles: number;
  totalBytes: number;
}

// 07-05: StatsTrendPointFull extends StatsTrendPoint with per-day job count.
export type StatsTrendPointFull = StatsTrendPoint & { jobCount: number };

// 07-05: Top N files by bytes saved in done-smaller jobs.
export interface TopSaverRow {
  jobId: number;
  fileId: number | null;
  filePath: string | null;
  bytesIn: number;
  bytesOut: number;
  savedBytes: number;
  savedPercent: number; // ROUND(..., 1), e.g. 43.5
  finishedAt: number | null;
  encoder: string | null;
}

// 07-05: Per-encoder aggregation for the Encoder Performance chart.
export interface EncoderPerfRow {
  encoder: string;
  jobCount: number;
  totalSavedBytes: number;
  avgSavedPercent: number; // ROUND(..., 1)
}

// 10-01: 3-bucket savings discrimination via file.status JOIN (NOT bytes comparison).
// Prevents double-counting and correctly attributes each outcome bucket.
export type SavingsBuckets = {
  realized: number; // bytes_in - bytes_out for done-smaller files
  lost: number; // bytes_in for done-larger + done-not-worth (input processed, savings not realized)
  rejected: number; // bytes_in - bytes_out for done-not-worth where output < input (marginal savings discarded)
  realizedCount: number; // count of done-smaller jobs
  totalCount: number; // count of all finished (done) jobs
};

export type EfficiencyRate = {
  rate: number; // realizedCount / totalCount (0.0–1.0); 0 when totalCount=0
  sampleSize: number; // totalCount
};

export interface StatsRepo {
  // audit M1: getKpis accepts `now` so the route handler computes ONE
  // Math.floor(Date.now()/1000) value and passes it to BOTH getKpis +
  // getTrend30d for single-now consistency.
  getKpis(now: number): StatsKpis;
  getTrend30d(now: number): StatsTrendPoint[];
  getRecentActivity(limit: number): RecentActivityRow[];
  getCodecDistribution(): CodecDistribution;
  getTopSavers(limit: number): TopSaverRow[];
  getEncoderPerf(): EncoderPerfRow[];
  getTrend30dFull(now: number): StatsTrendPointFull[];
  // 08-04 DISCOVERY.md Hand-off Contract — 10 new methods (AC-1):
  getResolutionDistribution(): {
    bucket: '4K' | '1080p' | '720p' | 'SD' | 'unknown';
    count: number;
  }[];
  getFileStatusDistribution(): { status: FileStatus; count: number }[];
  getBitrateDistribution(): {
    bucket: '<1 Mbps' | '1-5 Mbps' | '5-10 Mbps' | '10-20 Mbps' | '>20 Mbps' | 'unknown';
    count: number;
  }[];
  getEncodeSpeedRatio(): { avgSpeedRatio: number; sampleSize: number };
  getFailedJobRate(): { failRate: number; sampleSize: number };
  getAvgQueueWait(): { avgWaitSec: number; sampleSize: number };
  getSkipTypeBreakdown(): { status: string; count: number }[];
  getAllTimeJobSummary(): {
    done: number;
    failed: number;
    interrupted: number;
    cancelled: number;
    total: number;
  };
  getCurrentTrashSize(): { trashBytes: number; trashCount: number };
  getExpiringTrash(withinDays: number): { count: number };
  // 10-01: 3-bucket savings aggregation via file.status JOIN.
  getSavingsBuckets(): SavingsBuckets;
  // 10-01: encode efficiency rate (realizedCount / totalCount).
  getEncodeEfficiencyRate(): EfficiencyRate;
}

export function makeStatsRepo(db: Db): StatsRepo {
  // KPI: total saved (only WHERE bytes_out < bytes_in — done-smaller rows).
  const totalSavedStmt = db.prepare<[], { saved: number | null }>(
    `SELECT COALESCE(SUM(bytes_in - bytes_out), 0) AS saved
     FROM job
     WHERE status = 'done' AND bytes_out IS NOT NULL AND bytes_in IS NOT NULL
       AND bytes_out < bytes_in`,
  );
  // KPI: files processed (all done rows in last 30 days).
  const filesProcessedStmt = db.prepare<[number], { c: number }>(
    `SELECT COUNT(*) AS c FROM job WHERE status = 'done' AND finished_at >= ?`,
  );
  // KPI: avg savings percent — over ALL done rows (negative-saving rows
  // counted; operator-honest).
  const avgSavingsStmt = db.prepare<[], { pct: number | null }>(
    `SELECT AVG((CAST(bytes_in AS REAL) - bytes_out) / CAST(bytes_in AS REAL) * 100) AS pct
     FROM job
     WHERE status = 'done' AND bytes_in IS NOT NULL AND bytes_in > 0 AND bytes_out IS NOT NULL`,
  );
  // KPI: cumulative throughput per day (last 30d total bytes_in / 30).
  const throughputStmt = db.prepare<[number], { totalIn: number | null }>(
    `SELECT COALESCE(SUM(bytes_in), 0) AS totalIn
     FROM job
     WHERE status = 'done' AND finished_at >= ? AND bytes_in IS NOT NULL`,
  );
  // KPI: by encoder breakdown.
  const byEncoderStmt = db.prepare<[], { encoder: string | null; count: number; saved: number }>(
    `SELECT encoder, COUNT(*) AS count, COALESCE(SUM(bytes_in - bytes_out), 0) AS saved
     FROM job
     WHERE status = 'done' AND encoder IS NOT NULL
     GROUP BY encoder`,
  );
  // Trend 30d: daily group-by date(finished_at).
  // audit S1: bucketing is UTC-based.
  // - SQL `date(finished_at, 'unixepoch')` returns YYYY-MM-DD in UTC.
  // - JS `new Date(...).toISOString().slice(0, 10)` is also UTC.
  // Both sides of the zip use the same convention, so day boundaries align.
  // Operator-facing chart tooltip surfaces the "(UTC)" suffix on the date
  // (i18n key dashboard.chart.tooltip.dateUtc) so a CET operator encoding
  // at 23:30 local time understands why the entry shows on tomorrow's UTC
  // bucket. tz-aware bucketing deferred to Milestone 2 if real demand surfaces.
  // 28-01 M5: consume the exported TREND_30D_SQL const (byte-identical to the
  // former inline string) so the AC-4 EXPLAIN test runs the real production SQL.
  const trendStmt = db.prepare<[number], { d: string; bytesIn: number; bytesOut: number }>(
    TREND_30D_SQL,
  );
  // 07-01: LEFT JOIN file ON file.id = job.file_id so the row carries
  // `file_path` (nullable) for the Dashboard Recent-Activity row.
  // EXPLAIN QUERY PLAN evidence: SCAN job USING INDEX idx_job_created_at + SEARCH file
  // USING INTEGER PRIMARY KEY (rowid=?) — both indexes already exist in 0002_jobs.sql.
  const recentStmt = db.prepare<[number], JobRow & { file_path: string | null }>(
    `SELECT job.*, file.path AS file_path
       FROM job
       LEFT JOIN file ON file.id = job.file_id
       ORDER BY job.created_at DESC, job.id DESC LIMIT ?`,
  );

  // 07-02 A4: codec bucket aggregation. Single SQL-side source of truth for the
  // 6-bucket contract. NULL codec → 'unknown' is defensive — production scan
  // flow always writes codec, but raw-SQL bypass + PRAGMA-off tests + future
  // schema relaxations keep the branch live. ORDER BY count DESC, bucket ASC
  // — stable secondary tie-break for deterministic rendering.
  const codecDistStmt = db.prepare<[], { bucket: CodecBucketKey; count: number; bytes: number }>(
    `SELECT
       CASE
         WHEN codec IS NULL THEN 'unknown'
         WHEN codec = 'hevc' THEN 'hevc'
         WHEN codec = 'h264' THEN 'h264'
         WHEN codec = 'av1' THEN 'av1'
         WHEN codec = 'vp9' THEN 'vp9'
         ELSE 'other'
       END AS bucket,
       COUNT(*) AS count,
       COALESCE(SUM(size_bytes), 0) AS bytes
     FROM file
     GROUP BY bucket
     ORDER BY count DESC, bucket ASC`,
  );

  // 07-02 A4: container bucket aggregation. ffprobe writes container as the raw
  // `format_name` comma-list (e.g. 'matroska,webm' for .mkv; 'mov,mp4,m4a,3gp,3g2,mj2'
  // for .mp4). LIKE-normalize SQL-side; collapse NULL + unknown formats to 'other'.
  const containerDistStmt = db.prepare<[], { bucket: ContainerBucketKey; count: number }>(
    `SELECT
       CASE
         WHEN container IS NULL THEN 'other'
         WHEN container LIKE '%matroska%' THEN 'mkv'
         WHEN container LIKE '%mp4%' THEN 'mp4'
         ELSE 'other'
       END AS bucket,
       COUNT(*) AS count
     FROM file
     GROUP BY bucket
     ORDER BY count DESC, bucket ASC`,
  );

  // 07-02 A4: file-table totals (count + bytes) for subtitle + percent calc.
  const totalsStmt = db.prepare<[], { totalFiles: number; totalBytes: number }>(
    `SELECT COUNT(*) AS totalFiles, COALESCE(SUM(size_bytes), 0) AS totalBytes FROM file`,
  );

  // 07-05: Top N done-smaller jobs by bytes saved, with source file path.
  // LEFT JOIN file for filePath — nullable defense-in-depth (same rationale as recentStmt).
  const topSaversStmt = db.prepare<
    [number],
    {
      jobId: number;
      fileId: number | null;
      filePath: string | null;
      bytesIn: number;
      bytesOut: number;
      savedBytes: number;
      savedPercent: number;
      finishedAt: number | null;
      encoder: string | null;
    }
  >(
    `SELECT job.id AS jobId,
            file.id AS fileId,
            file.path AS filePath,
            job.bytes_in AS bytesIn,
            job.bytes_out AS bytesOut,
            (job.bytes_in - job.bytes_out) AS savedBytes,
            ROUND(CAST(job.bytes_in - job.bytes_out AS REAL) / CAST(job.bytes_in AS REAL) * 100, 1) AS savedPercent,
            job.finished_at AS finishedAt,
            job.encoder AS encoder
     FROM job
     LEFT JOIN file ON file.id = job.file_id
     WHERE job.status = 'done'
       AND job.bytes_in IS NOT NULL
       AND job.bytes_out IS NOT NULL
       AND job.bytes_out < job.bytes_in
     ORDER BY savedBytes DESC
     LIMIT ?`,
  );

  // 07-05: Per-encoder aggregation — only done rows with encoder + valid bytes.
  const encoderPerfStmt = db.prepare<
    [],
    {
      encoder: string;
      jobCount: number;
      totalSavedBytes: number;
      avgSavedPercent: number;
    }
  >(
    `SELECT encoder,
            COUNT(*) AS jobCount,
            COALESCE(SUM(bytes_in - bytes_out), 0) AS totalSavedBytes,
            ROUND(AVG(CAST(bytes_in - bytes_out AS REAL) / CAST(bytes_in AS REAL) * 100), 1) AS avgSavedPercent
     FROM job
     WHERE status = 'done'
       AND encoder IS NOT NULL
       AND bytes_in IS NOT NULL
       AND bytes_out IS NOT NULL
     GROUP BY encoder
     ORDER BY totalSavedBytes DESC`,
  );

  // 07-05: Like trendStmt but adds COUNT(*) AS jobCount per day.
  const trendFullStmt = db.prepare<
    [number],
    { d: string; bytesIn: number; bytesOut: number; jobCount: number }
  >(
    `SELECT date(finished_at, 'unixepoch') AS d,
            COALESCE(SUM(bytes_in), 0) AS bytesIn,
            COALESCE(SUM(bytes_out), 0) AS bytesOut,
            COUNT(*) AS jobCount
     FROM job
     WHERE status = 'done' AND finished_at >= ?
     GROUP BY d
     ORDER BY d ASC`,
  );

  // 08-04 DISCOVERY.md line 226-240 — A1: Resolution distribution (full file scan;
  // no width index — expected plan: SCAN file + USE TEMP B-TREE FOR GROUP BY).
  const resolutionDistStmt = db.prepare<
    [],
    { bucket: '4K' | '1080p' | '720p' | 'SD' | 'unknown'; count: number }
  >(
    `SELECT
       CASE
         WHEN width IS NULL THEN 'unknown'
         WHEN width >= 3840 THEN '4K'
         WHEN width >= 1920 THEN '1080p'
         WHEN width >= 1280 THEN '720p'
         ELSE 'SD'
       END AS bucket,
       COUNT(*) AS count
     FROM file
     GROUP BY bucket
     ORDER BY count DESC, bucket ASC`,
  );

  // 08-04 DISCOVERY.md line 125-130 — A2: File status distribution (idx_file_status).
  const fileStatusDistStmt = db.prepare<[], { status: FileStatus; count: number }>(
    `SELECT status, COUNT(*) AS count
     FROM file
     GROUP BY status
     ORDER BY count DESC, status ASC`,
  );

  // 08-04 DISCOVERY.md line 244-258 — A3: Bitrate distribution (full file scan;
  // no bitrate index).
  const bitrateDistStmt = db.prepare<
    [],
    {
      bucket: '<1 Mbps' | '1-5 Mbps' | '5-10 Mbps' | '10-20 Mbps' | '>20 Mbps' | 'unknown';
      count: number;
    }
  >(
    `SELECT
       CASE
         WHEN bitrate IS NULL THEN 'unknown'
         WHEN bitrate < 1000 THEN '<1 Mbps'
         WHEN bitrate < 5000 THEN '1-5 Mbps'
         WHEN bitrate < 10000 THEN '5-10 Mbps'
         WHEN bitrate < 20000 THEN '10-20 Mbps'
         ELSE '>20 Mbps'
       END AS bucket,
       COUNT(*) AS count
     FROM file
     GROUP BY bucket
     ORDER BY count DESC, bucket ASC`,
  );

  // 08-04 DISCOVERY.md line 134-145 — B1: Encode speed ratio (LEFT JOIN file;
  // idx_job_status + file PK lookup).
  const encodeSpeedRatioStmt = db.prepare<[], { avgSpeedRatio: number | null; sampleSize: number }>(
    `SELECT
       ROUND(AVG(CAST(f.duration_seconds AS REAL) * 1000.0 / NULLIF(j.duration_ms, 0)), 2) AS avgSpeedRatio,
       COUNT(*) AS sampleSize
     FROM job j
     LEFT JOIN file f ON f.id = j.file_id
     WHERE j.status = 'done'
       AND j.duration_ms IS NOT NULL
       AND j.duration_ms > 0
       AND f.duration_seconds IS NOT NULL
       AND f.duration_seconds > 0`,
  );

  // 08-04 DISCOVERY.md line 149-155 — B2: Failed job rate (idx_job_status).
  // 'interrupted' excluded deliberately — represents mid-encode process kill,
  // not a configuration failure. Document choice in UI tooltip.
  const failedJobRateStmt = db.prepare<[], { failRate: number | null; sampleSize: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'failed') * 1.0 / NULLIF(COUNT(*), 0) AS failRate,
       COUNT(*) AS sampleSize
     FROM job
     WHERE status IN ('done', 'failed', 'cancelled')`,
  );

  // 08-04 DISCOVERY.md line 276-284 — B3: Average queue wait time (idx_job_status).
  const avgQueueWaitStmt = db.prepare<[], { avgWaitSec: number | null; sampleSize: number }>(
    `SELECT
       ROUND(AVG(started_at - created_at), 1) AS avgWaitSec,
       COUNT(*) AS sampleSize
     FROM job
     WHERE started_at IS NOT NULL
       AND status = 'done'
       AND started_at > created_at`,
  );

  // 08-04 DISCOVERY.md line 159-166 — B4: Skip type breakdown (file.status source;
  // M6 reclassification: uses file.status, NOT job.status).
  const skipTypeBreakdownStmt = db.prepare<[], { status: string; count: number }>(
    `SELECT status, COUNT(*) AS count
     FROM file
     WHERE status LIKE 'skipped-%'
     GROUP BY status
     ORDER BY count DESC, status ASC`,
  );

  // 08-04 DISCOVERY.md line 169-175 — B7: All-time job status summary (idx_job_status).
  // Returns one row per job status; caller accumulates with .all() loop.
  // audit-added M1: total = COUNT(*) ALL statuses, not just done+failed+interrupted+cancelled.
  const allTimeJobSummaryStmt = db.prepare<[], { status: string; count: number }>(
    `SELECT status, COUNT(*) AS count
     FROM job
     GROUP BY status
     ORDER BY count DESC, status ASC`,
  );

  // 08-04 DISCOVERY.md line 178-186 — C1: Total current trash size (idx_trash_expires_at).
  // CAST(strftime AS INTEGER) preserved per AC-2.
  const currentTrashSizeStmt = db.prepare<[], { trashBytes: number; trashCount: number }>(
    `SELECT
       COALESCE(SUM(size_bytes), 0) AS trashBytes,
       COUNT(*) AS trashCount
     FROM trash_entry
     WHERE restored_at IS NULL
       AND expires_at > CAST(strftime('%s', 'now') AS INTEGER)`,
  );

  // 08-04 DISCOVERY.md line 327-334 — C3: Files expiring soon (idx_trash_expires_at).
  // Parameter: seconds offset from now (pre-computed by caller as safeDays * 86400).
  // CAST(strftime AS INTEGER) preserved per AC-2.
  const expiringTrashStmt = db.prepare<[number], { count: number }>(
    `SELECT COUNT(*) AS count
     FROM trash_entry
     WHERE restored_at IS NULL
       AND expires_at BETWEEN CAST(strftime('%s', 'now') AS INTEGER)
                          AND CAST(strftime('%s', 'now') AS INTEGER) + ?`,
  );

  function getKpis(now: number): StatsKpis {
    return withQueryTiming('statsRepo.kpis', () => {
      // audit M1: `now` arrives from the caller — DO NOT re-read the clock here.
      const thirtyDaysAgo = now - TREND_DAYS * SECONDS_PER_DAY;
      const totalSaved = totalSavedStmt.get()?.saved ?? 0;
      const filesProcessed = filesProcessedStmt.get(thirtyDaysAgo)?.c ?? 0;
      const avgPctRaw = avgSavingsStmt.get()?.pct;
      const avgSavingsPercent =
        avgPctRaw === null || avgPctRaw === undefined ? 0 : Math.round(avgPctRaw * 100) / 100;
      const totalIn = throughputStmt.get(thirtyDaysAgo)?.totalIn ?? 0;
      const cumulativeThroughputPerDay = Math.floor(totalIn / TREND_DAYS);
      const byEncoder: Record<string, { count: number; saved: number }> = {};
      for (const row of byEncoderStmt.all()) {
        if (row.encoder) byEncoder[row.encoder] = { count: row.count, saved: row.saved };
      }
      return {
        totalSaved,
        filesProcessed,
        avgSavingsPercent,
        cumulativeThroughputPerDay,
        byEncoder,
      };
    });
  }

  function getTrend30d(now: number): StatsTrendPoint[] {
    return withQueryTiming('statsRepo.trend30d', () => {
      const thirtyDaysAgo = now - TREND_DAYS * SECONDS_PER_DAY;
      const dbRows = trendStmt.all(thirtyDaysAgo);
      const dbByDate = new Map(
        dbRows.map((r) => [r.d, { bytesIn: r.bytesIn, bytesOut: r.bytesOut }]),
      );
      // Generate 30 days backwards from `now` so empty days have explicit zeros.
      // audit S7: chronological ordering — result[i].date < result[i+1].date.
      const out: StatsTrendPoint[] = [];
      for (let i = TREND_DAYS - 1; i >= 0; i--) {
        const dayUnix = now - i * SECONDS_PER_DAY;
        const date = new Date(dayUnix * 1000).toISOString().slice(0, 10);
        const hit = dbByDate.get(date);
        out.push({
          date,
          bytesIn: hit?.bytesIn ?? 0,
          bytesOut: hit?.bytesOut ?? 0,
          savings: hit ? hit.bytesIn - hit.bytesOut : 0,
        });
      }
      return out;
    });
  }

  function getRecentActivity(limit: number): RecentActivityRow[] {
    return withQueryTiming('statsRepo.recentActivity', () => {
      // audit S9 pattern from JobRepo.listRecent: clamp [1, 1000].
      const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 1000);
      return recentStmt.all(safeLimit);
    });
  }

  function getCodecDistribution(): CodecDistribution {
    return withQueryTiming('statsRepo.codecDistribution', () => {
      const codecRows = codecDistStmt.all();
      const containerRows = containerDistStmt.all();
      const totals = totalsStmt.get() ?? { totalFiles: 0, totalBytes: 0 };
      return {
        codec: codecRows,
        container: containerRows,
        totalFiles: totals.totalFiles,
        totalBytes: totals.totalBytes,
      };
    });
  }

  function getTopSavers(limit: number): TopSaverRow[] {
    return withQueryTiming('statsRepo.topSavers', () => {
      const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
      return topSaversStmt.all(safeLimit);
    });
  }

  function getEncoderPerf(): EncoderPerfRow[] {
    return withQueryTiming('statsRepo.encoderPerf', () => encoderPerfStmt.all());
  }

  function getTrend30dFull(now: number): StatsTrendPointFull[] {
    return withQueryTiming('statsRepo.trend30dFull', () => {
      const thirtyDaysAgo = now - TREND_DAYS * SECONDS_PER_DAY;
      const dbRows = trendFullStmt.all(thirtyDaysAgo);
      const dbByDate = new Map(
        dbRows.map((r) => [
          r.d,
          { bytesIn: r.bytesIn, bytesOut: r.bytesOut, jobCount: r.jobCount },
        ]),
      );
      const out: StatsTrendPointFull[] = [];
      for (let i = TREND_DAYS - 1; i >= 0; i--) {
        const dayUnix = now - i * SECONDS_PER_DAY;
        const date = new Date(dayUnix * 1000).toISOString().slice(0, 10);
        const hit = dbByDate.get(date);
        out.push({
          date,
          bytesIn: hit?.bytesIn ?? 0,
          bytesOut: hit?.bytesOut ?? 0,
          savings: hit ? hit.bytesIn - hit.bytesOut : 0,
          jobCount: hit?.jobCount ?? 0,
        });
      }
      return out;
    });
  }

  // 08-04 DISCOVERY.md line 226-240 — A1
  function getResolutionDistribution() {
    return withQueryTiming('statsRepo.resolutionDist', () => resolutionDistStmt.all());
  }

  // 08-04 DISCOVERY.md line 125-130 — A2
  function getFileStatusDistribution() {
    return withQueryTiming('statsRepo.fileStatusDist', () => fileStatusDistStmt.all());
  }

  // 08-04 DISCOVERY.md line 244-258 — A3
  function getBitrateDistribution() {
    return withQueryTiming('statsRepo.bitrateDist', () => bitrateDistStmt.all());
  }

  // 08-04 DISCOVERY.md line 134-145 — B1
  function getEncodeSpeedRatio(): { avgSpeedRatio: number; sampleSize: number } {
    return withQueryTiming('statsRepo.encodeSpeedRatio', () => {
      const row = encodeSpeedRatioStmt.get();
      return { avgSpeedRatio: row?.avgSpeedRatio ?? 0, sampleSize: row?.sampleSize ?? 0 };
    });
  }

  // 08-04 DISCOVERY.md line 149-155 — B2
  function getFailedJobRate(): { failRate: number; sampleSize: number } {
    return withQueryTiming('statsRepo.failedJobRate', () => {
      const row = failedJobRateStmt.get();
      return { failRate: row?.failRate ?? 0, sampleSize: row?.sampleSize ?? 0 };
    });
  }

  // 08-04 DISCOVERY.md line 276-284 — B3
  function getAvgQueueWait(): { avgWaitSec: number; sampleSize: number } {
    return withQueryTiming('statsRepo.avgQueueWait', () => {
      const row = avgQueueWaitStmt.get();
      return { avgWaitSec: row?.avgWaitSec ?? 0, sampleSize: row?.sampleSize ?? 0 };
    });
  }

  // 08-04 DISCOVERY.md line 159-166 — B4
  function getSkipTypeBreakdown() {
    return withQueryTiming('statsRepo.skipTypeBreakdown', () => skipTypeBreakdownStmt.all());
  }

  // 08-04 DISCOVERY.md line 169-175 — B7
  // audit-added M1: total = COUNT(*) ALL statuses (includes pending/encoding/queued/vanished).
  function getAllTimeJobSummary(): {
    done: number;
    failed: number;
    interrupted: number;
    cancelled: number;
    total: number;
  } {
    return withQueryTiming('statsRepo.allTimeJobSummary', () => {
      const result = { done: 0, failed: 0, interrupted: 0, cancelled: 0, total: 0 };
      for (const row of allTimeJobSummaryStmt.all()) {
        result.total += row.count;
        if (row.status === 'done') result.done = row.count;
        else if (row.status === 'failed') result.failed = row.count;
        else if (row.status === 'interrupted') result.interrupted = row.count;
        else if (row.status === 'cancelled') result.cancelled = row.count;
      }
      return result;
    });
  }

  // 08-04 DISCOVERY.md line 178-186 — C1
  function getCurrentTrashSize(): { trashBytes: number; trashCount: number } {
    return withQueryTiming(
      'statsRepo.currentTrashSize',
      () => currentTrashSizeStmt.get() ?? { trashBytes: 0, trashCount: 0 },
    );
  }

  // 08-04 DISCOVERY.md line 327-334 — C3
  function getExpiringTrash(withinDays: number): { count: number } {
    return withQueryTiming('statsRepo.expiringTrash', () => {
      const safeDays = Math.max(1, Math.floor(withinDays));
      return expiringTrashStmt.get(safeDays * 86400) ?? { count: 0 };
    });
  }

  // 10-01: 3-bucket savings — discrimination via file.status JOIN (NOT bytes
  // comparison). SQLite uses idx_file_status for file filter +
  // idx_job_file_id for the join. All 5 queries are index-hit (no table scan).
  const savingsRealizedStmt = db.prepare<[], { realized: number }>(
    `SELECT COALESCE(SUM(j.bytes_in - j.bytes_out), 0) AS realized
     FROM file f
     JOIN job j ON j.file_id = f.id AND j.status = 'done'
     WHERE f.status = 'done-smaller'
       AND j.bytes_in IS NOT NULL AND j.bytes_out IS NOT NULL`,
  );
  const savingsLostStmt = db.prepare<[], { lost: number }>(
    `SELECT COALESCE(SUM(j.bytes_in), 0) AS lost
     FROM file f
     JOIN job j ON j.file_id = f.id AND j.status = 'done'
     WHERE f.status IN ('done-larger', 'done-not-worth')
       AND j.bytes_in IS NOT NULL`,
  );
  const savingsRejectedStmt = db.prepare<[], { rejected: number }>(
    `SELECT COALESCE(SUM(j.bytes_in - j.bytes_out), 0) AS rejected
     FROM file f
     JOIN job j ON j.file_id = f.id AND j.status = 'done'
     WHERE f.status = 'done-not-worth'
       AND j.bytes_in IS NOT NULL AND j.bytes_out IS NOT NULL
       AND j.bytes_out < j.bytes_in`,
  );
  const savingsRealizedCountStmt = db.prepare<[], { realizedCount: number }>(
    `SELECT COUNT(*) AS realizedCount
     FROM file f
     JOIN job j ON j.file_id = f.id AND j.status = 'done'
     WHERE f.status = 'done-smaller'`,
  );
  const savingsTotalCountStmt = db.prepare<[], { totalCount: number }>(
    `SELECT COUNT(*) AS totalCount
     FROM job WHERE status = 'done' AND finished_at IS NOT NULL`,
  );

  function getSavingsBuckets(): SavingsBuckets {
    const realized = savingsRealizedStmt.get()?.realized ?? 0;
    const lost = savingsLostStmt.get()?.lost ?? 0;
    const rejected = savingsRejectedStmt.get()?.rejected ?? 0;
    const realizedCount = savingsRealizedCountStmt.get()?.realizedCount ?? 0;
    const totalCount = savingsTotalCountStmt.get()?.totalCount ?? 0;
    return { realized, lost, rejected, realizedCount, totalCount };
  }

  function getEncodeEfficiencyRate(): EfficiencyRate {
    const totalCount = savingsTotalCountStmt.get()?.totalCount ?? 0;
    const realizedCount = savingsRealizedCountStmt.get()?.realizedCount ?? 0;
    const rate = totalCount > 0 ? realizedCount / totalCount : 0;
    return { rate, sampleSize: totalCount };
  }

  return {
    getKpis,
    getTrend30d,
    getRecentActivity,
    getCodecDistribution,
    getTopSavers,
    getEncoderPerf,
    getTrend30dFull,
    getResolutionDistribution,
    getFileStatusDistribution,
    getBitrateDistribution,
    getEncodeSpeedRatio,
    getFailedJobRate,
    getAvgQueueWait,
    getSkipTypeBreakdown,
    getAllTimeJobSummary,
    getCurrentTrashSize,
    getExpiringTrash,
    getSavingsBuckets,
    getEncodeEfficiencyRate,
  };
}
