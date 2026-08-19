#!/bin/sh
set -eu

# Validate PUID/PGID are numeric and safely bounded (audit G1).
# Defaults follow unRAID convention: nobody:users (99:100).
PUID="${PUID:-99}"
PGID="${PGID:-100}"

case "$PUID" in
    '' | *[!0-9]*)
        echo "PUID must be numeric, got: '$PUID'" >&2
        exit 1
        ;;
esac

case "$PGID" in
    '' | *[!0-9]*)
        echo "PGID must be numeric, got: '$PGID'" >&2
        exit 1
        ;;
esac

if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
    echo "PUID/PGID must not be 0 (root rejected)" >&2
    exit 1
fi

if [ "$PUID" -gt 65535 ] || [ "$PGID" -gt 65535 ]; then
    echo "PUID/PGID must be <= 65535, got PUID=$PUID PGID=$PGID" >&2
    exit 1
fi

# Phase 18: PCI-vendor scan for LIBVA_DRIVER_NAME selection.
# 0x8086 = Intel  → try iHD (modern); fall back to unset on load-failure (legacy gen4-7).
# 0x1002 = AMD    → unset (Mesa autodetect-via-PCI).
# 0x10de = NVIDIA → unset (NVENC path bypasses VAAPI entirely).
# audit-fix M2: iHD does NOT load on pre-gen8 Intel. After export, run vainfo as
# a load-probe; on exit-nonzero unset LIBVA_DRIVER_NAME so VAAPI runtime
# auto-falls-back to i965.
if [ -d /sys/class/drm ]; then
    intel_found=0
    for vendor_file in /sys/class/drm/card*/device/vendor; do
        [ -r "$vendor_file" ] || continue
        vendor=$(cat "$vendor_file" 2>/dev/null || true)
        case "$vendor" in
            0x8086) intel_found=1 ;;
        esac
    done
    if [ "$intel_found" = "1" ]; then
        export LIBVA_DRIVER_NAME=iHD
        if vainfo --display drm >/dev/null 2>&1; then
            echo "x265-butler: LIBVA_DRIVER_NAME=iHD (Intel PCI 0x8086 + iHD loads OK)" >&2
        else
            unset LIBVA_DRIVER_NAME
            echo "x265-butler: libva_iHD_load_failed_unset — pre-gen8 Intel detected; falling back to i965 runtime autodetect" >&2
        fi
    else
        echo "x265-butler: LIBVA_DRIVER_NAME unset (no Intel PCI device; Mesa/NVENC autodetect)" >&2
    fi
else
    echo "x265-butler: dri_devices_absent — /sys/class/drm not visible to container" >&2
fi

# If running as root, remap the 'node' user/group to PUID:PGID and chown writable volumes.
if [ "$(id -u)" = "0" ]; then
    # Group: if another group already owns $PGID (e.g. unRAID's users=100 collides on the
    # default node image), reuse it instead of renaming the 'node' group onto a taken GID.
    if ! getent group "$PGID" >/dev/null 2>&1; then
        if getent group node >/dev/null 2>&1; then
            groupmod -g "$PGID" node
        else
            groupadd -g "$PGID" node
        fi
    fi

    # User: if another user already owns $PUID, reuse it; otherwise remap or create 'node'.
    if ! getent passwd "$PUID" >/dev/null 2>&1; then
        if id -u node >/dev/null 2>&1; then
            usermod -u "$PUID" -g "$PGID" node
        else
            useradd -u "$PUID" -g "$PGID" -M -s /usr/sbin/nologin node
        fi
    fi

    # chown only writable, app-owned volumes. NEVER /media or /media0 (read-only/host-owned).
    chown -R "$PUID:$PGID" /config /cache 2>/dev/null || true
    chown "$PUID:$PGID" /app 2>/dev/null || true
    # .next is built as node:node (UID 1000). After usermod remaps 'node' to PUID,
    # existing file UIDs are unchanged. Chown .next recursively so the runtime user
    # can write the image cache and other runtime-created subdirs.
    mkdir -p /app/.next/cache
    chown -R "$PUID:$PGID" /app/.next 2>/dev/null || true

    exec gosu "$PUID:$PGID" "$@"
else
    # Already non-root (dev compose override); just exec.
    exec "$@"
fi
