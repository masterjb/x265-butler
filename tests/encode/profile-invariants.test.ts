// 12-03 audit AC-14: cross-surface invariants for per-encoder preset defaults.
//
// Three independent surfaces store the factory-default preset per encoder:
//   1. DEFAULT_PRESET_BY_ENCODER in src/lib/encode/profiles.ts (runtime lookup)
//   2. migrations/0024_preset_settings.sql (INSERT OR IGNORE seed)
//   3. PROFILE_BUILDERS pre-12-03 hardcoded preset values (frozen-in-time
//      snapshot — the byte-identical contract AC-12 relies on)
//
// This test enforces that all three agree AND that every default is a member
// of the W9-Catalog (PRESETS_BY_ENCODER) so a future Catalog refactor cannot
// silently introduce a runtime fallback that points at a non-existent preset.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PRESET_BY_ENCODER, ENCODER_IDS, type EncoderId } from '@/src/lib/encode/profiles';
import { PRESETS_BY_ENCODER } from '@/src/lib/encode/presets';

// Pre-12-03 PROFILE_BUILDERS hardcoded preset snapshot. Captured at 12-03
// authoring time (commit predecessor of 12-03 APPLY). NEVER mutate without
// also updating the orchestrator's dispatch-fallback contract AND the
// AC-12 byte-identical regression fixture in tests/encode/profiles.test.ts.
const PRE_12_03_HARDCODED_PRESET: Record<EncoderId, string> = {
  libx265: 'medium',
  nvenc: 'p5',
  qsv: 'slow',
  vaapi: 'slow',
};

describe('AC-14 invariants — DEFAULT_PRESET_BY_ENCODER ⊆ PRESETS_BY_ENCODER', () => {
  for (const encoder of ENCODER_IDS) {
    it(`test_DEFAULT_PRESET_BY_ENCODER_${encoder}_is_member_of_W9_Catalog`, () => {
      const defaultPreset = DEFAULT_PRESET_BY_ENCODER[encoder];
      const catalog = PRESETS_BY_ENCODER[encoder] as readonly string[];
      expect(catalog).toContain(defaultPreset);
    });
  }
});

describe('AC-14 invariants — 3-place consistency (migration 0024 ↔ DEFAULT_PRESET_BY_ENCODER ↔ pre-12-03 snapshot)', () => {
  const migrationPath = path.join(process.cwd(), 'migrations', '0024_preset_settings.sql');
  const sqlText = fs.readFileSync(migrationPath, 'utf8');

  // Parse `('preset_<encoder>', '<value>')` rows from the INSERT OR IGNORE block.
  function parseMigrationSeeds(text: string): Record<string, string> {
    const seeds: Record<string, string> = {};
    const rowRegex = /\(\s*'preset_(libx265|nvenc|qsv|vaapi)'\s*,\s*'([^']+)'\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = rowRegex.exec(text)) !== null) {
      seeds[match[1]] = match[2];
    }
    return seeds;
  }

  const migrationSeeds = parseMigrationSeeds(sqlText);

  for (const encoder of ENCODER_IDS) {
    it(`test_3_place_consistency_${encoder}_migration_0024_seed_equals_DEFAULT_equals_pre_12_03_snapshot`, () => {
      const migrationValue = migrationSeeds[encoder];
      const defaultValue = DEFAULT_PRESET_BY_ENCODER[encoder];
      const snapshotValue = PRE_12_03_HARDCODED_PRESET[encoder];

      expect(migrationValue).toBeDefined();
      expect(migrationValue).toBe(defaultValue);
      expect(defaultValue).toBe(snapshotValue);
    });
  }

  it('test_migration_0024_seeds_exactly_4_preset_rows', () => {
    expect(Object.keys(migrationSeeds).sort()).toEqual(['libx265', 'nvenc', 'qsv', 'vaapi']);
  });
});
