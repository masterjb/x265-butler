// 26-02 (F5): output-mode helper — single source of truth for the operator-
// selectable file-output strategy.
//
// Pure module: zero side effects, zero logger import, zero filesystem access.
// Parallel to output-container.ts (deliberate boundary — output_mode is
// ORTHOGONAL to output_container/output_suffix: container picks the muxer,
// suffix names the sibling, mode decides suffix-sibling vs in-place-replace).
//
// Consumed by:
//   - orchestrator.ts (readSettings dispatch-boundary read + per-file resolution)
//   - settings PUT     (zod enum)
//   - settings-form.tsx (Select component options)
//
//   'suffix'  → default (code-fallback). Encode writes a sibling at the
//               operator's output_suffix path; original trashed or kept per
//               delete_original_after_encode. BYTE-IDENTICAL to pre-26-02.
//   'replace' → in-place. Original moved to TRASH (always — recoverability is
//               mandatory for a one-way-door), encoded output atomic-renamed
//               into the original basename. Hardlink-guarded (falls back to
//               suffix per-file). delete_original_after_encode is IGNORED in
//               replace mode (replace always trashes; never hard-unlinks).

export const OUTPUT_MODES = ['suffix', 'replace'] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

const OUTPUT_MODES_SET: ReadonlySet<string> = Object.freeze(new Set(OUTPUT_MODES));

export function isOutputMode(v: unknown): v is OutputMode {
  return typeof v === 'string' && OUTPUT_MODES_SET.has(v);
}
