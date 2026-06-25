# x265-butler

> Self-hosted web application that scans media shares, transcodes video files to HEVC (x265) with hardware acceleration, and intelligently avoids re-encoding work already done.

**Type:** Application · **License:** [PolyForm Noncommercial 1.0.0](LICENSE) · Contributions: [CLA](CLA.md)

[![Latest release](https://img.shields.io/github/v/tag/masterjb/x265-butler?sort=semver&label=release&color=blue)](https://github.com/masterjb/x265-butler/tags)
[![GHCR](https://img.shields.io/badge/ghcr.io-masterjb%2Fx265--butler-2496ED?logo=docker&logoColor=white)](https://github.com/masterjb/x265-butler/pkgs/container/x265-butler)
[![Architectures](https://img.shields.io/badge/arch-amd64-informational)](#deployment)
[![Next.js](https://img.shields.io/badge/Next.js-15-000?logo=nextdotjs)](https://nextjs.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-417e38?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm--NC--1.0.0-orange.svg)](LICENSE)
[![Telemetry](https://img.shields.io/badge/telemetry-none-22C55E)](#security)

---

## Overview

x265-butler is a Docker-based, unRAID-native tool for recursively scanning a media share, transcoding video files to HEVC (x265) with hardware acceleration when available, and tracking every attempt so it never re-encodes files already processed.

**Built for:** Self-hosters on unRAID who want a focused, opinionated transcoder that integrates cleanly with unRAID conventions (cache-pool aware, CA template, PUID/PGID, shfs-aware path handling) without the overhead or lock-in of heavier alternatives.

**Distribution:** Published on the unRAID Community Applications store.

### Core Capabilities

- Recursive scan of a configurable share for video files (filtered by extension and minimum size)
- Transcoding to HEVC using auto-detected hardware encoders (QSV, NVENC, VAAPI) with libx265 software fallback
- Cache-pool staging so HDDs stay spun down during encoding
- Hash-based file identity (partial SHA-256 over three 4 MB chunks) that survives rename and move
- Multi-layer skip logic: codec check, bitrate heuristic, DB lookup, blocklist, MKV metadata tag
- Optional auto-crop / black-bar removal (cropdetect-driven, opt-in per Settings)
- Device-aware hardware encoder selection — multi-GPU hosts can target a specific Intel/AMD/NVIDIA device
- Safe originals handling via trash with configurable retention (default 30 days) and restore
- Selectable output strategy: keep the `.x265.mkv` suffix or replace the original in place (trash-first, hardlink-safe, crash-recoverable); sidecar metadata written beside the file, off, or to a central tree under `/config`
- Dense, dark-mode-first dashboard with live SSE progress, per-job progress bars, concurrent-job visibility, cumulative savings stats
- Optional username/password auth (off by default), EN/DE i18n via next-intl
- Self-diagnostics page with hardware-encoder probe, render-node permission evidence, CPU/event-loop attribution, and copyable bug-report

---

## Docker Tag Strategy

Two GHCR tags are published per release:

- **`:X.Y.Z`** — Exact-semver pin (e.g. `ghcr.io/masterjb/x265-butler:2.38.2`). Reproducible, frozen at the build that created it. Recommended for production-stability operators.
- **`:latest`** — Floating across all versions. Auto-deploys every new release on next container restart, including Major-version transitions.

> **⚠️ `:latest` auto-deploys breaking changes.** Major transitions (`v2.x → v3.x`) MAY introduce breaking changes (config format, env-var renames, DB-schema migrations). If your deployment cannot tolerate unannounced Major upgrades, **pin to an exact semver**:
> - CA template: Edit Container → set `Repository` to `ghcr.io/masterjb/x265-butler:2.38.2`
> - `docker-compose.yml`: `image: ghcr.io/masterjb/x265-butler:2.38.2`

---

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript 5**
- **better-sqlite3** for persistence (single-file DB under `/config`)
- **next-intl** for EN/DE localisation
- **Tailwind CSS 4** + shadcn/ui + Base UI components
- **ffmpeg** (bundled in the image) for transcoding and hardware probing
- Single-process custom Next.js server; SSE for live progress

---

## Deployment

### unRAID (Production)

Single container:

- Image: `:latest` (auto-update) or `:X.Y.Z` (exact pin) — see [Docker Tag Strategy](#docker-tag-strategy)
- Default port: `8765 → 3000`
- Volumes:
  - `/config` → `/mnt/user/appdata/x265-butler/`
  - `/media` → `/mnt/user/{SHARE}/` (read)
  - `/media0` → `/mnt/user0/{SHARE}/` (write; bypasses shfs FUSE overhead)
  - `/cache` → `/mnt/cache/x265-butler/` (scratch for encoding)
- Devices: `/dev/dri:/dev/dri` (QSV/VAAPI); see [NVIDIA NVENC](#nvidia-nvenc) for NVENC
- Env: `PUID`, `PGID`, `TZ`, `AUTH_ENABLED`, `DEFAULT_LOCALE`
- Container starts as root, downgrades to `PUID:PGID` via `gosu` before running Node

### Community Applications Install

Recommended path for unRAID operators — install via the CA store rather than hand-crafting a container.

1. Open the unRAID web UI → **Apps** tab (Community Applications plugin required).
2. Search for `x265-butler` → **Install**.
3. Fill in the volume mappings:
   - `/config` → `/mnt/user/appdata/x265-butler/`
   - `/media` (read) → your media share, e.g. `/mnt/user/Movies/`
   - `/media0` (write) → matching `/mnt/user0/...` path
   - `/cache` (scratch) → `/mnt/cache/x265-butler/`
4. (Optional) Add device pass-through (see [Hardware Acceleration](#hardware-acceleration)).
5. Set `PUID` / `PGID` to match your share permissions (typically `99` / `100` on unRAID).
6. **Apply**.

### docker-compose

```yaml
services:
  x265-butler:
    image: ghcr.io/masterjb/x265-butler:latest
    container_name: x265-butler
    ports:
      - "8765:3000"
    environment:
      PUID: "99"
      PGID: "100"
      TZ: "Europe/Berlin"
    volumes:
      - /mnt/user/appdata/x265-butler:/config
      - /mnt/user/Movies:/media:ro
      - /mnt/user0/Movies:/media0
      - /mnt/cache/x265-butler:/cache
    devices:
      - /dev/dri:/dev/dri        # QSV / VAAPI
    restart: unless-stopped
```

### Local Development

`npm install && npm run dev` runs Next.js (custom server, single process) on port 3000. The SQLite database lives at `./data/x265-butler.db`. A seed script generates fake library entries for UI work without requiring ffmpeg.

---

## Hardware Acceleration

Drivers ship with the image — no `apt install` needed inside the container. The entrypoint auto-detects the right VAAPI driver per PCI-vendor scan + iHD load-probe, with `i965` fallback for pre-gen8 Intel iGPUs.

### Intel QuickSync / VAAPI

Pass through the render node:

```
--device /dev/dri:/dev/dri
```

HEVC-QSV requires Skylake (gen 6)+; 10-bit requires Kaby Lake (gen 7)+. On older silicon the onboarding wizard recommends the libx265 software fallback. The image bundles the oneVPL GPU-runtime (`libmfx-gen1.2`, `libvpl2`, `libigfxcmrt7`) required by modern Intel QSV.

### NVIDIA NVENC

NVENC needs the host driver (unRAID NVIDIA-Driver-Plugin or nvidia-container-toolkit) plus these container settings:

**Extra Parameters:**
```
--runtime=nvidia
```

**Variables:**
```
NVIDIA_VISIBLE_DEVICES=all
NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
```

> The **`video`** capability is the one that bites you: the runtime default is `compute,utility` and **without `video` the NVENC session fails to init** even though `nvidia-smi` works fine. `utility` = the detection probe, `compute` = CUDA filters, `video` = NVENC itself.

Verify: `docker exec x265-butler nvidia-smi -L` → expect a `GPU 0: ...` line.

### AMD VAAPI (Mesa)

Pass through `/dev/dri:/dev/dri`; the Mesa VAAPI driver in the image handles AMD GPUs.

---

## Security

- **No telemetry.** The application makes no outbound calls.
- Optional username/password auth (`AUTH_ENABLED`), off by default — intended for trusted LAN deployments behind a reverse proxy if exposed.
- Internal API consumed only by the built-in UI. No public endpoints, no third-party integrations.
- Container runs as `PUID:PGID` (not root) after entrypoint privilege-drop via `gosu`.

See [SECURITY.md](SECURITY.md) for the vulnerability-disclosure policy.

---

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for noncommercial use. Commercial use requires a separate license. See [LICENSES.md](LICENSES.md) for third-party component licenses.

Contributions are welcome under the [CLA](CLA.md) — see [CONTRIBUTING.md](CONTRIBUTING.md).
