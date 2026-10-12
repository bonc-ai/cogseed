/**
 * experience-service.ts — 经验条目的校验与读写（specs/016 T004/T006）与
 * 管理动作（T028：暂停/恢复、类型调整、同类合并、归档）。
 *
 * 经验与资产**完全隔离**（C-7）：独立集合 `experiences`、独立 id 前缀 `exp-`、
 * 独立状态机（active/paused/archived/merged，archived 与 merged 是终态）。本文件
 * 只做经验侧的数据对象，不调用任何 `recall.assets.*` 写函数——经验没有版本组、
 * 成熟度、保留期这些资产口径，也不进候选池。
 *
 * 存储复用 recall 既有记录工具（store.ts 的 read/update + paths.ts 的
 * recallJsonRecordPath）：每条经验一个 JSON 文件，与 ability-assets 集合同构，
 * 因此不引入新的锁或写原语；集合枚举照抄 `listAbilityAssets` 的 readdir 形态。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { safeId } from '../../storage';
import { createLogger } from '../../logger';
import { normalizeCognitionSourceRefs, type CognitionSourceRef } from './source-service';
import { recallJsonRecordPath } from './paths';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import { RECALL_SCHEMA_VERSION, type RecallJsonRecord } from './types';
import { evaluateAssetRuntimeEligibility, type AssetRuntimeCandidate, type AssetRuntimeContext, type AssetRuntimeEligibility } from './formal-assets/runtime';
import type { KstarLearningSignal, KstarLearningProvenance } from '../kstar/types';

/** 经验集合名（与 ability-assets 平级的独立集合，data-model §1）。 */
export const EXPERIENCE_COLLECTION = 'experiences';

const log = createLogger('experience-service');

export type ExperienceType = 'lesson' | 'workflow' | 'gap' | 'uncategorized';
export type ExperienceStatus = 'active' | 'paused' | 'archived' | 'merged';
/** 来源任务的类型标签（scopeForTask 的产出，闭集）。 */
export type ExperienceTaskType = 'report' | 'code' | 'review' | 'product' | 'general';

export interface ExperienceSource {
  episodeId: string;
  requirementId?: string;
  conversationId?: string;
  taskGoal: string;
  taskType: ExperienceTaskType;
  taskStatus: string;
}

/** 管理台账（E2 详情可见 / E3~E6 写通道各记一条）：只追加、不改写。 */
export interface ExperienceHistoryEntry {
  at: string;
  actor: 'user' | 'system';
  action: string;
  from?: string;
  to?: string;
  reason?: string;
}

/** 合并来源快照（E5）：source 的来源任务与证据引用原样冻结进 target 记录，
 *  保证「合并后来源与历史可从 target 全部取回」（US-803 AC1，不丢证据）。 */
export interface ExperienceMergedFromEntry {
  id: string;
  title: string;
  source?: ExperienceSource;
  evidenceRefs?: CognitionSourceRef[];
  mergedAt: string;
}

export interface ExperienceVerification {
  state: 'inferred' | 'needs_confirmation' | 'confirmed' | 'unknown';
  outcome: 'better_than_expected' | 'met_expected' | 'worse_than_expected' | 'unclear';
  deltaR: number | 'unknown';
  confidence: number;
}

