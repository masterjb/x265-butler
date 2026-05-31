# Changelog

All notable changes to x265-butler are documented here. This public changelog
starts at v2.20.0; earlier history is not published.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and the project adheres to [Semantic Versioning](https://semver.org/).

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
