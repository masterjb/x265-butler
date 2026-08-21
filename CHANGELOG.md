# Changelog

All notable changes to x265-butler are documented here. This public changelog
starts at v2.20.0; earlier history is not published.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [2.47.0] — Output integrity: a job that produced nothing no longer reports success

amd64-only image on a Debian 13 (Trixie) base. **No new dependencies, no database migration, no
settings change required.** Built from one report against 2.46.0 — a finished, green job whose
output held **17 of 371 722 video frames** — plus the four further "reports one thing, does
another" defects that checking it turned up. Where 2.46.0 fixed what the app _produces_, this
release fixes what it _reports_. **Nothing is repaired retroactively:** files hit by the 2.46.0
cover-art defect heal on their next encode, and library rows created by the old watch path stay
until you delete them.

### Fixed

- **An output without a picture was booked as a success.** `verifyOutput` checked only "ffprobe
  parses it" and "it has a size" — a video-less mux passes both, and the size ratio alone then
  picked a green verdict, trashed the original and marked the library row successful. Butler now
  counts the video packets of the produced file against the expected duration × frame rate and
  **fails** the job below 98 %, leaving the original untouched. The gate fails **open** in three
  named cases (no duration, no usable frame rate, counting probe failed) — a failed check is not
  evidence of a broken output. Escape hatch: `ENCODE_FRAME_GATE_DISABLED=1`.
- **The ffmpeg command line was never logged.** That is precisely why the 17-frame report could
  not be analysed. It is now the first line of every job log. It stays out of the diagnostics
  copy-report on purpose — that report is meant for sharing and would carry absolute share paths.
- **Cover art came back as a second video track in MKV.** The 2.46.0 stream-copy produced a
  600×900 MJPEG posing as a 90000 fps video stream: VLC crashes, mpv shows black with sound. The
  cover is now extracted losslessly and written back as a real Matroska attachment. Measured
  against ffmpeg directly, including the two ways of getting it wrong — a missing mimetype and a
  wrong attachment index both end in exit 234 with a 0-byte file. MP4 was never affected.
  Escape hatch: `ENCODE_COVER_ATTACH_DISABLED=1` (drops the cover; the output stays valid).
- **Auto-scan fed itself its own output.** The watch path ingested anything the file watcher
  reported — including the `*.x265-butler.json` sidecars Butler writes itself, plus posters,
  `.nfo` and `.srt` files, which became library rows and were queued, then failed with
  `Invalid data found when processing input`. It now applies the same media rules the scan
  walker always had. Escape hatch: `WATCH_INGEST_FILTER_DISABLED=1`.
- **The diagnostics test encode tested a different configuration than your jobs run.** It
  hard-coded CRF 28 and the default preset, ignored the 10-bit setting and the keyframe policy,
  and never read the encoder selection at all — so pinning VA-API while auto-detection preferred
  QSV meant the test probed QSV and reported on hardware the jobs never touch. It now resolves
  encoder, CRF, preset, 10-bit and keyframe interval through the same code the real encode uses,
  and reports every one of them plus the exact command line it ran. It also feeds proper 4:2:0
  video; it used to hand libx265 an RGB 4:4:4 frame, a format no real source has.

### Added

- **Un-blocklist directly from the library.** A blocklisted file carries an undo action in the
  slot the "add to blocklist" button vacates, with a 10-second undo window. Files blocklisted by
  a _pattern_ that has since been deleted have no entry to remove and therefore no button — a
  pre-existing gap, now visible and explained in the tooltip.
- **Free-text filter and a "hide telemetry" switch in the container log viewer.** The switch
  filters on the log _level_, not on a list of names, so a telemetry line that escalates into a
  warning stays visible. The download link still returns the **unfiltered** tail.

### Note for operators

If you enabled **force 10-bit** on hardware without 10-bit HEVC support, the diagnostics test
encode now comes back **red** where it previously came back green. That is correct — real jobs
fail the same way — but it will look like a regression. Likewise, a test encode whose pinned
encoder is not detected now says it fell back to libx265 instead of showing a green card.

The **root cause** behind the 17-frame report remains open. This release catches the symptom
reliably and makes the next such report analysable.

## [2.46.0] — Output correctness: cover art, keyframes, honest CRF scales

