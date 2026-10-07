# syntax=docker/dockerfile:1.27

# ---------- Stage 1: builder ----------
FROM node:22-trixie-slim AS builder

WORKDIR /build

COPY package.json package-lock.json ./
# BuildKit cache-mount: persists ~/.npm across builds (~30% faster npm ci on
# warm cache). `sharing=locked` because parallel buildx builds may share the
# same cache mount; locking serializes writes safely.
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci

ARG GIT_HASH=dev
ARG GIT_COMMITTED_AT=

ENV GIT_HASH=$GIT_HASH \
    GIT_COMMITTED_AT=$GIT_COMMITTED_AT

COPY . .

RUN npm run build

# ---------- Stage 1b: ffmpeg-bin (BtbN static GPL build with libvmaf) ----------
FROM debian:trixie-slim AS ffmpeg-bin
# ffmpeg comes from OUR mirror (a release of the public repo), pinned by sha256.
# Never from BtbN directly: BtbN deletes dated builds after three to four weeks and `latest` changes
# daily, so an image could neither be rebuilt nor its ffmpeg identified (a broken master nightly once shipped in v2.47.0). Branch is the
# BtbN release branch n9.0, not master. These three ARGs are the single source of the pin;
# change them only via `node scripts/ffmpeg-mirror.js` or `node scripts/ffmpeg-pins.js set`
# (docs/dev/ffmpeg-supply-chain.md). Images are amd64-only: only linux64 is mirrored.
ARG TARGETARCH
ARG FFMPEG_MIRROR_TAG=ffmpeg-n9.0.2-22-g46d8f462ee
ARG FFMPEG_ASSET=ffmpeg-n9.0.2-22-g46d8f462ee-linux64-gpl-9.0.tar.xz
ARG FFMPEG_SHA256=a6170faecf757381ad0338d7a6ba26e97c2ebe2b9c1568633421e15d1ed436a9
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget xz-utils binutils \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    if [ "${TARGETARCH}" != "amd64" ]; then echo "unsupported TARGETARCH=${TARGETARCH} (mirror holds linux64 only)" >&2; exit 1; fi; \
    URL="https://github.com/masterjb/x265-butler/releases/download/${FFMPEG_MIRROR_TAG}/${FFMPEG_ASSET}"; \
    wget -q -O /tmp/ffmpeg.tar.xz "${URL}"; \
    printf '%s  %s\n' "${FFMPEG_SHA256}" /tmp/ffmpeg.tar.xz > /tmp/ffmpeg.sha256; \
    sha256sum -c /tmp/ffmpeg.sha256; \
    mkdir -p /opt/ffmpeg; \
    tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1; \
    rm /tmp/ffmpeg.tar.xz /tmp/ffmpeg.sha256; \
    strip --strip-unneeded /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe 2>/dev/null || true; \
    cp /opt/ffmpeg/LICENSE.txt /opt/ffmpeg/LICENSE.GPL-3.0 2>/dev/null \
      || printf 'This binary is licensed under GPL-3.0-or-later.\nSource: https://www.gnu.org/licenses/gpl-3.0.html\nBuild: %s\n' "${FFMPEG_ASSET}" > /opt/ffmpeg/LICENSE.GPL-3.0; \
    test -s /opt/ffmpeg/LICENSE.GPL-3.0; \
    /opt/ffmpeg/bin/ffmpeg -version > /tmp/ffmpeg-version.txt; \
    read -r _ _ BUILD _ < /tmp/ffmpeg-version.txt; \
    rm /tmp/ffmpeg-version.txt; \
    printf 'build: %s\nasset: %s\nsha256: %s\nmirror: %s\nupstream and source: https://github.com/masterjb/x265-butler/releases/tag/%s (SOURCE.md)\n' \
      "${BUILD}" "${FFMPEG_ASSET}" "${FFMPEG_SHA256}" "${URL}" "${FFMPEG_MIRROR_TAG}" \
      > /opt/ffmpeg/SOURCE.txt

