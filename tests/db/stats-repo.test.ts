import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeJobRepo, type JobRepo } from '@/src/lib/db/repos/job';
import { makeStatsRepo, type StatsRepo } from '@/src/lib/db/repos/stats';

type Db = InstanceType<typeof Database>;

const NOW = 1_800_000_000; // fixed UTC: 2027-01-15 (deterministic across runs)
const SECONDS_PER_DAY = 86400;

function setupDb(): { db: Db; fileRepo: FileRepo; jobRepo: JobRepo; statsRepo: StatsRepo } {
  const db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  const fileRepo = makeFileRepo(db);
  const jobRepo = makeJobRepo(db, {
    setFileStatus: (id, status, expectedVersion) => fileRepo.setStatus(id, status, expectedVersion),
    bulkSetFileStatusToPending: (ids, expectedStates) =>
      fileRepo.bulkSetStatusToPendingByIds(ids, expectedStates),
  });
  const statsRepo = makeStatsRepo(db);
  return { db, fileRepo, jobRepo, statsRepo };
}

function seedFile(fileRepo: FileRepo, p: string, hash: string) {
  return fileRepo.upsertByPath({
    path: p,
    size_bytes: 1000,
    mtime: 1_700_000_000,
    content_hash: hash,
    codec: 'h264',
    bitrate: 5_000_000,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: 'mp4',
    last_scanned_at: 1_700_000_500,

    share_id: null,
  });
}

// Insert a done job directly with controlled bytes_in / bytes_out / finished_at / encoder.
function seedDoneJob(
  db: Db,
  fileId: number,
  bytesIn: number,
  bytesOut: number,
  finishedAt: number,
  encoder = 'libx265',
): void {
  db.prepare(
    `INSERT INTO job (file_id, status, started_at, finished_at, encoder, bytes_in, bytes_out, duration_ms, created_at)
     VALUES (?, 'done', ?, ?, ?, ?, ?, 1000, ?)`,
  ).run(fileId, finishedAt - 100, finishedAt, encoder, bytesIn, bytesOut, finishedAt - 100);
}

