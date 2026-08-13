import * as fs from 'node:fs/promises';
import * as personalOntologyCandidates from '../personal_ontology_candidates';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { genId12, safeId } from '../../storage';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { recallJsonRecordPath } from './paths';
import {
  readRecallJsonRecord,
  updateRecallJsonRecord,
  writeRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';
import type { KstarLearningSignal } from '../kstar/types';
import { normalizeAbilityAssetOntologyRefs, type AbilityAssetOntologyRef } from './ontology-refs';
import {
  readAbilityAssetSemantics,
  type AbilityAssetRelation,
  type AbilityAssetSemantics,
  type AbilityAssetSensitivity,
} from './asset-semantics';
import { initializeAbilityAsset, listAbilityAssets } from './asset-service';
import {
  cognitionSourceRefKey,
  normalizeCognitionSourceRefs,
  normalizeCognitionSourceRefsForWrite,
  type CognitionSourceRef,
} from './source-service';

export type RecallCandidateStatus = 'pending' | 'deferred' | 'rejected' | 'promoted';
export type AbilityAssetType = 'personal' | 'rule' | 'template' | 'skill_method';


export interface RecallCandidateRecord extends RecallJsonRecord {
  id: string;
  taxonomyVersion: 2;
  status: RecallCandidateStatus;
  judgment: string;
  summary?: string;
  uncertainty?: string;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  sourceRefs: CognitionSourceRef[];
  learningSignal?: KstarLearningSignal;
  captureKey?: string;
  /** 抽取时识别出的适用/禁用场景。缺失=没识别出来，不是无限制。
   *  promote 时原样带进资产，这样自动链路产出的资产才有边界，
   *  而不是只有手动 promote 时调用方传参才有。 */
  applicableWhen?: string[];
  forbiddenWhen?: string[];
  /**
   * Recognizer-supplied belief in this judgment, 0..1. Stays absent when the
   * recognizer gives no score — a fabricated default would read as evidence of
   * confidence the system does not have.
   */
  confidence?: number;
  promotedAssetId?: string;
  decisionNote?: string;
  promotionErrorCode?: 'asset_write_failed';
  promotionErrorMessage?: string;
  promotionFailedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecallAbilityAssetRecord extends RecallJsonRecord {
  id: string;
  candidateId: string;
  type: AbilityAssetType;
  title: string;
  statement: string;
  evidenceRefs: CognitionSourceRef[];
  learningSignal?: KstarLearningSignal;
  ontologyRefs?: AbilityAssetOntologyRef[];
  /** 与其它资产的关系。缺失=没记录过。 */
  relations?: AbilityAssetRelation[];
  /** 溯源链：这条资产从哪些既有资产长出来的。 */
  derivedFrom?: string[];
  /** 什么场景下该用这条资产。 */
  applicableWhen?: string[];
  /** 什么场景下绝对不能用。空/缺失只代表没写过，不代表无限制。 */
  forbiddenWhen?: string[];
  /** 限定接收方。缺失=不限定；空数组=谁都不给。 */
  targetAgentIds?: string[];
  /** L0/L1/L2。缺失=没分过级，不等于 L0。L3 被准入闸挡在候选之前，不会出现。 */
  sensitivity?: AbilityAssetSensitivity;
  scope: string;
  /**
   * 治理状态（规范 22.1）。除 active 外全部停止默认注入——下游一律用
   * `status !== 'active'` 拒绝式判断，所以新增状态天然不会被误带进任务。
   *
   *   active   正常使用
   *   paused   暂停默认注入，历史与 Evidence 保留，可恢复
   *   archived 从日常列表移出、不参与推荐，历史保留，可恢复
   *   deleted  移出可用资产并进入保留期，保留期内可恢复（见 `deletedAt`）
   *   purged   彻底清除后的墓碑：内容与版本已删，仅留不可识别的审计最小项
   *   revoked  撤销
   */
  status: 'active' | 'paused' | 'archived' | 'deleted' | 'purged' | 'revoked';
  /**
   * 成熟度阶梯（规范 10.1）。`stable` 是 `effectiveness_validated` 之上的一档，
   * 在 10.2 默认使用矩阵里与后者同属一行。
   *
   * 不收 `trial_use`：规范阶梯里有这一步，但 10.2 没有给它独立的使用策略行，
   * 目前也没有任何环节能产出它。加一个到不了又不改变行为的档位，只会让
   * 消费方以为自己需要处理它。
   */
  maturity: 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated' | 'stable';
  /**
   * 进入删除保留期的时刻。只记事实，不记算好的到期时间——保留期长度是政策，
   * 政策改了不该要求迁移已有记录。是否仍在保留期由
   * `asset-service.ts::isWithinDeletionRetention` 现算。
   */
  deletedAt?: string;
  version: string;
  /** Carried over from the promoted candidate; absent when it had none. */
  confidence?: number;
  /**
   * Conversations this asset was learned from, derived from the candidate's
   * conversation-kind source refs. Both fields are optional so records written
   * before they existed still load.
   */
  sourceSessionIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SaveRecallCandidateInput {
  judgment: string;
  summary?: string;
  uncertainty?: string;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  sourceRefs: unknown[];
  learningSignal?: KstarLearningSignal;
  captureKey?: string;
  confidence?: number;
  applicableWhen?: string[];
  forbiddenWhen?: string[];
}

const MAX_SOURCE_SESSION_IDS = 50;

/**
 * Validate a recognizer confidence score.
 *
 * Absent stays absent. A present-but-unusable value throws rather than being
 * coerced: silently rounding NaN or 1.5 into something plausible would put a
 * number the recognizer never produced in front of the user.
 */
function optionalConfidence(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('invalid confidence');
  }
  return Math.round(value * 100) / 100;
}

/** Conversations behind a candidate, in first-seen order and capped. */
function sourceSessionIdsFrom(refs: CognitionSourceRef[]): string[] {
  const ids: string[] = [];
  for (const ref of refs) {
    if (ref.kind !== 'conversation' || ids.includes(ref.id)) continue;
    ids.push(ref.id);
    if (ids.length >= MAX_SOURCE_SESSION_IDS) break;
  }
  return ids;
}

function boundedText(value: unknown, field: string, max: number, required = false): string | undefined {
  if (typeof value !== 'string') {
    if (required) throw new Error(`missing ${field}`);
    return undefined;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) {
    if (required) throw new Error(`missing ${field}`);
    return undefined;
  }
  if (text.length > max) throw new Error(`${field} is too long`);
  return text;
}

function requireAssetType(value: unknown): AbilityAssetType {
  if (value === 'personal' || value === 'rule' || value === 'template' || value === 'skill_method') return value;
  throw new Error('invalid suggested type');
}


function normalizeLearningSignal(value: unknown): KstarLearningSignal | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed candidate learning signal');
  const signal = value as Record<string, unknown>;
  if (
    (signal.expectedResult !== undefined && typeof signal.expectedResult !== 'string') ||
    (signal.actualResult !== undefined && typeof signal.actualResult !== 'string') ||
    (signal.deltaR !== 'unknown' && (typeof signal.deltaR !== 'number' || !Number.isFinite(signal.deltaR))) ||
    (signal.deltaA !== 'unknown' && (typeof signal.deltaA !== 'number' || !Number.isFinite(signal.deltaA))) ||
    !['better_than_expected', 'met_expected', 'worse_than_expected', 'unclear'].includes(String(signal.outcome)) ||
    typeof signal.confidence !== 'number' || !Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1 ||
    signal.source !== 'review'
  ) throw new Error('malformed candidate learning signal');
  return signal as unknown as KstarLearningSignal;
}

function asCandidate(value: RecallJsonRecord): RecallCandidateRecord {
  if (
    (value.status !== 'pending' && value.status !== 'deferred' && value.status !== 'rejected' && value.status !== 'promoted') ||
    typeof value.judgment !== 'string' ||
    typeof value.suggestedType !== 'string' ||
    typeof value.suggestedScope !== 'string' ||
    !Array.isArray(value.sourceRefs) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) throw new Error('malformed recall candidate');
  const sourceRefs = normalizeCognitionSourceRefs(value.sourceRefs);
  if (!sourceRefs.length) throw new Error('malformed recall candidate evidence');
  const learningSignal = normalizeLearningSignal(value.learningSignal);
  return { ...value, taxonomyVersion: 2, sourceRefs, ...(learningSignal ? { learningSignal } : {}) } as RecallCandidateRecord;
}

function asAsset(value: RecallJsonRecord): RecallAbilityAssetRecord {
  if (
    typeof value.candidateId !== 'string' || typeof value.title !== 'string' ||
    typeof value.statement !== 'string' || !Array.isArray(value.evidenceRefs) ||
    typeof value.scope !== 'string' || typeof value.version !== 'string'
  ) throw new Error('malformed recall ability asset');
  const evidenceRefs = normalizeCognitionSourceRefs(value.evidenceRefs);
  if (!evidenceRefs.length) throw new Error('malformed recall ability asset evidence');
  const learningSignal = normalizeLearningSignal(value.learningSignal);
  const ontologyRefs = value.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(value.ontologyRefs);
  const semantics = readAbilityAssetSemantics(
    value as Record<string, unknown>,
    typeof value.id === 'string' ? value.id : undefined,
  );
  return {
    ...value,
    evidenceRefs,
    ...(learningSignal ? { learningSignal } : {}),
    ...(ontologyRefs ? { ontologyRefs } : {}),
    ...semantics,
  } as RecallAbilityAssetRecord;
}

function candidateDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'candidates', 'placeholder'));
}

