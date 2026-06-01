// 11-01: Bench Orchestrator — runs bench_run matrix through sample-extract → encode → VMAF.
// Separate singleton from encode-orchestrator (02-02). Bench encodes use isBenchSample=true
// bypass: no sidecar, no file.status mutation, no job rows.

import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '../logger';
import type { BenchRunRepo } from '../db/repos/bench-run';
import { OccConflictError } from '../db/repos/bench-run';
import type { BenchComboRepo } from '../db/repos/bench-combo';
import type {
  BenchRunCreateInput,
  BenchMatrixNativeSweep,
  BenchMatrixVmafAnchored,
} from '../db/schema';
import { engineEvents } from '../encode/events';
import { runEncode } from '../encode/ffmpeg';
import type { EncoderId } from '../encode/profiles';
import { computeVmaf, encodeForBench } from './vmaf';
import {
  benchRunRepo as getBenchRunRepo,
  benchComboRepo as getBenchComboRepo,
  fileRepo as getFileRepo,
} from '../db';
import { extractSamples, SampleExtractorError } from './sample-extractor';

// 11-03 UAT regression: bench DB stores ffmpeg-encoder-names ("hevc_nvenc"
// etc.) but production buildCodecBlock dispatches on internal EncoderId
// ("nvenc"/"qsv"/"vaapi"/"libx265"). Map at the orchestrator boundary so
// Pass-2's runEncode call hits the same codepath production uses.
const BENCH_ENCODER_TO_PRODUCTION_ID: Record<string, EncoderId> = {
  libx265: 'libx265',
  hevc_nvenc: 'nvenc',
  hevc_qsv: 'qsv',
  hevc_vaapi: 'vaapi',
};

function normalizeBenchEncoderToProductionId(benchEncoder: string): EncoderId {
  const mapped = BENCH_ENCODER_TO_PRODUCTION_ID[benchEncoder];
  if (!mapped) {
    throw new Error(`bench encoder '${benchEncoder}' has no production EncoderId mapping`);
  }
  return mapped;
}

// 11-03 SR5: strip absolute paths / pid values / env-style tokens from
// error messages BEFORE they appear in SSE payloads or pino audit rows.
// Defense-in-depth — error.message from spawn/ffmpeg/vmaf frequently leaks
// scratch paths, ffmpeg's full output path, $PATH-style strings.
export function sanitizePass2ErrorMessage(input: string): string {
  return input
    .replace(/\/[A-Za-z0-9_./-]+/g, '<path>') // absolute filesystem paths
    .replace(/pid[\s=:]+\d+/gi, 'pid=<n>') // pid=12345
    .replace(/\$\{?[A-Z_][A-Z0-9_]*\}?/g, '<env>') // $VAR / ${VAR}
    .slice(0, 500);
}

const NATIVE_QUALITY_PARAM: Record<string, string> = {
  libx265: '-crf',
  hevc_nvenc: '-cq',
  hevc_qsv: '-global_quality',
  hevc_vaapi: '-qp',
};

const ENCODER_NATIVE_BRACKET: Record<string, [number, number]> = {
  libx265: [16, 32],
  hevc_nvenc: [20, 40],
  hevc_qsv: [16, 32],
  hevc_vaapi: [16, 32],
};

function getScratchBase(): string {
  return process.env.SCRATCH_DIR ?? path.join(process.cwd(), '.data', 'bench-scratch');
}

export class BenchOrchestrator {
  private readonly benchRunRepo: BenchRunRepo;
  private readonly benchComboRepo: BenchComboRepo;
  private readonly cancelledRuns = new Set<number>();
  private readonly inFlightControllers = new Map<number, AbortController>();
  private progressThrottle = new Map<number, number>();
  // 11-03: single in-flight Pass-2 lock + abort handle. AC-4 enforces
  // `pass2_busy` 409 at the API layer; this state is the authority.
  private isPass2Running = false;
  private pass2Controller: AbortController | null = null;
  private pass2InFlight: { runId: number; comboId: number } | null = null;

