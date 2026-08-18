/**
 * Recall Candidate 的**用户侧**能力判据（唯一来源）。
 *
 * 这一层只回答一个问题：*用户*现在对这条候选还能做什么。它不是系统自动
 * 沉淀的门禁——那条线在 candidate-service.ts::isAutoCaptureEligible，两者
 * 必须分开：把用户可操作面放宽到 weak_observation 是产品要的，把自动沉淀
 * 放宽到 weak_observation 则会让系统绕过用户确认直接晋升弱证据候选。
 *
 * 同样不要把这里的状态和 Ability Asset 成熟度（seed → bud → …）互相映射。
 * Candidate 状态决定"要不要成为资产"，maturity 决定"成为资产之后走到哪一步"。
 *
 * 消费方（inbox、Dashboard 计数、IPC DTO、renderer）一律读这里的字段，
 * 不得再自己写 `status === 'pending_review'`，也不得用其它字段自行组合出
 * needsUserAction / countsAsPending / canBatchSelect。
 */

import type { RecallCandidateRisk, RecallCandidateStatus } from './candidate-service';

/** 用户可见的产品态。后端枚举不直接进 UI。 */
export type RecallCandidateDisplayState =
  | 'needs_review'
  | 'weak_evidence'
  | 'deferred'
  | 'confirmed'
  | 'rejected'
  | 'ignored'
  | 'expired'
  | 'failed'
  | 'superseded'
  /** 认不出的状态（旧数据 / 上游异常）。只读展示，不猜它能做什么。 */
  | 'unknown';

/** disabledReason / 批量拦截原因的稳定码。UI 负责翻译，不得直接展示。 */
export type RecallCandidateBlockedReason =
  | 'candidate_confirmed'
  | 'candidate_rejected'
  | 'candidate_ignored'
  | 'candidate_expired'
  | 'candidate_superseded'
  | 'candidate_evidence_insufficient'
  | 'candidate_state_unknown'
  | 'candidate_high_risk_needs_single_review';

/** 判据输入：状态 + 风险 + 证据引用。证据只对 observed/weak_observation 有意义。 */
export interface RecallCandidateCapabilityInput {
  status: RecallCandidateStatus;
  risk?: RecallCandidateRisk;
  sourceRefs?: readonly unknown[];
  evidenceRefs?: readonly unknown[];
}

export interface RecallCandidateCapabilities {
  canView: boolean;
  canEdit: boolean;
  canConfirm: boolean;
  canPromote: boolean;
  canReject: boolean;
  canDefer: boolean;
  canRetry: boolean;
  /** 能否进入批量入库勾选池。= canPromote 且不是必须单条复核的高风险候选。 */
  canBatchSelect: boolean;
  /** 还需要用户做决定。= canConfirm || canReject || canDefer || canRetry。 */
  needsUserAction: boolean;
  /** 计入「待我处理」数量。Dashboard / inbox / 列表计数的唯一依据。 */
  countsAsPending: boolean;
  /**
   * 用户主动推迟过。仍然是待办（可以重新进入），但"不主动打扰"的摘要里
   * 应当安静——沉淀活动的复核摘要就是按这个把稍后处理排除在外的。
   */
  isSnoozed: boolean;
  isTerminal: boolean;
  displayState: RecallCandidateDisplayState;
  /** 仅在候选完全不可操作时给出（终态）。可操作候选为 undefined。 */
  disabledReason?: RecallCandidateBlockedReason;
  /** 候选本身可操作、但不能进批量时给出。用于批量按钮的真实 disabled 文案。 */
  batchBlockedReason?: RecallCandidateBlockedReason;
}

/** 可操作候选的公共底：编辑 / 确认 / 晋升 / 拒绝 / 稍后都开。 */
const ACTIONABLE = {
  canView: true,
  canEdit: true,
  canConfirm: true,
  canPromote: true,
  canReject: true,
  canDefer: true,
  canRetry: false,
  needsUserAction: true,
  countsAsPending: true,
  isSnoozed: false,
  isTerminal: false,
} as const;

/** 终态：只读。Candidate 生命周期到此为止，后续修改走正式 Asset 版本链。 */
function terminal(
  displayState: RecallCandidateDisplayState,
  disabledReason: RecallCandidateBlockedReason,
): Omit<RecallCandidateCapabilities, 'canBatchSelect' | 'batchBlockedReason'> {
  return {
    canView: true,
    canEdit: false,
    canConfirm: false,
    canPromote: false,
    canReject: false,
    canDefer: false,
    canRetry: false,
    needsUserAction: false,
    countsAsPending: false,
    isSnoozed: false,
    isTerminal: true,
    displayState,
    disabledReason,
  };
}

type BaseCapabilities = Omit<RecallCandidateCapabilities, 'canBatchSelect' | 'batchBlockedReason'>;

