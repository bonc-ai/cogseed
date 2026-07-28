// ============================================================
// 纯库入口：只 re-export 引擎类型与类，绝不启动 MCP stdio 服务器。
// PC 进程内 loadEngine 加载 dist/engine.js（本文件），与会启动服务器的
// index.js（MCP 子进程入口）区分开——两条加载路径互不干扰。
// ============================================================

export { OntologyReader } from './modules/ontology-reader.js';
export { OntologyWriter } from './modules/ontology-writer.js';
export { EvolutionOrchestrator } from './modules/evolution-orchestrator.js';
export { SkillCreator } from './modules/skill-creator.js';
export { AttributionEngine } from './modules/attribution-engine.js';
export { PatchGenerator } from './modules/patch-generator.js';
export { GovernanceGates } from './modules/governance-gates.js';
export { EvidenceCollector } from './modules/evidence-collector.js';
export { RegistryManager } from './modules/registry-manager.js';

export { ruleFallbackComplete } from './modules/llm-port.js';
export type { LlmComplete, LlmResult } from './modules/llm-port.js';

export { KSTAR_STEPS } from './types/evolution.js';
export type {
  EvolutionRun, EvolutionStep, EvalRecord, EvalRecordCase, EvalRecordRun, EvalRecordRunResult,
  KstarStepName, StepStatus, RunStatus,
} from './types/evolution.js';

export type {
  OntologyClass, OntologyRule, OntologyExample, OntologySlice, OntologyManifest, OntologyIndividual,
  KSTAREpisode, PatchProposal, PatchTarget,
} from './types/index.js';
