// 50-04 AC-29 (+ AC-8): the ONE builder both the SSR page and GET /api/library
// use. Tested here as a pure function so the two call sites cannot drift into
// different shapes (Map here, object there) or different skip-conditions.

import { describe, it, expect, vi } from 'vitest';
import {
  buildBlocklistEntryIdMap,
  type BlocklistEntryIdMap,
} from '@/src/lib/api/blocklist-entry-map';
import type { FileStatus } from '@/src/lib/db/schema';

function row(id: number, status: FileStatus) {
  return { id, status };
}

describe('buildBlocklistEntryIdMap', () => {
  it('test_buildMap_when_pinned_entries_exist_then_keys_are_string_fileIds', () => {
    const lookup = vi.fn(() => [
      { id: 91, file_id: 5 },
      { id: 92, file_id: 7 },
    ]);

    const map = buildBlocklistEntryIdMap([row(5, 'blocklisted'), row(7, 'blocklisted')], lookup);

    expect(map).toEqual({ '5': 91, '7': 92 });
    // JSON object keys are strings on the wire; the SSR path must not diverge
    // by using numeric keys. Object.keys proves the representation.
    expect(Object.keys(map)).toEqual(['5', '7']);
  });

  it('test_buildMap_when_no_blocklisted_row_then_empty_AND_lookup_not_called', () => {
    const lookup = vi.fn(() => []);

    const map = buildBlocklistEntryIdMap(
      [row(1, 'pending'), row(2, 'done-smaller'), row(3, 'failed')],
      lookup,
    );

    expect(map).toEqual({});
    expect(lookup).not.toHaveBeenCalled();
  });

  it('test_buildMap_when_mixed_statuses_then_only_blocklisted_ids_are_queried', () => {
    const lookup = vi.fn(() => [{ id: 91, file_id: 5 }]);

    buildBlocklistEntryIdMap([row(1, 'pending'), row(5, 'blocklisted'), row(9, 'queued')], lookup);

    expect(lookup).toHaveBeenCalledWith([5]);
  });

  it('test_buildMap_when_blocklisted_without_entry_then_key_absent_not_null', () => {
    // The pattern-flip case: encode-guard sets status only, it creates no row.
    // Indistinguishable here from the deleted-pattern case — and deliberately so:
    // absence means "no single entry to remove", nothing more.
    const lookup = vi.fn(() => []);

    const map: BlocklistEntryIdMap = buildBlocklistEntryIdMap([row(5, 'blocklisted')], lookup);

    expect(map).toEqual({});
    expect('5' in map).toBe(false);
  });

  it('test_buildMap_when_lookup_returns_null_file_id_then_skipped', () => {
    // Unreachable through `file_id IN (…)`, but the helper must not produce a
    // "null" key if a future caller injects a different lookup.
    const lookup = vi.fn(() => [
      { id: 91, file_id: null },
      { id: 92, file_id: 5 },
    ]);

    const map = buildBlocklistEntryIdMap([row(5, 'blocklisted')], lookup);

    expect(map).toEqual({ '5': 92 });
  });

  it('test_buildMap_when_no_rows_then_empty', () => {
    const lookup = vi.fn(() => []);
    expect(buildBlocklistEntryIdMap([], lookup)).toEqual({});
    expect(lookup).not.toHaveBeenCalled();
  });
});