export interface ExperienceRecord extends RecallJsonRecord {
  id: string;
  source: ExperienceSource;
  experienceType: ExperienceType;
  title: string;
  body: string;
  expected?: string;
  actual?: string;
  applicableWhen?: string[];
  forbiddenWhen?: string[];
  scope: string;
  verification: ExperienceVerification;
  evidenceRefs: CognitionSourceRef[];
  learningSignal?: KstarLearningSignal;
  learningProvenance: KstarLearningProvenance;
  status: ExperienceStatus;
  sensitivity?: string;
  agentId?: string;
  spaceId?: string;
  mergedIntoExperienceId?: string;
  /** 台账（记录内）：每个管理动作追加一条，actor/time/action/from/to/reason。 */
  history?: ExperienceHistoryEntry[];
  /** 合并进本条的来源快照（E5 并入，含来源任务与证据引用）。 */
  mergedFrom?: ExperienceMergedFromEntry[];
  archiveReason?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建入参：身份与时间戳由服务端定，其余按 data-model §1 全量给出。 */
export type ExperienceInput = Omit<ExperienceRecord, 'schemaVersion' | 'ownerId' | 'createdAt' | 'updatedAt'> & {
  createdAt?: string;
  updatedAt?: string;
};

export type ExperienceUpdater = (current: ExperienceRecord) => ExperienceRecord;

/** 字段上限（data-model §1 校验节；条数/单条长度与 prompt-injection 的既有
 *  截断同量级——超限是写入方的问题，宁拒收不静默截断，否则清单里出现的
 *  永远是"被裁过的经验"而没人知道）。 */
export const EXPERIENCE_TITLE_MAX = 200;
export const EXPERIENCE_BODY_MAX = 4_000;
export const EXPERIENCE_CONDITION_MAX_ITEMS = 5;
export const EXPERIENCE_CONDITION_ITEM_MAX = 300;
/** 管理动作的 note/reason 上限（与资产侧 1_000 字同量级，E3~E6 契约值）。 */
export const EXPERIENCE_NOTE_MAX = 1_000;

const EXPERIENCE_TYPES = new Set<ExperienceType>(['lesson', 'workflow', 'gap', 'uncategorized']);
const EXPERIENCE_STATUSES = new Set<ExperienceStatus>(['active', 'paused', 'archived', 'merged']);
const EXPERIENCE_TASK_TYPES = new Set<ExperienceTaskType>(['report', 'code', 'review', 'product', 'general']);
const VERIFICATION_STATES = new Set<ExperienceVerification['state']>(['inferred', 'needs_confirmation', 'confirmed', 'unknown']);
const VERIFICATION_OUTCOMES = new Set<ExperienceVerification['outcome']>(['better_than_expected', 'met_expected', 'worse_than_expected', 'unclear']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 可选范围条件（applicableWhen/forbiddenWhen）共用：各 ≤5 条、每条 ≤300 字。
 *  null 不是"空条件"——缺失才是"没记录过"（与资产同口径）。 */
function readOptionalConditions(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`malformed experience: ${label} must be an array`);
  const items = value.map((item) => {
    if (typeof item !== 'string') throw new Error(`malformed experience: ${label} entries must be strings`);
    return item;
  });
  if (items.length > EXPERIENCE_CONDITION_MAX_ITEMS) {
    throw new Error(`malformed experience: ${label} exceeds ${EXPERIENCE_CONDITION_MAX_ITEMS} entries`);
  }
  for (const item of items) {
    if (item.length > EXPERIENCE_CONDITION_ITEM_MAX) {
      throw new Error(`malformed experience: ${label} entry exceeds ${EXPERIENCE_CONDITION_ITEM_MAX} chars`);
    }
  }
  return items;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`malformed experience: ${label} is required`);
  return value;
}

/** 台账形状校验（可选字段）：条目必须带 at/actor/action，from/to/reason 可选。
 *  台账是可追溯性的载体，坏一条整条历史都不可信，所以宁拒收不放行。 */
function readOptionalHistory(value: unknown): ExperienceHistoryEntry[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('malformed experience: history must be an array');
  return value.map((entry) => {
    if (!isPlainObject(entry)) throw new Error('malformed experience: history entries must be objects');
    const actor = entry.actor;
    if (actor !== 'user' && actor !== 'system') throw new Error('malformed experience: history.actor is invalid');
    const shaped: ExperienceHistoryEntry = {
      at: requireNonEmptyString(entry.at, 'history.at'),
      actor,
      action: requireNonEmptyString(entry.action, 'history.action'),
    };
    for (const key of ['from', 'to', 'reason'] as const) {
      const field = entry[key];
      if (field === undefined) continue;
      if (typeof field !== 'string') {
        throw new Error(`malformed experience: history.${key} must be a string`);
      }
      shaped[key] = field;
    }
    return shaped;
  });
}