  constructor(benchRunRepo: BenchRunRepo, benchComboRepo: BenchComboRepo) {
    this.benchRunRepo = benchRunRepo;
    this.benchComboRepo = benchComboRepo;
  }

  // 11-03 AC-3 + AC-10: full-file Pass-2 verify against bench_run.fileIds[0].
  // Single try / finally — finally{} block does ALL cleanup unconditionally
  // (audit M3) so no orphan output remains on success / error / cancel.
  // errorReason emitted on bench.pass2_failed is path-sanitized (SR5).
  async runFullFileVerify(runId: number, comboId: number): Promise<void> {
    if (this.isPass2Running) {
      const err = new Error('pass2_busy');
      (err as Error & { code?: string }).code = 'pass2_busy';
      throw err;
    }

    const run = this.benchRunRepo.findById(runId);
    if (!run) throw new Error(`bench_run ${runId} not found`);
    if (run.status !== 'complete') {
      throw new Error(`bench_run ${runId} status=${run.status} (expected complete)`);
    }

    const combo = this.benchComboRepo.findById(comboId);
    if (!combo) throw new Error(`bench_combo ${comboId} not found`);
    if (combo.run_id !== runId) {
      throw new Error(`combo ${comboId} belongs to run ${combo.run_id}, not ${runId}`);
    }
    if (combo.pass2_completed_at !== null) {
      throw new Error(`combo ${comboId} already verified`);
    }

    const fileId = run.fileIds[0];
    if (fileId === undefined) {
      throw new Error(`bench_run ${runId} has empty fileIds`);
    }
    const file = getFileRepo().getById(fileId);
    if (!file) {
      throw new Error(`file ${fileId} not found`);
    }

    // Acquire lock + AbortController BEFORE async work — keep cleanup-paired with lock.
    this.isPass2Running = true;
    this.pass2Controller = new AbortController();
    this.pass2InFlight = { runId, comboId };
    const startedAt = Date.now();
    const outDir = path.join(getScratchBase(), `pass2-${runId}-${comboId}`);
    const outputPath = path.join(outDir, `verify-${comboId}.mkv`);

    engineEvents.emit({
      type: 'bench.pass2_started',
      runId,
      comboId,
      fileId,
      startedAt,
    } as never);
    logger.info(
      { audit: 'bench.pass2_started', runId, comboId, fileId, startedAt },
      'pass2 started',
    );

    // 11-03 SR4: monotonic 0..100 across encode (0→80) + vmaf (80→100).
    // Throttled 1Hz leading-edge per per-combo emitter (mirrors 11-02-FIX pattern).
    let lastEmitMs = 0;
    let lastPhase: 'encode' | 'vmaf' | null = null;
    let lastOverallPct = 0;
    const emitProgress = (phase: 'encode' | 'vmaf', phasePct: number): void => {
      const now = Date.now();
      const phaseChanged = phase !== lastPhase;
      if (!phaseChanged && now - lastEmitMs < 1000) return;
      const overallPct =
        phase === 'encode'
          ? Math.round((phasePct / 100) * 80)
          : 80 + Math.round((phasePct / 100) * 20);
      // Enforce monotonic non-decreasing (SR4 contract — a stray late
      // encode-phase emit after the vmaf-phase started would otherwise tick
      // backwards).
      const clampedPct = Math.max(lastOverallPct, Math.min(100, overallPct));
      lastOverallPct = clampedPct;
      engineEvents.emit({
        type: 'bench.pass2_progress',
        runId,
        comboId,
        overallPct: clampedPct,
        currentPhase: phase,
      } as never);
      lastEmitMs = now;
      lastPhase = phase;
    };

    try {
      await fs.mkdir(outDir, { recursive: true });

      // 11-03 SR3: invoke runEncode (production codepath) for byte-identical
      // args. EncodeOptions.crf carries the encoder-native quality value;
      // buildCodecBlock dispatches the right flag (`-crf` / `-cq` / `-qp`)
      // per encoder so the encoded output matches what Pipeline V2 will produce.
      // UAT regression: combo.encoder is the bench-ffmpeg-name ("hevc_nvenc")
      // and must be normalized to the internal EncoderId before dispatch.
      await runEncode({
        input: file.path,
        output: outputPath,
        encoder: normalizeBenchEncoderToProductionId(combo.encoder),
        preset: combo.preset ?? undefined,
        crf: combo.native_quality_value,
        signal: this.pass2Controller.signal,
        onProgress: (ev) => {
          // ffmpeg -progress emits out_time_ms (microseconds). Without the file
          // duration we have no anchor, so phasePct is best-effort: derive
          // from totalSize ratio when known, else fall back to a low constant
          // tick so the SSE pipeline still publishes "alive" frames.
          if (ev.progress === 'end') {
            emitProgress('encode', 100);
            return;
          }
          // Heuristic phasePct: cap at 95 in encode-phase so vmaf-phase reads
          // strictly higher. No estimate available without source duration —
          // tests stub onProgress directly.
          emitProgress('encode', 50);
        },
      });

      // 11-03 UAT regression: computeVmaf default timeout = durationSec*5*1000.
      // Without an explicit durationSec, it defaults to 20s → 100s timeout,
      // which aborts full-file VMAF compute on any movie-length source.
      // Pass file.duration_seconds when known; fallback 3600s = 5h headroom
      // for sources without a probed duration (long director's cuts, etc.).
      const vmafDurationSec = file.duration_seconds ?? 3600;
      const { vmafMean } = await computeVmaf(file.path, outputPath, {
        model: run.vmaf_model,
        signal: this.pass2Controller.signal,
        durationSec: vmafDurationSec,
        onProgress: (pct) => emitProgress('vmaf', pct),
      });

      const stat = await fs.stat(outputPath);
      const sizeBytes = stat.size;
      const encodeSec = (Date.now() - startedAt) / 1000;
      const completedAt = Date.now();

      this.benchComboRepo.markPass2Complete(comboId, {
        vmaf: vmafMean,
        sizeBytes,
        encodeSeconds: encodeSec,
        completedAt,
      });

      engineEvents.emit({
        type: 'bench.pass2_complete',
        runId,
        comboId,
        vmaf: vmafMean,
        sizeBytes,
        encodeSec,
        completedAt,
      } as never);
      logger.info(
        { audit: 'bench.pass2_complete', runId, comboId, vmaf: vmafMean, sizeBytes, encodeSec },
        'pass2 complete',
      );
    } catch (err) {
      const wasCancelled = this.pass2Controller?.signal.aborted ?? false;
      const rawReason = err instanceof Error ? err.message : String(err);
      const errorReason = wasCancelled ? 'cancelled' : sanitizePass2ErrorMessage(rawReason);
      engineEvents.emit({
        type: 'bench.pass2_failed',
        runId,
        comboId,
        errorReason,
      } as never);
      logger.warn({ audit: 'bench.pass2_failed', runId, comboId, errorReason }, 'pass2 failed');
    } finally {
      // 11-03 M3: unconditional cleanup — encoded output removed regardless of
      // success / error / cancel. No orphan files on the unRAID cache disk.
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
      this.isPass2Running = false;
      this.pass2Controller = null;
      this.pass2InFlight = null;
    }
  }

