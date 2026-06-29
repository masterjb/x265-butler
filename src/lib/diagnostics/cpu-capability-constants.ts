// 23-05 — pure CPU/iGPU HEVC-QSV gen thresholds (NO node:fs import) so they are
// safe to import into the client onboarding advisory component. cpu-capability.ts
// re-exports these; both server probe and client gate share one source of truth.

// First HW HEVC-QSV is Skylake (gen6, 8-bit). The onboarding advisory fires for
// an Intel iGPU with graphicsGen < MIN_GEN (i.e. hevcQsv === 'none').
export const INTEL_IGPU_HEVC_QSV_MIN_GEN = 6;

// First 10-bit HEVC-QSV is Kaby Lake (gen7).
export const INTEL_IGPU_HEVC_QSV_10BIT_MIN_GEN = 7;
