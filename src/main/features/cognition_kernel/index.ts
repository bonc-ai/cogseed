/**
 * cognition_kernel — 认知内核契约层。
 *
 * 核心任务读取契约：
 *   resolvePersonalFields  取件窗口：任务要的个人字段只走这一个口
 *   checkTaskFields        缺口引擎：任务包 → 已有/缺（缺的带问法与动作）
 *   readMergedInbox        合并收件箱：两个候选池 → 一个队列（供「待我处理」用）
 *
 * 设计约束见 types.ts 头注；本层不改变既有存储与既有通道的行为。
 */

export type {
  CandidatePool,
  CognitionDelta,
  ContentHome,
  DeltaEvidenceRef,
  DeltaOp,
  DeltaOrigin,
  DeltaStatus,
  DeltaTarget,
  InboxHome,
  InboxItemKind,
  MissingPersonalField,
  MissingReason,
  OntologyFieldValueView,
  PersonalAssetView,
  PersonalFieldRef,
  PersonalFieldResolution,
  PersonalFieldSource,
  PersonalSourceSnapshot,
  ResolvePersonalFieldsRequest,
  ResolvedPersonalField,
} from './types';
export { PERSONAL_FIELD_POLICY_VERSION } from './types';

// 归属：契约（家的定义与落池）+ 判定引擎（模型按本体判定 + 三档门控）+ 规则数据。
// 判断归模型，闸门归代码，不以静态类型表替代内容判定。
export { CONTENT_ROUTE_TABLE, HOME_DEFINITIONS, POOL_BY_HOME, UNCLASSIFIED } from './routing';
export type { HomeDefinition } from './routing';
export {
  buildJudgePrompt,
  buildOntologyContext,
  judgeContentHome,
  parseJudgeReply,
  rankCorrectionsByRelevance,
  recordRoutingDecision,
} from './judge';
export type { ContentToRoute, HomeCandidate, JudgeOptions, RoutingJudgement, RoutingOutcome } from './judge';
export { addRoutingRule, learnFromCorrection, readRoutingRules, routingRulesPath } from './routing_rules';
export type { RoutingCorrection, RoutingRule, RoutingRulesDoc } from './routing_rules';

export { buildDelta, deltaFingerprint, deltaIdempotencyKey, validateDelta, DELTA_ID_PREFIX } from './delta';
export type { BuildDeltaInput, DeltaValidation } from './delta';

export { loadPersonalSourceSnapshot, resolveFromSnapshot, resolvePersonalFields } from './resolve';

export { TASK_FIELD_PACKS, getTaskFieldPack } from './task_field_packs';
export type { AssetSlotRef, OntologySlotRef, TaskFieldPack } from './task_field_packs';

export { checkTaskFields } from './gap';
export type { FieldGap, TaskFieldCheck } from './gap';

export {
  listCognitionBoundReceipts,
  recordCognitionBoundReceipt,
} from './bound_receipt';
export type { BoundSlotAxis, BoundSlotRef, CognitionBoundReceipt, MissingSlotRef } from './bound_receipt';

export {
  resolveAssetSlots,
  resolveOntologySlots,
} from './slots';
export type {
  AssetSlotBound,
  AssetSlotMissing,
  AssetSlotResolution,
  OntologySlotBound,
  OntologySlotMissing,
  OntologySlotResolution,
  ResolveSlotOptions,
  SlotAxis,
} from './slots';

export { INBOX_LIMIT, buildMergedInbox, readMergedInbox } from './inbox';
export type { InboxItem, MergedInbox } from './inbox';

// 统一认知库：对象模型、存储内核、Delta 落地器与家注册表。
export {
  APPLIED_DELTA_INDEX_MAX,
  BUILTIN_HOME_IDS,
  COGNITION_STORE_SCHEMA_VERSION,
  DEFAULT_HOME_REGISTRY,
  emptyCognitionStore,
  findAssertionSlot,
  findHomeEntry,
  homeToObjectShape,
  normalizeCognitionObject,
  normalizeCognitionStoreDocument,
  normalizeHomeRegistry,
  storeShapeForHomes,
  validateHomeRegistry,
} from './object-model';
export type {
  BundleKind,
  CognitionObject,
  CognitionObjectKind,
  CognitionObjectStatus,
  CognitionStoreDocument,
  HomeRegistryEntry,
} from './object-model';
export {
  COGNITION_STORE_CORRUPT_DOMAIN,
  applyCognitionDelta,
  applyCognitionDeltas,
  cognitionAuditPath,
  cognitionStorePath,
  listCognitionVersions,
  loadCognitionStoreSync,
  replaceCognitionHomes,
} from './store';
export type { ApplyDeltasOutcome, CognitionVersionLine, DeltaApplyResult, ReplaceHomesOutcome } from './store';

// 统一候选池：池条目为 proposed Delta，同槽只留最新。
export {
  POOL_CORRUPT_DOMAIN,
  POOL_MAX_ITEMS,
  POOL_SCHEMA_VERSION,
  UNROUTED_MAX,
  addUnrouted,
  decidePoolItem,
  decideUnrouted,
  emptyPool,
  listPool,
  listUnrouted,
  loadPoolSync,
  poolPath,
  resumeDuePoolItems,
  submitToPool,
} from './pool';
export type {
  DecideOutcome,
  PoolDocument,
  PoolItem,
  PoolItemStatus,
  PoolSourceKind,
  PoolView,
  SubmitOutcome,
  UnroutedItem,
  UnroutedOutcome,
} from './pool';