amd64-only image on a Debian 13 (Trixie) base. **No new migration file, no new dependencies, no
Dockerfile change** — the only database change is the seed value used when a database is created
from scratch. Built from one detailed report against 2.45.0 on an Intel N100 (iHD, VA-API
1.22.0) plus what checking it turned up. Where 2.45.0 fixed what the app _sees_, this release
fixes what it _produces_. **Files that failed on an older version need a retry** — nothing is
repaired retroactively.

### Fixed

- **Embedded cover art killed the encode.** An MKV carries cover art as a second video stream
  (`attached_pic`), and every `-c:v`, `-vf` and `-tag:v` argument was global, so ffmpeg tried to
  push a still image through the HEVC encoder alongside the film. Cover art is now detected by
  video ordinal and stream-copied; all three global video arguments were narrowed to the real
  video track (`-c:v:N copy`, `-filter:v:<n>`, `-tag:v:<n>`).
- **No keyframe interval was ever set.** Until 2.45.0 not one line of code set an interval, so
  every output rode ffmpeg's default `gop_size = 250` **frames** — about 10.4 s at 24 fps, which
  is what "the picture is only normal after ten seconds" was. Outputs now carry a forced keyframe
  every 5 s **and** a closed GOP; measured on the raw bitstream, the interval alone produced
  1 IDR + 5 CRA, the closed-GOP pin alone produced the wrong spacing, and only both together
  produced 6 IDR / 0 CRA at 5 s. A CRA with leading pictures is the "block garbage over an
  otherwise correct picture" signature.
- **The detection probe reported a working encoder as broken.** The synthetic probe fed
  `testsrc` (rgb24), which the iHD driver rejects, so `/diagnostics` declared QSV broken on hosts
  whose real encodes — which never see rgb24 — worked. The probe now pins `-pix_fmt nv12` for
  QSV and NVENC; **the production command line is byte-identical**.
- **A diagnostic line was printed every 15 seconds.** The CPU-attribution sampler had only two
  options — invisible to everyone (`debug`, cut before the diagnostics ring buffer) or shouted at
  the operator (`info`). Quiet ticks now use a recorded-but-not-printed tier.
- **An unknown `LOG_LEVEL` crashed the container** at module load. It now falls back to `info`
  with a single warning.
- **The four `crf_*` settings claimed a comparability that does not exist.** The same stored
  number sets a different ffmpeg parameter per encoder — `-crf` (libx265), `-qp` under
  `-rc constqp` (NVENC), `-qp` under `-rc_mode CQP` (VAAPI), and either `-global_quality` (ICQ)
  or `-q:v` (CQP) for QSV depending on the tier resolved at boot. Running one source through both
  Intel paths at UI value 22 produced 1.1 GB via QSV against 500 MB via VAAPI; no encoder was
  misbehaving.
- **The bench `native_quality_param` column named the wrong flag for NVENC** (`-cq`; the builder
  emits `-rc constqp -qp` and never emitted `-cq`) and a fixed flag for QSV regardless of tier.
  Both are now resolved when the row is created. **Existing rows are untouched** — the tier is
  not stored on the row, so rewriting them at display time would reinterpret history rather than
  repair it.

### Added

- **`-force_key_frames` every 5 s plus a per-encoder closed-GOP pin** — `open-gop=0` (libx265),
  `-forced_idr 1` (QSV), `-forced-idr 1` (NVENC). VAAPI deliberately emits nothing: its
  `idr_interval` default already means every I-frame is an IDR.
- **`ENCODE_KEYFRAME_INTERVAL_SEC`** (default `5`; `=0` emits no forced-keyframe argument) and
  **`ENCODE_CLOSED_GOP_DISABLED=1`**. Setting **both** reproduces the byte-identical 2.45.0
  command line — the complete revert without a downgrade. Both require a restart.
- **Boot confirmation of the IDR option.** One extra probe per working QSV/NVENC chain checks
  whether the runtime accepts the flag. A rejecting runtime **loses the closed-GOP pin and keeps
  working** — it is not removed from the encoder list. `/api/diagnostics` carries a per-encoder
  `forcedIdr` state of `supported` / `unsupported` / `not-probed`, and `not-probed` means
  genuinely unprobed, not "fine".
- **A `telemetry` log tier** that reaches the diagnostics ring buffer and the copy-report but not
  stdout. `LOG_LEVEL=debug` puts those lines back on stdout.
- **The resolved QSV rate-control tier is visible for the first time** — in the settings helper,
  as `encoders.outcome[].rateControl` in `/api/diagnostics` (`icq-full` / `cqp` / `unresolved` /
  `not-applicable`), and in the copy-report. When it cannot be resolved, the text names the
  `-global_quality` fallback the encode will actually use rather than only saying "unknown".
