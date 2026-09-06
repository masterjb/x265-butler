// 50-04: the Library list payload carries, for every row that is currently
// `blocklisted` BECAUSE OF A FILE-PINNED ENTRY, that entry's id. Without it the
// UI cannot offer a per-file unblock action — `DELETE /api/library/:id/blocklist`
// wants the blocklist_entry.id, and the Library row only knows the file.id.
//
// Built HERE and nowhere else, because two call sites need the identical shape:
//   - app/[locale]/library/page.tsx      (Server Component, SSR render path)
//   - app/api/library/route.ts           (GET /api/library JSON payload)
// Typing them separately is how the two drift apart (Map here, object there).
//
// This module is a LEAF ON PURPOSE: it imports no repo, no logger, no node
// builtin — the lookup is injected. Same discipline as
// src/lib/encode/crf-defaults.ts (49-05): a value-import that drags `@/src/lib/db`
// into a `'use client'` graph is type-correct, so neither `tsc --noEmit` nor
// vitest catches it; it fails first in `npm run build`.

import type { FileStatus } from '@/src/lib/db/schema';

/**
 * fileId → blocklist_entry.id.
 *
 * Keys are STRINGS, not numbers: this object is serialized to JSON for
 * `GET /api/library`, and JSON object keys are always strings. Typing it
 * `Record<number, number>` would be a lie on the wire and would invite a
 * `map[row.id]`/`map[String(row.id)]` split between the SSR and the API
 * consumer. One representation, both ends.
 */
export type BlocklistEntryIdMap = Record<string, number>;

/** Minimal row shape this helper needs — deliberately narrower than FileRow. */
type StatusRow = { id: number; status: FileStatus };

/** Minimal entry shape — deliberately narrower than BlocklistRow. */
type PinnedEntry = { id: number; file_id: number | null };

/**
 * Collect the file-pinned blocklist entry ids for the `blocklisted` rows of one
 * Library page.
 *
 * @param rows           the page's file rows (any superset of StatusRow)
 * @param findByFileIds  batched lookup, normally `blocklistRepo().findByFileIds`
 *
 * Returns `{}` WITHOUT calling `findByFileIds` when the page holds no
 * `blocklisted` row — the overwhelmingly common case, and the reason this is a
 * conditional lookup rather than an unconditional join.
 *
 * A row can hold at most one entry: `idx_blocklist_file_id_unique` is a partial
 * UNIQUE INDEX on `file_id WHERE file_id IS NOT NULL`
 * (migrations/0008_blocklist.sql). The single-assignment below rests on that
 * index, not on an assumption about iteration order.
 *
 * Rows that are `blocklisted` WITHOUT a file-pinned entry are simply absent from
 * the map — no `null` placeholder. Two different situations produce that state
 * and this helper cannot tell them apart (nor does it try):
 *   - a live path_pattern matches the file (the pattern flip in
 *     encode-guard.ts sets status only, it creates no per-file row), or
 *   - the pattern that caused the flip has since been deleted, which leaves the
 *     file stuck at `blocklisted` because the DELETE handler only flips back for
 *     entries with a non-NULL file_id.
 * Absence from this map therefore means exactly "no single entry to remove",
 * which is all the UI is entitled to claim.
 */
export function buildBlocklistEntryIdMap(
  rows: readonly StatusRow[],
  findByFileIds: (ids: readonly number[]) => readonly PinnedEntry[],
): BlocklistEntryIdMap {
  const blocklistedIds: number[] = [];
  for (const row of rows) {
    if (row.status === 'blocklisted') blocklistedIds.push(row.id);
  }
  if (blocklistedIds.length === 0) return {};

  const map: BlocklistEntryIdMap = {};
  for (const entry of findByFileIds(blocklistedIds)) {
    if (entry.file_id === null) continue; // unreachable via `file_id IN (…)`; defensive
    map[String(entry.file_id)] = entry.id;
  }
  return map;
}
