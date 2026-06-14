# Changelog

All notable changes to x265-butler are documented here. This public changelog
starts at v2.20.0; earlier history is not published.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [2.28.0] — Output compatibility + bench fixes

amd64-only image on a Debian 13 (Trixie) base. An intermediate stabilization
release fixing three operator-reported papercuts. No new dependencies, no
database migrations, no behaviour change to the scan/encode success path.

### Fixed

- **macOS / QuickTime HEVC playback (`.mp4` output).** HEVC inside `.mp4` now
  carries the `hvc1` codec tag. ffmpeg's default is `hev1`, which Apple
  QuickTime and Photos refuse to play — so an `.mp4` that played fine in VLC was
  silently broken on a Mac. Applies to `.mp4` output for every encoder (software
  and hardware). Matroska (`.mkv`) is unchanged; it ignores the fourcc.
- **Original modification time preserved on the encoded file.** The encoded
  output now inherits the source file's modification (and access) time instead of
  a fresh "now" timestamp, so sort-by-date, "recently added" heuristics, and
  Sonarr/Radarr import logic see the file at its real age. Best-effort and never
  fails an encode: if the timestamp can't be copied it is logged and the encode
  still commits. Sidecar `.json` files keep their real write time; only kept
  (smaller) outputs are stamped.
- **Benchmark "Verify on full file" — live status bar for a 2nd verify.**
  Running a second full-file verify on a different preset now shows the live
  progress card immediately, and Cancel/Retry act on the verify that is actually
  running — no page reload needed. Previously the status bar tracked the
  highest-numbered preset rather than the one in flight, so a second verify on a
  lower-numbered preset stayed invisible until reload. Idle and all-complete
  views are unchanged.

## [2.27.0] — QSV ratecontrol path fix + code-quality hardening

amd64-only image on a Debian 13 (Trixie) base. An intermediate stabilization
release. The headline fix restores hardware-encoder detection for Intel QSV
setups that were still falling back to software `libx265` after the v2.25.0
probe-size fix. This release also folds in a whole-project code-quality sweep
(the internal v2.26.0 work, which was never shipped as its own image — so the
previous public release is v2.25.0). No new dependencies, no database migrations.

### Fixed

- **QSV (`hevc_qsv`) ratecontrol path selection.** v2.25.0 fixed the
  encoder-detection probe frame size, but at that resolution ffmpeg/iHD
  auto-selects the low-power (VDENC) encode path, which rejects ICQ ratecontrol
  (`-global_quality`) — so some working Intel iGPUs (e.g. UHD 770) were still
  gated out of detection and dropped to software `libx265`. Detection now probes
  QSV in two tiers: ICQ on the full-encode path first (forced with `-low_power 0`,
  best quality), and if that path rejects it, a CQP (`-q:v`) fallback that runs in
  both the full and the low-power path. The variant that passes is persisted and
  used for every real encode (production, benchmark, diagnostics test-encode stay
  in sync). Full-encode chips keep ICQ quality; low-power-only chips keep hardware
  QSV via CQP instead of `libx265`. The variant is auto-resolved at detection on a
  1-frame test clip — a wrong guess never reaches a real file encode.

### Changed

- **Faster, more resilient internals (no behaviour change).** Bounded-concurrency
  file hashing/probing in the scanner and the change-watcher (sequential DB
  writes preserved), parallelised hardware-encoder detection probes with an
  explicit per-probe timeout, indexed and de-duplicated database read paths, and
  hardened React lifecycle/cleanup (SSE event-stream reconnect and the settings
  forms no longer leak timers or update state after unmount). Each change that
  touches a hot path ships an operator-flippable env-var revert lever (e.g.
  `SCAN_PROBE_CONCURRENCY`, `WATCH_INGEST_CONCURRENCY`) so a bad interaction with
  your hardware can be neutralised without a redeploy.
- **Largest source files split for maintainability.** The encode orchestrator's
  `processOne` path and the settings form were decomposed into focused helper
  modules and single-concern components. Pure file reorganisation: identical
  runtime behaviour and identical rendered UI.

## [2.25.0] — Encoder probe-size fix + diagnostics QoL

amd64-only image on a Debian 13 (Trixie) base. An intermediate stabilization
release. The headline fix restores hardware-encoder detection for Intel QSV and
Intel/AMD VAAPI setups that were wrongly falling back to software `libx265`.

### Fixed

- **Hardware encoder detection no longer fails on a too-small probe frame.** The
  encoder-detection probe-encode used a 16×16 test frame — below the minimum
  frame size HW HEVC encoders will open — so it failed with `Invalid argument`,
  the encoder was marked broken, and it was gated out of the detected list,
  dropping the job to software `libx265`. The probe now uses a **320×240** frame
  (the size the diagnostics test-encode already used), and both probe paths read
  one shared constant so they can't drift apart again.