/** 合并来源快照形状校验（可选字段）：id 必须 still 是经验前缀（隔离边界
 *  在快照层同样成立），title 与 mergedAt 必填；source/evidenceRefs 是合并
 *  时冻结的原样数据，只做形状检查不做语义归一。 */
function readOptionalMergedFrom(value: unknown): ExperienceMergedFromEntry[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('malformed experience: mergedFrom must be an array');
  return value.map((entry) => {
    if (!isPlainObject(entry)) throw new Error('malformed experience: mergedFrom entries must be objects');
    const id = entry.id;
    if (typeof id !== 'string' || !safeId(id) || !id.startsWith('exp-')) {
      throw new Error('malformed experience: mergedFrom entry id is invalid');
    }
    const title = requireNonEmptyString(entry.title, 'mergedFrom.title');
    if (title.length > EXPERIENCE_TITLE_MAX) {
      throw new Error(`malformed experience: mergedFrom.title exceeds ${EXPERIENCE_TITLE_MAX} chars`);
    }
    if (entry.source !== undefined && !isPlainObject(entry.source)) {
      throw new Error('malformed experience: mergedFrom.source is invalid');
    }
    if (entry.evidenceRefs !== undefined && !Array.isArray(entry.evidenceRefs)) {
      throw new Error('malformed experience: mergedFrom.evidenceRefs must be an array');
    }
    const shaped: ExperienceMergedFromEntry = { id, title, mergedAt: requireNonEmptyString(entry.mergedAt, 'mergedFrom.mergedAt') };
    if (entry.source !== undefined) shaped.source = entry.source as ExperienceSource;
    if (entry.evidenceRefs !== undefined) shaped.evidenceRefs = entry.evidenceRefs as CognitionSourceRef[];
    return shaped;
  });
}

/**
 * 逐项校验并收拢成 ExperienceRecord（data-model §1 字段表）。
 *
 * 校验失败的记录**一律拒绝**：经验条目是长期数据对象，坏一条会顺着清单与引用
 * 链路向外漏，宁可写入方立刻看到错误。evidenceRefs 走与资产同一套
 * `normalizeCognitionSourceRefs`（去重 + 形状收拢），非空是硬门槛——没有证据的
 * 经验无法追溯，等于编造。
 */
