/**
 * 「待我处理」的唯一读模型。
 *
 * 回答一个问题：**现在有什么事情真的需要用户决定。**
 *
 * 为什么要有这一层：这些信号本来就存在，但都散在产生它们的那一刻——
 * `assessRecallCandidateClassification` 的阻断原因只写进日志，
 * `validatePromotionByAssetType` 的原因只在晋升那一次返回，
 * `evaluateAssetRuntimeEligibility` 的原因只在注入那一次返回。事后没有任何
 * 地方能回答"我现在有哪些事要处理"。渲染层如果各查各的，就会又长出一套
 * "什么算待办"的判断，跟 gate 的判断慢慢分叉。
 *
 * 所以这里把判断收在一处，且复用同一批 gate 函数，不另立标准。
 *
 * 打扰分级按产品口径：普通候选低打扰进列表；冲突、作用范围变更、来源失效、
 * Skill 建议才需要主动确认。分级只影响呈现，不影响是否入列。
 */

import { tryGetRecallCandidateCapabilities } from '../candidate-capabilities';
import { validatePromotionByAssetType } from './promotion';
import type { FormalAbilityAsset, FormalAssetType } from './types';
import type { AssetVersionDiff } from './version-diff';

export type CognitionInboxKind =
  /** 已确认拥有的方法，还没落成可执行 Skill。 */
  | 'skill_creation_suggested'
  /** 方法在生成 Skill 之后又改过内容：已装的 Skill 落后于资产。 */
  | 'skill_upgrade_suggested'
  /** 系统线改了规则的作用范围：它从此会进出一批不同的任务。 */
  | 'rule_scope_changed'
  /** 系统线改了模板正文。 */
  | 'template_updated'
  /** 规则没有作用边界：无边界的规则不该被默认带入任何任务。 */
  | 'rule_boundary_missing'
  /** 同一条判断被归到了两个不同的资产类型，必须由用户裁定。 */
  | 'classification_conflict'
  /** 证据不足，需要补证。 */
  | 'evidence_insufficient'
  /**
   * 内容不够格成为该类型的正式资产（`validatePromotionByAssetType` 阻断）。
   * 与 `candidate_pending_review` **必须**分开：后者的承诺是"点确认就能落库"，
   * 而这一类点了确认会被晋升闸门拒——那是假审批。列出来是为了让用户能改，
   * 具体原因在 detail 里（PromotionBlockReason 的码，UI 负责翻译）。
   */
  | 'candidate_ineligible'
  /** 来源失效，已经影响到具体的既有资产。 */
  | 'source_unavailable'
  // 2026-09-29 第 2 批·一物一链：`candidate_pending_review` 停产——同一 pending
  // 候选此前既出候选卡（promote 完整三选一）又出治理行（accept 直调 promote
  // 不带选项，撞闸门直接报错），两套按钮两条链（B1/B2）。治理清单不再镜像
  // 候选池；待确认候选唯一确认入口=候选卡/详情。
  /**
   * AI 自主提出的实质变化（specs/008 US-406）：待处理或用户选了「稍后处理」。
   * 与候选分开：候选是"还没成为资产的东西"，这条是"资产已经在、改动等拍板"。
   */
  | 'asset_change_pending'
  /**
   * 大扫除里拿不准的项（specs/008 US-403）：疑似重复但正文不同之类。
   * 当初就是因为"要判断含义"才没动手，所以这里只等用户给个处置意见。
   */
  | 'cleanup_uncertain'
  /**
   * 后台巡检的发现（specs/008 US-405）：重复 / 过时 / 冲突。
   * **只是建议**——巡检不改任何资产，用户自己去处理或标"不管它"。
   * 呈现分组待 specs/010 落地，这里只带发现类别。
   */
  | 'inspection_finding';

/**
 * `confirm` = 需要用户明确点头才继续；`low_disturbance` = 列出来即可，
 * 不弹窗、不打断。
 */
export type CognitionInboxUrgency = 'confirm' | 'low_disturbance';

/**
 * 这条待办**能做什么**（不是"该怎么显示"）。
 *
 * 由读模型给出而不是让渲染层各判一次：处置的分发在
 * `cognition/inbox-adapter.ts::resolveCognitionInboxItem`，两处各写一份
 * "哪些动作可用"就是下一个分叉源——渲染层只负责把动作渲染成按钮。
 * 空数组 = 没有一键动作（资产类待办要用户去资产详情里改）。
 *
 * specs/010 新增的动作：`claim`（候选分类冲突选边保留本边）、`set_boundary`
 * （规则就地补边界条件）、`keep` / `merge`（巡检冲突/重复的选边归档与合并）。
 */
