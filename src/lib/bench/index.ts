// 11-01: Bench module barrel — re-export public API.
export { computeParetoFrontier, pickTop3, normalizeForBalance } from './pareto';
export type { ParetoCandidate } from './pareto';
export { extractSamples, SampleExtractorError } from './sample-extractor';
export type { SampleExtractionResult, ExtractSamplesOpts } from './sample-extractor';
export { computeVmaf, encodeForBench, probeLibvmafAvailability, VmafComputeError } from './vmaf';
export type { VmafResult, ComputeVmafOpts } from './vmaf';
export {
  BenchOrchestrator,
  benchOrchestrator,
  __forTests_resetBenchOrchestrator,
  sanitizePass2ErrorMessage,
} from './orchestrator';
export { selectRecommendationsByEncoder } from './recommendation';
export type {
  EncoderRecommendation,
  RecommendationByEncoder,
  RecommendationDivergence,
  RecommendationResult,
  RecommendationMode,
} from './recommendation';