- **An advisory under the QSV CRF field** for existing installations still on 22 with QSV
  detected. It is display-only and writes nothing.

### Changed

- **Output files are larger, by design.** On a synthetic worst case (60 s `testsrc`, every frame
  new content, CRF 28 ultrafast): 518 185 B before, **614 321 B at the new 5 s default (+18.6 %)**.
  Real film material pays far less, because the I-frame share collapses when consecutive frames
  resemble each other. Note an effectiveness limit: the observable spacing is
  `min(interval, encoder GOP default)` and this release does not touch `gop_size`, so values
  above roughly 10 s have no effect.
- **New installations seed `crf_qsv = 26`** (was 22). **Existing installations are not migrated**
  — no setting row is written, in any migration or boot path. **The 26 is an estimate**, derived
  from the unRAID forum recommendation of 26–28 (lower end chosen); there is no VMAF measurement
  behind it. A calibrated number comes only from a vmaf-anchored `/bench` run, which the CRF
  section now links to. `crf_vaapi` stays at 22.
- **`LOG_LEVEL=silent` now silences stdout but keeps the diagnostics ring buffer filled**, so a
  copy-report from a silenced container still carries evidence. Previously it emptied both.
- **Bench pass 2 carries the new keyframe policy; pass 1 does not.** That preserves the
  apples-to-apples VMAF comparison, but the size recorded per combination now understates what a
  real encode produces. `bench_run` rows carry no marker of either the keyframe policy or the
  rate-control tier, so comparisons across the 2.45 → 2.46 boundary in the `/bench` UI are
  indicative only.

### Rollback

```
docker stop x265-butler && docker rm x265-butler
docker pull ghcr.io/masterjb/x265-butler:2.45.0
```

No migration file was added and no existing setting was rewritten, so the rollback is clean — the
five defects simply come back. A database created fresh on 2.46.0 keeps `crf_qsv = 26` after a
downgrade; it is an ordinary setting. The keyframe change reverts without a downgrade via
`ENCODE_KEYFRAME_INTERVAL_SEC=0` **and** `ENCODE_CLOSED_GOP_DISABLED=1`.

## [2.45.0] — Scan integrity on unRAID shares + share-root guard + honest queue counts

amd64-only image on a Debian 13 (Trixie) base. **No DB migration, no new dependencies, no
Dockerfile change.** Built entirely from three independent reports against 2.44.0, each traced
to a specific line of code. **Run one full library scan after upgrading** — the scan fix cannot
repair what an older version never wrote.

### Fixed

- **The scan skipped most of the library on `/mnt/user` shares.** Folders were deduplicated by
  device+inode, a normal POSIX assumption that does not hold on shfs: the share is one FUSE
  mount reporting one device id, while the array disks behind it keep independent inode
  numbering that shfs passes through unchanged. Entire sibling folder trees pruned each other —
  one reporter had 143 of 546 folders indexed, with nothing in the UI saying so. Loop protection
  now checks only the ancestors of the current descent path (GNU `find` semantics), so symlink
  loops are still caught while siblings can no longer collide.
- **A share path of `/` could take the container down.** Nothing rejected it, and the watcher
  then recursed the container's own root filesystem into an unthrottled permission-warning storm
  that flushed the diagnostics ring buffer and, in one report, killed the container.
- **The queue reported queued jobs as running.** `activeJobs` counts queued+encoding, and the UI
  rendered it as "active": with `encode_parallelism = 4` and 995 waiting files the header read
  "999 active", cancel-all offered to cancel 1994 jobs in a 999-job queue, and the topbar badge
  jumped from the correct 4 to 999 on the first live update.

### Added

- **Scan-integrity counters.** Every directory the walk refuses to enter — permissions, loop, or
  system path — is counted and surfaced under `## Scan Integrity` in the diagnostics copy-report,
  on the success path and when a scan throws.
- **Forbidden share roots.** `/`, `/proc`, `/sys`, `/dev`, `/etc`, `/boot` and `/run` are rejected
  on all three doors that write a share path: create, edit, and the onboarding wizard.
- **Self-healing runtime prune.** Both tree walkers skip `/proc`, `/sys`, `/dev` and `/run` at
  runtime regardless of the stored root, so an install that already carries a bad share path
  recovers without operator action. A share whose own root lies under one of those prefixes
  (e.g. `/run/media/usb1`) is exempted.