export function asExperience(value: unknown): ExperienceRecord {
  if (!isPlainObject(value)) throw new Error('malformed experience: expected object');

  const id = value.id;
  if (typeof id !== 'string' || !safeId(id)) throw new Error('invalid experience id');
  // 前缀互斥是隔离边界（data-model：exp- vs aa-/历史 id）——靠校验挡住，不靠自觉。
  if (!id.startsWith('exp-')) throw new Error('invalid experience id: missing exp- prefix');

  const sourceRaw = value.source;
  if (!isPlainObject(sourceRaw)) throw new Error('malformed experience: source is required');
  const taskType = sourceRaw.taskType;
  if (typeof taskType !== 'string' || !EXPERIENCE_TASK_TYPES.has(taskType as ExperienceTaskType)) {
    throw new Error('malformed experience: source.taskType is invalid');
  }
  const source: ExperienceSource = {
    episodeId: requireNonEmptyString(sourceRaw.episodeId, 'source.episodeId'),
    ...(typeof sourceRaw.requirementId === 'string' && sourceRaw.requirementId ? { requirementId: sourceRaw.requirementId } : {}),
    ...(typeof sourceRaw.conversationId === 'string' && sourceRaw.conversationId ? { conversationId: sourceRaw.conversationId } : {}),
    taskGoal: requireNonEmptyString(sourceRaw.taskGoal, 'source.taskGoal'),
    taskType: taskType as ExperienceTaskType,
    taskStatus: requireNonEmptyString(sourceRaw.taskStatus, 'source.taskStatus'),
  };

  const experienceType = value.experienceType;
  if (typeof experienceType !== 'string' || !EXPERIENCE_TYPES.has(experienceType as ExperienceType)) {
    throw new Error('malformed experience: experienceType is invalid');
  }

  const title = requireNonEmptyString(value.title, 'title');
  if (title.length > EXPERIENCE_TITLE_MAX) {
    throw new Error(`malformed experience: title exceeds ${EXPERIENCE_TITLE_MAX} chars`);
  }
  const body = requireNonEmptyString(value.body, 'body');
  if (body.length > EXPERIENCE_BODY_MAX) {
    throw new Error(`malformed experience: body exceeds ${EXPERIENCE_BODY_MAX} chars`);
  }

  const applicableWhen = readOptionalConditions(value.applicableWhen, 'applicableWhen');
  const forbiddenWhen = readOptionalConditions(value.forbiddenWhen, 'forbiddenWhen');

  const verificationRaw = value.verification;
  if (!isPlainObject(verificationRaw)) throw new Error('malformed experience: verification is required');
  if (typeof verificationRaw.state !== 'string' || !VERIFICATION_STATES.has(verificationRaw.state as ExperienceVerification['state'])) {
    throw new Error('malformed experience: verification.state is invalid');
  }
  if (typeof verificationRaw.outcome !== 'string' || !VERIFICATION_OUTCOMES.has(verificationRaw.outcome as ExperienceVerification['outcome'])) {
    throw new Error('malformed experience: verification.outcome is invalid');
  }
  if (verificationRaw.deltaR !== 'unknown' && !(typeof verificationRaw.deltaR === 'number' && Number.isFinite(verificationRaw.deltaR))) {
    throw new Error('malformed experience: verification.deltaR is invalid');
  }
  if (typeof verificationRaw.confidence !== 'number' || !Number.isFinite(verificationRaw.confidence)) {
    throw new Error('malformed experience: verification.confidence is invalid');
  }
  const verification: ExperienceVerification = {
    state: verificationRaw.state as ExperienceVerification['state'],
    outcome: verificationRaw.outcome as ExperienceVerification['outcome'],
    deltaR: verificationRaw.deltaR as number | 'unknown',
    confidence: verificationRaw.confidence,
  };

  const evidenceRefs = normalizeCognitionSourceRefs(Array.isArray(value.evidenceRefs) ? value.evidenceRefs : []);
  if (!evidenceRefs.length) throw new Error('malformed experience: evidenceRefs must not be empty');

  // 溯源不断链：source 与 learningProvenance 必须指向同一个 episode（data-model 不变量）。
  const provenanceRaw = value.learningProvenance;
  if (!isPlainObject(provenanceRaw)) throw new Error('malformed experience: learningProvenance is required');
  if (typeof provenanceRaw.episodeId !== 'string' || !provenanceRaw.episodeId.trim()) {
    throw new Error('malformed experience: learningProvenance.episodeId is required');
  }
  if (provenanceRaw.episodeId !== source.episodeId) {
    throw new Error('malformed experience: learningProvenance.episodeId must match source.episodeId');
  }

  const status = value.status;
  if (typeof status !== 'string' || !EXPERIENCE_STATUSES.has(status as ExperienceStatus)) {
    throw new Error('malformed experience: status is invalid');
  }

  const scope = requireNonEmptyString(value.scope, 'scope');
  const createdAt = requireNonEmptyString(value.createdAt, 'createdAt');
  const updatedAt = requireNonEmptyString(value.updatedAt, 'updatedAt');
  const history = readOptionalHistory(value.history);
  const mergedFrom = readOptionalMergedFrom(value.mergedFrom);

  return {
    ...(value as RecallJsonRecord),
    id,
    source,
    experienceType: experienceType as ExperienceType,
    title,
    body,
    ...(applicableWhen !== undefined ? { applicableWhen } : {}),
    ...(forbiddenWhen !== undefined ? { forbiddenWhen } : {}),
    evidenceRefs,
    scope,
    verification,
    status: status as ExperienceStatus,
    ...(history !== undefined ? { history } : {}),
    ...(mergedFrom !== undefined ? { mergedFrom } : {}),
    createdAt,
    updatedAt,
  } as ExperienceRecord;
}