export type CognitionInboxAction =
  | 'accept'
  | 'reject'
  | 'defer'
  | 'ignore'
  | 'claim'
  | 'set_boundary'
  | 'keep'
  | 'merge';

export interface CognitionInboxItem {
  /** 稳定 id：同一件事重复计算要得到同一个 id，否则前端列表会闪。 */
  id: string;
  kind: CognitionInboxKind;
  urgency: CognitionInboxUrgency;
  title: string;
  assetType?: FormalAssetType;
  assetId?: string;
  candidateId?: string;
  /** 补充说明，已是用户能读懂的话，渲染层不再翻译。 */
  detail?: string;
  /** 可用动作；缺省/空数组 = 没有一键动作，只给"去资产详情"的落点。 */
  actions?: readonly CognitionInboxAction[];
  /**
   * 本条待办涉及的**全部**资产 id（specs/010 T006）。巡检的冲突/重复发现
   * 涉及一对资产——只带 `assetIds[0]` 会让"合并/选边"拿不到另一方。
   */
  assetIds?: readonly string[];
  /** 巡检发现的类别（仅 `inspection_finding` 带；分组映射的唯一输入）。 */
  findingCategory?: 'duplicate' | 'outdated' | 'conflict';
  /** 缺边界规则**当前**的条件（仅 `rule_boundary_missing` 带，供就地表单预填）。 */
  boundary?: { applicableWhen: readonly string[]; forbiddenWhen: readonly string[] };
}

/**
 * 待办读模型看到的候选投影。
 *
 * 内容字段（value / summary / suggestedScope / suggestedAction / 边界）不是
 * 展示用的，是**给能力判据算 eligibility 用的**——`getRecallCandidateCapabilities`
 * 会拿它们跑一次正式资产准入门槛。少给字段不会报错，只会让这条候选被当成
 * "无法评估、不收紧"，于是不合格候选又混进 `candidate_pending_review`。
 * adapter 必须把整条记录喂进来。
 */
export interface CognitionInboxCandidate {
  id: string;
  status: string;
  judgment?: string;
  value?: string;
  summary?: string;
  suggestedType?: string;
  suggestedScope?: string;
  suggestedAction?: string;
  applicableWhen?: readonly string[];
  forbiddenWhen?: readonly string[];
  sourceRefs?: readonly unknown[];
  evidenceRefs?: readonly unknown[];
  /** 同文本不同类型的其它候选类型。由 adapter 用
   *  `recallCandidateConflictingTypes` 算好传入，单条算不出来。 */
  conflictingTypes?: readonly string[];
}

export interface CognitionInboxInput {
  assets: readonly FormalAbilityAsset[];
  candidates: readonly CognitionInboxCandidate[];
  /** 当前不可用（失效/暂停/撤权）的来源 id。 */
  unavailableSourceIds: ReadonlySet<string>;
  /**
   * assetId → 该资产最近一次真正改了内容的版本变更。缺省 = 没有版本历史可读，
   * 变更类待办整体不产出（而不是当成"没变过"去猜）。
   */
  latestDiffs?: ReadonlyMap<string, AssetVersionDiff>;
  /** Skill 安装状态读取失败的资产。未知状态不能当成未生成。 */
  skillStateUnknownAssetIds?: ReadonlySet<string>;
  /** 已安装 Skill 已经追上当前资产版本的资产，不应再次产生升级待办。 */
  skillUpgradeCurrentAssetIds?: ReadonlySet<string>;
  /** 用户已明确拒绝当前资产版本的升级，不应重复打扰。 */
  skillUpgradeRejectedAssetIds?: ReadonlySet<string>;
  /** AI 提议的实质变化里还没拍板的那些（pending / deferred）。 */
  pendingAssetChanges?: ReadonlyArray<{ proposalId: string; assetId: string; title?: string; reason?: string }>;
  /** 大扫除里还没处置的拿不准项。 */
  pendingCleanupItems?: ReadonlyArray<{ reportId: string; assetId: string; title?: string; question: string }>;
  /** 后台巡检的发现（最新一轮、未被"不管它"的）。 */
  pendingInspectionFindings?: ReadonlyArray<{
    key: string;
    category: string;
    assetIds: readonly string[];
    title?: string;
    detail?: string;
    deferred?: boolean;
  }>;
}

