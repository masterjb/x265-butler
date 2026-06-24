# Changelog

All notable changes to x265-butler are documented here. This public changelog
starts at v2.20.0; earlier history is not published.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [2.37.0] — Output stream-mapping hardening

amd64-only image on a Debian 13 (Trixie) base. Fixes two encode-output failures
seen on real footage: iPhone `.MOV` clips that refused to encode, and long 4K
encodes that self-killed partway through. No new dependencies, no database
migrations, no API-contract change — output is byte-identical for sources without
incompatible streams; both changes are fully revertible.

### Fixed

- **iPhone `.MOV` encodes failed instantly (`Only audio, video, and subtitles are
supported for Matroska`).** iPhones attach Apple `mebx` timed-metadata data
  streams, and the encoder copied every source stream into the MKV mux — which
  Matroska rejects, so the header was refused before the first frame (`exit 234`,
  `0 frames`; it only looked like it failed near the end). The MKV path now maps
  only video/audio/subtitle and **attachment** streams (font attachments such as
  anime ASS fonts are preserved) and drops the incompatible data/unknown streams.
  MP4 output is unchanged. An audit warn records what was dropped.
- **Long 4K encodes self-killed with `stdout exceeded cap`.** ffmpeg's progress
  stream emitted ~2 blocks/sec; a ~5.5h 4K encode produced ~40k blocks (~8.4 MiB)
  and tripped the 8 MiB stdout guard — duration-bound, so 1080p/720p were fine.
  Progress is now throttled to one update every 30 seconds (~140 KiB over the same
  encode); the cap stays as a memory guard. The job-log "copy report" also no
  longer floods with progress lines — it now carries the real ffmpeg/x265 output.

## [2.36.0] — AMD/VAAPI card no longer lost after a fresh-install restart

amd64-only image on a Debian 13 (Trixie) base. Fixes an AMD/VAAPI encoder that
could disappear after restarting the container on a fresh install. No new
dependencies, no database migrations, no API-contract change.

### Fixed

- **AMD/VAAPI card lost until manual restart after a fresh-install restart.** At
  boot, encoder detection could run twice at the same instant (the boot loop and
  the first dispatch both probed an empty cache), launching two competing VAAPI
  probe-encodes that contended for the AMD card's single encode session. One
  probe exited non-zero, the card was marked broken, and that verdict was cached
  for the process lifetime. Detection is now single-flight — concurrent callers
  join one probe — so the first encode starts only after detection finishes on an
  idle GPU. Use the "Re-detect HW" button on `/diagnostics` to force a fresh probe.

## [2.35.0] — Web UI stays responsive while encoding

amd64-only image on a Debian 13 (Trixie) base. Keeps the web UI responsive while
encodes run, and makes slow request-path queries visible in diagnostics. No new
dependencies, no database migrations, no API-contract change — encode output is
byte-identical to v2.34.x; both changes are env-tunable and fully revertible.

### Fixed

- **Web UI sluggish / page-loads "crashing" while encoding.** ffmpeg children were
  spawned at the same OS scheduler priority as the Node web server, so a few
  concurrent encodes saturated the CPU and starved the interactive server →
  SSR page-loads stalled or timed out. Every ffmpeg child (encode, cropdetect,
  detection probe, Test Encode, version probe) is now renice'd to `19` (lowest
  priority): encodes run only on otherwise-idle CPU so the UI always wins the
  scheduler, while still using the full CPU when the UI is idle (throughput
  unchanged). Tune with `ENCODE_NICE=<-20..19>` (default `19`); `ENCODE_NICE=0`
  restores the pre-v2.35 behavior. An `EPERM` on a locked-down host never aborts
  an encode — it continues at the inherited priority.

### Changed

- **Slow request-path queries are now visible in diagnostics.** The `slow_query`
  event was emitted below the active log gate, so it never reached the in-memory
  ring buffer and `/api/diagnostics` → `slowQueries.topN` was always empty. It now
  emits at `warn`, surfacing slow queries in container logs and in the diagnostics
  copy-report. Tune the threshold with `SLOW_QUERY_MS=<ms>` (default `100`).