function experiencesDirectory(userId: string): string {
  // 与 asset-service 的 assetsDirectory 同构：借 record 路径定位集合目录。
  return path.dirname(recallJsonRecordPath(userId, EXPERIENCE_COLLECTION, 'placeholder'));
}

function assertExperienceId(experienceId: string): void {
  if (typeof experienceId !== 'string' || !safeId(experienceId) || !experienceId.startsWith('exp-')) {
    throw new Error('invalid experience id');
  }
}

/**
 * 新建经验条目（幂等：同 id 已存在时返回既有记录，不覆盖——重复沉淀/迁移重跑
 * 不产生第二条；「内容是否同一条」由调用方（沉淀线/迁移线）的判据保证）。
 */
export async function createExperience(userId: string, input: ExperienceInput): Promise<ExperienceRecord> {
  if (!safeId(userId)) throw new Error('invalid experience user');
  if ('ownerId' in input && input.ownerId !== undefined && input.ownerId !== userId) {
    throw new Error('experience owner mismatch');
  }
  const now = new Date().toISOString();
  const candidate = {
    ...input,
    schemaVersion: RECALL_SCHEMA_VERSION,
    ownerId: userId,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || input.createdAt || now,
  };
  const validated = asExperience(candidate);
  const stored = await updateRecallJsonRecord(
    userId,
    EXPERIENCE_COLLECTION,
    validated.id,
    (current) => current || validated,
  );
  return asExperience(stored);
}

export async function readExperience(userId: string, experienceId: string): Promise<ExperienceRecord | undefined> {
  assertExperienceId(experienceId);
  const raw = await readRecallJsonRecord(userId, EXPERIENCE_COLLECTION, experienceId);
  return raw ? asExperience(raw) : undefined;
}