/**
 * 每类待办可用的动作（**唯一处**）。与 `inbox-adapter` 的分发分支一一对应：
 *   - 候选类走既有 4 个处置函数（confirm/reject/defer/ignore）；
 *   - 审批提议走三态（确认更新 / 稍后处理 / 拒绝）；
 *   - 大扫除拿不准项与巡检发现只有"要不要继续提醒"（不管它 / 回头再看）；
 *   - 巡检的冲突/重复发现另有选边与合并（specs/010 US-302，见 `itemActions`）；
 *   - 缺边界可就地补条件（US-304）——资产编辑动作拥有待办内的一键入口。
 */
const INBOX_ACTIONS: Record<CognitionInboxKind, readonly CognitionInboxAction[]> = {
  skill_creation_suggested: [],
  skill_upgrade_suggested: [],
  rule_scope_changed: [],
  template_updated: [],
  rule_boundary_missing: ['set_boundary'],
  classification_conflict: ['claim', 'reject', 'defer'],
  evidence_insufficient: ['reject', 'defer'],
  candidate_ineligible: ['reject', 'defer'],
  source_unavailable: [],
  asset_change_pending: ['accept', 'defer', 'reject'],
  cleanup_uncertain: ['reject', 'defer'],
  inspection_finding: ['reject', 'defer'],
};

/**
 * 巡检发现的"过时"没有合并/选边语义（两条不是同一件事，只是旧了），维持
 * 只读建议；冲突与重复才有「保留这一条，归档另一条 / 合并到这一条」。
 * 动作判定仍收口在本文件——渲染层不自行判断。
 */
const INSPECTION_PAIR_ACTIONS: readonly CognitionInboxAction[] = ['keep', 'merge', 'reject', 'defer'];

const URGENCY: Record<CognitionInboxKind, CognitionInboxUrgency> = {
  skill_creation_suggested: 'confirm',
  skill_upgrade_suggested: 'confirm',
  rule_scope_changed: 'confirm',
  template_updated: 'low_disturbance',
  rule_boundary_missing: 'low_disturbance',
  classification_conflict: 'confirm',
  evidence_insufficient: 'low_disturbance',
  // 列出来就够，不打断：用户可以改到合格，也可以直接否掉，都不紧急。
  candidate_ineligible: 'low_disturbance',
  source_unavailable: 'confirm',
  asset_change_pending: 'confirm',
  cleanup_uncertain: 'low_disturbance',
  inspection_finding: 'low_disturbance',
};

/** 排序权重：先要人点头的，再低打扰的；同级按 kind 稳定排序。 */
const KIND_ORDER: CognitionInboxKind[] = [
  'classification_conflict',
  'rule_scope_changed',
  'source_unavailable',
  'skill_upgrade_suggested',
  'skill_creation_suggested',
  'rule_boundary_missing',
  'template_updated',
  'evidence_insufficient',
  'asset_change_pending',
  'cleanup_uncertain',
  'inspection_finding',
];

