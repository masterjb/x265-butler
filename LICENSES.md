# x265-butler — Third-Party Licenses

This document enumerates third-party software bundled in the x265-butler container image.

## Primary Project License

**PolyForm Noncommercial 1.0.0** (see [LICENSE](LICENSE)) — x265-butler
application code. Source-available license; noncommercial use only.
SPDX-ID: `PolyForm-Noncommercial-1.0.0`. Commercial use requires a separate
license from the Project Owner.

Contributions are accepted under the [Individual Contributor License
Agreement (CLA.md)](CLA.md) — sign-off via `git commit -s`.

## Runtime Dependencies

- **FFmpeg** — GPL-3.0+ (statically built with libx265 + libvpx + libsvtav1 + libfdk-aac per static-build profile)
- **Node.js 22** — MIT
- **better-sqlite3** — MIT
- **Next.js 15** — MIT
- (additional runtime deps tracked via `npm ls --prod`)

## VAAPI / QSV Drivers (Phase 18 — v2.15.0+)

- **`intel-media-va-driver-non-free`** — Intel iHD driver for gen8+ hardware.
  - Classification: Debian `non-free-firmware` (binary firmware required for VAAPI HEVC/AV1 encode on Arc/Battlemage/UHD-630+).
  - Upstream: <https://github.com/intel/media-driver>
- **`i965-va-driver`** — legacy Intel VAAPI driver for gen4-gen7 (Sandybridge/Ivy/Haswell).
  - Classification: free (MIT).
  - Upstream: <https://github.com/intel/intel-vaapi-driver>
- **`mesa-va-drivers`** — Mesa Gallium VAAPI driver for AMD GPUs.
  - Classification: free (MIT).
  - Upstream: <https://gitlab.freedesktop.org/mesa/mesa>

## OCI Image License Label

`org.opencontainers.image.licenses` = `PolyForm-Noncommercial-1.0.0 AND GPL-3.0+ AND non-free-firmware`

The `non-free-firmware` token reflects the `intel-media-va-driver-non-free` package inclusion. Reproduction or redistribution of the image must honor the Debian `non-free-firmware` redistribution terms.

The `PolyForm-Noncommercial-1.0.0` token applies to the x265-butler application code only. The bundled FFmpeg binary remains GPL-3.0+; redistribution of the combined image must satisfy both the PolyForm noncommercial restriction and GPL source-availability obligations.

---

_Generated as part of Phase 18 — GPU Driver Bake-in (v2.15.0)._