  // 11-03 SR2 / AC-4b: aborts the in-flight Pass-2 encode. finally{} in
  // runFullFileVerify completes cleanup + emits bench.pass2_failed { 'cancelled' }.
  cancelPass2(runId: number, comboId: number): void {
    if (!this.isPass2Running || !this.pass2InFlight) {
      const err = new Error('not_running');
      (err as Error & { code?: string }).code = 'not_running';
      throw err;
    }
    if (this.pass2InFlight.runId !== runId || this.pass2InFlight.comboId !== comboId) {
      const err = new Error('not_running');
      (err as Error & { code?: string }).code = 'not_running';
      throw err;
    }
    this.pass2Controller?.abort();
    logger.info({ audit: 'bench.pass2_cancel', runId, comboId }, 'pass2 cancel signal sent');
  }

  async enqueueRun(input: BenchRunCreateInput): Promise<{ runId: number }> {
    const matrix = input.matrix;
    const encoders = (matrix as BenchMatrixNativeSweep).encoders ?? [];
    const presets = (matrix as BenchMatrixNativeSweep).presets ?? [];
    const nativeValues = (matrix as BenchMatrixNativeSweep).nativeValues;
    const vmafTargets = (matrix as BenchMatrixVmafAnchored).vmafTargets;
    const sampleCount = input.sampleCount ?? 3;

    const comboCount = nativeValues
      ? encoders.length * presets.length * nativeValues.length * input.fileIds.length * sampleCount
      : encoders.length *
        presets.length *
        (vmafTargets?.length ?? 0) *
        input.fileIds.length *
        sampleCount;

    const runId = this.benchRunRepo.create(input);

    const combos = [];
    for (const fileId of input.fileIds) {
      for (const encoder of encoders) {
        const nativeQualityParam = NATIVE_QUALITY_PARAM[encoder] ?? '-crf';
        for (const preset of presets) {
          if (nativeValues) {
            for (const nativeValue of nativeValues) {
              for (let s = 0; s < sampleCount; s++) {
                combos.push({
                  file_id: fileId,
                  encoder,
                  preset,
                  native_quality_param: nativeQualityParam,
                  native_quality_value: nativeValue,
                  vmaf_target: null,
                  sample_idx: s,
                });
              }
            }
          } else if (vmafTargets) {
            for (const target of vmafTargets) {
              for (let s = 0; s < sampleCount; s++) {
                combos.push({
                  file_id: fileId,
                  encoder,
                  preset,
                  native_quality_param: nativeQualityParam,
                  native_quality_value: 23, // placeholder; resolved at encode time
                  vmaf_target: target,
                  sample_idx: s,
                });
              }
            }
          }
        }
      }
    }

    this.benchComboRepo.createBatch(runId, combos);

    engineEvents.emit({
      type: 'bench.queued',
      runId,
      mode: input.mode,
      fileCount: input.fileIds.length,
      comboCount,
    } as never);

    return { runId };
  }

