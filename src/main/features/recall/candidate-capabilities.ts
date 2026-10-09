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
import type { AbilityAssetType, RecallCandidateAction } from './candidate-service';
import type { RecallCandidateClassificationReason } from './capture-value-screening';
import { validatePromotionByAssetType, type PromotionBlockReason } from './formal-assets/promotion';

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

/**
 * 正式资产准入结论。与候选状态正交：状态回答「这条候选走到哪一步了」，
 * eligibility 回答「它的**内容**够不够格成为该类型的正式资产」。
 *
 *   eligible      内容过闸，确认后可直接落库
 *   soft_warning  过闸，但有 advisory 欠缺（例如方法结构不完整）。仍可确认。
 *   ineligible    不过闸。**必须**关掉确认，否则就是假审批：用户点了确认，
 *                 promoteRecallCandidate 的同一道闸会再拒一次。
 */
export type RecallCandidateEligibility = 'eligible' | 'soft_warning' | 'ineligible';

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

/**
 * 判据输入：状态 + 风险 + 证据引用 + **内容**。
 *
 * 内容字段是为了在这一层就跑一次正式资产准入门槛
 * （`validatePromotionByAssetType`）——晋升时跑的是同一个函数，所以这里给出的
 * canPromise 与真正 promote 的结论同源。全部可选：只带状态与证据的旧调用方
 * （外部构造、老 DTO）仍然可用，缺内容时不收紧，见 `assessEligibility`。
 */