# ---------- Stage 1c: ffmpeg-nvenc-bin (jellyfin-ffmpeg portable GPL — NVENC only) ----------
FROM debian:trixie-slim AS ffmpeg-nvenc-bin
ARG TARGETARCH
# DUAL-BINARY: a SECOND ffmpeg used ONLY for encoder=nvenc.
# (a) WHY jellyfin: it pins an OLD nv-codec-headers floor (Pascal/Maxwell-safe,
#     backward-compatible so modern RTX also runs). BtbN's NVENC floor is
#     compile-baked at API 13.1 and Pascal EOL'd at 13.0 → BtbN can NEVER encode
#     on a Tesla P4 ("Required: 13.1 Found: 13.0"). jellyfin's hevc_nvenc encoded
#     frame= 30 exit-0 on the real P4 (CONTEXT command C).
# (b) WHY a second binary and not a swap: jellyfin ships NO libvmaf (its build
#     config has no --enable-libvmaf; only built-in vmafmotion, NOT equivalent).
#     A naked swap would silently break the whole bench/Pareto VMAF subsystem
#     (src/lib/bench/*). So BtbN stays PRIMARY (libvmaf + qsv/vaapi/x265 +
#     cropdetect + ffprobe); jellyfin serves nvenc ONLY.
# (c) Asset pattern: jellyfin-ffmpeg_${VER}_portable_${ARCH}-gpl.tar.xz — FLAT
#     layout (ffmpeg+ffprobe at root, NO nested dir → NO --strip-components,
#     unlike BtbN's =1). ldd-clean self-contained (glibc-core only → single-binary
#     COPY, no lib/, no LD_LIBRARY_PATH). Use -gpl NOT -gpl-extra (keeps GPL-3.0+
#     OCI label valid; -gpl-extra portable does not exist for this release).
# (d) mirrored and sha256-pinned like the BtbN binary (jellyfin publishes no
#     checksum; the hash was recorded on first mirroring, see the release's SOURCE.md).
ARG FFMPEG_NVENC_MIRROR_TAG=jellyfin-ffmpeg-v7.1.4-3
ARG FFMPEG_NVENC_ASSET=jellyfin-ffmpeg_7.1.4-3_portable_linux64-gpl.tar.xz
ARG FFMPEG_NVENC_SHA256=cab9ff40a47e4232d231e4eb7e4e85fabfeec56c6905266bc94291fc0881f83f
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget xz-utils binutils \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    if [ "${TARGETARCH}" != "amd64" ]; then echo "unsupported TARGETARCH=${TARGETARCH} (mirror holds linux64 only)" >&2; exit 1; fi; \
    URL="https://github.com/masterjb/x265-butler/releases/download/${FFMPEG_NVENC_MIRROR_TAG}/${FFMPEG_NVENC_ASSET}"; \
    wget -q -O /tmp/ffmpeg-nvenc.tar.xz "${URL}"; \
    printf '%s  %s\n' "${FFMPEG_NVENC_SHA256}" /tmp/ffmpeg-nvenc.tar.xz > /tmp/ffmpeg-nvenc.sha256; \
    sha256sum -c /tmp/ffmpeg-nvenc.sha256; \
    mkdir -p /opt/ffmpeg-nvenc; \
    tar -xJf /tmp/ffmpeg-nvenc.tar.xz -C /opt/ffmpeg-nvenc; \
    rm /tmp/ffmpeg-nvenc.tar.xz /tmp/ffmpeg-nvenc.sha256; \
    strip --strip-unneeded /opt/ffmpeg-nvenc/ffmpeg 2>/dev/null || true; \
    printf 'This binary is licensed under GPL-3.0-or-later.\nSource: https://www.gnu.org/licenses/gpl-3.0.html\njellyfin-ffmpeg build: %s\n' "${FFMPEG_NVENC_ASSET}" > /opt/ffmpeg-nvenc/LICENSE.GPL-3.0; \
    test -s /opt/ffmpeg-nvenc/LICENSE.GPL-3.0; \
    /opt/ffmpeg-nvenc/ffmpeg -version > /tmp/ffmpeg-version.txt; \
    read -r _ _ BUILD _ < /tmp/ffmpeg-version.txt; \
    rm /tmp/ffmpeg-version.txt; \
    printf 'build: %s\nasset: %s\nsha256: %s\nmirror: %s\nupstream and source: https://github.com/masterjb/x265-butler/releases/tag/%s (SOURCE.md)\n' \
      "${BUILD}" "${FFMPEG_NVENC_ASSET}" "${FFMPEG_NVENC_SHA256}" "${URL}" "${FFMPEG_NVENC_MIRROR_TAG}" \
      > /opt/ffmpeg-nvenc/SOURCE.txt

