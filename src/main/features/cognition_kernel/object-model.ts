/**
 * cognition_kernel/object-model — 统一认知库的对象模型。
 *
 * 四类内容里的三类在本库物理存储：
 *   assertion（关于我的断言）｜rule（规则）｜bundle（能力包：模板+方法）
 * experience 物理留 KSTAR 线、task_local 留项目作用域——两者只经 resolve()
 * 联合读，不进本库。
 *
 * 生命周期语义吸收自 recall 资产线（版本链/软删/并入去向），断言语义吸收自
 * po v2 的 PoValue（asOf/verified/restricted/groupId+fieldName 槽位）。
 */

import type { CandidatePool, ContentHome, DeltaEvidenceRef } from './types';
import { validateOntologyDocument, type OntologyDocument } from '../cognition/ontology/model';

export type CognitionObjectKind = 'assertion' | 'rule' | 'bundle';
export type BundleKind = 'template' | 'method';
export type CognitionObjectStatus = 'active' | 'paused' | 'archived' | 'deleted';

/** 家注册表条目：判据文案 + 落池 + 存储映射，全部是数据（可加自定义家，不改代码）。 */
export interface HomeRegistryEntry {
  /** 家 id（内置六家 = ContentHome 字面量；自定义家是合法 id 串）。 */
  home: string;
  label: string;
  definition: string;
  examples: string[];
  pool: CandidatePool;
  /** 存储映射；缺省 = 不进统一库（experience/task_local 语义，只判不存）。 */
  store?: { kind: CognitionObjectKind; bundleKind?: BundleKind };
  builtin?: true;
}

/** 内置归属：出厂默认的判据、落池位置与存储形态。 */
export const DEFAULT_HOME_REGISTRY: readonly HomeRegistryEntry[] = [
  {
    home: 'cognition', label: '认知',
    definition: '由可核对来源形成的独立认识或做法，保留条件和局限，暂不分类。',
    examples: ['部署决定应记录适用条件和证据，条件变化后重新核对。'], pool: 'recall', store: { kind: 'assertion' }, builtin: true,
  },
  {
    home: 'personal_fact',
    label: '关于我',
    definition: '关于用户本人的、跨任务长期成立的短句事实（身份、归属、联系方式、稳定偏好与边界）。',
    examples: ['我在开源项目组', '我的银行卡号是…', '我回复偏好用简短中文'],
    pool: 'ontology',
    store: { kind: 'assertion' },
    builtin: true,
  },
  {
    home: 'rule',
    label: '规则',
    definition: '带适用/禁止边界的判断、约束或做法；被违反时应当能指出"违反了哪一条"。',
    examples: ['对外报价不要承诺交期', '报销住宿按城市封顶'],
    pool: 'recall',
    store: { kind: 'rule' },
    builtin: true,
  },
  {
    home: 'template',
    label: '模板',
    definition: '可复用的结构、检查表、范例（填进去就能用的骨架）。',
    examples: ['周报按进展/风险/下周计划三段写'],
    pool: 'recall',
    store: { kind: 'bundle', bundleKind: 'template' },
    builtin: true,
  },
  {
    home: 'method',
    label: '方法',
    definition: '有目标、步骤与适用范围的可执行做法（"怎么做"的一套流程）。',
    examples: ['整理材料五步法：先分类→合并→标注→复核→输出清单'],
    pool: 'recall',
    store: { kind: 'bundle', bundleKind: 'method' },
    builtin: true,
  },
  {
    home: 'task_local',
    label: '任务/项目事实',
    definition: '只对当前项目、任务或协作关系成立的临时事实；会过期，不进长期档案。',
    examples: ['本周上线支付网关', '这个项目由张三对接'],
    pool: 'task_local',
    builtin: true,
  },
  {
    home: 'experience',
    label: '经验',
    definition: '某一次任务的情境、结果与教训（复盘所得，不是可复用规则本身）。',
    examples: ['上次那张发票被退回，因为抬头写成了简称'],
    pool: 'experience',
    builtin: true,
  },
];

export const BUILTIN_HOME_IDS: readonly string[] = DEFAULT_HOME_REGISTRY.map((entry) => entry.home);

export function findHomeEntry(homes: readonly HomeRegistryEntry[], home: string): HomeRegistryEntry | undefined {
  return homes.find((entry) => entry.home === home);
}

/** 家 → 存储映射（按注册表）；不在注册表或不可存 → null。 */
export function storeShapeForHomes(
  homes: readonly HomeRegistryEntry[],
  home: string,
): { kind: CognitionObjectKind; bundleKind?: BundleKind } | null {
  const entry = findHomeEntry(homes, home);
  return entry?.store ? { ...entry.store } : null;
}

