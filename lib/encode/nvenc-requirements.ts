// Phase 23 Plan 23-06 — NVENC container-runtime requirements, single source of truth.
//
// Consumed by BOTH components/onboarding/hw-accel-step.tsx and
// components/settings/encoder-warnings-badge.tsx so the operator-facing NVENC
// guidance is defined exactly once.
//
// Per [[feedback_release_notes_nvidia]]: NVENC fails unless the `video`
// driver-capability is granted (hence `compute,video,utility`). The
// docker-compose `--gpus` flag is DELIBERATELY OMITTED — it is compose / CLI
// syntax, NOT unRAID-native, and was the original mis-paste bug this plan kills.
//
// AUDIT-M1: unRAID's Docker-template "Variable" entry has TWO separate inputs
// (Name and Value). Each env-var is modelled as `{ key, value }` so a copy
// affordance can expose the BARE key and the BARE value as DISTINCT copy
// targets — each maps 1:1 to one unRAID Variable input. A pre-joined
// `KEY=value` string is NEVER offered as an operator-facing paste value
// (it would repeat the same wrong-slot mis-paste class as the omitted flag).

export interface NvencEnvVar {
  /** unRAID Variable "Name" input — a distinct bare copy target. */
  readonly key: string;
  /** unRAID Variable "Value" input — a distinct bare copy target. */
  readonly value: string;
}

export interface NvencRequirements {
  /** unRAID "Extra Parameters" free-text field — single bare copy target. */
  readonly extraParam: string;
  readonly envVars: readonly NvencEnvVar[];
}

export const NVENC_REQUIREMENTS: NvencRequirements = {
  extraParam: '--runtime=nvidia',
  envVars: [
    { key: 'NVIDIA_VISIBLE_DEVICES', value: 'all' },
    { key: 'NVIDIA_DRIVER_CAPABILITIES', value: 'compute,video,utility' },
  ],
} as const;