- **Render-device group advisory no longer mis-fires.** The diagnostics
  render-device surface raised an amber "fix your group membership" warning plus
  a `PGID`/`--group-add` suggestion whenever a `/dev/dri/renderD*` node's owning
  group wasn't in the container's group list — even when the node was fully
  readable and writable. The advisory now fires only when a render node actually
  fails read/write, and a symmetric guard keeps a genuinely-failing in-group node
  amber rather than silently passing.

### Added

- **Library bulk-delete (row-only forget).** The Library selection bar gains a
  3rd action — "Delete (N)" — to forget many selected entries at once. Like the
  single-entry delete it is a row-only forget: it removes the database rows but
  **never touches the file on disk** (a re-scan re-adds the entry). Entries with
  an active encode job or referenced by a benchmark run are skipped with a
  per-entry result, behind a confirm cooldown.

No new dependencies, no migrations, no pipeline-format changes. Defaults are
unchanged from v2.24.x.

## [2.24.0] — Encoder-Detection QSV/VAAPI decoupling + UI polish

amd64-only image on a Debian 13 (Trixie) base. An intermediate stabilization
release: a broken Intel QSV runtime no longer costs you hardware acceleration,
plus a round of touch-target and layout polish.

### Changed

- **QSV and VAAPI are detected independently.** They are now treated as
  orthogonal capabilities on the same `/dev/dri` device — QSV matched by the
  `iHD` driver, VAAPI by `VAEntrypointEncSlice`. An `iHD` host exposes **both**
  `qsv` and `vaapi` candidates, and the runtime probe-encode gate verifies each
  on its own. When QSV is present-but-broken the encoder now falls back to
  **VAAPI** instead of dropping all the way down to software `libx265`; the
  diagnostics surface still flags the broken QSV so the fallback never silently
  hides it.
- **Touch-target & layout polish** — the Library "Encode now" action button and
  the desktop "Clear selection" button are lifted to the 44px touch-target
  standard (Library + Trash); the Queue two-column layout on wider screens is
  rebalanced from ~80/20 to an equal 50/50 split.

No new dependencies, no migrations, no pipeline-format changes. Defaults are
otherwise unchanged from v2.23.x.

## [2.23.0] — Output Strategy: Sidecar Location + In-Place Replace

amd64-only image on a Debian 13 (Trixie) base. Two opt-in Output settings for
operators on Sonarr/Radarr-managed libraries who don't want `movie.x265.mkv`
siblings and `.x265.json` sidecars cluttering the library. Defaults are
byte-identical to v2.22.x — an upgrade changes nothing until you opt in.

### Added

- **Selectable sidecar location** — new Output → Sidecar location setting:
  `beside` (default, sidecar next to the encoded file as before), `off` (no
  sidecar written), or `central` (sidecars go to a mirrored tree under `/config`
  instead of into the media library). `central` works even on a read-only media
  mount, and the boot-time orphan sweep covers it. Anti-double-work is
  unaffected — the MKV tag and DB hash still short-circuit re-encodes when the
  sidecar is `off` or `central`.