const BY_STATUS: Record<RecallCandidateStatus, BaseCapabilities> = {
  observed: { ...ACTIONABLE, displayState: 'needs_review' },
  weak_observation: { ...ACTIONABLE, displayState: 'weak_evidence' },
  pending_review: { ...ACTIONABLE, displayState: 'needs_review' },
  deferred: { ...ACTIONABLE, isSnoozed: true, displayState: 'deferred' },
  // 后端 isTerminalCandidate 不含 failed：更新 / 拒绝 / 晋升都仍然放行，
  // 所以这里不能把它当只读。产品上的主动作是重试。
  failed: { ...ACTIONABLE, canRetry: true, displayState: 'failed' },
  confirmed: terminal('confirmed', 'candidate_confirmed'),
  rejected: terminal('rejected', 'candidate_rejected'),
  ignored: terminal('ignored', 'candidate_ignored'),
  expired: terminal('expired', 'candidate_expired'),
  // normalizeCandidateStatus 会把落盘的 superseded 迁成 ignored，正常读不到；
  // 这里保留只读兜底，防止未经 normalize 的记录漏进 UI 时变成"假可操作"。
  superseded: terminal('superseded', 'candidate_superseded'),
};

/**
 * 高风险候选不进批量入库：批量没有逐条确认边界的机会，风险确认必须留在
 * 单条路径（promoteRecallCaptureCandidate 的 riskAcknowledged）。
 */
function blocksBatch(risk: RecallCandidateRisk | undefined): boolean {
  return risk === 'high';
}

/**
 * 记录不变量（asCandidate）：没有来源/证据的候选**只能**待在 observed /
 * weak_observation。硬把它推出去会写出一条读不回来的记录，整份候选列表随之
 * 加载失败。所以"证据是否齐全"是真正的可操作性判据，状态只是它的表征。
 * 未提供 refs 时不额外收紧——真实记录一定带这两个字段。
 */
function hasReviewableEvidence(candidate: RecallCandidateCapabilityInput): boolean {
  const evidence = candidate.evidenceRefs ?? candidate.sourceRefs;
  if (candidate.sourceRefs === undefined && evidence === undefined) return true;
  // 只对**给到的**字段判空：调用方可能只带其中一个（inbox DTO 就是这样），
  // 缺字段不等于"没有证据"。asCandidate 要求两者都非空，所以两者都要过。
  return (candidate.sourceRefs === undefined || candidate.sourceRefs.length > 0)
    && (evidence === undefined || evidence.length > 0);
}

export function getRecallCandidateCapabilities(
  candidate: RecallCandidateCapabilityInput,
): RecallCandidateCapabilities {
  let base = BY_STATUS[candidate.status];
  if (!base) throw new Error('unknown recall candidate status');
  const evidenceBound = candidate.status === 'observed' || candidate.status === 'weak_observation';
  if (evidenceBound && !hasReviewableEvidence(candidate)) {
    // 证据补齐前它连状态都迁不出去：UI 说"可以处理"就是假话。
    base = {
      ...base,
      canEdit: true,
      canConfirm: false,
      canPromote: false,
      canReject: false,
      canDefer: false,
      canRetry: false,
      needsUserAction: false,
      countsAsPending: false,
      disabledReason: 'candidate_evidence_insufficient',
    };
  }
  const batchBlocked = base.canPromote && blocksBatch(candidate.risk);
  return {
    ...base,
    canBatchSelect: base.canPromote && !batchBlocked,
    ...(batchBlocked ? { batchBlockedReason: 'candidate_high_risk_needs_single_review' as const } : {}),
  };
}

/**
 * 宽松入口：状态可能来自未经 normalize 的旧记录 / 外部构造的输入。
 * 认不出的状态返回 undefined —— 调用方按"不可操作、不计待办"处理，
 * 而不是猜。判据仍然只有上面那张表一份。
 */
export function tryGetRecallCandidateCapabilities(
  candidate: Omit<RecallCandidateCapabilityInput, 'status'> & { status: string },
): RecallCandidateCapabilities | undefined {
  if (!Object.prototype.hasOwnProperty.call(BY_STATUS, candidate.status)) return undefined;
  return getRecallCandidateCapabilities(candidate as RecallCandidateCapabilityInput);
}

/** 认不出状态时的兜底：只读。比让整份候选列表读失败要好得多。 */
const UNKNOWN_CAPABILITIES: RecallCandidateCapabilities = {
  ...terminal('unknown', 'candidate_state_unknown'),
  isTerminal: false,
  canBatchSelect: false,
};

/**
 * IPC DTO 投影：给出去的候选带上能力，落盘记录本身不带（避免被写回存储）。
 * 状态认不出时降级成只读而不是抛错——一条坏记录不该让整个读口 500。
 */
export function withRecallCandidateCapabilities<T extends { status: string }>(
  candidate: T,
): T & { capabilities: RecallCandidateCapabilities } {
  return {
    ...candidate,
    capabilities: tryGetRecallCandidateCapabilities(candidate) ?? UNKNOWN_CAPABILITIES,
  };
}

/** 终态候选被写操作命中时的稳定错误码。UI 靠 code 翻译，不靠 message 文本。 */
export const RECALL_CANDIDATE_TERMINAL_ERROR_CODE = 'recall_candidate_terminal';
/** 批量晋升里"这条不允许晋升"的稳定错误码。 */
export const RECALL_CANDIDATE_NOT_PROMOTABLE_ERROR_CODE = 'recall_candidate_not_promotable';

export class RecallCandidateStateError extends Error {
  readonly code: string;
  readonly status: RecallCandidateStatus;
  constructor(code: string, message: string, status: RecallCandidateStatus) {
    super(message);
    this.name = 'RecallCandidateStateError';
    this.code = code;
    this.status = status;
  }
}
