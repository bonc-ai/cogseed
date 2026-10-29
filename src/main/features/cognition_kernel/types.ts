/**
 * cognition_kernel/types — 认知内核契约层。
 *
 * 把「本体 ↔ 认知资产」从"两套账"固化成三个可实现的契约：
 *   ① 内容形态 → 唯一归属        （ContentHome；判定见 routing.ts）
 *   ② 任务读取 → 统一读接口      （PersonalFieldResolution；实现见 resolve.ts）
 *   ③ 任何改动 → 变更集 Delta    （CognitionDelta；校验见 delta.ts）
 *
 * 本模块只定义形状：不写用户数据、不改动任何既有存储。po/ 与 recall/ 是它的
 * 数据来源（适配层见 resolve.ts 的 loadPersonalSourceSnapshot）。
 */

/** 一个内容只有一个归属；保留历史分类供旧记录读取。 */
export type ContentHome =
  /** 新认知统一归属，保留历史归属用于兼容读取。 */
  | 'cognition'
  /** 关于我的短句事实 → 个人本体字段值 */
  | 'personal_fact'
  /** 带适用/禁止边界的判断与约束 → rule 资产 */
  | 'rule'
  /** 可复用结构 / 检查表 / 范例 → template 资产 */
  | 'template'
  /** 有目标与步骤的可执行方法 → skill_method 资产 */
  | 'method'
  /** 项目 / 任务 / 当前协作事实 → 局部支撑，不进个人档案 */
  | 'task_local'
  /** 只对某一次任务成立的情境与教训 → 经验条目 */
  | 'experience';

/** 落哪个候选池（写入路由的出口；两池互斥）。 */
export type CandidatePool = 'ontology' | 'recall' | 'experience' | 'task_local';

// ── 统一读接口（resolve）────────────────────────────────────────────────────

/** 任务侧声明的所需字段。groupId 可选，用于同名字段消歧。 */
export interface PersonalFieldRef {
  fieldName: string;
  groupId?: string;
  /** 缺省视为必需；非必需字段缺失时不进 missing（只记录）。 */
  required?: boolean;
}

/** 一条字段值的来源类型。 */
export type PersonalFieldSource = 'ontology_value' | 'personal_asset';

/** 解析成功的一条字段。 */
export interface ResolvedPersonalField {
  fieldName: string;
  groupId?: string;
  value: string;
  source: PersonalFieldSource;
  /** PoValue.id 或 asset.id，用于回溯字段值的权威来源。 */
  sourceId: string;
  /** 资产来源时的版本号；本体手编值没有版本。 */
  version?: string;
  revision?: string;
  /** 信息截至年月 YYYY-MM（本体值的 @asof）。 */
  asOf?: string;
  /** 核实档：true=有来源支持；'independent'=独立核实过。 */
  verified?: boolean | 'independent';
  updatedAt: string;
  /** 同一字段存在多条互不相同的可用值（矛盾未仲裁）。 */
  disputed?: true;
  /** 与主值冲突的其他取值（≤2 条，各自截断）。 */
  conflictsWith?: string[];
}

/** 取不到值的原因（每一种都对应一个不同的用户动作）。 */
export type MissingReason =
  /** 档案里根本没有这个字段值 → 应当提问并回填 */
  | 'no_value'
  /** 有值但标了"仅自己可见" → 不进任务读取 */
  | 'restricted'
  /** 来源资产被暂停/越权/不在适用范围 → 先治理再谈取用 */
  | 'not_authorized'
  /** 本体值指向的来源资产已不存在（悬空投影）→ 需要修复引用 */
  | 'stale';

export interface MissingPersonalField {
  fieldName: string;
  groupId?: string;
  required: boolean;
  reason: MissingReason;
}

/** 统一读接口的输出：已绑定字段与仍缺失字段分开返回。 */
export interface PersonalFieldResolution {
  bound: ResolvedPersonalField[];
  missing: MissingPersonalField[];
  policyVersion: string;
}

