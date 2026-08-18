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
 * 打扰分级按产品口径：普通候选低打扰进列表；冲突、扩权、敏感信息、Skill
 * 建议才需要主动确认。分级只影响呈现，不影响是否入列。
 */

import { allowsSilentDefaultInjection } from './policy';
import { validatePromotionByAssetType } from './promotion';
import { evaluateAssetRuntimeEligibility } from './runtime';
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
  /** 敏感级被升高：能去的地方变多了，属于扩权。 */
  | 'sensitivity_escalated'
  /** 规则没有作用边界：无边界的规则不该被默认带入任何任务。 */
  | 'rule_boundary_missing'
  /** 同一条判断被归到了两个不同的资产类型，必须由用户裁定。 */
  | 'classification_conflict'
  /** 证据不足，需要补证。 */
  | 'evidence_insufficient'
  /** 来源失效，已经影响到具体的既有资产。 */
  | 'source_unavailable'
  /** 没有分过敏感级。缺失不等于 L0，所以这是待办而不是默认放行。 */
  | 'sensitivity_unclassified'
  /** 普通待确认候选。 */
  | 'candidate_pending_review';

/**
 * `confirm` = 需要用户明确点头才继续；`low_disturbance` = 列出来即可，
 * 不弹窗、不打断。
 */
export type CognitionInboxUrgency = 'confirm' | 'low_disturbance';

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
}

export interface CognitionInboxCandidate {
  id: string;
  status: string;
  judgment?: string;
  suggestedType?: string;
  evidenceRefs?: readonly unknown[];
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
}

const URGENCY: Record<CognitionInboxKind, CognitionInboxUrgency> = {
  skill_creation_suggested: 'confirm',
  skill_upgrade_suggested: 'confirm',
  rule_scope_changed: 'confirm',
  template_updated: 'low_disturbance',
  sensitivity_escalated: 'confirm',
  rule_boundary_missing: 'low_disturbance',
  classification_conflict: 'confirm',
  evidence_insufficient: 'low_disturbance',
  source_unavailable: 'confirm',
  sensitivity_unclassified: 'confirm',
  candidate_pending_review: 'low_disturbance',
};

/** 排序权重：先要人点头的，再低打扰的；同级按 kind 稳定排序。 */
const KIND_ORDER: CognitionInboxKind[] = [
  'sensitivity_escalated',
  'classification_conflict',
  'rule_scope_changed',
  'sensitivity_unclassified',
  'source_unavailable',
  'skill_upgrade_suggested',
  'skill_creation_suggested',
  'rule_boundary_missing',
  'template_updated',
  'evidence_insufficient',
  'candidate_pending_review',
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
  return { id, kind, urgency: URGENCY[kind], title, ...extra };
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
      if (diff.kinds.includes('sensitivity_escalated')) {
        const escalation = diff.changes.find((change) => change.kind === 'sensitivity_escalated');
        items.push(item('sensitivity_escalated', `sensitivity-up:${asset.assetId}`, asset.title, {
          assetType: asset.assetType,
          assetId: asset.assetId,
          ...(escalation ? { detail: `${escalation.before} → ${escalation.after}` } : {}),
        }));
      }
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
        }));
      }
    }

    // 敏感级：**只对真的会被静默默认注入的资产报**。
    //
    // 未分级确实不等于 L0，但如果对每一条资产都报一次，待办会被几十条永远
    // 处理不完的"未分级"塞满，真正的冲突和扩权就被埋掉了——那比不报更糟。
    // 会自己走出去的只有 transfer_validated 及以上那一档（PRD 3.6 默认使用
    // 契约），所以这里先用 policy 判一次能不能静默注入，能才继续问 runtime
    // gate 要原因。判断标准与真正注入时同源。
    // sameScope=true：问的是「在它自己的作用域里会不会自动带出去」，
    // 而不是某一次具体注入。
    if (allowsSilentDefaultInjection(asset, true)) {
      const eligibility = evaluateAssetRuntimeEligibility({
        status: asset.status,
        maturity: asset.maturity,
        lifecycleStatus: asset.lifecycleStatus,
        scope: asset.scope,
        ...(asset.sensitivity !== undefined ? { sensitivity: asset.sensitivity } : {}),
      }, { maxSensitivity: 'L0' });
      if (eligibility.reasons.includes('sensitivity_unclassified')) {
        items.push(item('sensitivity_unclassified', `sensitivity:${asset.assetId}`, asset.title, {
          assetType: asset.assetType,
          assetId: asset.assetId,
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
  const pending = input.candidates.filter((candidate) => candidate.status === 'pending_review');
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
    if (!candidate.evidenceRefs?.length) {
      items.push(item('evidence_insufficient', `evidence:${candidate.id}`, candidate.judgment || candidate.id, {
        candidateId: candidate.id,
      }));
      continue;
    }
    items.push(item('candidate_pending_review', `candidate:${candidate.id}`, candidate.judgment || candidate.id, {
      candidateId: candidate.id,
    }));
  }

  return items.sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind)
    || left.id.localeCompare(right.id));
}