function fingerprint(input: Pick<RecallCandidateRecord, 'judgment' | 'sourceRefs'>): string {
  return `${input.judgment.toLocaleLowerCase()}\n${input.sourceRefs.map(cognitionSourceRefKey).sort().join('\n')}`;
}

function candidateIdForCaptureKey(captureKey: string): string {
  return `cand-${createHash('sha256').update(captureKey).digest('hex').slice(0, 24)}`;
}

function abilityAssetIdForCandidate(candidateId: string): string {
  return `aa-${createHash('sha256').update(candidateId).digest('hex').slice(0, 24)}`;
}

export async function listRecallCandidates(userId: string): Promise<RecallCandidateRecord[]> {
  let names: string[];
  try { names = await fs.readdir(candidateDirectory(userId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map(async (name) => readRecallJsonRecord(userId, 'candidates', name.slice(0, -5))));
  return records.filter((record): record is RecallJsonRecord => Boolean(record)).map(asCandidate)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readRecallCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  const record = await readRecallJsonRecord(userId, 'candidates', candidateId);
  if (!record) throw new Error('recall candidate not found');
  return asCandidate(record);
}

export async function importPersonalOntologyCandidate(userId: string, legacyCandidateId: string): Promise<RecallCandidateRecord> {
  if (!safeId(legacyCandidateId)) throw new Error('invalid personal ontology candidate id');
  const data = await personalOntologyCandidates.listCandidates(userId);
  const legacy = (data.candidate_updates || []).find((candidate) => candidate.candidate_id === legacyCandidateId);
  if (!legacy) throw new Error('personal ontology candidate not found');
  const suggestedType: AbilityAssetType = legacy.kind === 'preference' ? 'personal' : legacy.kind === 'rule' ? 'rule' : 'personal';
  return saveRecallCandidate(userId, {
    judgment: legacy.memory_text || legacy.summary,
    summary: legacy.summary,
    suggestedType,
    suggestedScope: legacy.memory_scope === 'user' ? 'global' : 'project',
    sourceRefs: legacy.source_memory_refs.map((id) => ({ kind: 'memory', id })),
  });
}

export async function saveRecallCandidate(userId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  const judgment = boundedText(input.judgment, 'judgment', 4_000, true)!;
  const summary = boundedText(input.summary, 'summary', 1_000);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', 1_000);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', 500, true)!;
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  if (!sourceRefs.length) throw new Error('candidate evidence is required');
  // L3 准入闸（规范 16.1）：密钥、口令、未脱敏凭证不得形成候选。
  // 拦在这里而不是输出侧脱敏，是因为候选一旦长成资产，就会被冻进能力包、
  // 注入 Agent 提示、写进回执、跨会话复用——后面每一环都在忠实搬运它。
  // judgment 与 summary 一起过闸，否则把凭证写在 summary 里就能绕过去。
  assertNotForbiddenToPersist([judgment, summary, uncertainty]);
  const learningSignal = normalizeLearningSignal(input.learningSignal);
  // 复用资产语义字段的同一套规范化：去重、长度上限、大小写不敏感，
  // 免得候选层和资产层各有一套约束、promote 时才发现对不上。
  const candidateSemantics = readAbilityAssetSemantics(input as unknown as Record<string, unknown>);
  const captureKey = input.captureKey === undefined
    ? undefined
    : boundedText(input.captureKey, 'capture key', 160, true);
  if (captureKey && !safeId(captureKey)) throw new Error('invalid capture key');
  if (captureKey) {
    const captured = (await listRecallCandidates(userId)).find((candidate) => candidate.captureKey === captureKey);
    if (captured) return captured;
  }
  const candidateDraft = { judgment, sourceRefs } as Pick<RecallCandidateRecord, 'judgment' | 'sourceRefs'>;
  const existing = (await listRecallCandidates(userId)).find((candidate) => fingerprint(candidate) === fingerprint(candidateDraft));
  if (existing) return existing;

  const confidence = optionalConfidence(input.confidence);
  const now = new Date().toISOString();
  const record: RecallCandidateRecord = {
    schemaVersion: 1,
    taxonomyVersion: 2,
    ownerId: userId,
    id: captureKey ? candidateIdForCaptureKey(captureKey) : `cand-${genId12()}`,
    status: 'pending',
    judgment,
    ...(summary ? { summary } : {}),
    ...(uncertainty ? { uncertainty } : {}),
    suggestedType: requireAssetType(input.suggestedType),
    suggestedScope,
    sourceRefs,
    ...(learningSignal ? { learningSignal } : {}),
    ...(captureKey ? { captureKey } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(candidateSemantics.applicableWhen ? { applicableWhen: candidateSemantics.applicableWhen } : {}),
    ...(candidateSemantics.forbiddenWhen ? { forbiddenWhen: candidateSemantics.forbiddenWhen } : {}),
    createdAt: now,
    updatedAt: now,
  };
  if (captureKey) {
    return asCandidate(await updateRecallJsonRecord(
      userId,
      'candidates',
      record.id,
      (current) => current || record,
    ));
  }
  await writeRecallJsonRecord(userId, 'candidates', record.id, record);
  return record;
}

async function transitionCandidate(
  userId: string,
  candidateId: string,
  nextStatus: RecallCandidateStatus,
  decisionNote?: string,
): Promise<RecallCandidateRecord> {
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
    if (!current) throw new Error('recall candidate not found');
    const candidate = asCandidate(current);
    if (candidate.status === 'rejected' || candidate.status === 'promoted') throw new Error('recall candidate is terminal');
    if (nextStatus === 'promoted') throw new Error('use promoteRecallCandidate');
    const note = boundedText(decisionNote, 'decision note', 1_000);
    return {
      ...candidate,
      status: nextStatus,
      ...(note ? { decisionNote: note } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  return asCandidate(updated);
}

export async function updateRecallCandidate(userId: string, candidateId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  const judgment = boundedText(input.judgment, 'judgment', 4_000, true)!;
  const summary = boundedText(input.summary, 'summary', 1_000);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', 1_000);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', 500, true)!;
  const suggestedType = requireAssetType(input.suggestedType);
  const confidence = optionalConfidence(input.confidence);
  // develop 已把写路径切到 ...ForWrite（比 dev/shiyuxuan 的 normalizeCognitionSourceRefs 新），保留新的。
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  if (!sourceRefs.length) throw new Error('candidate evidence is required');
  const learningSignal = normalizeLearningSignal(input.learningSignal);
  const duplicates = await listRecallCandidates(userId);
  const nextFingerprint = fingerprint({ judgment, sourceRefs });
  if (duplicates.some((candidate) => candidate.id !== candidateId && fingerprint(candidate) === nextFingerprint)) throw new Error('duplicate recall candidate');
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, (raw) => {
    if (!raw) throw new Error('recall candidate not found');
    const current = asCandidate(raw);
    if (current.status === 'rejected' || current.status === 'promoted') throw new Error('recall candidate is terminal');
    // An omitted confidence clears any previous score rather than keeping a
    // stale one attached to a judgment that has since been edited.
    // learningSignal 走的是相反的约定：不传就沿用旧值（它记的是评估结果，
    // 不随判断文本编辑而失效），所以这里两种语义并存。
    const {
      confidence: _previousConfidence,
      promotionErrorCode: _previousPromotionErrorCode,
      promotionErrorMessage: _previousPromotionErrorMessage,
      promotionFailedAt: _previousPromotionFailedAt,
      ...rest
    } = current;
    return {
      ...rest,
      judgment,
      ...(summary ? { summary } : {}),
      ...(uncertainty ? { uncertainty } : {}),
      suggestedType,
      suggestedScope,
      sourceRefs,
      ...(learningSignal ? { learningSignal } : current.learningSignal ? { learningSignal: current.learningSignal } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  return asCandidate(updated);
}

export function deferRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return transitionCandidate(userId, candidateId, 'deferred', note);
}

export function resumeRecallCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  return transitionCandidate(userId, candidateId, 'pending');
}

export function rejectRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return transitionCandidate(userId, candidateId, 'rejected', note);
}

export async function promoteRecallCandidate(
  userId: string,
  candidateId: string,
  options: { ontologyRefs?: AbilityAssetOntologyRef[] } & AbilityAssetSemantics = {},
): Promise<{ candidate: RecallCandidateRecord; asset: RecallAbilityAssetRecord }> {
  try {
    // 语义字段在写盘前先校验，避免半写状态：候选已翻 promoted 但资产字段非法。
    const optionSemantics = readAbilityAssetSemantics(options as Record<string, unknown>);
    const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, async (current) => {
      if (!current) throw new Error('recall candidate not found');
      const candidate = asCandidate(current);
      if (candidate.status === 'promoted') return candidate;
      if (candidate.status === 'rejected') throw new Error('recall candidate is terminal');
      const recoveredAsset = (await listAbilityAssets(userId))
        .find((asset) => asset.candidateId === candidate.id);
      if (recoveredAsset) {
        await initializeAbilityAsset(userId, recoveredAsset);
        return {
          ...candidate,
          status: 'promoted',
          promotedAssetId: recoveredAsset.id,
          promotionErrorCode: undefined,
          promotionErrorMessage: undefined,
          promotionFailedAt: undefined,
          updatedAt: new Date().toISOString(),
        };
      }
      const now = new Date().toISOString();
      const sourceSessionIds = sourceSessionIdsFrom(candidate.sourceRefs);
      const asset: RecallAbilityAssetRecord = {
        schemaVersion: 1,
        ownerId: userId,
        id: abilityAssetIdForCandidate(candidate.id),
        candidateId: candidate.id,
        type: candidate.suggestedType,
        title: candidate.summary || candidate.judgment.slice(0, 120),
        statement: candidate.judgment,
        evidenceRefs: candidate.sourceRefs,
        ...(candidate.learningSignal ? { learningSignal: candidate.learningSignal } : {}),
        ...(options.ontologyRefs?.length ? { ontologyRefs: options.ontologyRefs } : {}),
        // 候选自带的适用/禁用条件作为底，调用方显式传入的可覆盖。
        // 此前只认 options，于是自动链路产出的资产永远没有边界——
        // 只有手动 promote 且调用方主动传参时才有，等于形同虚设。
        ...(candidate.applicableWhen ? { applicableWhen: candidate.applicableWhen } : {}),
        ...(candidate.forbiddenWhen ? { forbiddenWhen: candidate.forbiddenWhen } : {}),
        ...optionSemantics,
        scope: candidate.suggestedScope,
        status: 'active',
        maturity: 'seed',
        version: '1',
        ...(candidate.confidence !== undefined ? { confidence: candidate.confidence } : {}),
        ...(sourceSessionIds.length ? { sourceSessionIds } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await writeRecallJsonRecord(userId, 'ability-assets', asset.id, asset);
      await initializeAbilityAsset(userId, asset);
      return {
        ...candidate,
        status: 'promoted',
        promotedAssetId: asset.id,
        promotionErrorCode: undefined,
        promotionErrorMessage: undefined,
        promotionFailedAt: undefined,
        updatedAt: now,
      };
    });
    const candidate = asCandidate(updated);
    if (!candidate.promotedAssetId) throw new Error('promoted candidate has no ability asset');
    const storedAsset = await readRecallJsonRecord(userId, 'ability-assets', candidate.promotedAssetId);
    if (!storedAsset) throw new Error('promoted ability asset not found');
    return { candidate, asset: asAsset(storedAsset) };
  } catch (error) {
    const message = boundedText(
      error instanceof Error ? error.message : String(error),
      'promotion error',
      500,
    ) || 'Recall asset write failed';
    await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
      if (!current) return current;
      const candidate = asCandidate(current);
      if (candidate.status === 'promoted' || candidate.status === 'rejected') return candidate;
      return {
        ...candidate,
        promotionErrorCode: 'asset_write_failed',
        promotionErrorMessage: message,
        promotionFailedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }).catch(() => undefined);
    throw error;
  }
}