describe('makeStatsRepo', () => {
  let db: Db;
  let fileRepo: FileRepo;
  let statsRepo: StatsRepo;

  beforeEach(() => {
    ({ db, fileRepo, statsRepo } = setupDb());
  });

  afterEach(() => {
    db.close();
  });

  // ============ getKpis ============

  it('test_getKpis_when_empty_then_zeros', () => {
    const kpis = statsRepo.getKpis(NOW);
    expect(kpis.totalSaved).toBe(0);
    expect(kpis.filesProcessed).toBe(0);
    expect(kpis.avgSavingsPercent).toBe(0);
    expect(kpis.cumulativeThroughputPerDay).toBe(0);
    expect(kpis.byEncoder).toEqual({});
  });

  it('test_getKpis_when_three_done_smaller_rows_then_totalSaved_is_sum', () => {
    const f1 = seedFile(fileRepo, '/m/a.mp4', 'a'.repeat(64));
    const f2 = seedFile(fileRepo, '/m/b.mp4', 'b'.repeat(64));
    const f3 = seedFile(fileRepo, '/m/c.mp4', 'c'.repeat(64));
    seedDoneJob(db, f1.id, 1000, 500, NOW - SECONDS_PER_DAY);
    seedDoneJob(db, f2.id, 2000, 1500, NOW - SECONDS_PER_DAY);
    seedDoneJob(db, f3.id, 3000, 1000, NOW - SECONDS_PER_DAY);
    const kpis = statsRepo.getKpis(NOW);
    expect(kpis.totalSaved).toBe(500 + 500 + 2000);
    expect(kpis.filesProcessed).toBe(3);
  });

  it('test_getKpis_when_done_larger_row_present_then_excluded_from_totalSaved', () => {
    const f1 = seedFile(fileRepo, '/m/a.mp4', 'a'.repeat(64));
    const f2 = seedFile(fileRepo, '/m/b.mp4', 'b'.repeat(64));
    seedDoneJob(db, f1.id, 1000, 500, NOW - SECONDS_PER_DAY);
    // done-larger: bytes_out > bytes_in
    seedDoneJob(db, f2.id, 1000, 1500, NOW - SECONDS_PER_DAY);
    const kpis = statsRepo.getKpis(NOW);
    expect(kpis.totalSaved).toBe(500); // only first row counted
  });

  it('test_getKpis_when_done_larger_row_present_then_included_in_filesProcessed', () => {
    const f1 = seedFile(fileRepo, '/m/a.mp4', 'a'.repeat(64));
    const f2 = seedFile(fileRepo, '/m/b.mp4', 'b'.repeat(64));
    seedDoneJob(db, f1.id, 1000, 500, NOW - SECONDS_PER_DAY);
    seedDoneJob(db, f2.id, 1000, 1500, NOW - SECONDS_PER_DAY); // done-larger
    const kpis = statsRepo.getKpis(NOW);
    expect(kpis.filesProcessed).toBe(2); // operator-honest count
  });

  it('test_getKpis_when_done_rows_have_encoder_then_byEncoder_groups_correctly', () => {
    const f1 = seedFile(fileRepo, '/m/a.mp4', 'a'.repeat(64));
    const f2 = seedFile(fileRepo, '/m/b.mp4', 'b'.repeat(64));
    const f3 = seedFile(fileRepo, '/m/c.mp4', 'c'.repeat(64));
    seedDoneJob(db, f1.id, 1000, 500, NOW - SECONDS_PER_DAY, 'libx265');
    seedDoneJob(db, f2.id, 2000, 1000, NOW - SECONDS_PER_DAY, 'nvenc');
    seedDoneJob(db, f3.id, 1500, 1000, NOW - SECONDS_PER_DAY, 'libx265');
    const kpis = statsRepo.getKpis(NOW);
    expect(kpis.byEncoder.libx265).toEqual({ count: 2, saved: 1000 });
    expect(kpis.byEncoder.nvenc).toEqual({ count: 1, saved: 1000 });
  });

  it('test_getKpis_when_only_failed_rows_then_filesProcessed_zero_and_byEncoder_empty', () => {
    const f1 = seedFile(fileRepo, '/m/a.mp4', 'a'.repeat(64));
    db.prepare(
      `INSERT INTO job (file_id, status, finished_at, exit_code, error_msg, created_at)
       VALUES (?, 'failed', ?, 1, 'boom', ?)`,
    ).run(f1.id, NOW, NOW - 100);
    const kpis = statsRepo.getKpis(NOW);
    expect(kpis.filesProcessed).toBe(0);
    expect(kpis.byEncoder).toEqual({});
    expect(kpis.totalSaved).toBe(0);
  });

  // audit M1: signature accepts `now` and DOES NOT re-read clock
  it('test_getKpis_when_signature_accepts_now_then_filesProcessed_window_uses_passed_value', () => {
    const f1 = seedFile(fileRepo, '/m/a.mp4', 'a'.repeat(64));
    // job finished 40 days ago
    seedDoneJob(db, f1.id, 1000, 500, NOW - 40 * SECONDS_PER_DAY);
    // With now=NOW (today), 40 days ago is OUTSIDE 30-day window
    const kpis = statsRepo.getKpis(NOW);
    expect(kpis.filesProcessed).toBe(0);
    // With now shifted 11 days back (now-11d), 40 days ago becomes 29 days ago — INSIDE window
    const kpisShifted = statsRepo.getKpis(NOW - 11 * SECONDS_PER_DAY);
    expect(kpisShifted.filesProcessed).toBe(1);
  });

  // ============ getTrend30d ============

  it('test_getTrend30d_when_called_then_returns_30_entries', () => {
    expect(statsRepo.getTrend30d(NOW)).toHaveLength(30);
  });

  it('test_getTrend30d_when_called_with_no_jobs_then_all_30_entries_have_savings_0', () => {
    const trend = statsRepo.getTrend30d(NOW);
    for (const point of trend) {
      expect(point.savings).toBe(0);
      expect(point.bytesIn).toBe(0);
      expect(point.bytesOut).toBe(0);
    }
  });

  it('test_getTrend30d_when_called_then_dates_in_YYYY_MM_DD_format_UTC', () => {
    const trend = statsRepo.getTrend30d(NOW);
    for (const point of trend) {
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('test_getTrend30d_when_jobs_on_different_days_then_per_day_aggregation_correct', () => {
    const f1 = seedFile(fileRepo, '/m/a.mp4', 'a'.repeat(64));
    const f2 = seedFile(fileRepo, '/m/b.mp4', 'b'.repeat(64));
    // 5 days ago (day index 25, since we have 0..29 with 0=today-29 and 29=today)
    seedDoneJob(db, f1.id, 2000, 500, NOW - 5 * SECONDS_PER_DAY);
    seedDoneJob(db, f2.id, 3000, 1000, NOW - 5 * SECONDS_PER_DAY);
    const trend = statsRepo.getTrend30d(NOW);
    const fiveDaysAgoEntry = trend.find(
      (p) => p.date === new Date((NOW - 5 * SECONDS_PER_DAY) * 1000).toISOString().slice(0, 10),
    );
    expect(fiveDaysAgoEntry).toBeDefined();
    expect(fiveDaysAgoEntry?.bytesIn).toBe(5000);
    expect(fiveDaysAgoEntry?.bytesOut).toBe(1500);
    expect(fiveDaysAgoEntry?.savings).toBe(3500);
  });

  // audit S7: chronological-ordering invariant
  it('test_getTrend30d_when_called_then_returns_chronologically_ordered_dates', () => {
    const trend = statsRepo.getTrend30d(NOW);
    for (let i = 0; i < trend.length - 1; i++) {
      expect(trend[i].date < trend[i + 1].date).toBe(true);
    }
    // First and last entries are exactly 29 days apart (29 transitions of 1 day each)
    expect(trend[0].date < trend[29].date).toBe(true);
  });

  // audit S7: idempotency invariant
  it('test_getTrend30d_when_two_consecutive_calls_with_same_now_then_byte_identical_outputs', () => {
    const f1 = seedFile(fileRepo, '/m/a.mp4', 'a'.repeat(64));
    seedDoneJob(db, f1.id, 1000, 500, NOW - 3 * SECONDS_PER_DAY);
    const a = statsRepo.getTrend30d(NOW);
    const b = statsRepo.getTrend30d(NOW);
    expect(a).toEqual(b);
  });

  // ============ getRecentActivity ============

  it('test_getRecentActivity_when_25_rows_and_limit_10_then_returns_10', () => {
    const f1 = seedFile(fileRepo, '/m/a.mp4', 'a'.repeat(64));
    for (let i = 0; i < 25; i++) {
      db.prepare(
        `INSERT INTO job (file_id, status, finished_at, encoder, bytes_in, bytes_out, duration_ms, created_at)
         VALUES (?, 'done', ?, 'libx265', 1000, 500, 1000, ?)`,
      ).run(f1.id, NOW - i * 100, NOW - i * 100 - 100);
    }
    const recent = statsRepo.getRecentActivity(10);
    expect(recent).toHaveLength(10);
    // 07-01: LEFT JOIN file threads file_path through.
    expect(recent[0].file_path).toBe('/m/a.mp4');
  });

  it('test_getRecentActivity_when_limit_above_1000_then_clamped', () => {
    const recent = statsRepo.getRecentActivity(99999);
    expect(recent.length).toBeLessThanOrEqual(1000);
  });

  it('test_getRecentActivity_when_limit_below_1_then_clamped_to_1', () => {
    const f1 = seedFile(fileRepo, '/m/a.mp4', 'a'.repeat(64));
    seedDoneJob(db, f1.id, 1000, 500, NOW);
    const recent = statsRepo.getRecentActivity(0);
    expect(recent).toHaveLength(1); // floor clamp to 1
    // 07-01: LEFT JOIN file threads file_path through.
    expect(recent[0].file_path).toBe('/m/a.mp4');
  });

  // 07-01: defense-in-depth coverage. Under FK CASCADE (default PRAGMA
  // foreign_keys=ON) orphan job rows are unreachable in production. PRAGMA-off
  // scope simulates raw-SQL bypass / future schema relaxations to verify the
  // LEFT JOIN null branch surfaces null instead of crashing.
  it('test_getRecentActivity_when_FK_pragma_off_orphan_then_file_path_null', () => {
    db.pragma('foreign_keys = OFF');
    try {
      db.prepare(
        `INSERT INTO job (file_id, status, finished_at, encoder, bytes_in, bytes_out, duration_ms, created_at)
         VALUES (?, 'done', ?, 'libx265', 1000, 500, 1000, ?)`,
      ).run(999999, NOW, NOW - 100);
      const recent = statsRepo.getRecentActivity(10);
      expect(recent).toHaveLength(1);
      expect(recent[0].file_path).toBeNull();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  });

  // 07-01: regression-guard — LEFT JOIN must not alter the (created_at DESC,
  // id DESC) ordering the pre-07-01 single-table SELECT delivered.
  it('test_getRecentActivity_when_join_then_orders_match_pre_join', () => {
    for (let i = 0; i < 5; i++) {
      const f = seedFile(fileRepo, `/m/order_${i}.mp4`, String.fromCharCode(97 + i).repeat(64));
      const createdAt = NOW - i * SECONDS_PER_DAY;
      db.prepare(
        `INSERT INTO job (file_id, status, finished_at, encoder, bytes_in, bytes_out, duration_ms, created_at)
         VALUES (?, 'done', ?, 'libx265', 1000, 500, 1000, ?)`,
      ).run(f.id, createdAt + 50, createdAt);
    }
    const recent = statsRepo.getRecentActivity(5);
    expect(recent).toHaveLength(5);
    for (let i = 0; i < recent.length - 1; i++) {
      expect(recent[i].created_at).toBeGreaterThanOrEqual(recent[i + 1].created_at);
    }
    expect(recent[0].created_at).toBe(NOW);
    expect(recent[4].created_at).toBe(NOW - 4 * SECONDS_PER_DAY);
    for (let i = 0; i < recent.length; i++) {
      expect(recent[i].file_path).toBe(`/m/order_${i}.mp4`);
    }
  });

  // ============ getCodecDistribution (07-02 A4) ============

  // Helper: seed a file with arbitrary codec/container/size for distribution tests.
  // Uses raw INSERT to bypass the seedFile defaults (h264/mp4/1000 bytes).
  function seedFileWithDist(
    p: string,
    hash: string,
    codec: string | null,
    container: string | null,
    sizeBytes: number,
  ): number {
    const result = db
      .prepare(
        `INSERT INTO file
           (path, size_bytes, mtime, content_hash, codec, container, last_scanned_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered')
         RETURNING id`,
      )
      .get(p, sizeBytes, 1_700_000_000, hash, codec, container, 1_700_000_500) as { id: number };
    return result.id;
  }

  it('test_getCodecDistribution_when_mixed_codecs_then_buckets_ordered_count_desc', () => {
    const GB = 1024 ** 3;
    // AC-1 seed: 60 hevc / 30 h264 / 5 av1 / 3 vp9 / 1 mpeg4 / 1 NULL.
    let n = 0;
    const seed = (codec: string | null, container: string, sizeBytes: number) =>
      seedFileWithDist(
        `/m/${++n}.mkv`,
        n.toString().padStart(64, '0'),
        codec,
        container,
        sizeBytes,
      );
    for (let i = 0; i < 60; i++) seed('hevc', 'matroska,webm', 10 * GB);
    for (let i = 0; i < 30; i++) seed('h264', 'matroska,webm', 10 * GB);
    for (let i = 0; i < 5; i++) seed('av1', 'matroska,webm', 10 * GB);
    for (let i = 0; i < 3; i++) seed('vp9', 'matroska,webm', (20 / 3) * GB); // 20 GB total
    seed('mpeg4', 'matroska,webm', 5 * GB);
    seed(null, 'matroska,webm', 5 * GB);

    const dist = statsRepo.getCodecDistribution();

    expect(dist.codec).toHaveLength(6);
    // ORDER BY count DESC, bucket ASC — deterministic ordering contract.
    expect(dist.codec[0]).toMatchObject({ bucket: 'hevc', count: 60 });
    expect(dist.codec[0].bytes).toBe(60 * 10 * GB);
    expect(dist.codec[1]).toMatchObject({ bucket: 'h264', count: 30 });
    expect(dist.codec[1].bytes).toBe(30 * 10 * GB);
    expect(dist.codec[2]).toMatchObject({ bucket: 'av1', count: 5 });
    expect(dist.codec[2].bytes).toBe(5 * 10 * GB);
    expect(dist.codec[3]).toMatchObject({ bucket: 'vp9', count: 3 });
    // 'other' (count=1) renders BEFORE 'unknown' (count=1) per alphabetic tie-break.
    expect(dist.codec[4]).toMatchObject({ bucket: 'other', count: 1 });
    expect(dist.codec[4].bytes).toBe(5 * GB);
    expect(dist.codec[5]).toMatchObject({ bucket: 'unknown', count: 1 });
    expect(dist.codec[5].bytes).toBe(5 * GB);

    expect(dist.totalFiles).toBe(100);
    // 60*10 + 30*10 + 5*10 + 20 + 5 + 5 = 600 + 300 + 50 + 20 + 5 + 5 = 980 GB.
    expect(dist.totalBytes).toBe(980 * GB);
  });

  it('test_getCodecDistribution_when_container_format_name_is_csv_then_normalizes_to_mkv_or_mp4', () => {
    let n = 0;
    const seed = (container: string | null) =>
      seedFileWithDist(`/m/${++n}.bin`, n.toString().padStart(64, '0'), 'h264', container, 1000);
    // AC-2 seed: ffprobe-csv output VERBATIM as the scan orchestrator writes it.
    for (let i = 0; i < 80; i++) seed('matroska,webm');
    for (let i = 0; i < 15; i++) seed('mov,mp4,m4a,3gp,3g2,mj2');
    for (let i = 0; i < 3; i++) seed('avi');
    for (let i = 0; i < 2; i++) seed(null);

    const dist = statsRepo.getCodecDistribution();
    expect(dist.container).toHaveLength(3);
    expect(dist.container[0]).toEqual({ bucket: 'mkv', count: 80 });
    expect(dist.container[1]).toEqual({ bucket: 'mp4', count: 15 });
    // 3 avi + 2 NULL collapsed into 'other'.
    expect(dist.container[2]).toEqual({ bucket: 'other', count: 5 });
    expect(dist.totalFiles).toBe(100);
  });

  it('test_getCodecDistribution_when_only_hevc_and_unmapped_codec_then_only_relevant_buckets_present', () => {
    let n = 0;
    const seed = (codec: string | null) =>
      seedFileWithDist(
        `/m/${++n}.mkv`,
        n.toString().padStart(64, '0'),
        codec,
        'matroska,webm',
        1000,
      );
    // SR1 contract: zero-count buckets are OMITTED. Seed 50 hevc + 1 vc1; assert
    // result.codec.length === 2 (hevc + 'other' from vc1's ELSE branch).
    for (let i = 0; i < 50; i++) seed('hevc');
    seed('vc1');

    const dist = statsRepo.getCodecDistribution();
    expect(dist.codec).toHaveLength(2);
    expect(dist.codec[0]).toMatchObject({ bucket: 'hevc', count: 50 });
    expect(dist.codec[1]).toMatchObject({ bucket: 'other', count: 1 });
    // h264 / av1 / vp9 / unknown buckets ABSENT from the array.
    const bucketKeys = dist.codec.map((b) => b.bucket);
    expect(bucketKeys).not.toContain('h264');
    expect(bucketKeys).not.toContain('av1');
    expect(bucketKeys).not.toContain('vp9');
    expect(bucketKeys).not.toContain('unknown');
  });

  // ============ getTopSavers ============
  // <!-- audit-added:M1 --> Removed two orphaned it() blocks that appeared here in the original plan spec:
  // (1) 'test_getTopSavers_when_empty_then_empty_array' — redundant with nested describe below
  // (2) 'test_getTopSavers_returns_top_N_ordered_by_savedBytes_desc' — empty body, vacuous pass, zero coverage
  // All getTopSavers coverage lives in the nested describe blocks only (each with own db/fileRepo/statsRepo).

  describe('getTopSavers', () => {
    let db2: Db;
    let fileRepo2: ReturnType<typeof makeFileRepo>;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      const s = setupDb();
      db2 = s.db;
      fileRepo2 = s.fileRepo;
      statsRepo2 = s.statsRepo;
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getTopSavers_empty_returns_empty_array', () => {
      expect(statsRepo2.getTopSavers(10)).toEqual([]);
    });

    it('test_getTopSavers_returns_rows_ordered_by_savedBytes_desc', () => {
      const f1 = seedFile(fileRepo2, '/a/big.mp4', 'hash-big');
      const f2 = seedFile(fileRepo2, '/a/small.mp4', 'hash-small');
      seedDoneJob(db2, f1.id, 1_000_000, 400_000, NOW - 10, 'libx265'); // saved 600k
      seedDoneJob(db2, f2.id, 500_000, 400_000, NOW - 5, 'libx265'); // saved 100k
      const rows = statsRepo2.getTopSavers(10);
      expect(rows).toHaveLength(2);
      expect(rows[0].savedBytes).toBe(600_000);
      expect(rows[1].savedBytes).toBe(100_000);
      expect(rows[0].filePath).toBe('/a/big.mp4');
    });

    it('test_getTopSavers_excludes_done_larger_jobs', () => {
      const f = seedFile(fileRepo2, '/a/c.mp4', 'hash-c');
      seedDoneJob(db2, f.id, 500_000, 600_000, NOW - 5); // done-larger: bytes_out > bytes_in
      expect(statsRepo2.getTopSavers(10)).toHaveLength(0);
    });
  });

  describe('getEncoderPerf', () => {
    let db2: Db;
    let fileRepo2: ReturnType<typeof makeFileRepo>;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      const s = setupDb();
      db2 = s.db;
      fileRepo2 = s.fileRepo;
      statsRepo2 = s.statsRepo;
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getEncoderPerf_empty_returns_empty_array', () => {
      expect(statsRepo2.getEncoderPerf()).toEqual([]);
    });

    it('test_getEncoderPerf_aggregates_per_encoder_ordered_by_saved_desc', () => {
      const f1 = seedFile(fileRepo2, '/a/x.mp4', 'hash-x');
      const f2 = seedFile(fileRepo2, '/a/y.mp4', 'hash-y');
      const f3 = seedFile(fileRepo2, '/a/z.mp4', 'hash-z');
      seedDoneJob(db2, f1.id, 1_000_000, 300_000, NOW - 10, 'hevc_nvenc'); // saved 700k (70%)
      seedDoneJob(db2, f2.id, 1_000_000, 500_000, NOW - 8, 'hevc_nvenc'); // saved 500k (50%)
      seedDoneJob(db2, f3.id, 500_000, 400_000, NOW - 5, 'libx265'); // saved 100k (20%)
      const rows = statsRepo2.getEncoderPerf();
      expect(rows).toHaveLength(2);
      expect(rows[0].encoder).toBe('hevc_nvenc');
      expect(rows[0].jobCount).toBe(2);
      expect(rows[0].totalSavedBytes).toBe(1_200_000);
      expect(rows[0].avgSavedPercent).toBe(60.0);
      expect(rows[1].encoder).toBe('libx265');
    });
  });

  describe('getTrend30dFull', () => {
    let db2: Db;
    let fileRepo2: ReturnType<typeof makeFileRepo>;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      const s = setupDb();
      db2 = s.db;
      fileRepo2 = s.fileRepo;
      statsRepo2 = s.statsRepo;
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getTrend30dFull_always_returns_30_entries', () => {
      const rows = statsRepo2.getTrend30dFull(NOW);
      expect(rows).toHaveLength(30);
      expect(rows.every((r) => r.jobCount === 0)).toBe(true);
    });

    it('test_getTrend30dFull_jobCount_matches_inserted_jobs', () => {
      const f = seedFile(fileRepo2, '/a/t.mp4', 'hash-t');
      const today = NOW;
      seedDoneJob(db2, f.id, 1_000_000, 600_000, today);
      const rows = statsRepo2.getTrend30dFull(NOW);
      const todayRow = rows.find(
        (r) => r.date === new Date(today * 1000).toISOString().slice(0, 10),
      );
      expect(todayRow?.jobCount).toBe(1);
      expect(todayRow?.savings).toBe(400_000);
    });
  });

  it('test_getCodecDistribution_when_file_table_empty_then_totalFiles_zero_and_arrays_empty', () => {
    const dist = statsRepo.getCodecDistribution();
    expect(dist.codec).toEqual([]);
    expect(dist.container).toEqual([]);
    expect(dist.totalFiles).toBe(0);
    expect(dist.totalBytes).toBe(0);

    // M6: EXPLAIN QUERY PLAN evidence — assert SCAN file + USE TEMP B-TREE
    // FOR GROUP BY for both new prepared statements (unindexed codec/container
    // → table-scan + temp-tree is the expected plan at the seeded test scale).
    type ExplainRow = { id: number; parent: number; notused: number; detail: string };
    const codecPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT
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
         FROM file GROUP BY bucket ORDER BY count DESC, bucket ASC`,
      )
      .all() as ExplainRow[];
    const containerPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT
           CASE
             WHEN container IS NULL THEN 'other'
             WHEN container LIKE '%matroska%' THEN 'mkv'
             WHEN container LIKE '%mp4%' THEN 'mp4'
             ELSE 'other'
           END AS bucket,
           COUNT(*) AS count
         FROM file GROUP BY bucket ORDER BY count DESC, bucket ASC`,
      )
      .all() as ExplainRow[];

    const codecDetails = codecPlan.map((r) => r.detail).join(' | ');
    const containerDetails = containerPlan.map((r) => r.detail).join(' | ');
    expect(codecDetails).toMatch(/SCAN file/);
    expect(codecDetails).toMatch(/USE TEMP B-TREE FOR GROUP BY/);
    expect(containerDetails).toMatch(/SCAN file/);
    expect(containerDetails).toMatch(/USE TEMP B-TREE FOR GROUP BY/);
    // Regression-guard: no nested SCAN file (would indicate accidental cartesian).
    expect((codecDetails.match(/SCAN file/g) ?? []).length).toBe(1);
    expect((containerDetails.match(/SCAN file/g) ?? []).length).toBe(1);
  });

  // ============ getResolutionDistribution (08-04 DISCOVERY A1) ============

  describe('getResolutionDistribution', () => {
    let db2: Db;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      ({ db: db2, statsRepo: statsRepo2 } = setupDb());
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getResolutionDistribution_when_empty_then_returns_empty_array', () => {
      expect(statsRepo2.getResolutionDistribution()).toEqual([]);
    });

    it('test_getResolutionDistribution_when_single_4K_file_then_single_bucket', () => {
      db2
        .prepare(
          `INSERT INTO file (path, size_bytes, mtime, content_hash, width, last_scanned_at, status)
         VALUES (?, 1000, 0, ?, 3840, 0, 'pending')`,
        )
        .run('/m/4k.mkv', 'a'.repeat(64));
      const rows = statsRepo2.getResolutionDistribution();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ bucket: '4K', count: 1 });
    });

    it('test_getResolutionDistribution_when_mixed_widths_then_correct_buckets_ordered_count_desc', () => {
      const seed = (width: number | null) =>
        db2
          .prepare(
            `INSERT INTO file (path, size_bytes, mtime, content_hash, width, last_scanned_at, status)
             VALUES (?, 1000, 0, ?, ?, 0, 'pending')`,
          )
          .run(
            `/m/${Math.random()}.mkv`,
            Math.random().toString(36).slice(2).padEnd(64, '0'),
            width,
          );
      for (let i = 0; i < 5; i++) seed(3840); // 4K
      for (let i = 0; i < 3; i++) seed(1920); // 1080p
      for (let i = 0; i < 2; i++) seed(1280); // 720p
      seed(640); // SD
      seed(null); // unknown
      const rows = statsRepo2.getResolutionDistribution();
      expect(rows[0]).toEqual({ bucket: '4K', count: 5 });
      expect(rows[1]).toEqual({ bucket: '1080p', count: 3 });
      expect(rows[2]).toEqual({ bucket: '720p', count: 2 });
      // SD + unknown both count=1; alphabetical tie-break: SD < unknown
      expect(rows[3]).toEqual({ bucket: 'SD', count: 1 });
      expect(rows[4]).toEqual({ bucket: 'unknown', count: 1 });
    });

    it('test_getResolutionDistribution_when_null_width_only_then_unknown_bucket', () => {
      db2
        .prepare(
          `INSERT INTO file (path, size_bytes, mtime, content_hash, width, last_scanned_at, status)
         VALUES (?, 1000, 0, ?, NULL, 0, 'pending')`,
        )
        .run('/m/null.mkv', 'b'.repeat(64));
      const rows = statsRepo2.getResolutionDistribution();
      expect(rows).toHaveLength(1);
      expect(rows[0].bucket).toBe('unknown');
    });
  });

  // ============ getFileStatusDistribution (08-04 DISCOVERY A2) ============

  describe('getFileStatusDistribution', () => {
    let db2: Db;
    let fileRepo2: ReturnType<typeof makeFileRepo>;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      ({ db: db2, fileRepo: fileRepo2, statsRepo: statsRepo2 } = setupDb());
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getFileStatusDistribution_when_empty_then_returns_empty_array', () => {
      expect(statsRepo2.getFileStatusDistribution()).toEqual([]);
    });

    it('test_getFileStatusDistribution_when_single_file_then_single_status_row', () => {
      seedFile(fileRepo2, '/m/a.mp4', 'a'.repeat(64));
      const rows = statsRepo2.getFileStatusDistribution();
      expect(rows).toHaveLength(1);
      // seedFile creates a file with default status 'discovered' but upsertByPath sets 'pending'
      expect(rows[0].count).toBe(1);
    });

    it('test_getFileStatusDistribution_when_multiple_statuses_then_ordered_count_desc', () => {
      // Insert directly with controlled statuses
      for (let i = 0; i < 5; i++)
        db2
          .prepare(
            `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, status)
             VALUES (?, 1000, 0, ?, 0, 'skipped-codec')`,
          )
          .run(`/m/s${i}.mp4`, `s${i}`.padEnd(64, '0'));
      for (let i = 0; i < 3; i++)
        db2
          .prepare(
            `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, status)
             VALUES (?, 1000, 0, ?, 0, 'vanished')`,
          )
          .run(`/m/v${i}.mp4`, `v${i}`.padEnd(64, '0'));
      const rows = statsRepo2.getFileStatusDistribution();
      expect(rows[0]).toEqual({ status: 'skipped-codec', count: 5 });
      expect(rows[1]).toEqual({ status: 'vanished', count: 3 });
    });

    it('test_getFileStatusDistribution_when_all_pending_then_one_row', () => {
      seedFile(fileRepo2, '/m/p1.mp4', 'p1'.padEnd(64, '0'));
      seedFile(fileRepo2, '/m/p2.mp4', 'p2'.padEnd(64, '0'));
      const rows = statsRepo2.getFileStatusDistribution();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('pending');
      expect(rows[0].count).toBe(2);
    });
  });

  // ============ getBitrateDistribution (08-04 DISCOVERY A3) ============

  describe('getBitrateDistribution', () => {
    let db2: Db;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      ({ db: db2, statsRepo: statsRepo2 } = setupDb());
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getBitrateDistribution_when_empty_then_returns_empty_array', () => {
      expect(statsRepo2.getBitrateDistribution()).toEqual([]);
    });

    it('test_getBitrateDistribution_when_single_high_bitrate_file_then_correct_bucket', () => {
      db2
        .prepare(
          `INSERT INTO file (path, size_bytes, mtime, content_hash, bitrate, last_scanned_at, status)
         VALUES (?, 1000, 0, ?, 25000, 0, 'pending')`,
        )
        .run('/m/hb.mkv', 'c'.repeat(64));
      const rows = statsRepo2.getBitrateDistribution();
      expect(rows).toHaveLength(1);
      expect(rows[0].bucket).toBe('>20 Mbps');
    });

    it('test_getBitrateDistribution_when_multiple_buckets_then_ordered_count_desc', () => {
      const seed = (bitrate: number | null) =>
        db2
          .prepare(
            `INSERT INTO file (path, size_bytes, mtime, content_hash, bitrate, last_scanned_at, status)
             VALUES (?, 1000, 0, ?, ?, 0, 'pending')`,
          )
          .run(
            `/m/${Math.random()}.mkv`,
            Math.random().toString(36).slice(2).padEnd(64, '0'),
            bitrate,
          );
      for (let i = 0; i < 4; i++) seed(500); // <1 Mbps
      for (let i = 0; i < 2; i++) seed(3000); // 1-5 Mbps
      seed(null); // unknown
      const rows = statsRepo2.getBitrateDistribution();
      expect(rows[0].bucket).toBe('<1 Mbps');
      expect(rows[0].count).toBe(4);
      expect(rows[1].bucket).toBe('1-5 Mbps');
      expect(rows[1].count).toBe(2);
    });

    it('test_getBitrateDistribution_when_null_bitrate_then_unknown_bucket', () => {
      db2
        .prepare(
          `INSERT INTO file (path, size_bytes, mtime, content_hash, bitrate, last_scanned_at, status)
         VALUES (?, 1000, 0, ?, NULL, 0, 'pending')`,
        )
        .run('/m/null.mkv', 'd'.repeat(64));
      const rows = statsRepo2.getBitrateDistribution();
      expect(rows).toHaveLength(1);
      expect(rows[0].bucket).toBe('unknown');
    });
  });

  // ============ getEncodeSpeedRatio (08-04 DISCOVERY B1) ============

  describe('getEncodeSpeedRatio', () => {
    let db2: Db;
    let fileRepo2: ReturnType<typeof makeFileRepo>;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      ({ db: db2, fileRepo: fileRepo2, statsRepo: statsRepo2 } = setupDb());
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getEncodeSpeedRatio_when_empty_then_returns_zero', () => {
      const r = statsRepo2.getEncodeSpeedRatio();
      expect(r.avgSpeedRatio).toBe(0);
      expect(r.sampleSize).toBe(0);
    });

    it('test_getEncodeSpeedRatio_when_single_done_job_then_correct_ratio', () => {
      // seedFile sets duration_seconds=60; job duration_ms=10000 → 60×1000/10000 = 6.0×
      const f = seedFile(fileRepo2, '/m/a.mp4', 'a'.repeat(64));
      db2
        .prepare(
          `INSERT INTO job (file_id, status, started_at, finished_at, encoder, bytes_in, bytes_out, duration_ms, created_at)
         VALUES (?, 'done', ?, ?, 'libx265', 1000, 500, 10000, ?)`,
        )
        .run(f.id, NOW - 10, NOW, NOW - 15);
      const r = statsRepo2.getEncodeSpeedRatio();
      expect(r.sampleSize).toBe(1);
      expect(r.avgSpeedRatio).toBeCloseTo(6.0, 1);
    });

    it('test_getEncodeSpeedRatio_when_null_duration_ms_then_excluded_from_sample', () => {
      const f = seedFile(fileRepo2, '/m/b.mp4', 'b'.repeat(64));
      db2
        .prepare(
          `INSERT INTO job (file_id, status, finished_at, encoder, bytes_in, bytes_out, created_at)
         VALUES (?, 'done', ?, 'libx265', 1000, 500, ?)`,
        )
        .run(f.id, NOW, NOW - 5);
      const r = statsRepo2.getEncodeSpeedRatio();
      expect(r.sampleSize).toBe(0);
    });
  });

  // ============ getFailedJobRate (08-04 DISCOVERY B2) ============

  describe('getFailedJobRate', () => {
    let db2: Db;
    let fileRepo2: ReturnType<typeof makeFileRepo>;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      ({ db: db2, fileRepo: fileRepo2, statsRepo: statsRepo2 } = setupDb());
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getFailedJobRate_when_empty_then_returns_zero_rate', () => {
      const r = statsRepo2.getFailedJobRate();
      expect(r.failRate).toBe(0);
      expect(r.sampleSize).toBe(0);
    });

    it('test_getFailedJobRate_when_all_done_then_fail_rate_zero', () => {
      const f = seedFile(fileRepo2, '/m/a.mp4', 'a'.repeat(64));
      seedDoneJob(db2, f.id, 1000, 500, NOW);
      const r = statsRepo2.getFailedJobRate();
      expect(r.failRate).toBe(0);
      expect(r.sampleSize).toBe(1);
    });

    it('test_getFailedJobRate_when_half_failed_then_rate_0_5', () => {
      const f1 = seedFile(fileRepo2, '/m/a.mp4', 'a'.repeat(64));
      const f2 = seedFile(fileRepo2, '/m/b.mp4', 'b'.repeat(64));
      seedDoneJob(db2, f1.id, 1000, 500, NOW);
      db2
        .prepare(
          `INSERT INTO job (file_id, status, finished_at, exit_code, error_msg, created_at)
         VALUES (?, 'failed', ?, 1, 'boom', ?)`,
        )
        .run(f2.id, NOW, NOW - 100);
      const r = statsRepo2.getFailedJobRate();
      expect(r.sampleSize).toBe(2);
      expect(r.failRate).toBeCloseTo(0.5);
    });

    it('test_getFailedJobRate_interrupted_excluded_from_denominator', () => {
      const f = seedFile(fileRepo2, '/m/a.mp4', 'a'.repeat(64));
      db2
        .prepare(`INSERT INTO job (file_id, status, created_at) VALUES (?, 'interrupted', ?)`)
        .run(f.id, NOW - 50);
      const r = statsRepo2.getFailedJobRate();
      // interrupted not in IN ('done', 'failed', 'cancelled') → sampleSize=0
      expect(r.sampleSize).toBe(0);
    });
  });

  // ============ getAvgQueueWait (08-04 DISCOVERY B3) ============

  describe('getAvgQueueWait', () => {
    let db2: Db;
    let fileRepo2: ReturnType<typeof makeFileRepo>;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      ({ db: db2, fileRepo: fileRepo2, statsRepo: statsRepo2 } = setupDb());
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getAvgQueueWait_when_empty_then_returns_zero', () => {
      const r = statsRepo2.getAvgQueueWait();
      expect(r.avgWaitSec).toBe(0);
      expect(r.sampleSize).toBe(0);
    });

    it('test_getAvgQueueWait_when_single_done_job_then_correct_wait', () => {
      const f = seedFile(fileRepo2, '/m/a.mp4', 'a'.repeat(64));
      const createdAt = NOW - 100;
      const startedAt = NOW - 60; // wait = 40s
      db2
        .prepare(
          `INSERT INTO job (file_id, status, started_at, finished_at, encoder, bytes_in, bytes_out, duration_ms, created_at)
         VALUES (?, 'done', ?, ?, 'libx265', 1000, 500, 1000, ?)`,
        )
        .run(f.id, startedAt, NOW, createdAt);
      const r = statsRepo2.getAvgQueueWait();
      expect(r.sampleSize).toBe(1);
      expect(r.avgWaitSec).toBeCloseTo(40.0, 1);
    });

    it('test_getAvgQueueWait_when_null_started_at_then_excluded', () => {
      const f = seedFile(fileRepo2, '/m/a.mp4', 'a'.repeat(64));
      db2
        .prepare(
          `INSERT INTO job (file_id, status, finished_at, encoder, bytes_in, bytes_out, created_at)
         VALUES (?, 'done', ?, 'libx265', 1000, 500, ?)`,
        )
        .run(f.id, NOW, NOW - 50);
      const r = statsRepo2.getAvgQueueWait();
      expect(r.sampleSize).toBe(0);
    });
  });

  // ============ getSkipTypeBreakdown (08-04 DISCOVERY B4) ============

  describe('getSkipTypeBreakdown', () => {
    let db2: Db;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      ({ db: db2, statsRepo: statsRepo2 } = setupDb());
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getSkipTypeBreakdown_when_empty_then_returns_empty_array', () => {
      expect(statsRepo2.getSkipTypeBreakdown()).toEqual([]);
    });

    it('test_getSkipTypeBreakdown_when_no_skipped_files_then_empty_array', () => {
      db2
        .prepare(
          `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, status)
         VALUES (?, 1000, 0, ?, 0, 'pending')`,
        )
        .run('/m/p.mp4', 'p1'.padEnd(64, '0'));
      expect(statsRepo2.getSkipTypeBreakdown()).toEqual([]);
    });

    it('test_getSkipTypeBreakdown_when_multiple_skip_statuses_then_ordered_count_desc', () => {
      for (let i = 0; i < 4; i++)
        db2
          .prepare(
            `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, status)
             VALUES (?, 1000, 0, ?, 0, 'skipped-codec')`,
          )
          .run(`/m/sc${i}.mp4`, `sc${i}`.padEnd(64, '0'));
      for (let i = 0; i < 2; i++)
        db2
          .prepare(
            `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, status)
             VALUES (?, 1000, 0, ?, 0, 'skipped-sidecar')`,
          )
          .run(`/m/ss${i}.mp4`, `ss${i}`.padEnd(64, '0'));
      const rows = statsRepo2.getSkipTypeBreakdown();
      expect(rows[0]).toEqual({ status: 'skipped-codec', count: 4 });
      expect(rows[1]).toEqual({ status: 'skipped-sidecar', count: 2 });
    });

    it('test_getSkipTypeBreakdown_non_skipped_statuses_excluded', () => {
      db2
        .prepare(
          `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, status)
         VALUES (?, 1000, 0, ?, 0, 'failed')`,
        )
        .run('/m/f.mp4', 'ff'.padEnd(64, '0'));
      db2
        .prepare(
          `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at, status)
         VALUES (?, 1000, 0, ?, 0, 'skipped-blocklist')`,
        )
        .run('/m/sb.mp4', 'sb'.padEnd(64, '0'));
      const rows = statsRepo2.getSkipTypeBreakdown();
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('skipped-blocklist');
    });
  });

  // ============ getAllTimeJobSummary (08-04 DISCOVERY B7) ============

  describe('getAllTimeJobSummary', () => {
    let db2: Db;
    let fileRepo2: ReturnType<typeof makeFileRepo>;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      ({ db: db2, fileRepo: fileRepo2, statsRepo: statsRepo2 } = setupDb());
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getAllTimeJobSummary_when_empty_then_all_zeros', () => {
      const r = statsRepo2.getAllTimeJobSummary();
      expect(r).toEqual({ done: 0, failed: 0, interrupted: 0, cancelled: 0, total: 0 });
    });

    it('test_getAllTimeJobSummary_when_done_and_failed_then_correct_counts', () => {
      const f1 = seedFile(fileRepo2, '/m/a.mp4', 'a'.repeat(64));
      const f2 = seedFile(fileRepo2, '/m/b.mp4', 'b'.repeat(64));
      seedDoneJob(db2, f1.id, 1000, 500, NOW);
      db2
        .prepare(
          `INSERT INTO job (file_id, status, finished_at, exit_code, error_msg, created_at)
         VALUES (?, 'failed', ?, 1, 'boom', ?)`,
        )
        .run(f2.id, NOW, NOW - 100);
      const r = statsRepo2.getAllTimeJobSummary();
      expect(r.done).toBe(1);
      expect(r.failed).toBe(1);
      expect(r.total).toBe(2);
    });

    it('test_getAllTimeJobSummary_total_includes_all_statuses_including_non_named', () => {
      // audit-added M1: total must count ALL statuses, not just 4 named ones.
      // Use separate files per non-done status (partial UNIQUE prevents two active-status
      // jobs on the same file: idx_job_active_per_file on job(file_id) WHERE status IN
      // ('queued','encoding')).
      const f1 = seedFile(fileRepo2, '/m/a.mp4', 'a'.repeat(64));
      const f2 = seedFile(fileRepo2, '/m/b.mp4', 'b'.repeat(64));
      const f3 = seedFile(fileRepo2, '/m/c.mp4', 'c'.repeat(64));
      seedDoneJob(db2, f1.id, 1000, 500, NOW);
      db2
        .prepare(`INSERT INTO job (file_id, status, created_at) VALUES (?, 'encoding', ?)`)
        .run(f2.id, NOW - 20);
      db2
        .prepare(`INSERT INTO job (file_id, status, created_at) VALUES (?, 'queued', ?)`)
        .run(f3.id, NOW - 30);
      const r = statsRepo2.getAllTimeJobSummary();
      expect(r.done).toBe(1);
      expect(r.total).toBe(3); // 1 done + 1 encoding + 1 queued
    });

    it('test_getAllTimeJobSummary_mixed_statuses_total_is_sum_of_all', () => {
      // 2 done + 1 encoding + 1 queued = 4 total; use separate files to avoid partial
      // UNIQUE constraint (idx_job_active_per_file on job(file_id) WHERE status IN
      // ('queued','encoding')).
      const f1 = seedFile(fileRepo2, '/m/d.mp4', 'd1'.padEnd(64, '0'));
      const f2 = seedFile(fileRepo2, '/m/e.mp4', 'e1'.padEnd(64, '0'));
      const f3 = seedFile(fileRepo2, '/m/f.mp4', 'f1'.padEnd(64, '0'));
      const f4 = seedFile(fileRepo2, '/m/g.mp4', 'g1'.padEnd(64, '0'));
      seedDoneJob(db2, f1.id, 1000, 500, NOW - 10);
      seedDoneJob(db2, f2.id, 1000, 500, NOW - 20);
      db2
        .prepare(`INSERT INTO job (file_id, status, created_at) VALUES (?, 'encoding', ?)`)
        .run(f3.id, NOW - 30);
      db2
        .prepare(`INSERT INTO job (file_id, status, created_at) VALUES (?, 'queued', ?)`)
        .run(f4.id, NOW - 40);
      const r = statsRepo2.getAllTimeJobSummary();
      expect(r.done).toBe(2);
      expect(r.total).toBe(4);
    });
  });

  // ============ getCurrentTrashSize (08-04 DISCOVERY C1) ============

  describe('getCurrentTrashSize', () => {
    let db2: Db;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      ({ db: db2, statsRepo: statsRepo2 } = setupDb());
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getCurrentTrashSize_when_empty_then_zero_bytes_zero_count', () => {
      const r = statsRepo2.getCurrentTrashSize();
      expect(r.trashBytes).toBe(0);
      expect(r.trashCount).toBe(0);
    });

    it('test_getCurrentTrashSize_when_restored_entries_then_excluded', () => {
      // Restored entry — should NOT be counted
      db2
        .prepare(
          `INSERT INTO trash_entry (original_path, trash_path, size_bytes, trashed_at, expires_at, restored_at)
         VALUES (?, ?, 5000, ?, ?, ?)`,
        )
        .run('/orig/a.mp4', '/trash/a.mp4', NOW - 100, NOW + 86400, NOW - 10);
      const r = statsRepo2.getCurrentTrashSize();
      expect(r.trashBytes).toBe(0);
      expect(r.trashCount).toBe(0);
    });

    it('test_getCurrentTrashSize_when_active_entries_then_sums_correctly', () => {
      const futureExpiry = NOW + 7 * 86400;
      db2
        .prepare(
          `INSERT INTO trash_entry (original_path, trash_path, size_bytes, trashed_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run('/orig/b.mp4', '/trash/b.mp4', 3000, NOW - 50, futureExpiry);
      db2
        .prepare(
          `INSERT INTO trash_entry (original_path, trash_path, size_bytes, trashed_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run('/orig/c.mp4', '/trash/c.mp4', 7000, NOW - 40, futureExpiry);
      const r = statsRepo2.getCurrentTrashSize();
      expect(r.trashBytes).toBe(10000);
      expect(r.trashCount).toBe(2);
    });

    it('test_getCurrentTrashSize_when_expired_entries_then_excluded', () => {
      // expires_at = 1_000_000 (year 2001) — definitely in the past relative to
      // CAST(strftime('%s', 'now') AS INTEGER) which uses real wall clock.
      db2
        .prepare(
          `INSERT INTO trash_entry (original_path, trash_path, size_bytes, trashed_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run('/orig/d.mp4', '/trash/d.mp4', 9000, 900_000, 1_000_000);
      const r = statsRepo2.getCurrentTrashSize();
      expect(r.trashBytes).toBe(0);
      expect(r.trashCount).toBe(0);
    });
  });

  // ============ getExpiringTrash (08-04 DISCOVERY C3) ============

  describe('getExpiringTrash', () => {
    let db2: Db;
    let statsRepo2: ReturnType<typeof makeStatsRepo>;

    beforeEach(() => {
      ({ db: db2, statsRepo: statsRepo2 } = setupDb());
    });
    afterEach(() => {
      db2.close();
    });

    it('test_getExpiringTrash_when_empty_then_count_zero', () => {
      expect(statsRepo2.getExpiringTrash(7)).toEqual({ count: 0 });
    });

    it('test_getExpiringTrash_when_entry_expires_within_window_then_counted', () => {
      // Use real wall-clock time from SQLite so BETWEEN math aligns.
      const sqlNow = (
        db2.prepare("SELECT CAST(strftime('%s', 'now') AS INTEGER) AS n").get() as { n: number }
      ).n;
      const expiresIn3Days = sqlNow + 3 * 86400;
      db2
        .prepare(
          `INSERT INTO trash_entry (original_path, trash_path, size_bytes, trashed_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run('/orig/e.mp4', '/trash/e.mp4', 1000, sqlNow - 100, expiresIn3Days);
      expect(statsRepo2.getExpiringTrash(7).count).toBe(1);
    });

    it('test_getExpiringTrash_when_entry_expires_outside_window_then_not_counted', () => {
      const sqlNow = (
        db2.prepare("SELECT CAST(strftime('%s', 'now') AS INTEGER) AS n").get() as { n: number }
      ).n;
      // Expires in 10 days — outside 7-day window
      const expiresIn10Days = sqlNow + 10 * 86400;
      db2
        .prepare(
          `INSERT INTO trash_entry (original_path, trash_path, size_bytes, trashed_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run('/orig/f.mp4', '/trash/f.mp4', 1000, sqlNow - 100, expiresIn10Days);
      expect(statsRepo2.getExpiringTrash(7).count).toBe(0);
    });

    it('test_getExpiringTrash_withinDays_below_1_clamped_to_1', () => {
      // No entries expiring within 1 day — but clamp shouldn't throw
      expect(() => statsRepo2.getExpiringTrash(0)).not.toThrow();
      expect(() => statsRepo2.getExpiringTrash(-5)).not.toThrow();
    });
  });

  // ============ getSavingsBuckets + getEncodeEfficiencyRate (10-01) ============

  describe('getSavingsBuckets', () => {
    it('test_getSavingsBuckets_empty_db_returns_all_zeros', () => {
      const b = statsRepo.getSavingsBuckets();
      expect(b).toEqual({ realized: 0, lost: 0, rejected: 0, realizedCount: 0, totalCount: 0 });
    });

    it('test_getSavingsBuckets_all_realized_done_smaller_correct_buckets', () => {
      const f1 = seedFile(fileRepo, '/m/a.mp4', 'a'.repeat(64));
      fileRepo.setStatus(f1.id, 'done-smaller', 0);
      seedDoneJob(db, f1.id, 1000, 800, NOW - 100);
      const b = statsRepo.getSavingsBuckets();
      expect(b.realized).toBe(200); // 1000-800
      expect(b.lost).toBe(0);
      expect(b.rejected).toBe(0);
      expect(b.realizedCount).toBe(1);
      expect(b.totalCount).toBe(1);
    });

    it('test_getSavingsBuckets_mixed_outcomes_correct_discrimination', () => {
      const f1 = seedFile(fileRepo, '/m/s.mp4', 'a'.repeat(64));
      const f2 = seedFile(fileRepo, '/m/l.mp4', 'b'.repeat(64));
      const f3 = seedFile(fileRepo, '/m/n.mp4', 'c'.repeat(64));
      fileRepo.setStatus(f1.id, 'done-smaller', 0);
      fileRepo.setStatus(f2.id, 'done-larger', 0);
      fileRepo.setStatus(f3.id, 'done-not-worth', 0);
      seedDoneJob(db, f1.id, 1000, 800, NOW - 300); // done-smaller: saves 200
      seedDoneJob(db, f2.id, 2000, 2500, NOW - 200); // done-larger: lost 2000
      seedDoneJob(db, f3.id, 3000, 2900, NOW - 100); // done-not-worth: lost 3000, rejected 100
      const b = statsRepo.getSavingsBuckets();
      expect(b.realized).toBe(200);
      expect(b.lost).toBe(5000); // 2000 + 3000
      expect(b.rejected).toBe(100); // 3000-2900
      expect(b.realizedCount).toBe(1);
      expect(b.totalCount).toBe(3);
    });

    it('test_getEncodeEfficiencyRate_when_one_of_three_realized_rate_is_one_third', () => {
      const f1 = seedFile(fileRepo, '/m/s2.mp4', 'd'.repeat(64));
      const f2 = seedFile(fileRepo, '/m/l2.mp4', 'e'.repeat(64));
      const f3 = seedFile(fileRepo, '/m/n2.mp4', 'f'.repeat(64));
      fileRepo.setStatus(f1.id, 'done-smaller', 0);
      fileRepo.setStatus(f2.id, 'done-larger', 0);
      fileRepo.setStatus(f3.id, 'done-not-worth', 0);
      seedDoneJob(db, f1.id, 1000, 800, NOW - 300);
      seedDoneJob(db, f2.id, 2000, 2500, NOW - 200);
      seedDoneJob(db, f3.id, 3000, 2900, NOW - 100);
      const eff = statsRepo.getEncodeEfficiencyRate();
      expect(eff.sampleSize).toBe(3);
      expect(eff.rate).toBeCloseTo(1 / 3, 5);
    });
  });
});