- **`encodingJobs`** — a new encoding-only count on the SSE `queue.updated` payload and on
  `GET /api/queue/status`.
- **Kill-switches `SCAN_PRUNE_SYSTEM_PATHS=0`** (disables the runtime prune in both walkers) and
  **`WATCH_FOLLOW_SYMLINKS=1`** (restores symlink following). Both require a container restart.

### Changed

- **The queue UI shows encoding and waiting separately** — header `4 encoding · 995 queued`,
  cancel-all counting each job once, a topbar badge that no longer jumps and that clears as soon
  as the last encode finishes, and a dashboard card that distinguishes encoding from waiting.
  **The wire field `activeJobs` keeps its name and its meaning (queued + encoding)** — external
  SSE consumers are unaffected.
- **The watcher no longer follows symlinked directories.** If a media tree is reached through a
  symlink, auto-scan stops seeing it; `WATCH_FOLLOW_SYMLINKS=1` is the documented recovery lever.
- **Permission-warning damping.** A watch-error storm now costs at most about two log lines per
  15 minutes per share (escalating window) instead of one line per error.
- **`cpu_attribution.activeEncodes` in the diagnostics copy-report is encoding-only** from this
  version on. When comparing two pasted reports across the 2.44 → 2.45 boundary, the same field
  name means slightly different things on either side.

### Rollback

```
docker stop x265-butler && docker rm x265-butler
docker pull ghcr.io/masterjb/x265-butler:2.44.0
```

No migration, so the rollback is clean — the three defects simply come back. Library entries a
2.45.0 scan added stay in the database.

## [2.44.0] — Delete bench runs + library-delete unblock

amd64-only image on a Debian 13 (Trixie) base. **Carries DB migration 0029, which is
forward-only — back up your appdata folder before upgrading.** No new dependencies, no
Dockerfile change; encode and scan behaviour are unchanged.

### Added

- **Bench runs can be deleted — single row and bulk.** The `/bench` history table's action
  column carries a delete control, and the multi-select bar gained a bulk delete next to
  Compare. The purge is irreversible (there is no trash tier for bench runs), so both use
  the inverted-cooldown confirm. An active run is refused, and so is a finished run whose
  full-file verify pass is still writing into it. Bulk is partial-success: each id commits
  on its own and the toast reports exactly what went and what stayed.
- **Kill-switch `NEXT_PUBLIC_BENCH_DELETE_DISABLED=1`** removes both delete controls from
  the UI (restart required). Compare, search, sort and selection are unaffected. The API
  routes stay reachable — this is a UI switch, not a backend one.

### Changed

- **A finished benchmark no longer blocks a library delete.** Migration 0029 makes
  `bench_combo.file_id` nullable with `ON DELETE SET NULL`, so deleting a library entry
  severs the link instead of being refused with a permanent `409`. The benchmark keeps its
  VMAF, size and time numbers. A library entry held by a **currently running** benchmark is
  still refused — the message names the run and links to `/bench`.
- **`DELETE /api/bench/{id}` now means purge.** Cancel moved to its own endpoint,
  `POST /api/bench/{id}/cancel`. Relevant only for scripted API use.

### Migration note

0029 is the first table rebuild in this schema's history. It runs once at container start
and verifies row counts before dropping the old table; a database carrying a dangling
`file_id` is self-healed during the migration rather than aborting boot. **A downgrade to
2.43.0 does not undo it** — the schema stays migrated and the older image simply goes back
to refusing every bench-referenced library delete. No data is lost, but the appdata backup
is the only true rollback.

### Rollback

```
docker stop x265-butler && docker rm x265-butler
docker pull ghcr.io/masterjb/x265-butler:2.43.0
```

## [2.43.0] — NVENC HEVC-unsupported diagnosis + NVIDIA GPU surface

amd64-only image on a Debian 13 (Trixie) base. Diagnostics-only release: no encode
behaviour changes — the generated ffmpeg command line is byte-identical to v2.42.0
across every encoder, and bench / VMAF are unchanged. No new dependencies, no DB
migration, no Dockerfile change.

### Added

- **NVIDIA GPU model + driver now surface in diagnostics.** The diagnostics page and the
  copy-report carry a new "NVIDIA GPU" section listing each card's name + driver version
  (via `nvidia-smi`), alongside the existing CPU-model line. An NVENC report can now be
  evidence-checked against the actual card instead of relying on a hedged guess. Degrades
  gracefully to a legible fallback on hosts without the NVIDIA runtime, and the report
  still returns 200.