# ---------- Stage 2: runtime ----------
FROM node:22-trixie-slim AS runtime

# hadolint ignore=DL3008
# vainfo binary required by src/lib/encode/detection.ts to
# probe QSV (iHD driver) + VAAPI (VAEntrypointEncSlice) inside the container.
# Without it, all HW detection silently returns ['libx265'] in production.
# nvidia-smi is NOT installed here — host-injected via nvidia-container-toolkit
# at `--gpus all` runtime, documented in README.
# ffmpeg is NOT installed via apt — static BtbN GPL binary with libvmaf is
# COPY'd from ffmpeg-bin stage below (libvmaf baked in).
#
# Since v2.15.0: VAAPI/QSV drivers baked in to close forum-feedback gap
# (2026-05-22) — operators no longer need to `apt install` inside the container.
#   - intel-media-va-driver-non-free → Intel iHD driver, gen8+ (UHD-630, Arc,
#     Battlemage). Debian non-free-firmware component (binary firmware required
#     for VAAPI HEVC/AV1 encode); reflected in OCI license label below.
#   - i965-va-driver → legacy Intel VAAPI for gen4-gen7 (Sandybridge/Ivy/Haswell).
#     Free (MIT). Picked up by entrypoint as fallback when iHD load-probe fails.
#   - mesa-va-drivers → Mesa Gallium VAAPI for AMD GPUs (Polaris/Vega/RDNA).
#     Free (MIT). LIBVA_DRIVER_NAME stays unset → Mesa PCI-autodetects.
#
# Since v2.19.0: rebased Bookworm → Trixie. Trixie ships
# intel-media-va-driver-non-free ≥ 24.x out-of-box from the
# non-free-firmware component — closes Arc-Alchemist (gen12.5) /
# Battlemage / Lunar-Lake HEVC + AV1 hardware-encode age-gap that
# surfaced via 3rd-party-user diagnostics-report 2026-05-24.
# UNPINNED — tracks the Debian trixie-stable channel.
#
# Since v2.20.0 the image ships the oneVPL GPU-runtime; missing, it was the ROOT-CAUSE of the
# 3rd-party `Error creating a MFX session: -9` (2026-05-24). The image shipped
# the iHD VAAPI driver but NO oneVPL MFX runtime; ffmpeg's QSV hwcontext loads
# its implementation through the libvpl dispatcher at runtime, and with no
# libmfx-gen implementation installed the dispatcher found nothing → -9. VAAPI
# worked, QSV did not, yet `ffmpeg -encoders` still listed qsv (false-positive).
#   - libmfx-gen1.2 → Intel VPL GPU Runtime (the MFX implementation the
#     dispatcher loads). NOT legacy libmfx1 (MSDK; no Arc/gen12+ support; absent
#     from trixie repos anyway).
#   - libvpl2       → Intel oneVPL dispatcher (libvpl.so.2).
#   - libigfxcmrt7  → Intel C-for-Media runtime (runtime dep of libmfx-gen).
# NO `ENV LIBVA_DRIVER_NAME=iHD` is hardcoded — docker-entrypoint.sh PCI-scans +
# vainfo-probes the device dynamically. The trailing dpkg-query in the install
# RUN is an enforced artifact-gate: under the UNPINNED trixie policy apt can
# exit-0 without landing a renamed/virtual package, so the build FAILS HARD if
# any of the 3 oneVPL libs is absent from the final runtime stage.
RUN sed -i 's/Components: main/Components: main contrib non-free non-free-firmware/g' \
        /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
        gosu \
        tini \
        ca-certificates \
        wget \
        vainfo \
        intel-media-va-driver-non-free \
        i965-va-driver \
        mesa-va-drivers \
        libmfx-gen1.2 \
        libvpl2 \
        libigfxcmrt7 \
 && dpkg-query -W -f='${Package} ${Version}\n' libmfx-gen1.2 libvpl2 libigfxcmrt7 \
 && rm -rf /var/lib/apt/lists/*

# BtbN static ffmpeg binary — GPL-3.0+ with built-in libvmaf models
# (vmaf_v0.6.1, vmaf_4k_v0.6.1, vmaf_v0.6.1neg; no separate model file needed)
COPY --from=ffmpeg-bin /opt/ffmpeg/bin/ffmpeg  /usr/local/bin/ffmpeg
COPY --from=ffmpeg-bin /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=ffmpeg-bin /opt/ffmpeg/LICENSE.GPL-3.0 /usr/share/doc/ffmpeg/LICENSE.GPL-3.0

# DUAL-BINARY: jellyfin-ffmpeg NVENC-only second binary (Pascal/Maxwell floor).
# ffprobe stays BtbN (encoder-agnostic) — only the ffmpeg encode binary is added.
COPY --from=ffmpeg-nvenc-bin /opt/ffmpeg-nvenc/ffmpeg /usr/local/bin/ffmpeg-nvenc
COPY --from=ffmpeg-nvenc-bin /opt/ffmpeg-nvenc/LICENSE.GPL-3.0 /usr/share/doc/ffmpeg-nvenc/LICENSE.GPL-3.0

# SOURCE.txt names the exact build, sha256 and mirror release of each binary.
COPY --from=ffmpeg-bin /opt/ffmpeg/SOURCE.txt /usr/share/doc/ffmpeg/SOURCE.txt
COPY --from=ffmpeg-nvenc-bin /opt/ffmpeg-nvenc/SOURCE.txt /usr/share/doc/ffmpeg-nvenc/SOURCE.txt
RUN chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/ffmpeg-nvenc \
 && test -s /usr/share/doc/ffmpeg/LICENSE.GPL-3.0 \
 && test -s /usr/share/doc/ffmpeg-nvenc/LICENSE.GPL-3.0 \
 && test -s /usr/share/doc/ffmpeg/SOURCE.txt \
 && test -s /usr/share/doc/ffmpeg-nvenc/SOURCE.txt

# Build-time parity assertions — FAIL HARD on any lost encoder/filter. The
# two binaries carry DIFFERENT guarantees so they are asserted separately.
# A. BtbN primary — everything EXCEPT nvenc, incl libvmaf (bench) + cropdetect (G3).
#    hevc_nvenc is deliberately NOT asserted here (BtbN's Pascal-broken nvenc is
#    exactly why the second binary exists; the app never routes nvenc to BtbN).
# (pipe-to-grep exit + `&&-chain || (exit 1)` FATAL branch are intentional here —
#  pipefail would break the "ffmpeg fails → grep empty → assert fires" semantics.)
# hadolint ignore=DL4006,SC2015
RUN /usr/local/bin/ffmpeg -hide_banner -encoders 2>/dev/null | grep -q hevc_qsv \
 && /usr/local/bin/ffmpeg -hide_banner -encoders 2>/dev/null | grep -q hevc_vaapi \
 && /usr/local/bin/ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx265 \
 && /usr/local/bin/ffmpeg -hide_banner -filters  2>/dev/null | grep -q libvmaf \
 && /usr/local/bin/ffmpeg -hide_banner -filters  2>/dev/null | grep -q cropdetect \
 || (echo "FATAL: BtbN ffmpeg lost a required encoder/filter" >&2; exit 1)
# B. BtbN libvmaf MODEL smoke — presence != usable model. The bench needs the
#    baked-in vmaf_v0.6.1 model without a separate file arg. CPU-only (CI amd64).
# hadolint ignore=DL4006,SC2015
RUN /usr/local/bin/ffmpeg -hide_banner -nostats \
      -f lavfi -i testsrc=size=64x64:rate=1:duration=1 \
      -f lavfi -i testsrc=size=64x64:rate=1:duration=1 \
      -lavfi libvmaf -f null - 2>&1 | grep -qi 'VMAF score' \
 || (echo "FATAL: BtbN libvmaf default model did not resolve" >&2; exit 1)
# C. jellyfin nvenc binary — the fix's raison d'être.
# hadolint ignore=DL4006,SC2015
RUN /usr/local/bin/ffmpeg-nvenc -hide_banner -encoders 2>/dev/null | grep -q hevc_nvenc \
 || (echo "FATAL: jellyfin ffmpeg-nvenc missing hevc_nvenc" >&2; exit 1)

# Drop npm from the RUNTIME image (v2.44.0 trivy CRITICAL CVE-2026-59873).
# The finding is npm's BUNDLED tar 7.5.11 under /usr/local/lib/node_modules/npm,
# NOT an app dependency — package-lock.json carries no `tar` at all. Trivy labels
# it `(package.json)`, which reads as app-code under the bifurcated .trivyignore
# policy (app-code blocks, OS-base waivable), so a waiver would be the wrong
# instrument. The runtime never invokes npm — ENTRYPOINT runs `node server.js`
# and the builder stage owns every `npm ci` / `npm run build` — so the tree is
# dead weight. Removing it fixes this CVE for real and pre-empts every future
# npm-bundled node-pkg finding. The negative assertion is the regression guard:
# a base image that relocates npm must fail the build, not silently re-ship it.
# corepack goes with it: same class (base-image node-pkg, never invoked by the
# runtime), and leaving it would keep the exact hole this step is meant to close.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && ! command -v npm > /dev/null \
 && ! command -v npx > /dev/null \
 && ! command -v corepack > /dev/null \
 && node --version

WORKDIR /app

# Next.js standalone build inlines node_modules — no separate COPY needed.
COPY --from=builder --chown=node:node /build/.next/standalone ./
COPY --from=builder --chown=node:node /build/.next/static ./.next/static
COPY --from=builder --chown=node:node /build/public ./public

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# /cache is NOT a volume any more. The cache resolver uses /cache when it
# exists (the optional "Cache Pool" template path); a VOLUME entry would create
# an anonymous volume on every unmapped install and the cache would silently
# land in it, lost on the next update.
# The media volumes are gone too. Without a mapping (the CA template maps
# its own media path) Docker created root-owned anonymous volumes, which the
# diagnostics reported as EACCES; the second, write-side media path was never
# read by the code at all. Media shares are always operator-mapped.
VOLUME ["/config"]
EXPOSE 3000

ARG GIT_HASH=dev
ARG GIT_COMMITTED_AT=
ARG BUILD_DATE=

ENV GIT_HASH=$GIT_HASH \
    GIT_COMMITTED_AT=$GIT_COMMITTED_AT \
    NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    PUID=99 \
    PGID=100 \
    TZ=UTC

LABEL org.opencontainers.image.title="x265-butler" \
      org.opencontainers.image.description="Self-hosted HEVC transcoding butler for unRAID" \
      org.opencontainers.image.source="https://github.com/MisterJB/x265-butler" \
      org.opencontainers.image.revision="$GIT_HASH" \
      org.opencontainers.image.version="$GIT_HASH" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0 AND GPL-3.0+ AND non-free-firmware" \
      org.opencontainers.image.vendor="MisterJB" \
      org.opencontainers.image.created="$BUILD_DATE"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["sh", "-c", "wget -qO- \"http://localhost:${PORT}/api/health\" >/dev/null 2>&1 || exit 1"]

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