/** 全量列举（updatedAt 降序）。目录不存在 = 用户还没有经验，返回空数组。 */
export async function listExperiences(userId: string): Promise<ExperienceRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(experiencesDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ids = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .filter((id) => safeId(id) && id.startsWith('exp-'));
  // 逐条降级，而不是让一条坏经验把整份经验目录读失败（照抄同目录
  // listRecallCandidates 的既有口径）：记录形状的不变量分布在两层——store 的
  // validateRecallRecord 和这里的 asExperience——任一层一抛，`experiences.list`
  // 就整体失败，好条目也列不出、整页不可用。
  //
  // 只降级**记录形状**的错。真正的 IO 故障（EACCES / EISDIR……）带 errno code，
  // 照旧上抛：那种情况下静默少几条，等于把磁盘问题伪装成「经验变少了」。
  const reads = await Promise.all(ids.map(async (id) => {
    try {
      return { id, record: await readRecallJsonRecord(userId, EXPERIENCE_COLLECTION, id) };
    } catch (error) {
      if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
      return { id, error: error as Error };
    }
  }));
  const experiences: ExperienceRecord[] = [];
  for (const read of reads) {
    if (read.error) {
      log.warn('skipped an unreadable experience', { experienceId: read.id, error: read.error.message });
      continue;
    }
    if (!read.record) continue;
    try {
      experiences.push(asExperience(read.record));
    } catch (error) {
      log.warn('skipped a malformed experience', { experienceId: read.id, error: (error as Error).message });
    }
  }
  return experiences.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * 更新经验条目。updater 返回的记录在写盘前过一遍 `asExperience`——store 只做
 * 通用字段校验，语义校验（前缀/枚举/长度/溯源一致）必须在这里补上，否则
 * update 路径成了绕过 create 校验的后门。
 */
export async function updateExperience(
  userId: string,
  experienceId: string,
  updater: ExperienceUpdater,
): Promise<ExperienceRecord> {
  assertExperienceId(experienceId);
  const stored = await updateRecallJsonRecord(userId, EXPERIENCE_COLLECTION, experienceId, (current) => {
    if (!current) throw new Error('experience not found');
    return asExperience(updater(asExperience(current)));
  });
  return asExperience(stored);
}

/**
 * ── 管理动作（specs/016 T028 / 契约 E3~E6，US-803）─────────────────────────
 *
 * 共同口径：
 *  - 终态（archived/merged）拒绝：状态机里没有出弧（data-model §状态机），
 *    「复活」会破坏「已冻结引用仍可读快照」的可信度——想复用请手动新建；
 *  - 每个动作台账一条（actor:'user'、时间、动作、from/to、依据），可追溯
 *    是 FR-006 的硬要求，不静默；
 *  - 一律不物理删除：归档/合并都是「换个状态 + 记去向」，历史引用（冻结
 *    快照、台账）仍指向原记录可读（D9 不变量）；
 *  - 不触碰资产库：本文件到头都不 import asset-service，隔离靠结构不靠自觉。
 */

/** note/reason 的可选校验：给了就必须是非空且 ≤1000 字（E3~E6 契约上限）。 */
function requireOptionalNote(note: unknown, label: string): string | undefined {
  if (note === undefined || note === null) return undefined;
  if (typeof note !== 'string' || !note.trim() || note.length > EXPERIENCE_NOTE_MAX) {
    throw new Error(`invalid experience ${label}`);
  }
  return note;
}

/** 终态闸门：archived/merged 之后不再接受任何管理动作（data-model §状态机）。 */
function assertMutableExperience(exp: ExperienceRecord): void {
  if (exp.status === 'archived') throw new Error('archived experience is terminal and cannot be modified');
  if (exp.status === 'merged') throw new Error('merged experience is terminal and cannot be modified');
}

function appendHistory(exp: ExperienceRecord, entry: ExperienceHistoryEntry): ExperienceHistoryEntry[] {
  return [...(exp.history || []), entry];
}

/** 开关面（E3）：pause→paused、resume→active。已在目标状态时幂等返回、
 *  不追加台账——反复点开关不该把台账刷成流水账。 */
export async function setExperienceStatus(
  userId: string,
  experienceId: string,
  action: 'pause' | 'resume',
  note?: string,
): Promise<ExperienceRecord> {
  if (!safeId(userId)) throw new Error('invalid experience user');
  assertExperienceId(experienceId);
  if (action !== 'pause' && action !== 'resume') throw new Error('invalid experience status action');
  const reason = requireOptionalNote(note, 'status note');
  const to: ExperienceStatus = action === 'pause' ? 'paused' : 'active';
  return updateExperience(userId, experienceId, (current) => {
    assertMutableExperience(current);
    if (current.status === to) return current;
    const now = new Date().toISOString();
    return {
      ...current,
      status: to,
      history: appendHistory(current, {
        at: now,
        actor: 'user',
        action: action === 'pause' ? 'paused' : 'resumed',
        from: current.status,
        to,
        ...(reason !== undefined ? { reason } : {}),
      }),
      updatedAt: now,
    };
  });
}

/** 类型调整（E4）：uncategorized 是合法目标与源（Edge Case「判不出→未分类，
 *  可后续调整」的落点）；只改 experienceType + 台账，不自动动任何其他字段。 */
export async function setExperienceType(
  userId: string,
  experienceId: string,
  type: ExperienceType,
  note?: string,
): Promise<ExperienceRecord> {
  if (!safeId(userId)) throw new Error('invalid experience user');
  assertExperienceId(experienceId);
  if (typeof type !== 'string' || !EXPERIENCE_TYPES.has(type)) throw new Error('invalid experience type');
  const reason = requireOptionalNote(note, 'type note');
  return updateExperience(userId, experienceId, (current) => {
    assertMutableExperience(current);
    if (current.experienceType === type) return current;
    const now = new Date().toISOString();
    return {
      ...current,
      experienceType: type,
      history: appendHistory(current, {
        at: now,
        actor: 'user',
        action: 'type_changed',
        from: current.experienceType,
        to: type,
        ...(reason !== undefined ? { reason } : {}),
      }),
      updatedAt: now,
    };
  });
}

/** 同类合并（E5）：source 的来源任务与证据引用冻结进 target.mergedFrom；
 *  source 置 merged + 记去向，**不物理删除**（历史引用仍指向原记录）。
 *
 *  前置校验（读原语直读而非 readExperience 包装——E5 是写通道，不能依赖
 *  可能在测试里被替换的读取出口）：
 *  - 必须同 experienceType：跨类型合并会把「教训」并进「流程」，静默做掉
 *    等于替用户改判，所以宁可拒绝（契约 E5 的两条不变量之一）；
 *  - source 已 merged → 拒绝并说明去向（重复合并不产生第二条影子）；
 *  - 链式合并（A→B 再 B→C）：source 自己吸收的 mergedFrom 一并下放，
 *    家谱在 target 侧完整可考（「来源全部取回」）。
 */
export interface ExperienceMergeResult {
  target: ExperienceRecord;
  source: ExperienceRecord;
}

export async function mergeExperiences(
  userId: string,
  sourceExperienceId: string,
  targetExperienceId: string,
  note?: string,
): Promise<ExperienceMergeResult> {
  if (!safeId(userId)) throw new Error('invalid experience user');
  assertExperienceId(sourceExperienceId);
  assertExperienceId(targetExperienceId);
  if (sourceExperienceId === targetExperienceId) throw new Error('cannot merge an experience into itself');
  const reason = requireOptionalNote(note, 'merge note');

  const sourceRaw = await readRecallJsonRecord(userId, EXPERIENCE_COLLECTION, sourceExperienceId);
  if (!sourceRaw) throw new Error('experience not found');
  const source = asExperience(sourceRaw);
  const targetRaw = await readRecallJsonRecord(userId, EXPERIENCE_COLLECTION, targetExperienceId);
  if (!targetRaw) throw new Error('experience not found');
  const target = asExperience(targetRaw);

  // 重复合并给出带去向的说明（比通用终态报错可操作：用户能直接跳去那条）。
  if (source.status === 'merged' || source.mergedIntoExperienceId) {
    throw new Error(
      source.mergedIntoExperienceId
        ? `experience has already been merged into ${source.mergedIntoExperienceId}`
        : 'experience has already been merged',
    );
  }
  assertMutableExperience(source);
  assertMutableExperience(target);
  if (source.experienceType !== target.experienceType) {
    throw new Error('experience merge requires the same experienceType');
  }

  const now = new Date().toISOString();
  // ① target：吸收 source 的来源与证据（含 source 之前吸收的辈分），台账一条。
  const mergedTarget = await updateExperience(userId, targetExperienceId, (current) => {
    const seen = new Set((current.mergedFrom || []).map((entry) => entry.id));
    const inherited = (source.mergedFrom || []).filter((entry) => !seen.has(entry.id));
    const entry: ExperienceMergedFromEntry = {
      id: source.id,
      title: source.title,
      source: source.source,
      evidenceRefs: source.evidenceRefs,
      mergedAt: now,
    };
    return {
      ...current,
      mergedFrom: [...(current.mergedFrom || []), ...inherited, entry],
      history: appendHistory(current, {
        at: now,
        actor: 'user',
        action: 'merged_from',
        from: source.id,
        ...(reason !== undefined ? { reason } : {}),
      }),
      updatedAt: now,
    };
  });
  // ② source：置终态 + 记去向（台账一条），文件保留。
  const mergedSource = await updateExperience(userId, sourceExperienceId, (current) => ({
    ...current,
    status: 'merged',
    mergedIntoExperienceId: targetExperienceId,
    history: appendHistory(current, {
      at: now,
      actor: 'user',
      action: 'merged',
      from: current.status,
      to: 'merged',
      ...(reason !== undefined ? { reason } : {}),
    }),
    updatedAt: now,
  }));
  return { target: mergedTarget, source: mergedSource };
}

/** 过期/失效清理（E6）：reason **必填**（≤1000 字）——「有明确口径」就是
 *  这个意思；无保留期数字（资产的 30 天是 US-306 口径，不搬）；不物理删除。
 *  归档后清单零出现由消费侧的 status 过滤自然保证（清单/准入只认 active）。 */
export async function archiveExperience(
  userId: string,
  experienceId: string,
  reason: string,
): Promise<ExperienceRecord> {
  if (!safeId(userId)) throw new Error('invalid experience user');
  assertExperienceId(experienceId);
  if (typeof reason !== 'string' || !reason.trim() || reason.length > EXPERIENCE_NOTE_MAX) {
    throw new Error('invalid experience archive reason');
  }
  const now = new Date().toISOString();
  return updateExperience(userId, experienceId, (current) => {
    assertMutableExperience(current);
    return {
      ...current,
      status: 'archived',
      archiveReason: reason,
      archivedAt: now,
      history: appendHistory(current, {
        at: now,
        actor: 'user',
        action: 'archived',
        from: current.status,
        to: 'archived',
        reason,
      }),
      updatedAt: now,
    };
  });
}

/**
 * 准入适配（specs/016 T006 / research D10）：把经验条目适配成资产闸门要的
 * `AssetRuntimeCandidate` 形状，判定本身**全部**交给 `evaluateAssetRuntimeEligibility`
 * ——这里不复制任何判据，理由码（status_not_active / scope_mismatch /
 * forbidden_context / not_applicable_context …）与资产侧同源。
 *
 * 适配取舍：
 *   - `merged` 是经验特有终态，映射到同为终态的 `archived`：闸门只按
 *     `!== 'active'` 判 `status_not_active`，语义等价，不新造第四种状态判据；
 *   - `maturity` 固定 `bud`：经验没有成熟度轴（决策口径 6），但闸门的入参
 *     要求该字段。取 bud 是唯一"既不拦也不撒谎"的档位——seed 会在非静默
 *     路径落 `maturity_below_default_use`（把未验证当成资产的 Candidate 禁令，
 *     不适用于经验），transfer+ 则谎称效果已实证；
 *   - `agentId` 映射 `targetAgents`：单值白名单，语义就是"只许这个 Agent 用"。
 */
export function experienceRuntimeCandidate(exp: ExperienceRecord): AssetRuntimeCandidate {
  return {
    status: exp.status === 'merged' ? 'archived' : exp.status,
    maturity: 'bud',
    scope: exp.scope,
    ...(exp.spaceId ? { scopePolicy: { workspaceIds: [exp.spaceId] } } : {}),
    applicableWhen: exp.applicableWhen,
    forbiddenWhen: exp.forbiddenWhen,
    ...(exp.agentId ? { targetAgents: [exp.agentId] } : {}),
    ...(exp.sensitivity !== undefined ? { sensitivity: exp.sensitivity } : {}),
  };
}

/** 经验的消费准入（FR-005：与资产同一套闸门，不写第二套判据）。
 *  userId 参与 owner 校验：跨用户的经验不得被判定可用（隔离不只按集合，也按属主）。 */
export function evaluateExperienceRuntimeEligibility(
  userId: string,
  exp: ExperienceRecord,
  context: AssetRuntimeContext = {},
): AssetRuntimeEligibility {
  if (!safeId(userId) || exp.ownerId !== userId) throw new Error('experience owner mismatch');
  const candidate = experienceRuntimeCandidate(exp);
  // Experience `general` means usable across task categories. The shared gate
  // models cross-scope use explicitly; adapt this domain wildcard to the
  // current destination so workspace, Agent, status, and condition checks stay
  // in the same gate without inventing a persisted confirmation timestamp.
  if (candidate.scope === 'general' && context.scope) candidate.scope = context.scope;
  return evaluateAssetRuntimeEligibility(candidate, context);
}