## [2.34.0] — Encode-stall fix on high-core-count hosts + auto-crop clarity

amd64-only image on a Debian 13 (Trixie) base. Fixes libx265 encodes that hung
forever on machines with very many CPU threads. No new dependencies, no database
migrations, no API-contract change — encode output is byte-identical to v2.33.x
except for the libx265 thread-pool cap (revertible) and a new info log line.

### Fixed

- **libx265 encode-stall on high-core-count hosts.** On a host with very many
  logical CPUs (reported on a 128-thread machine), libx265 jobs flipped to
  _encoding_ and then hung with the CPU idle — x265's own thread-pool auto-detect
  over-allocated (`Thread pool created using 21914 threads`) and stalled before the
  first frame. The libx265 codec now caps the pool at `pools = min(cpuCount, 16)`,
  covering normal encodes, the Test Encode, and the boot detection-probe. Override
  with `X265_POOLS=<N>` to pin an exact size, or `X265_POOLS=0` / `auto` to fall
  back to x265 native auto-detect. libx265 only — NVENC/QSV/VAAPI have no CPU thread
  pool and are unaffected.

### Changed

- **Auto-crop no-op is now visible.** When Auto-Crop is on and the source has no
  black bars, the file is encoded full-frame (correct, unchanged). That was silent
  and looked like the feature did nothing; it now logs a clear `crop_no_op` line and
  the Settings Auto-Crop card + onboarding state that a bars-free file is left
  unchanged on purpose — the expected result, not an error.

## [2.33.0] — Queue progress + sidecar / cache-path stabilization

amd64-only image on a Debian 13 (Trixie) base. Bug-stabilization release. No new
dependencies, no API-contract change.

### Fixed

- **Multi-job queue progress bars.** With parallelism ≥ 2 the live queue showed only
  one progress bar and it could vanish when a sibling job finished. Active jobs are
  now tracked per job, so each running encode keeps its own live bar.
- **Central-sidecar re-queue.** With `sidecar_mode = central`, already-encoded files
  could re-enter the queue after a rescan because the source-side sidecar was not
  written centrally. The source-keyed central sidecar is now written so completed
  files are recognized on resurface.
- **Legacy cache-path upgraders.** Installs carrying the old hardcoded
  `cache_pool_path = /mnt/cache/x265-butler` override (pre-auto-resolve default)
  could fail every dispatch with `EACCES` on hosts without that exact mount. A boot
  migration drops the legacy default row so the path auto-resolves to a writable
  location; deliberate custom overrides are untouched.

## [2.32.0] — Auto-crop / black-bar removal

amd64-only image on a Debian 13 (Trixie) base. Letterboxed/pillarboxed sources can
now have their black bars cropped out during the encode — the equivalent of
Handbrake's `crop = auto`. No new dependencies, no database migrations, no
API-contract change — `auto_crop` off + an empty `crop_override` behave identically
to v2.31.x.

### Added

- **Auto-crop (`auto_crop`).** A new _Auto-Crop_ card under Settings → Encoder.
  The toggle runs an ffmpeg `cropdetect` pre-pass on a short sample of each source,
  derives the `crop=W:H:X:Y`, and applies it to the encode so baked-in black bars
  are removed (per-file). A CPU `crop` filter applied before hardware upload, so it
  works uniformly across libx265, NVENC, QSV and VAAPI. The VMAF bench path stays
  crop-free, so quality comparisons remain apples-to-apples.
- **Manual crop override (`crop_override`).** A fixed `W:H:X:Y` geometry escape
  hatch. A valid override wins over the auto toggle (so you can force one specific
  crop with Auto-Crop off), and odd/malformed geometry is rejected on both the form
  and the API rather than failing the encode later.
- **Onboarding awareness callout.** The first-run encoder step points operators at
  the new Auto-Crop card (deep-link opens in a new tab, leaving the wizard intact).