/** 与 candidate-service 的同名比较保持一致：只做空白归一，不做语义归一。 */
function comparableJudgment(text: string | undefined): string {
  return String(text || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function item(
  kind: CognitionInboxKind,
  id: string,
  title: string,
  extra: Omit<CognitionInboxItem, 'id' | 'kind' | 'urgency' | 'title'> = {},
): CognitionInboxItem {
  return { id, kind, urgency: URGENCY[kind], title, actions: INBOX_ACTIONS[kind], ...extra };
}

/**
 * 纯函数：给定当前事实，算出需要用户决定的事项。
 *
 * 不读盘、不发 IPC，方便直接用真实数据回放验证——这批规则一旦跑偏，用户会
 * 在待办里看到一堆假警报，比不显示更糟。
 */
export function buildCognitionInbox(input: CognitionInboxInput): CognitionInboxItem[] {
  const items: CognitionInboxItem[] = [];
  const activeAssets = input.assets.filter((asset) => asset.status === 'active');

  for (const asset of activeAssets) {
    if (asset.assetType === 'skill_method' && asset.payload.kind === 'skill_method'
      && !asset.payload.generatedSkillId
      && !input.skillStateUnknownAssetIds?.has(asset.assetId)) {
      items.push(item('skill_creation_suggested', `skill:${asset.assetId}`, asset.title, {
        assetType: asset.assetType,
        assetId: asset.assetId,
      }));
    }

    // ── 变更类待办 ────────────────────────────────────────────────────
    //
    // 判断依据是最近一次版本变更，且**只报系统线改的**。用户自己刚改过的边界
    // 不需要再回来问他一遍——他就是那个改的人。反过来，自动抽取线和 KStar
    // 沉淀线改的内容，用户从来没看见过，那才是需要知情的。
    //
    // 这条规则顺带解决了"永不消失的待办"：没有已读状态可存，但用户一旦自己
    // 编辑或确认过这条资产（产生一次 user 版本），它就自动从待办里退场。
    const diff = input.latestDiffs?.get(asset.assetId);
    const systemChanged = diff !== undefined && diff.actor !== 'user';

    if (diff && systemChanged) {
      if (asset.assetType === 'rule'
        && (diff.kinds.includes('boundary') || diff.kinds.includes('scope'))) {
        const boundary = diff.changes.find((change) => change.kind === 'boundary' || change.kind === 'scope');
        items.push(item('rule_scope_changed', `rule-scope:${asset.assetId}`, asset.title, {
          assetType: asset.assetType,
          assetId: asset.assetId,
          ...(boundary ? { detail: `${boundary.before} → ${boundary.after}` } : {}),
        }));
      }
      if (asset.assetType === 'template' && diff.kinds.includes('statement')) {
        items.push(item('template_updated', `template:${asset.assetId}`, asset.title, {
          assetType: asset.assetType,
          assetId: asset.assetId,
          ...(diff.reason ? { detail: diff.reason } : {}),
        }));
      }
    }

    // Skill 升版：方法在生成 Skill 之后又改了内容，已装的 Skill 就落后了。
    // 这一条不看 actor——就算是用户自己改的方法，那个已经装好的 Skill 也不会
    // 跟着自己变，仍然需要他决定要不要重新生成。
    if (asset.assetType === 'skill_method' && asset.payload.kind === 'skill_method'
      && asset.payload.generatedSkillId && diff
      && !input.skillUpgradeCurrentAssetIds?.has(asset.assetId)
      && !input.skillUpgradeRejectedAssetIds?.has(asset.assetId)
      && (diff.kinds.includes('statement') || diff.kinds.includes('boundary'))) {
      items.push(item('skill_upgrade_suggested', `skill-upgrade:${asset.assetId}`, asset.title, {
        assetType: asset.assetType,
        assetId: asset.assetId,
        detail: `${diff.fromVersion} → ${diff.toVersion}`,
      }));
    }

    // 规则边界：复用晋升 gate 的判断，不在这里重写一套"什么叫有边界"。
    // 以 system actor 校验——用户已经确认过这条资产，但确认的是内容，
    // 不代表边界被补齐；system 档正是"没有人为它兜底"的那一档。
    if (asset.assetType === 'rule') {
      const validation = validatePromotionByAssetType({
        judgment: asset.statement,
        suggestedType: 'rule',
        suggestedScope: asset.scope,
        ...(asset.applicableWhen ? { applicableWhen: asset.applicableWhen } : {}),
        ...(asset.forbiddenWhen ? { forbiddenWhen: asset.forbiddenWhen } : {}),
      }, { actor: 'system' });
      if (validation.reasons.includes('rule_boundary_required')) {
        items.push(item('rule_boundary_missing', `rule-boundary:${asset.assetId}`, asset.title, {
          assetType: asset.assetType,
          assetId: asset.assetId,
          // 当前条件随行（specs/010 T006）：用户点开就地表单时要看到现状，
          // 而不是一张空表单——空表单会让人以为条件从来没填过。
          boundary: {
            applicableWhen: asset.applicableWhen || [],
            forbiddenWhen: asset.forbiddenWhen || [],
          },
        }));
      }
    }

    // 来源失效：只在**确实影响到这条资产**时才报。全局"有 N 个来源需要处理"
    // 说不清后果，用户无从判断要不要管。
    if (input.unavailableSourceIds.size) {
      const broken = asset.evidenceRefs.filter((ref) => input.unavailableSourceIds.has(ref.id));
      if (broken.length) {
        items.push(item('source_unavailable', `source:${asset.assetId}`, asset.title, {
          assetType: asset.assetType,
          assetId: asset.assetId,
          detail: broken.map((ref) => ref.title || ref.id).join('、'),
        }));
      }
    }
  }

  // 同一条判断被归成两个类型：晋升 gate 会拦，但用户得先知道有这回事，
  // 否则两条候选会一直停在待确认里，谁也不知道为什么推不动。
  const byJudgment = new Map<string, Set<string>>();
  // 待办口径 = capability 的 needsUserAction，不是 pending_review 单点。实机
  // 候选多数是 weak_observation，只认 pending_review 会让「待我处理」显示 0，
  // 而候选实际是可确认的。认不出的状态（旧数据）按不计待办处理。
  const pending = input.candidates.filter(
    (candidate) => tryGetRecallCandidateCapabilities(candidate)?.needsUserAction === true,
  );
  for (const candidate of pending) {
    const key = comparableJudgment(candidate.judgment);
    if (!key || !candidate.suggestedType) continue;
    const types = byJudgment.get(key) || new Set<string>();
    types.add(candidate.suggestedType);
    byJudgment.set(key, types);
  }
  for (const candidate of pending) {
    const key = comparableJudgment(candidate.judgment);
    const conflicting = key ? byJudgment.get(key) : undefined;
    if (conflicting && conflicting.size > 1) {
      items.push(item('classification_conflict', `conflict:${candidate.id}`, candidate.judgment || candidate.id, {
        candidateId: candidate.id,
        detail: [...conflicting].sort().join(' / '),
      }));
      continue;
    }
    // 内容过不了正式资产准入门槛的，**不能**当普通待确认候选出。
    // `candidate_pending_review` 对用户的承诺是"点确认就能落库"；这一类点了
    // 确认会被 promoteRecallCandidate 里的同一道闸拒掉，一次认真的审批白做。
    // 判据不在这里重写，取 capability 算好的 eligibility。
    const capabilities = tryGetRecallCandidateCapabilities(candidate);
    if (capabilities?.eligibility === 'ineligible') {
      items.push(item('candidate_ineligible', `ineligible:${candidate.id}`, candidate.judgment || candidate.id, {
        candidateId: candidate.id,
        ...(capabilities.ineligibleReasons.length
          ? { detail: capabilities.ineligibleReasons.join(',') }
          : {}),
      }));
      continue;
    }
    // 2026-09-29 第 2 批：普通待确认候选不再进治理清单（candidate_pending_review
    // 停产，B2）——它的唯一确认入口是候选卡/详情（完整三选一），这里再给
    // 一套 accept 直调就是第二条确认链。
  }

  // 补证据不是"决定"，所以它不能跟决定类共用 `pending` 这层过滤。
  //
  // 这一条此前就写在上面的循环里，而 `pending` 已经按 `needsUserAction` 筛过；
  // 证据不足的候选恰恰是 `needsUserAction === false`（能力表在证据补齐前把
  // confirm/reject/defer 全关掉），于是这条分支在实机永远命不中——产品里那句
  // 「Evidence 不足，需要补证」一次都没出现过，这类候选在待办、候选池、树上
  // 同时隐身，用户既看不见也没法补。
  //
  // 按能力自己的判据出：`disabledReason` 就是"为什么不能确认"的稳定码，
  // 不在这里重写一遍"什么叫没有证据"。urgency 仍是 low_disturbance——列出来
  // 就够，不打断。
  for (const candidate of input.candidates) {
    if (tryGetRecallCandidateCapabilities(candidate)?.disabledReason !== 'candidate_evidence_insufficient') continue;
    items.push(item('evidence_insufficient', `evidence:${candidate.id}`, candidate.judgment || candidate.id, {
      candidateId: candidate.id,
    }));
  }

  // AI 提议的实质变化：还没拍板的都进清单（"稍后处理"不丢，就靠这条）。
  // 与候选不同，它不依赖任何能力判据——提议已经是既成事实，只等用户点一下。
  for (const change of input.pendingAssetChanges || []) {
    items.push(item('asset_change_pending', `proposal:${change.proposalId}`, change.title || change.assetId, {
      assetId: change.assetId,
      ...(change.reason ? { detail: change.reason } : {}),
    }));
  }

  // 大扫除拿不准项：低打扰列出（列出来就够，不打断），等用户给个处置意见。
  for (const pending of input.pendingCleanupItems || []) {
    items.push(item('cleanup_uncertain', `cleanup:${pending.reportId}:${pending.assetId}`, pending.title || pending.assetId, {
      assetId: pending.assetId,
      detail: pending.question,
    }));
  }

  // 后台巡检的发现：低打扰列出（列出来就够，不打断）。**只是建议**，
  // 处置动作是"要不要继续提醒"，不是"这条资产怎么办"——冲突/重复除外
  // （specs/010 US-302：那一类的处置恰恰是"这两条资产怎么办"）。
  for (const finding of input.pendingInspectionFindings || []) {
    const category = finding.category === 'duplicate' || finding.category === 'outdated' || finding.category === 'conflict'
      ? finding.category
      : undefined;
    const pair = category === 'conflict' || category === 'duplicate';
    const entry = item('inspection_finding', `inspection:${finding.key}`, finding.title || finding.assetIds.join(' / '), {
      ...(finding.assetIds[0] ? { assetId: finding.assetIds[0] } : {}),
      // 整对带上（T006）：合并与选边都需要"另一方"，只带 [0] 会把 id 丢掉。
      ...(finding.assetIds.length ? { assetIds: finding.assetIds } : {}),
      ...(category ? { findingCategory: category } : {}),
      ...(finding.detail ? { detail: finding.detail } : {}),
    });
    if (pair) entry.actions = INSPECTION_PAIR_ACTIONS;
    items.push(entry);
  }

  return items.sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind)
    || left.id.localeCompare(right.id));
}