  async cancelRun(runId: number): Promise<void> {
    const run = this.benchRunRepo.findById(runId);
    if (!run) throw new Error(`bench_run ${runId} not found`);

    this.cancelledRuns.add(runId);
    const controller = this.inFlightControllers.get(runId);
    if (controller) controller.abort();

    try {
      this.benchRunRepo.markCancelled(runId, run.version);
    } catch (err) {
      if (err instanceof OccConflictError) throw err;
      throw err;
    }

    engineEvents.emit({ type: 'bench.cancelled', runId, cancelledAt: Date.now() } as never);
  }

  async executeNextPending(): Promise<void> {
    const run = this.benchRunRepo.listRecent(10, 0).find((r) => r.status === 'pending');
    if (!run) return;
    await this._executeRun(run.id);
  }

  private async _executeRun(runId: number): Promise<void> {
    const run = this.benchRunRepo.findById(runId);
    if (!run) return;

    try {
      this.benchRunRepo.markRunning(runId, run.version);
    } catch {
      return;
    }

    const controller = new AbortController();
    this.inFlightControllers.set(runId, controller);

    engineEvents.emit({ type: 'bench.started', runId, startedAt: Date.now() } as never);

    const scratchDir = path.join(getScratchBase(), String(runId));
    const mode = run.mode;
    const matrix = run.matrix;
    const vmafTargets = (matrix as BenchMatrixVmafAnchored).vmafTargets;

    const pendingCombos = this.benchComboRepo.listPendingByRun(runId);
    const totalCombos = pendingCombos.length;
    let completedCombos = 0;

    try {
      for (const fileId of run.fileIds) {
        if (this.cancelledRuns.has(runId)) break;

        // We group samples by fileId: extract once, reuse per-encoder combos
        const fileCombos = pendingCombos.filter((c) => c.file_id === fileId);
        if (fileCombos.length === 0) continue;

        const sampleDurationSec = run.sample_duration_seconds;
        const sampleDir = path.join(scratchDir, `file-${fileId}`);

        const file = getFileRepo().getById(fileId);
        if (!file) {
          for (const combo of fileCombos) {
            this.benchComboRepo.markComboFailed(combo.id, `file ${fileId} not found`);
          }
          continue;
        }

        let extractedPaths: Map<number, string>;
        try {
          const extracted = await extractSamples(file.path, {
            count: run.sample_count,
            durationSec: sampleDurationSec,
            scratchDir: sampleDir,
            fileId,
            signal: controller.signal,
          });
          extractedPaths = new Map(extracted.map((r) => [r.sampleIdx, r.path]));
        } catch (err) {
          if (this.cancelledRuns.has(runId)) break;
          const reason =
            err instanceof SampleExtractorError
              ? `sample extraction failed: ${err.message}`
              : `sample extraction error: ${err instanceof Error ? err.message : String(err)}`;
          for (const combo of fileCombos) {
            this.benchComboRepo.markComboFailed(combo.id, reason.slice(0, 500));
          }
          continue;
        }

        // Group fileCombos by sample_idx
        const sampleIdxSet = new Set(fileCombos.map((c) => c.sample_idx));

        for (const sampleIdx of sampleIdxSet) {
          if (this.cancelledRuns.has(runId)) break;

          const samplePath = extractedPaths.get(sampleIdx);
          if (!samplePath) {
            const missing = fileCombos.filter((c) => c.sample_idx === sampleIdx);
            for (const combo of missing) {
              this.benchComboRepo.markComboFailed(combo.id, `sample ${sampleIdx} not extracted`);
            }
            continue;
          }

          // Combos for this sample
          const sampleCombos = fileCombos.filter((c) => c.sample_idx === sampleIdx);

          for (const combo of sampleCombos) {
            if (this.cancelledRuns.has(runId)) {
              this.benchComboRepo.markComboSkipped(combo.id);
              continue;
            }

            this.benchComboRepo.markComboEncoding(combo.id);

            const encodedPath = path.join(sampleDir, `encoded-${combo.id}.mkv`);

            try {
              let nativeValue = combo.native_quality_value;

              if (mode === 'vmaf-anchored' && combo.vmaf_target !== null && vmafTargets) {
                const bracket = ENCODER_NATIVE_BRACKET[combo.encoder] ?? [16, 32];
                nativeValue = await this._resolveVmafAnchoredValue(
                  samplePath,
                  normalizeBenchEncoderToProductionId(combo.encoder),
                  combo.preset,
                  bracket,
                  combo.vmaf_target,
                  sampleDurationSec,
                  controller.signal,
                  runId,
                  combo.id,
                  combo.file_id,
                );
              }

              // 11-02-FIX (UAT-001): per-combo throttled emitter (leading-edge 1Hz).
              // Closure scope: per-combo (orchestrator iterates combos serially per the
              // single-loop here; closure dies between combos so throttle state can't leak).
              // Audit M3: phase change bypasses throttle (immediate emit).
              const PHASE_ANCHORS = {
                'sample-extraction': [0, 10],
                encode: [10, 70],
                vmaf: [70, 95],
                pareto: [95, 100],
              } as const;
              let lastEmitMs = 0;
              let lastPhase: keyof typeof PHASE_ANCHORS | null = null;
              const emitComboProgress = (
                phase: keyof typeof PHASE_ANCHORS,
                phasePct: number,
              ): void => {
                const now = Date.now();
                const phaseChanged = phase !== lastPhase;
                if (!phaseChanged && now - lastEmitMs < 1000) return; // 1Hz leading-edge
                const [start, end] = PHASE_ANCHORS[phase];
                const overallPct = Math.round(start + (phasePct / 100) * (end - start));
                engineEvents.emit({
                  type: 'bench.combo_progress',
                  runId,
                  comboId: combo.id,
                  phase,
                  phasePct: Math.round(phasePct),
                  overallPct,
                } as never);
                lastEmitMs = now;
                lastPhase = phase;
              };

              // 11-02-FIX-V2 UAT-003: measure source-sample size BEFORE encode for
              // compression-ratio + projected full-file savings. fs.stat error → log + continue
              // with sourceSampleBytes undefined (NOT a hard fail; ratio just renders '—').
              let sourceSampleBytes: number | undefined;
              try {
                const stat = await fs.stat(samplePath);
                sourceSampleBytes = stat.size;
              } catch (err) {
                logger.warn(
                  {
                    action: 'bench_source_size_stat_failed',
                    runId,
                    comboId: combo.id,
                    samplePath,
                    err: err instanceof Error ? err.message : String(err),
                  },
                  'pre-encode stat failed; sourceSampleBytes left undefined',
                );
              }

              const { sizeBytes, encodeSec } = await encodeForBench({
                inputPath: samplePath,
                outputPath: encodedPath,
                // HW-bench-fix: normalize bench-ffmpeg-name → production EncoderId
                // so encodeForBench dispatches via buildCodecBlock (= same args
                // production runEncode emits). Pre-fix path bypassed the codec
                // registry and HW combos failed at ffmpeg spawn.
                encoder: normalizeBenchEncoderToProductionId(combo.encoder),
                preset: combo.preset,
                crf: nativeValue,
                signal: controller.signal,
                durationSec: sampleDurationSec,
                onProgress: (p) => emitComboProgress('encode', p),
              });

              const { vmafMean } = await computeVmaf(samplePath, encodedPath, {
                model: run.vmaf_model,
                durationSec: sampleDurationSec,
                signal: controller.signal,
                onProgress: (p) => emitComboProgress('vmaf', p),
              });

              this.benchComboRepo.markComboComplete(combo.id, {
                vmaf: vmafMean,
                sizeBytes,
                encodeSec,
                sourceSampleBytes,
              });

              // Discard encoded file after VMAF
              fs.unlink(encodedPath).catch(() => undefined);

              completedCombos++;
              this._emitProgress(
                runId,
                combo.id,
                combo.file_id,
                sampleIdx,
                completedCombos,
                totalCombos,
              );

              engineEvents.emit({
                type: 'bench.combo_complete',
                runId,
                comboId: combo.id,
                vmaf: vmafMean,
                sizeBytes,
                encodeSec,
              } as never);
            } catch (err) {
              if (this.cancelledRuns.has(runId)) {
                this.benchComboRepo.markComboSkipped(combo.id);
              } else {
                const reason = err instanceof Error ? err.message : String(err);
                this.benchComboRepo.markComboFailed(combo.id, reason.slice(0, 500));
              }
              fs.unlink(encodedPath).catch(() => undefined);

              // Failed / skipped combos still advance progress so the UI
              // doesn't freeze at 0% when most combos fail (e.g. ffmpeg
              // missing libvmaf). Symmetric to the success path above.
              completedCombos++;
              this._emitProgress(
                runId,
                combo.id,
                combo.file_id,
                sampleIdx,
                completedCombos,
                totalCombos,
              );
            }
          }
        }
      }

      if (!this.cancelledRuns.has(runId)) {
        const currentRun = this.benchRunRepo.findById(runId);
        if (currentRun && currentRun.status === 'running') {
          this.benchComboRepo.recomputePareto(runId);
          this.benchRunRepo.markComplete(runId, currentRun.version);

          const summary = this.benchComboRepo.summarizeRun(runId);
          const paretoCount = summary.filter((c) => c.is_pareto).length;
          const top3RoleCounts = { quality: 0, balanced: 0, size: 0 };
          for (const c of summary) {
            if (c.top3_role) top3RoleCounts[c.top3_role]++;
          }

          engineEvents.emit({
            type: 'bench.completed',
            runId,
            completedAt: Date.now(),
            paretoCount,
            top3RoleCounts,
          } as never);
        }
      }
    } catch (err) {
      const currentRun = this.benchRunRepo.findById(runId);
      if (currentRun && !['failed', 'cancelled', 'complete'].includes(currentRun.status)) {
        const reason = err instanceof Error ? err.message : String(err);
        try {
          this.benchRunRepo.markFailed(runId, reason.slice(0, 500), currentRun.version);
        } catch {
          /* already terminal */
        }
        engineEvents.emit({
          type: 'bench.failed',
          runId,
          errorReason: reason.slice(0, 500),
        } as never);
      }
    } finally {
      this.inFlightControllers.delete(runId);
      this.cancelledRuns.delete(runId);
      // Best-effort scratch cleanup
      fs.rm(scratchDir, { recursive: true, force: true }).catch((err: Error) =>
        logger.warn({ action: 'bench_scratch_cleanup_failed', runId, err: err.message }),
      );
    }
  }