### Changed

- **"Could not open encoder" NVENC failures now diagnose a missing HEVC block.** The
  `-22 / Could not open encoder before EOF` probe-failure maps to a dedicated hedged
  message on the Test-encode callout and the notification bell — distinct from the
  "API too new" (Pascal API-floor) case. It means the GPU has no HEVC-NVENC encode block
  (Kepler / Maxwell-1); HEVC-NVENC needs Maxwell-2 / GM206+ (GTX 950/960 or newer). The
  copy points at a self-check against that boundary before abandoning NVENC.

## [2.42.0] — Clear NVENC "API too new" diagnosis

amd64-only image on a Debian 13 (Trixie) base. Diagnostics-only release: no encode
behaviour changes — the generated ffmpeg command line is byte-identical to v2.41.0
across every encoder (libx265 / NVENC / QSV / VAAPI), and bench / VMAF are unchanged.

### Changed

- **NVENC's "API too new" error now reports what it actually means.** When a card is
  refused with `Required: X.Y Found: A.B`, the Test-encode callout and the
  encoder-detection warning now explain it as a hardware-generation limit — the GPU's
  NVENC API (`Found`) is older than the encoder's compile-baked floor (`Required`), and
  Pascal/Maxwell cards can never get a newer one — instead of the misleading "update
  your driver" hint. v2.41.0 already fixed the normal path (NVENC routes to the bundled
  jellyfin-ffmpeg), so this now only surfaces via the `FFMPEG_NVENC_PATH=ffmpeg` revert
  lever or a card older than jellyfin's floor. The `nvencDriverMismatch` and
  `encoder_runtime_broken` hints are untouched for their own errors.

## [2.41.0] — Pascal/Maxwell NVENC support (dual-binary ffmpeg)

amd64-only image on a Debian 13 (Trixie) base.

### Added

- **NVENC now works on older NVIDIA cards — Pascal (Tesla P4, GTX 10-series) and
  Maxwell (GTX 9-series).** Those cards were previously refused with
  `Required: 13.1 Found: 13.0` and silently fell back to CPU encoding, because the
  primary ffmpeg build (BtbN) has an NVENC API floor of 13.1 compiled in. The image now
  ships a second ffmpeg — jellyfin-ffmpeg — used **only** for NVENC; it has an older
  NVENC floor so Pascal/Maxwell encode, and modern RTX cards keep working (the floor is
  backward-compatible). Everything else routes to the primary BtbN ffmpeg unchanged
  (QSV, VAAPI, libx265, cropdetect, ffprobe, VMAF bench). Set `FFMPEG_NVENC_PATH=ffmpeg`
  to route NVENC back to the primary binary (a revert lever — re-triggers the refusal).
  Trade-off: the image grew ~100 MB for the second binary.

## [2.40.0] — Encoding Profile card

amd64-only image on a Debian 13 (Trixie) base. UI-only reorganisation: no new
dependencies, no database migrations, and the generated ffmpeg command line is
byte-identical to v2.39.0 across every encoder (libx265 / NVENC / QSV / VAAPI).

### Changed

- **The three per-encode video toggles now live in one place.** Auto-Crop, Force
  10-bit, and Colour/HDR10 passthrough were scattered as separate cards across the
  Encoder settings tab; they now sit together under a single **Encoding Profile**
  card, each as its own sub-section. The output-routing cards (Container, Output-Mode,
  Sidecar) stay separate. Deep-links and the onboarding scroll-to-Auto-Crop anchor are
  preserved. Existing toggle states carry over untouched — nothing to re-configure.

## [2.39.0] — 10-bit toggle + per-encode ETA + colour/HDR10 passthrough

amd64-only image on a Debian 13 (Trixie) base. New encode controls plus a running-job
ETA; no database migrations. New options default OFF, so encodes are byte-identical to
v2.38.2 until you opt in.

### Added

- **Force 10-bit toggle (all four encoders).** Opt-in setting to encode Main10 / 10-bit
  output regardless of source bit-depth (libx265 `yuv420p10le` / NVENC + QSV `p010le` /
  VAAPI `format=p010le`). Default OFF — argv unchanged until enabled. HW 10-bit on
  unsupported cards fails the encode and surfaces stderr rather than silently producing
  8-bit.
- **Per-encode ETA.** The running-job view now shows a live ETA derived from ffmpeg's
  reported encode `speed` — no new ffmpeg flag, refreshes on the existing progress
  cadence.