/* ══════════════════════════ 治理分组（specs/010 US-301 / US-305） ══════════════════════════
 * 分组是**纯函数视图**：不落盘、不改 `buildCognitionInbox` 的输出语义，
 * 只把已排好序的扁平清单多对一地归到三个治理分区里。判定收口在这里——
 * 渲染层只遍历，不在页面里再写一份 kind→类别映射（反漂移守卫钉着）。 */

/** 治理分区：冲突 / 缺边界 / 其他（收纳位，不是新类别）。 */
export type CognitionInboxGovernanceCategory =
  | 'conflict'
  | 'boundary'
  | 'other';

export interface CognitionInboxGroup {
  category: CognitionInboxGovernanceCategory;
  /** 分区标题的 i18n 键（渲染层内联取词）。 */
  titleKey: string;
  /** 组内条目（已按入参顺序）。 */
  items: CognitionInboxItem[];
  /** 组内条目数。 */
  count: number;
  /** 组内涉及的资产/对象总数（巡检成对发现按对内资产数计）。 */
  total: number;
}

/** 分区顺序恒定：冲突置顶（SC-001 的机械判据），其余按治理优先级。 */
const GROUP_ORDER: readonly CognitionInboxGovernanceCategory[] = [
  'conflict', 'boundary', 'other',
];