export function validateHomeRegistry(homes: readonly HomeRegistryEntry[]): { ok: true } | { ok: false; reason: string } {
  const seen = new Set<string>();
  for (const entry of homes) {
    const id = String(entry.home ?? '').trim();
    if (!id || !/^[a-z][a-z0-9_]{1,40}$/.test(id)) return { ok: false, reason: `家 id 非法：${id || '(空)'}` };
    if (seen.has(id)) return { ok: false, reason: `家 id 重复：${id}` };
    seen.add(id);
    if (entry.store) {
      const kind = entry.store.kind;
      if (kind !== 'assertion' && kind !== 'rule' && kind !== 'bundle') {
        return { ok: false, reason: `家 ${id} 的存储映射非法：${String(kind)}` };
      }
      if (kind === 'bundle' && entry.store.bundleKind !== 'template' && entry.store.bundleKind !== 'method') {
        return { ok: false, reason: `家 ${id} 的 bundle 映射缺 template/method` };
      }
    }
    if (!String(entry.label ?? '').trim()) return { ok: false, reason: `家 ${id} 缺 label` };
  }
  for (const builtin of BUILTIN_HOME_IDS) {
    if (!seen.has(builtin)) return { ok: false, reason: `内置家不可删除：${builtin}` };
  }
  return { ok: true };
}

/** 防御性归一：字段容错；内置六家缺失或损坏 → 默认条目补位（判据文案以出厂为准可被覆盖）。 */
export function normalizeHomeRegistry(raw: unknown): HomeRegistryEntry[] {
  const merged = new Map<string, HomeRegistryEntry>();
  for (const entry of DEFAULT_HOME_REGISTRY) merged.set(entry.home, { ...entry });
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const r = item as Record<string, unknown>;
      const home = typeof r.home === 'string' ? r.home.trim() : '';
      if (!home) continue;
      merged.set(home, {
        home,
        label: typeof r.label === 'string' && r.label.trim() ? r.label : home,
        definition: typeof r.definition === 'string' ? r.definition : '',
        examples: Array.isArray(r.examples) ? r.examples.filter((e) => typeof e === 'string') : [],
        pool: (typeof r.pool === 'string' ? r.pool : 'recall') as CandidatePool,
        ...(r.store && typeof r.store === 'object' && !Array.isArray(r.store)
          ? {
              store: {
                kind: (r.store as Record<string, unknown>).kind as CognitionObjectKind,
                ...((r.store as Record<string, unknown>).bundleKind
                  ? { bundleKind: (r.store as Record<string, unknown>).bundleKind as BundleKind }
                  : {}),
              },
            }
          : {}),
        ...(r.builtin === true ? { builtin: true as const } : {}),
      });
    }
  }
  return [...merged.values()];
}

export interface CognitionObject {
  id: string;
  kind: CognitionObjectKind;
  home: ContentHome;
  /** assertion：字段人类名；rule/bundle：标题。 */
  title: string;
  /** assertion：值文本；rule：判断语句；bundle：正文（结构/步骤）。 */
  statement: string;
  origin: string;
  status: CognitionObjectStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** assertion 槽位（本体分组+字段）。 */
  groupId?: string;
  fieldName?: string;
  /** 信息截至年月 YYYY-MM。 */
  asOf?: string;
  verified?: boolean | 'independent';
  ruleKind?: 'operation' | 'preference' | 'constraint';
  applicableWhen?: string;
  forbiddenWhen?: string;
  bundleKind?: BundleKind;
  sensitivity?: 'normal' | 'sensitive';
  restricted?: boolean;
  project?: string;
  source?: string;
  scope?: string;
  evidenceRefs?: DeltaEvidenceRef[];
  /** 软删时间（remove 不物理清，purge 才清）。 */
  deletedAt?: string;
  /** 并入去向（merge 语义保留在版本链之外的事实指针）。 */
  mergedIntoId?: string;
  /** 来源管理对象只由兼容桥更新，禁止 Delta 与旧业务同时写。 */
  managedSource?: string;
}

/** 兼容契约：保留完整来源形状。业务 API 不变，存储权威可逐用户切换。
 * JSONL 版本/采用/审计流继续作为不可变支撑账，不在对象主档复制正文历史。 */