export interface RecallCandidateCapabilityInput {
  status: RecallCandidateStatus;
  risk?: RecallCandidateRisk;
  sourceRefs?: readonly unknown[];
  evidenceRefs?: readonly unknown[];
  judgment?: string;
  value?: string;
  summary?: string;
  suggestedType?: string;
  suggestedScope?: string;
  suggestedAction?: string;
  applicableWhen?: readonly string[];
  forbiddenWhen?: readonly string[];
  /**
   * 候选池里同文本、不同类型的其它条目的类型。跨候选判断，单条算不出来，
   * 必须由持有完整候选列表的读口（`recall.candidates.list`、inbox adapter、
   * tree）算好传进来——`promoteRecallCandidate` 也是这么算的。不传 = 不判冲突。
   */
  conflictingTypes?: readonly string[];
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
  /** 内容够不够格成为正式资产。与 status 正交。 */
  eligibility: RecallCandidateEligibility;
  /** eligibility==='ineligible' 时的阻断原因。UI 用 PromotionBlockReason 的既有
   *  文案表翻译，不另立一套 taxonomy。其余情况为空数组。 */
  ineligibleReasons: PromotionBlockReason[];
  /** 不阻断但应如实告知的欠缺（soft_warning 的来源）。 */
  eligibilityAdvisories: RecallCandidateClassificationReason[];
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
): BaseCapabilities {
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

/**
 * 静态状态表给的那一半能力。eligibility 三件套不在其中——它们由内容算出来
 * （`assessEligibility`），不属于"状态决定什么"这张表，最后在
 * `getRecallCandidateCapabilities` 里合并。
 */
type BaseCapabilities = Omit<
  RecallCandidateCapabilities,
  'canBatchSelect' | 'batchBlockedReason' | 'eligibility' | 'ineligibleReasons' | 'eligibilityAdvisories'
>;

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

/**
 * 跑一次**正式资产准入门槛**，得到 eligibility。
 *
 * 用的就是晋升时那一个函数（`formal-assets/promotion.ts`），`actor: 'user'`
 * 对齐"用户点确认"真实走的那条路——用 'system' 会把"缺边界的规则候选"判成
 * 不合格，而它用户确认确实能成功，那样 UI 会比真实可做的事更保守。
 *
 * **内容字段缺失时不收紧**：调用方可能只带状态与证据（老 DTO、外部构造的
 * 输入）。这时无法评估准入门槛，猜"不合格"会把一批正常候选误锁成只读，
 * 比漏判更糟。与 `hasReviewableEvidence` 对缺字段的处理同一条纪律。
 */
function assessEligibility(candidate: RecallCandidateCapabilityInput): {
  eligibility: RecallCandidateEligibility;
  ineligibleReasons: PromotionBlockReason[];
  advisories: RecallCandidateClassificationReason[];
} {
  const judgment = typeof candidate.judgment === 'string' ? candidate.judgment.trim() : '';
  if (!judgment || !candidate.suggestedType) {
    return { eligibility: 'eligible', ineligibleReasons: [], advisories: [] };
  }
  const validation = validatePromotionByAssetType({
    judgment,
    ...(candidate.value !== undefined ? { value: candidate.value } : {}),
    ...(candidate.summary !== undefined ? { summary: candidate.summary } : {}),
    suggestedType: candidate.suggestedType as AbilityAssetType,
    suggestedScope: candidate.suggestedScope || '',
    ...(candidate.suggestedAction
      ? { suggestedAction: candidate.suggestedAction as RecallCandidateAction }
      : {}),
    ...(candidate.applicableWhen ? { applicableWhen: candidate.applicableWhen } : {}),
    ...(candidate.forbiddenWhen ? { forbiddenWhen: candidate.forbiddenWhen } : {}),
    ...(candidate.conflictingTypes?.length ? { conflictingTypes: candidate.conflictingTypes } : {}),
  }, { actor: 'user' });
  if (!validation.ok) {
    return {
      eligibility: 'ineligible',
      ineligibleReasons: validation.reasons,
      advisories: validation.advisories,
    };
  }
  return {
    eligibility: validation.advisories.length ? 'soft_warning' : 'eligible',
    ineligibleReasons: [],
    advisories: validation.advisories,
  };
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
  // 准入门槛：内容不够格时**必须**关掉确认与晋升。留着它就是假审批——
  // 用户点确认，promoteRecallCandidate 里的同一个 validatePromotionByAssetType
  // 会再拒一次，一次认真的审批白做。
  //
  // 编辑、拒绝、稍后一律保留：方案 B 要求不合格候选仍然可见，且用户有
  // "改到合格"与"直接否掉"两条出路。改完后 eligibility 会重新算（这一层是
  // 纯投影，不落盘），够格了确认按钮自己会回来。
  const eligibility = assessEligibility(candidate);
  if (eligibility.eligibility === 'ineligible' && !base.isTerminal) {
    base = {
      ...base,
      canConfirm: false,
      canPromote: false,
      needsUserAction: base.canEdit || base.canReject || base.canDefer || base.canRetry,
    };
  }
  const batchBlocked = base.canPromote && blocksBatch(candidate.risk);
  return {
    ...base,
    eligibility: eligibility.eligibility,
    ineligibleReasons: eligibility.ineligibleReasons,
    eligibilityAdvisories: eligibility.advisories,
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
  // 状态都认不出，不去断言它的内容够不够格——只读态下 eligibility 没有后果。
  eligibility: 'eligible',
  ineligibleReasons: [],
  eligibilityAdvisories: [],
};

/**
 * IPC DTO 投影：给出去的候选带上能力，落盘记录本身不带（避免被写回存储）。
 * 状态认不出时降级成只读而不是抛错——一条坏记录不该让整个读口 500。
 */
export function withRecallCandidateCapabilities<T extends { status: string }>(
  candidate: T,
  /** 同文本不同类型的其它候选类型。列表读口应当传（它手里有全量候选）；
   *  单条读口拿不到全量，不传即不判冲突——冲突仍由晋升闸门兜底。 */
  conflictingTypes?: readonly string[],
): T & { capabilities: RecallCandidateCapabilities } {
  const input = conflictingTypes?.length ? { ...candidate, conflictingTypes } : candidate;
  return {
    ...candidate,
    capabilities: tryGetRecallCandidateCapabilities(input) ?? UNKNOWN_CAPABILITIES,
  };
}

/** 终态候选被写操作命中时的稳定错误码。UI 靠 code 翻译，不靠 message 文本。 */
export const RECALL_CANDIDATE_TERMINAL_ERROR_CODE = 'recall_candidate_terminal';
/** 批量晋升里"这条不允许晋升"的稳定错误码。 */
export const RECALL_CANDIDATE_NOT_PROMOTABLE_ERROR_CODE = 'recall_candidate_not_promotable';

/**
 * 候选写路径上其余失败的稳定错误码。
 *
 * 与上面两个同一套判据：**UI 靠 code 翻译，不靠 message 文本**。message 是内部
 * 契约语言（"candidate evidence is insufficient for review"），过去被渲染层原样
 * 弹给用户；一旦有人改措辞，UI 文案还会跟着散掉。
 */
export type RecallCandidateErrorCode =
  | 'recall_candidate_not_found'
  | 'recall_candidate_duplicate'
  | 'recall_candidate_handoff_incomplete'
  | 'recall_candidate_evidence_insufficient'
  | 'recall_candidate_risk_gate'
  | 'recall_candidate_non_asset_decision'
  | 'recall_candidate_security_blocked'
  /** 编辑时新加的证据引用在来源目录里查不到——不接受用户自造的 id。 */
  | 'recall_candidate_unknown_source'
  | 'recall_capture_not_review_ready'
  | 'recall_capture_writing';

/** 打码的候选错误。message 保持原样（日志/契约仍读它），code 供 UI 翻译。 */
export function recallCandidateError(
  code: RecallCandidateErrorCode,
  message: string,
): Error & { code: RecallCandidateErrorCode } {
  const error = new Error(message) as Error & { code: RecallCandidateErrorCode };
  error.code = code;
  return error;
}

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