const GROUP_TITLE_KEYS: Record<CognitionInboxGovernanceCategory, string> = {
  conflict: 'cognition.inbox_group_conflict',
  boundary: 'cognition.inbox_group_boundary',
  other: 'cognition.inbox_group_other',
};

/**
 * kind → 治理分区（唯一映射处）。
 * 巡检发现按 `findingCategory` 细分：conflict/duplicate 归「冲突」（它们的
 * 处置就是选边/合并）；outdated 归「其他」（没有合并语义，只是旧了）。
 */
function governanceCategory(entry: CognitionInboxItem): CognitionInboxGovernanceCategory {
  if (entry.kind === 'classification_conflict') return 'conflict';
  if (entry.kind === 'inspection_finding'
    && (entry.findingCategory === 'conflict' || entry.findingCategory === 'duplicate')) return 'conflict';
  if (entry.kind === 'rule_boundary_missing') return 'boundary';
  return 'other';
}

/**
 * 纯函数：把扁平待办清单归成治理分区（specs/010 T004/T005）。
 *
 * - 组序恒为 conflict → boundary → other，空组不出；
 * - `groups.flatMap(g => g.items)` 与入参集合相等。
 */
export function groupCognitionInbox(items: readonly CognitionInboxItem[]): CognitionInboxGroup[] {
  const buckets = new Map<CognitionInboxGovernanceCategory, CognitionInboxItem[]>(
    GROUP_ORDER.map((category) => [category, []]),
  );
  for (const entry of items) {
    buckets.get(governanceCategory(entry))!.push(entry);
  }

  return GROUP_ORDER
    .map((category) => {
      const groupItems = buckets.get(category)!;
      const total = groupItems.reduce(
        (sum, entry) => sum + (entry.assetIds && entry.assetIds.length > 1 ? entry.assetIds.length : 1),
        0,
      );
      return {
        category,
        titleKey: GROUP_TITLE_KEYS[category],
        items: groupItems,
        count: groupItems.length,
        total,
      };
    })
    .filter((group) => group.items.length > 0);
}