export interface CognitionCompatibilityState {
  mode: 'mirror' | 'unified';
  revision: number;
  records: Record<string, Record<string, Record<string, unknown>>>;
  po?: Record<string, unknown>;
  ontologyCandidates?: Record<string, unknown>[];
  pendingProjection: boolean;
  /** Absent with pending=true means full recovery (legacy markers remain compatible). */
  projectionChanges?: { records: Record<string, string[]>; po?: boolean; ontologyCandidates?: boolean };
  migratedAt: string;
}

export interface CognitionStoreDocument {
  schemaVersion: 1;
  /** 本体领域共用认知主档，旧档未创建本体时没有此字段。 */
  ontology?: OntologyDocument;
  compatibility?: CognitionCompatibilityState;
  objects: Record<string, CognitionObject>;
  /** 家注册表（数据化：可加自定义家；内置六家出厂种子、不可删）。 */
  homes: HomeRegistryEntry[];
  /** 已落地 Delta 的精确重放索引：deltaId → true（有界 FIFO；防同一 Delta 双提交/崩溃重试双落地）。 */
  appliedDeltas: Record<string, true>;
  appliedOrder: string[];
  /** Durable replay fingerprints survive eviction of the fast index. */
  deltaReceipts?: Record<string, string>;
  pendingJournal?: { key: string; objectId?: string; line: Record<string, unknown> }[];
  updatedAt: string;
}

export const COGNITION_STORE_SCHEMA_VERSION = 1 as const;
export const APPLIED_DELTA_INDEX_MAX = 500;

/** 家 → 本库物理形态（按默认注册表便捷查表；文档级判定走 storeShapeForHomes(doc.homes, …)）。 */
export function homeToObjectShape(
  home: ContentHome,
): { kind: CognitionObjectKind; bundleKind?: BundleKind } | null {
  return storeShapeForHomes(DEFAULT_HOME_REGISTRY, home);
}

export function emptyCognitionStore(): CognitionStoreDocument {
  return {
    schemaVersion: COGNITION_STORE_SCHEMA_VERSION,
    objects: {},
    homes: DEFAULT_HOME_REGISTRY.map((entry) => ({ ...entry, examples: [...entry.examples] })),
    appliedDeltas: {},
    appliedOrder: [],
    updatedAt: new Date().toISOString(),
  };
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function optionalStr(value: unknown): string | undefined {
  const s = str(value).trim();
  return s ? s : undefined;
}

/** 防御性归一：字段级容错（单字段坏不拖垮整档），形状不对的对象剔除。 */
export function normalizeCognitionObject(raw: unknown): CognitionObject | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id).trim();
  const kind = str(r.kind);
  if (!id || (kind !== 'assertion' && kind !== 'rule' && kind !== 'bundle')) return null;
  const status = str(r.status, 'active');
  return {
    id,
    kind,
    home: str(r.home) as ContentHome,
    title: str(r.title),
    statement: str(r.statement),
    origin: str(r.origin, 'import'),
    status: status === 'paused' || status === 'archived' || status === 'deleted' ? status : 'active',
    version: Number.isFinite(r.version) && (r.version as number) > 0 ? Math.floor(r.version as number) : 1,
    createdAt: str(r.createdAt, new Date().toISOString()),
    updatedAt: str(r.updatedAt, new Date().toISOString()),
    ...(optionalStr(r.groupId) ? { groupId: optionalStr(r.groupId) } : {}),
    ...(optionalStr(r.fieldName) ? { fieldName: optionalStr(r.fieldName) } : {}),
    ...(optionalStr(r.asOf) ? { asOf: optionalStr(r.asOf) } : {}),
    ...(r.verified === true || r.verified === 'independent' ? { verified: r.verified } : {}),
    ...(optionalStr(r.ruleKind) && ['operation', 'preference', 'constraint'].includes(str(r.ruleKind))
      ? { ruleKind: str(r.ruleKind) as CognitionObject['ruleKind'] }
      : {}),
    ...(optionalStr(r.applicableWhen) ? { applicableWhen: optionalStr(r.applicableWhen) } : {}),
    ...(optionalStr(r.forbiddenWhen) ? { forbiddenWhen: optionalStr(r.forbiddenWhen) } : {}),
    ...(optionalStr(r.bundleKind) && ['template', 'method'].includes(str(r.bundleKind))
      ? { bundleKind: str(r.bundleKind) as BundleKind }
      : {}),
    ...(r.sensitivity === 'sensitive' ? { sensitivity: 'sensitive' } : {}),
    ...(r.restricted === true ? { restricted: true } : {}),
    ...(optionalStr(r.project) ? { project: optionalStr(r.project) } : {}),
    ...(optionalStr(r.source) ? { source: optionalStr(r.source) } : {}),
    ...(optionalStr(r.scope) ? { scope: optionalStr(r.scope) } : {}),
    ...(Array.isArray(r.evidenceRefs) ? { evidenceRefs: r.evidenceRefs as DeltaEvidenceRef[] } : {}),
    ...(optionalStr(r.managedSource) ? { managedSource: optionalStr(r.managedSource) } : {}),
    ...(optionalStr(r.deletedAt) ? { deletedAt: optionalStr(r.deletedAt) } : {}),
    ...(optionalStr(r.mergedIntoId) ? { mergedIntoId: optionalStr(r.mergedIntoId) } : {}),
  };
}

