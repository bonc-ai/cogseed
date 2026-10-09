/**
 * 四类正式能力资产的规范形状（PRD 3.1 / 3.5）。
 *
 * 这一层存在的理由：正式资产此前有两套并行形状（`RecallAbilityAssetRecord`
 * 与 `CognitionAssetSummary`），22 个模块各自直读底层记录、各自决定过滤什么，
 * 于是「个人本体分组」这类支撑对象能被合成成资产混进列表，渲染层只好靠
 * `source === 'recall_ability_asset'` 自己辨真假。
 *
 * 约定：
 *   - envelope 只放四类共用的字段，直接对应 PRD 3.5「共通元数据」；
 *   - 类型差异放进 `payload`，按 `assetType` 判别（当前是最小占位，
 *     Rule 的条件三元组 / Template 的结构 / Skill 的 Manifest 引用后续填）；
 *   - `statement` 保留为所有类型的人类可读摘要，不再承担结构表达职责。
 *
 * 三条状态轴必须保持正交（PRD 3.6）：
 *   lifecycleStatus = 这条资产是谁写进来的；
 *   maturity        = 被验证到哪一步；
 *   status          = 现在还允不允许用。
 */

import type {
  AbilityAssetType,
  RecallAbilityAssetLifecycleStatus,
  RecallAbilityAssetRecord,
} from '../candidate-service';

export type FormalAssetType = AbilityAssetType;

/** PRD 3.6 的成熟度阶梯。内部仍沿用 seed/bud（存量数据未迁移），
 *  用户侧口径的翻译在展示层，策略判断一律走 policy 层。 */
export type FormalAssetMaturity = RecallAbilityAssetRecord['maturity'];

export type FormalAssetStatus = RecallAbilityAssetRecord['status'];

/** 四类正式资产共用的信封，字段对应 PRD 3.5。 */
export interface FormalAssetEnvelope {
  assetId: string;
  assetType: FormalAssetType;
  owner: string;
  version: string;
  /** 来源标签（谁写进来的），不是验证阶段。 */
  lifecycleStatus: RecallAbilityAssetLifecycleStatus;
  /** 验证阶段。 */
  maturity: FormalAssetMaturity;
  /** 当前治理状态。 */
  status: FormalAssetStatus;
  title: string;
  /** 人类可读摘要；结构化内容在 payload。 */
  statement: string;
  scope: string;
  /** 适用条件。缺失 = 没记录过，**不是**「无限制」。 */
  applicableWhen?: string[];
  /** 禁止范围。缺失 = 没记录过。 */
  forbiddenWhen?: string[];
  /** 敏感级别与外发限制。缺失 = 没分过级，不等于 L0。 */
  sensitivity?: RecallAbilityAssetRecord['sensitivity'];
  /** 形成候选时的来源空间，仅用于追溯，不改变 Owner（PRD 3.4）。 */
  sourceWorkspaceRef?: string;
  evidenceRefs: RecallAbilityAssetRecord['evidenceRefs'];
  createdAt: string;
  updatedAt: string;
}

/** 分类型 payload。当前是最小占位：四类先共用 statement，
 *  各自的结构化字段按 PR-C/后续阶段逐类填充，形状先钉在这里。 */
export type FormalAssetPayload =
  | { kind: 'personal' }
  | { kind: 'rule' }
  | { kind: 'template' }
  | { kind: 'skill_method'; generatedSkillId?: string };

export interface FormalAbilityAsset extends FormalAssetEnvelope {
  payload: FormalAssetPayload;
  /** 底层记录。过渡期保留，供尚未改造的调用方读取原字段；
   *  新代码不要依赖它，需要什么就往 envelope 上加。 */
  record: RecallAbilityAssetRecord;
}

export interface ListFormalAssetsFilter {
  assetType?: FormalAssetType;
  /** 只要当前仍可用的（active）。缺省返回全部治理状态。 */
  activeOnly?: boolean;
  spaceId?: string;
}

/** 四类之外的一切都不是正式资产（PRD 3.3）。这个集合是 canonical 边界的
 *  唯一判据——Personal Ontology 分组、Memory、Evidence、Receipt、
 *  RelationshipAssertion、Workspace state、原始文件都进不来。 */
export const FORMAL_ASSET_TYPES: ReadonlySet<FormalAssetType> = new Set<FormalAssetType>([
  'personal', 'rule', 'template', 'skill_method',
]);

export function isFormalAssetType(value: unknown): value is FormalAssetType {
  return typeof value === 'string' && FORMAL_ASSET_TYPES.has(value as FormalAssetType);
}
