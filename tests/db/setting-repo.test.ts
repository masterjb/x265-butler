import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeSettingRepo, type SettingRepo } from '@/src/lib/db/repos/setting';

type Db = InstanceType<typeof Database>;

describe('makeSettingRepo', () => {
  let db: Db;
  let repo: SettingRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = makeSettingRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('test_get_when_seed_default_present_then_returns_value', () => {
    // 14-04 (Plan 14-04 Task 2): scan_root / min_size_mb / extensions /
    // max_depth retired by migration 0027 — verify they are gone after the
    // full migrate-chain runs. Other seeds (encoder defaults from 0005) stay.
    expect(repo.get('scan_root')).toBeUndefined();
    expect(repo.get('min_size_mb')).toBeUndefined();
    expect(repo.get('extensions')).toBeUndefined();
    expect(repo.get('max_depth')).toBeUndefined();
    expect(repo.get('encoder')).toBe('auto');
  });

  it('test_get_when_key_absent_then_returns_undefined', () => {
    expect(repo.get('nonexistent_key')).toBeUndefined();
  });

  it('test_set_when_key_existed_then_overwrites_via_round_trip', () => {
    // 14-04: scan_root no longer a seeded key (dropped by 0027) — pick
    // encoder which still survives full migrate-chain.
    repo.set('encoder', 'nvenc');
    expect(repo.get('encoder')).toBe('nvenc');
  });

  it('test_set_when_key_new_then_inserts_via_round_trip', () => {
    repo.set('custom_pref', 'on');
    expect(repo.get('custom_pref')).toBe('on');
  });

  it('test_getAll_when_called_then_returns_all_seed_defaults', () => {
    const all = repo.getAll();
    // 03-01: 6 new seeds added by migration 0005 (encoder/concurrency + 4 crf_*).
    // 03-05: migration 0007 adds onboarding_completed seed.
    // 05-01: migration 0010 adds 7 auth seeds (auth_enabled, auth_setup_completed,
    //   session_secret, session_ttl_seconds, auth_trust_proxy_xff,
    //   password_pepper, bcrypt_cost).
    // 05-09: migration 0013 retires queue_paused (Pause concept removed).
    // 11-01: migration 0019 adds 6 bench_* settings.
    // 11-06: migration 0023 adds 3 default-matrix keys (encoders/presets/native_values).
    // 12-03: migration 0024 adds 4 preset_<encoder> seeds (libx265/nvenc/qsv/vaapi).
    expect(Object.keys(all).sort()).toEqual([
      'audio_auto_transcode_mp4',
      'auth_enabled',
      'auth_setup_completed',
      'auth_trust_proxy_xff',
      'auto_enqueue_after_scan',
      'bcrypt_cost',
      'bench_default_encoders',
      'bench_default_mode',
      'bench_default_native_values',
      'bench_default_presets',
      'bench_max_concurrent_runs',
      'bench_sample_count',
      'bench_sample_duration_seconds',
      'bench_vmaf_buckets',
      'bench_vmaf_model',
      'cache_pool_path',
      'concurrency',
      'crf_libx265',
      'crf_nvenc',
      'crf_qsv',
      'crf_vaapi',
      'default_crf',
      'delete_original_after_encode',
      'encoder',
      // 14-04 (Plan 14-04 Task 2): scan_root / extensions / min_size_mb /
      // max_depth dropped by migration 0027.
      'min_savings_percent',
      'onboarding_completed',
      'output_container',
      'output_suffix',
      'password_pepper',
      'preset_libx265',
      'preset_nvenc',
      'preset_qsv',
      'preset_vaapi',
      'session_secret',
      'session_ttl_seconds',
      'trash_retention_days',
    ]);
    // 05-01: auth seeds factory defaults (off-by-default zero-regression contract).
    expect(all.auth_enabled).toBe('false');
    expect(all.auth_setup_completed).toBe('false');
    expect(all.session_secret).toBe('');
    expect(all.session_ttl_seconds).toBe('604800');
    expect(all.auth_trust_proxy_xff).toBe('false');
    expect(all.password_pepper).toBe('');
    expect(all.bcrypt_cost).toBe('12');
    // 05-bonus / 16-05: encode-behavior toggles factory defaults. Migration
    // 0011 seeds '.x265.mkv'; 0028 UPDATEs WHERE value='.x265.mkv' to '-x265'
    // (D1=β). Net post-full-migrate value for fresh install: '-x265'.
    expect(all.delete_original_after_encode).toBe('false');
    expect(all.output_suffix).toBe('-x265');
    // 05-14: output_container factory default 'mkv' (preserves pre-05-14 behavior).
    expect(all.output_container).toBe('mkv');
    // 14-04 (Plan 14-04 Task 2): scan_root retired by 0027.
    expect(all.scan_root).toBeUndefined();
    expect(all.cache_pool_path).toBe('/mnt/cache/x265-butler');
    expect(all.default_crf).toBe('23');
    expect(all.min_savings_percent).toBe('5');
    expect(all.trash_retention_days).toBe('30');
    // 05-09: queue_paused retired by migration 0013.
    expect(all.queue_paused).toBeUndefined();
    expect(all.auto_enqueue_after_scan).toBe('false');
    // 03-01 migration 0005 seeds.
    expect(all.encoder).toBe('auto');
    expect(all.concurrency).toBe('auto');
    expect(all.crf_libx265).toBe('23');
    expect(all.crf_nvenc).toBe('23');
    expect(all.crf_qsv).toBe('22');
    expect(all.crf_vaapi).toBe('22');
    // 03-05 migration 0007 seed.
    expect(all.onboarding_completed).toBe('false');
    // 12-03 migration 0024 seeds (matches DEFAULT_PRESET_BY_ENCODER + AC-12 byte-identical).
    expect(all.preset_libx265).toBe('medium');
    expect(all.preset_nvenc).toBe('p5');
    expect(all.preset_qsv).toBe('slow');
    expect(all.preset_vaapi).toBe('slow');
  });

  it('test_getAll_when_after_set_then_includes_new_value', () => {
    repo.set('test_key', 'test_value');
    const all = repo.getAll();
    expect(all.test_key).toBe('test_value');
  });

  // 16-05 AC-1 + AC-2: migration 0028 outcome by fresh-install path.
  // Beforeach already runs full migrate() including 0028 — the row arrives
  // here as '-x265' (0011 → 0028 chain on empty DB).
  it('test_16_05_fresh_install_output_suffix_is_dash_x265', () => {
    expect(repo.get('output_suffix')).toBe('-x265');
  });

  // 16-05 AC-1 S1 (operator-customized preservation): post-migration, an
  // operator-customized value persists across re-runs of migrate (re-runs
  // are no-ops per schema_migrations gate). This validates that future
  // boots do not regress an operator's customization.
  it('test_16_05_operator_customized_value_persists_across_migrate_reruns', () => {
    repo.set('output_suffix', '_h265');
    expect(repo.get('output_suffix')).toBe('_h265');
    // Re-run migrate — already-applied versions are skipped; no UPDATE fires.
    migrate(db);
    expect(repo.get('output_suffix')).toBe('_h265');
  });
});