## [2.31.0] — GPU device selection

amd64-only image on a Debian 13 (Trixie) base. Multi-GPU operators can now choose
which GPU encodes. No new dependencies, no database migrations, no API-contract
change — an empty `gpu_device` (Auto) behaves identically to v2.30.x.

### Added

- **Operator-selectable GPU device (`gpu_device`).** A new _GPU Device_ picker
  under Settings → Encoder, plus a matching one in the first-run onboarding
  hardware-acceleration step. Both lists are populated from a live probe of
  `/dev/dri/renderD*`, so you select the actual node you want (e.g. a discrete
  Arc) instead of being stuck with whatever enumerated first. Leave it on **Auto**
  (default) and behaviour is byte-identical to v2.30.x. The picked node is read
  single-source by the detector and passed explicitly to both QSV
  (`-init_hw_device qsv=hw:<node>`, a binding QSV never had before) and VAAPI
  (`-vaapi_device`); changing it invalidates the detection cache, so no container
  restart is needed. A pinned node that has since disappeared falls back to the
  first available node with a `gpu_device_not_found` warning.

### Fixed

- **Discrete GPU never used on multi-GPU hosts.** Encoder detection always grabbed
  the first `/dev/dri/renderD*` node (usually the Intel iGPU at `renderD128`), so a
  discrete card such as an Arc A380 (`renderD129`) was never probed or used. The new
  device selection makes the discrete card pickable.

## [2.30.0] — Storage + anti-double-work

amd64-only image on a Debian 13 (Trixie) base. Two storage / anti-double-work
items from operator reports. No new dependencies, no database migrations, no
API-contract change — an empty `trash_path` behaves identically to v2.29.x.

### Added

- **Configurable trash location (`trash_path`).** A new _Trash location_ field
  under Settings → Encoder → Sidecar card. Leave it empty (default) and the
  30-day recoverable originals-trash tracks the cache pool exactly as before. Set
  an absolute path (e.g. on the array) to keep the originals off the fast cache.
  Cache→array cross-device moves are handled automatically. The path is validated
  (absolute, not a system root, and not inside any scanned share so the watcher
  can't re-ingest the trashed originals). A bad/unmounted path fails loud with a
  dedicated `trash_move_failed` diagnostic instead of an opaque encode failure,
  and in replace-mode the original is left intact on failure.

### Fixed

- **Central-sidecar re-queue.** With `sidecar_mode=central`, the skip-pipeline
  only ever read the _beside_ sidecar, so it was blind to its own central
  forensics and re-queued already-encoded files. It now consults the central
  sidecar (with a beside fallback for libraries that switched modes), restoring
  full loop-protection. Backend-only; no configuration change required.

## [2.29.0] — Queue controls + pagination fixes

amd64-only image on a Debian 13 (Trixie) base. An operator-QoL release after the
clean-running v2.28.0: two queue-control features plus three list/pagination
fixes. No new dependencies, no database migrations, no change to the scan/encode
success path.

### Added

- **Queue pause/resume (pause-after-current).** A Pause/Resume control on the
  Queue page. Pausing stops the queue from picking up the _next_ job while the
  currently running encode finishes normally — it is not aborted (that is what
  Cancel-all does). Resume restarts dispatch immediately. A persistent banner
  shows the paused state. The pause is in-memory: a container restart resumes.
- **Bulk "Encode Now" on the Library.** Select multiple Library rows and queue
  them all at once. Blocklisted or already-queued items are skipped and reported
  per item without blocking the rest.

### Fixed

- **Queue list went empty after switching devices/tabs.** The pending/scheduled
  list now re-hydrates when the browser tab regains focus or the live connection
  reconnects, instead of staying stale until a full reload.
- **Logs page Per-Job tab was capped at 50 entries.** With more than 50 jobs you
  could not reach the current or older log files. The tab is now paginated, with
  out-of-range page clamping.
- **Trash page pagination needed a full reload.** The controls now repaint the
  page in place, and a stale out-of-range page clamps to the last real page.

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
