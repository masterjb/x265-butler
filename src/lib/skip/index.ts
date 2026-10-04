// 04-01 barrel — skip pipeline public API consumed by scan/orchestrator.ts
// (Plan 04-01 Task 3 wiring) + future Plan 04-02 blocklist step + 04-03
// retry/self-heal hooks.
export {
  runSkipPipeline,
  type SkipDecision,
  type SkipReason,
  type SkipSource,
  type PipelineDeps,
  type PipelineInput,
} from './pipeline';