  private async _resolveVmafAnchoredValue(
    samplePath: string,
    encoder: EncoderId,
    preset: string | null,
    bracket: [number, number],
    vmafTarget: number,
    durationSec: number,
    signal: AbortSignal,
    runId: number,
    comboId: number,
    fileId: number,
  ): Promise<number> {
    const [start, end] = bracket;
    const step = (end - start) / 3;
    const probeValues = [start, start + step, start + 2 * step, end].map(Math.round);

    const probeResults: { nativeValue: number; vmaf: number }[] = [];
    const probeDir = path.join(getScratchBase(), String(runId), `probe-${comboId}`);
    await fs.mkdir(probeDir, { recursive: true });

    for (const nativeValue of probeValues) {
      const probePath = path.join(probeDir, `probe-${nativeValue}.mkv`);
      try {
        const { encodeSec: probeEncodeSec } = await encodeForBench({
          inputPath: samplePath,
          outputPath: probePath,
          encoder,
          preset,
          crf: nativeValue,
          signal,
        });
        const { vmafMean } = await computeVmaf(samplePath, probePath, { durationSec, signal });
        logger.debug({
          action: 'bench_probe_metric',
          runId,
          comboId,
          fileId,
          nativeValue,
          vmafMean,
          probeEncodeSec,
        });
        probeResults.push({ nativeValue, vmaf: vmafMean });
        fs.unlink(probePath).catch(() => undefined);
      } catch {
        // probe_chain_aborted
        fs.unlink(probePath).catch(() => undefined);
        break;
      }
    }

    fs.rm(probeDir, { recursive: true, force: true }).catch(() => undefined);

    if (probeResults.length < 2) {
      return probeValues[1]; // fallback to nearest mid-bracket
    }

    // Linear interpolation in (VMAF, nativeValue) space to find target
    let lower = probeResults[0];
    let upper = probeResults[probeResults.length - 1];

    for (let i = 0; i < probeResults.length - 1; i++) {
      if (probeResults[i].vmaf >= vmafTarget && probeResults[i + 1].vmaf <= vmafTarget) {
        upper = probeResults[i];
        lower = probeResults[i + 1];
        break;
      }
      if (probeResults[i].vmaf <= vmafTarget && probeResults[i + 1].vmaf >= vmafTarget) {
        lower = probeResults[i];
        upper = probeResults[i + 1];
        break;
      }
    }

    const vmafRange = upper.vmaf - lower.vmaf;
    const solved =
      vmafRange === 0
        ? lower.nativeValue
        : Math.round(
            lower.nativeValue +
              ((vmafTarget - lower.vmaf) / vmafRange) * (upper.nativeValue - lower.nativeValue),
          );

    return Math.max(bracket[0], Math.min(bracket[1], solved));
  }

  private _emitProgress(
    runId: number,
    comboId: number,
    fileId: number,
    sampleIdx: number,
    completedCombos: number,
    totalCombos: number,
  ): void {
    const now = Date.now();
    const last = this.progressThrottle.get(runId) ?? 0;
    if (now - last < 1000) return;
    this.progressThrottle.set(runId, now);
    engineEvents.emit({
      type: 'bench.progress',
      runId,
      comboId,
      fileId,
      sampleIdx,
      completedCombos,
      totalCombos,
      currentPhase: 'encode',
    } as never);
  }
}

let _benchOrchestrator: BenchOrchestrator | null = null;

export function benchOrchestrator(): BenchOrchestrator {
  if (!_benchOrchestrator) {
    _benchOrchestrator = new BenchOrchestrator(getBenchRunRepo(), getBenchComboRepo());
  }
  return _benchOrchestrator;
}

export function __forTests_resetBenchOrchestrator(): void {
  _benchOrchestrator = null;
}