export interface ResolvePersonalFieldsRequest {
  fields: readonly PersonalFieldRef[];
  /** 与角色画像/资产准入同源的任务上下文（taskText / workspaceId / agentId …）。 */
  context?: RecallAgentReadContextLike;
}

/** 与 recall/prompt-injection 的 RecallAgentReadContext 同形的窄类型，避免静态依赖。 */
export interface RecallAgentReadContextLike {
  agentId?: string;
  roleId?: string;
  projectId?: string;
  workspaceId?: string;
  conversationKind?: string;
  fileKinds?: string[];
  purpose?: string;
  taskText?: string;
}

// ── 读接口的数据快照（纯函数输入；适配层负责装配）──────────────────────────

/** 一条本体字段值的只读视图。 */
export interface OntologyFieldValueView {
  id: string;
  groupId: string;
  fieldId: string;
  fieldName: string;
  text: string;
  source: string;
  updatedAt: string;
  asOf?: string;
  verified?: boolean | 'independent';
  restricted?: boolean;
  /** 来源资产 id（引用态）：带此标记的值由该资产维护，读时取 live 正文。 */
  assetId?: string;
}

/** 一条 personal 资产的只读视图。 */
export interface PersonalAssetView {
  id: string;
  title: string;
  statement: string;
  version: string;
  revision?: string;
  status: string;
  updatedAt: string;
  /** 显式声明的本体落点（T-Box 指针）。 */
  ontologyRefs: ReadonlyArray<{ groupId: string; field?: string }>;
  /** 是否通过任务期准入闸（暂停/敏感级/范围不符 → false）。 */
  eligible: boolean;
}

export interface PersonalSourceSnapshot {
  values: readonly OntologyFieldValueView[];
  assets: readonly PersonalAssetView[];
}

/** 契约版本：读接口语义变化时递增（写进回执，便于回溯"当时按哪版取的"）。 */
export const PERSONAL_FIELD_POLICY_VERSION = 'kernel-1';

// ── 收件箱（合并两个候选池）────────────────────────────────────────────────

/** 收件箱条目的来源池：本体候选 / 资产候选。 */
export type InboxHome = 'ontology' | 'recall';

/** 收件箱条目的内容形态（与归属表同构，另加 unknown 兜底）。 */
export type InboxItemKind = ContentHome | 'unknown';

// ── 变更集（Delta）─────────────────────────────────────────────────────────

/** 支持的字段级变更操作。 */
export type DeltaOp = 'add' | 'update' | 'remove' | 'set';

/** 改动从哪来：决定它要不要人工确认，以及归因到哪条规则。 */
export type DeltaOrigin = 'gap' | 'kstar' | 'correction' | 'user' | 'import' | 'projection';

export type DeltaStatus = 'proposed' | 'applied' | 'rejected' | 'rolled_back';

export interface DeltaTarget {
  home: ContentHome;
  /** 被改对象的稳定 id（本体值 id / 资产 id / 组 id）。 */
  objectId?: string;
  groupId?: string;
  fieldName?: string;
}

export interface DeltaEvidenceRef {
  kind: 'session' | 'message' | 'asset' | 'task_run' | 'meeting' | 'file' | 'user_input' | 'candidate';
  id: string;
  title?: string;
}

export interface CognitionDelta {
  deltaId: string;
  op: DeltaOp;
  target: DeltaTarget;
  before?: string | null;
  after?: string | null;
  origin: DeltaOrigin;
  evidenceRefs: readonly DeltaEvidenceRef[];
  /** 同一"槽位"重复提议恒同键 → 池内只留最新一条（对照 asset-backflow-<id>）。 */
  idempotencyKey: string;
  status: DeltaStatus;
  /** 落地后的内容版本号（本体值/资产的版本链；未落地时缺省）。 */
  version?: number;
  /** 回滚：指向被回滚的 deltaId（回滚产生新记录，不改历史）。 */
  rollbackOf?: string;
  createdAt: string;
}
