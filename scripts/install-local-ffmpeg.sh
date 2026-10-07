#!/usr/bin/env bash
# Downloads the same BtbN static GPL ffmpeg + ffprobe (with libvmaf baked in)
# that the production Docker image uses, so local `npm run dev` can run VMAF
# computations without VmafComputeError "Filter not found".
#
# Fetches the pinned build from our mirror through scripts/ffmpeg-fetch.js
# (pins + sha256 from the Dockerfile), so the local binary stays in lockstep with
# the image. Writes to ./.local-bin/ffmpeg-pinned/ (gitignored) and prints the
# env-var exports the dev server needs. linux x86_64 only (the mirror holds linux64).

set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$(uname -m)" != "x86_64" ]; then
  echo "unsupported host arch: $(uname -m) (the ffmpeg mirror holds linux64 only)" >&2
  exit 1
fi

DEST=".local-bin/ffmpeg-pinned"
node scripts/ffmpeg-fetch.js "${DEST}" btbn

ABS_DIR=$(cd "${DEST}/bin" && pwd)

if ! "${ABS_DIR}/ffmpeg" -hide_banner -filters 2>/dev/null | grep -qE '[[:space:]]libvmaf[[:space:]]'; then
  echo "Downloaded ffmpeg lacks libvmaf filter" >&2
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