- **Colour-tag passthrough (opt-in).** Preserves the source VUI colour tags
  (`colorspace` / `color_primaries` / `color_trc` / `color_range`) on the output so a
  re-encode no longer washes out HDR/wide-gamut sources. Default OFF.
- **HDR10 static-metadata passthrough.** When colour passthrough is on, the source
  mastering-display and max-CLL metadata are carried through. libx265 emits explicit
  `master-display` / `max-cll` x265 params; NVENC / QSV / VAAPI rely on ffmpeg's
  automatic frame-side-data → SEI passthrough (verify the output with
  `ffprobe -show_streams` on hardware encoders).

## [2.38.2] — Poll-rate diagnostics now measured

amd64-only image on a Debian 13 (Trixie) base. Backend-only diagnostics
observability: no new dependencies, no database migrations, the encode/ffmpeg path
and the watcher poll cadence are untouched.

### Changed

- **The Diagnostics poll-rate is now measured, not estimated.** v2.38.1 stopped the
  FUSE/shfs `stat`-storm, but the poll-rate the Diagnostics page reported was an
  estimate from a fixed "10 paths per watched file" heuristic — it under-reported the
  real rate by roughly 3× on libraries with deeper directory nesting (a strace
  measured ~1,061 `statx`/sec where the page printed ~350). Each forced-polling share
  now reports the chokidar `getWatched()`-measured watched-path count
  (`actualWatchedPaths` / `actualStatsPerSec` / `actualPathMultiplier`) alongside the
  preserved estimate, so the stat-rate is auditable from `/api/diagnostics` without a
  shell. The actual poll cadence is byte-identical to v2.38.1 — only the reported
  number becomes correct.

## [2.38.1] — Watcher poll-storm hotfix (binaryInterval)

amd64-only image on a Debian 13 (Trixie) base. A hotfix on v2.38.0: backend-only,
no new dependencies, no database migrations, the encode/ffmpeg path is untouched.

### Fixed

- **The v2.38.0 stat-storm fix did not fully apply on media libraries.** The
  watcher's forced-polling mode has two poll knobs — one for ordinary files and one
  for binary-extension files (`.mkv`/`.mp4`/`.jpg`/`.png`), the latter defaulting to
  300 ms. v2.38.0 scaled only the first, so on a media library (where nearly every
  file is a binary extension) the storm survived even with `WATCH_POLL_INTERVAL_MS`
  set — an operator who set it to 60000 still measured ~59.000 `statx`/sec. Both
  poll knobs are now pinned to the same resolved interval, so the scaled default and
  the `WATCH_POLL_INTERVAL_MS` override govern the entire watched tree. Existing
  installs benefit automatically; no config change required.

## [2.38.0] — Watcher poll-pool stat-storm fix

amd64-only image on a Debian 13 (Trixie) base. Fixes web-UI sluggishness on large
libraries that live on a FUSE/shfs user-share. No new dependencies, no database
migrations, backend-only — the encode/ffmpeg path is untouched and inotify shares
(ext4/xfs) are byte-identical to before.

### Fixed

- **Web UI crawled (pages slow or never loading) while encodes ran, on large
  user-share libraries.** The file-watcher's forced-polling mode issued a `statx`
  storm — strace on an 11.685-file share measured 87.9% of syscall time, ~62.000
  calls/sec — that saturated Node's 4-thread I/O pool, so every page-load's
  filesystem op queued behind it. The encodes themselves were never affected, and
  raising `UV_THREADPOOL_SIZE` only spread the load without reducing it. The poll
  interval now scales with library size to cap the stat-rate at ~500/sec
  (`interval = clamp(2000ms, ceil(realPaths / 500 × 1000), 300000ms)`, where
  `realPaths ≈ 10× the file count because every directory is stat()ed too at
depth 99`) — a **≥10× stat-rate reduction** on the reporter's library. Watch
  latency grows in return (the boot/periodic reconcile is the safety net).

### Added

- **`WATCH_POLL_INTERVAL_MS` server env knob** — pin an exact forced-polling
  interval, bypassing the size-scaler (precedence: env > explicit operator setting
  > scaled default). Reject-to-default on invalid input. The no-redeploy revert lever.
- **Per-share polling state on `/api/diagnostics`** (`pollingShares`: mode,
  watched-file count, effective interval, computed stat-rate) — the stat-storm is
  now visible without shell access, and the copy-report carries it.

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
