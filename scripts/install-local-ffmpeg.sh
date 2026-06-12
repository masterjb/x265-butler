#!/usr/bin/env bash
# Downloads the same BtbN static GPL ffmpeg + ffprobe (with libvmaf baked in)
# that the production Docker image uses, so local `npm run dev` can run VMAF
# computations without VmafComputeError "Filter not found".
#
# Reads the pinned BTBN_TAG / BTBN_BUILD from Dockerfile so the local binary
# stays in lockstep with the image. Writes the binaries to ./.local-bin/
# (gitignored) and prints the env-var exports the dev server needs.

set -euo pipefail

cd "$(dirname "$0")/.."

BTBN_TAG=$(awk -F= '/^ARG BTBN_TAG=/ { print $2; exit }' Dockerfile)
BTBN_BUILD=$(awk -F= '/^ARG BTBN_BUILD=/ { print $2; exit }' Dockerfile)

if [ -z "${BTBN_TAG}" ] || [ -z "${BTBN_BUILD}" ]; then
  echo "Could not read BTBN_TAG / BTBN_BUILD from Dockerfile" >&2
  exit 1
fi

UNAME_M=$(uname -m)
case "${UNAME_M}" in
  x86_64)  ARCH=linux64 ;;
  aarch64) ARCH=linuxarm64 ;;
  *) echo "unsupported host arch: ${UNAME_M}" >&2; exit 1 ;;
esac

DEST=".local-bin"
URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}/ffmpeg-${BTBN_BUILD}-${ARCH}-gpl.tar.xz"
TARBALL=$(mktemp -t ffmpeg-btbn-XXXXXX.tar.xz)

echo "Downloading: ${URL}"
wget -q --show-progress -O "${TARBALL}" "${URL}"

mkdir -p "${DEST}"
tar -xJf "${TARBALL}" -C "${DEST}" --strip-components=2 \
  "ffmpeg-${BTBN_BUILD}-${ARCH}-gpl/bin/ffmpeg" \
  "ffmpeg-${BTBN_BUILD}-${ARCH}-gpl/bin/ffprobe"

chmod +x "${DEST}/ffmpeg" "${DEST}/ffprobe"
rm -f "${TARBALL}"

ABS_DIR=$(cd "${DEST}" && pwd)

if ! "${DEST}/ffmpeg" -hide_banner -filters 2>/dev/null | grep -qE '[[:space:]]libvmaf[[:space:]]'; then
  echo "Downloaded ffmpeg lacks libvmaf filter — BtbN tarball may have changed layout" >&2
  exit 1
fi

echo
echo "Installed at: ${ABS_DIR}"
echo
echo "Add the following two lines to .env.local (or export in your shell):"
echo
echo "  FFMPEG_PATH=${ABS_DIR}/ffmpeg"
echo "  FFPROBE_PATH=${ABS_DIR}/ffprobe"
echo
echo "Restart \`npm run dev\` after setting them."