- **In-place replace** — new Output → Output mode setting: `suffix` (default —
  encode to `movie.x265.mkv`, leave the original) or `replace` (the encoded file
  takes the original's name, no `.x265` sibling). Replace is built for a one-way
  door: the original is moved to the recoverable trash **first** and only then is
  the new file atomic-renamed in, so a crash mid-commit always leaves a
  recoverable state; it **never hard-deletes** (it always trashes — ignoring
  `delete_original_after_encode` — so there is always a recovery path); hardlinked
  sources (Sonarr/Radarr "Use Hardlinks") fall back to suffix automatically and
  the link is left untouched (re-checked at commit); and a rename failure after
  the original was trashed is surfaced loudly with the recovery location. Enabling
  `replace` requires an explicit arm-then-confirm in Settings. Applies to future
  encodes only — existing `.x265.mkv` files are not swept. EN + DE.

No new dependencies, no migrations. Both settings persist via code-fallback
defaults — pull and restart, then opt in.

### Rollback

```
docker stop x265-butler && docker rm x265-butler
docker pull ghcr.io/masterjb/x265-butler:2.22.0
```

## [2.22.0] — QSV Restore + Diagnostics Excerpt

amd64-only image on a Debian 13 (Trixie) base. Restores Intel QuickSync (QSV)
HEVC encoding, which was broken on v2.20.0, and sharpens the diagnostics
surface around encoder-option failures. libx265 / NVENC / VAAPI are untouched.

### Fixed

- **QSV HEVC encoding restored** — the QSV profile was still passing the Intel
  MSDK-only `look_ahead` option, which the current oneVPL/libvpl runtime rejects
  with `(Invalid argument)`. That aborted both the encode and the detection
  probe, so QSV got gated out and you were pointed at hardware / pass-through
  problems that were not real. The option is removed — QSV encodes again.
- **Encoder-option rejections no longer misread as hardware faults** — the
  manual Test Encode on `/diagnostics` now recognises this whole class of
  encoder-option rejections and reports "the encoder rejected an ffmpeg option —
  NOT a hardware fault" instead of the misleading "check render group / GPU
  pass-through" hint. Real hardware faults still keep the hardware hint. EN + DE.

### Changed

- **Cleaner failure excerpts** — encoder-probe failure snippets on the
  diagnostics page now strip ffmpeg muxer/progress boilerplate so the actual
  error line is what you see.

No new dependencies, no migrations, no config changes — pull and restart.

### Rollback

```
docker stop x265-butler && docker rm x265-butler
docker pull ghcr.io/masterjb/x265-butler:2.21.0
```

## [2.21.0] — Operator Quality-of-Life

amd64-only image on a Debian 13 (Trixie) base. Quality-of-life pass on the
surfaces around the encode pipeline; the pipeline itself is unchanged.

### Fixed

- **VAAPI test-encode false `-38`** — the `/diagnostics` test-encode built its
  ffmpeg arguments differently from the real encode path and could fail with a
  misleading `Function not implemented (-38)` on working hardware. It now uses the
  same codec block as a real job (`-vaapi_device` + `-vf format=nv12,hwupload`).

### Added

- **Cache path auto-resolve** — at boot the app probes `/mnt/cache` for writability
  and uses it, falling back to `/config/cache` otherwise. The effective path and the
  reason it was chosen are surfaced on `/diagnostics` and in Settings; an explicit
  override still wins, and a config-fallback raises a space advisory.
- **Forget a library entry** — library rows can be deleted (row-only "forget" that
  drops the database entry without touching any file on disk), mainly for entries
  whose source file is already gone. 2-step confirm with a 10-second undo; blocked
  while a job for that file is active.
- **Clear log** — `/logs` gains a Clear-log button backed by `DELETE /api/logs` that
  empties the in-memory log buffer (2-step arm→confirm, no undo). Warns that the
  Diagnostics recent-errors / slow-requests / slow-queries views share the buffer.

### Rollback

```
docker stop x265-butler && docker rm x265-butler
docker pull ghcr.io/masterjb/x265-butler:2.20.0
```

## [2.20.0] — Encoder-Robustness + Mount-Gate

amd64-only image on a Debian 13 (Trixie) base.

### Fixed

- **Intel QSV "Error creating MFX session: -9"** — the image shipped Intel's iHD
  VA-driver but not the oneVPL MFX runtime that QSV links against. The image now
  bundles the oneVPL GPU-runtime (`libmfx-gen1.2`, `libvpl2`, `libigfxcmrt7`), and
  a CI guard verifies these libraries are present in every build.
- **False-positive `detected: qsv`** — detection no longer trusts the ffmpeg
  `-encoders` capability list alone. At boot each hardware encoder runs a 1-frame
  `testsrc` probe-encode and is reported as detected only if that probe exits 0.
  Set `X265_PROBE_ENCODE_DISABLED=1` to revert to parse-only detection.
- **NVENC copy-block** — the onboarding hint shipped `--gpus all` (compose/CLI
  syntax, not unRAID-native) and was missing the two mandatory env-vars. Each
  value now copies into the correct unRAID field.

### Added

- **Plain-language HW-init diagnosis** — a 13-pattern stderr → diagnosis dictionary
  maps opaque ffmpeg hardware-init failures to a cause + next step (EN + DE),
  surfaced directly under the failed test-encode result.
- **CPU / iGPU generation advisory** — `/proc/cpuinfo` is matched against an
  embedded Intel gen-table; HEVC-QSV needs Skylake (gen 6)+, 10-bit needs Kaby
  Lake (gen 7)+. On older silicon the wizard recommends the software fallback.
- **Render-node permission evidence** — `/diagnostics` reports, per
  `/dev/dri/renderD*` device, its owning GID, container-process membership, and
  read/write access from the container's point of view.
- **Output-mount writable-gate** — the setup wizard probes the chosen output path
  for writability at the Continue step (not at first encode), with an amber
  warning + override checkbox for false positives.
- **oneVPL runtime state** is now reported on `/diagnostics`.

### Rollback

```
docker stop x265-butler && docker rm x265-butler
docker pull ghcr.io/masterjb/x265-butler:2.19.0
```