export function normalizeCognitionStoreDocument(raw: unknown): CognitionStoreDocument {
  const doc = emptyCognitionStore();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return doc;
  const r = raw as Record<string, unknown>;
  if (r.ontology !== undefined) doc.ontology = validateOntologyDocument(r.ontology);
  const objects: Record<string, CognitionObject> = {};
  if (r.objects && typeof r.objects === 'object' && !Array.isArray(r.objects)) {
    for (const [id, value] of Object.entries(r.objects as Record<string, unknown>)) {
      const normalized = normalizeCognitionObject(value);
      if (normalized && normalized.id === id) Object.defineProperty(objects, id, { value: normalized, writable: true, enumerable: true, configurable: true });
    }
  }
  if (r.appliedDeltas && typeof r.appliedDeltas === 'object' && !Array.isArray(r.appliedDeltas)) {
    for (const deltaId of Object.keys(r.appliedDeltas as Record<string, unknown>)) {
      if (deltaId) {
        doc.appliedDeltas[deltaId] = true;
        doc.appliedOrder.push(deltaId);
      }
    }
  }
  if (r.deltaReceipts !== undefined) {
    if (!r.deltaReceipts || typeof r.deltaReceipts !== 'object' || Array.isArray(r.deltaReceipts)
      || Object.values(r.deltaReceipts).some(v => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))) throw new Error('invalid delta receipts');
    doc.deltaReceipts = { ...r.deltaReceipts as Record<string, string> };
  }
  if (r.pendingJournal !== undefined) {
    if (!Array.isArray(r.pendingJournal) || r.pendingJournal.some(v => !v || typeof v.key !== 'string'
      || (v.objectId !== undefined && !/^[A-Za-z0-9_-]+$/.test(v.objectId)) || !v.line || typeof v.line !== 'object' || Array.isArray(v.line))) throw new Error('invalid pending journal');
    doc.pendingJournal = r.pendingJournal;
  }
  if (r.compatibility !== undefined) {
    const c = r.compatibility as CognitionCompatibilityState;
    if (!c || (c.mode !== 'mirror' && c.mode !== 'unified') || !Number.isSafeInteger(c.revision)
      || c.revision < 1 || !c.records || typeof c.records !== 'object' || Array.isArray(c.records)
      || !c.records['ability-assets'] || !c.records.candidates || !c.po || !Array.isArray(c.po.groups) || !Array.isArray(c.po.trash)
      || (c.ontologyCandidates !== undefined && !Array.isArray(c.ontologyCandidates))
      || typeof c.pendingProjection !== 'boolean' || typeof c.migratedAt !== 'string') {
      throw new Error('invalid cognition compatibility state');
    }
    if (c.projectionChanges) {
      const dirty = c.projectionChanges;
      if (!dirty.records || typeof dirty.records !== 'object' || Array.isArray(dirty.records)
        || Object.entries(dirty.records).some(([key, ids]) => !['ability-assets', 'candidates'].includes(key)
          || !Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)))
        || (dirty.po !== undefined && typeof dirty.po !== 'boolean')
        || (dirty.ontologyCandidates !== undefined && typeof dirty.ontologyCandidates !== 'boolean')) throw new Error('invalid cognition projection changes');
    }
    doc.compatibility = JSON.parse(JSON.stringify(c)) as CognitionCompatibilityState;
  }
  doc.updatedAt = str(r.updatedAt, doc.updatedAt);
  return { ...doc, objects, homes: normalizeHomeRegistry(r.homes) };
}

/** assertion 槽位寻址：同 (groupId, fieldName) 只有一条活对象。 */
export function findAssertionSlot(
  doc: CognitionStoreDocument,
  groupId: string | undefined,
  fieldName: string,
): CognitionObject | undefined {
  const gid = groupId ?? '';
  return Object.values(doc.objects).find(
    (o) =>
      o.kind === 'assertion' &&
      o.status !== 'deleted' &&
      (o.groupId ?? '') === gid &&
      o.fieldName === fieldName,
  );
}
