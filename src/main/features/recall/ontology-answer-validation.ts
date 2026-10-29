import { createHash, randomUUID } from 'node:crypto';

import type { JevClient, JevDecision, JevEvaluationResult } from '../jev/types';
import { appendRecallJsonlRecord } from './store';
import type { RecallJsonRecord } from './types';
import type { OntologyAssetQueryEvidenceEdge, OntologyAssetQueryResult } from './ontology-asset-query';

const RESULT_VALIDATION_QUESTION_ID = 'ontology-answer-evidence-v1';
const ANSWER_CANDIDATE_ID = 'answer-draft';
const DEFAULT_VALIDATION_SCORE = 0.7;

export interface AnswerAssetEvidence {
  assetId: string;
  title: string;
  version: string;
  statement: string;
}

export interface AnswerRelationEvidence {
  query: string;
  result?: OntologyAssetQueryResult;
  /** Relation paths attached by automatic Semantica projection. These are
   * emitted only for candidates whose content was actually injected. */
  paths?: readonly AnswerRelationPathEvidence[];
}

export interface AnswerRelationPathEvidence {
  entryAssetId: string;
  entryTitle: string;
  assetId: string;
  assetTitle: string;
  distance: number;
  relationKind?: OntologyAssetQueryEvidenceEdge['kind'];
  direction?: 'incoming' | 'outgoing' | 'both';
  maxHops?: number;
  evidencePath: readonly OntologyAssetQueryEvidenceEdge[];
}

export interface OntologyAnswerEvidenceBundle {
  assets: AnswerAssetEvidence[];
  relations: AnswerRelationEvidence[];
  /** Original task plus the current follow-up. Used only by the turn-local
   * final validator and never persisted in its receipt. */
  taskText?: string;
}

export interface OntologyAnswerValidationInput {
  query: string;
  answer: string;
  assets?: readonly AnswerAssetEvidence[];
  relations?: readonly AnswerRelationEvidence[];
  requestId?: string;
}

export interface OntologyAnswerValidationOptions {
  jev?: JevClient;
  signal?: AbortSignal;
  minimumScore?: number;
  rolloutKey?: string;
  /** Jev observes by default; enforcement is opt-in for controlled tests. */
  mode?: 'observe' | 'enforce';
}

export interface OntologyAnswerValidationChecks {
  evidenceAvailable: boolean;
  citationsPresent: boolean;
  citationsValid: boolean;
  relationDirectionConsistent: boolean;
  directnessConsistent: boolean;
  answerFullyCoveredByJev: boolean;
}

export interface OntologyAnswerValidationResult {
  status: 'validated' | 'observed' | 'rejected' | 'fallback' | 'insufficient';
  answer: string;
  originalAnswer: string;
  reason: string;
  checks: OntologyAnswerValidationChecks;
  jev?: JevEvaluationResult;
}

export interface OntologyAnswerValidationReceipt extends RecallJsonRecord {
  schemaVersion: 1;
  queryHash: string;
  answerHash: string;
  approvedAnswerHash: string;
  status: OntologyAnswerValidationResult['status'];
  reason: string;
  assetIds: string[];
  relationPathCount: number;
  jevStatus?: 'ok' | 'fallback';
  jevFallbackReason?: string;
  jevAttempts?: number;
  jevLatencyMs?: number;
  jevDecisionType?: JevDecision['type'];
  jevScore?: number;
  answerFullyCoveredByJev: boolean;
  createdAt: string;
}

function compact(value: unknown, maxLength: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

const JEV_ANSWER_SUMMARY_LIMIT = 2_000;

function answerSummary(answer: string): { summary: string; complete: boolean } {
  const normalized = compact(answer, 12_000);
  const prefix = `ANSWER_COMPLETE chars=${normalized.length}: `;
  if (prefix.length + normalized.length <= JEV_ANSWER_SUMMARY_LIMIT) {
    return { summary: prefix + normalized, complete: true };
  }
  const marker = ` ANSWER_MIDDLE_OMITTED total_chars=${normalized.length} `;
  const available = JEV_ANSWER_SUMMARY_LIMIT - marker.length;
  const headLength = Math.ceil(available * 0.62);
  return {
    summary: normalized.slice(0, headLength) + marker + normalized.slice(-(available - headLength)),
    complete: false,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedScore(value: unknown): number {
  const score = Number(value);
  if (!Number.isFinite(score)) return DEFAULT_VALIDATION_SCORE;
  return Math.max(0, Math.min(1, score));
}

function okRelations(relations: readonly AnswerRelationEvidence[]): Array<Extract<OntologyAssetQueryResult, { status: 'ok' }>> {
  return relations.flatMap(({ result }) => result?.status === 'ok' ? [result] : []);
}

function projectedRelationPaths(relations: readonly AnswerRelationEvidence[]): AnswerRelationPathEvidence[] {
  return relations.flatMap((relation) => relation.paths || []);
}

function evidenceLines(input: OntologyAnswerValidationInput): string[] {
  const lines: string[] = [];
  for (const asset of input.assets || []) {
    lines.push(compact(
      `ASSET ${asset.title} [${asset.assetId}] version=${asset.version}: ${asset.statement}`,
      1_000,
    ));
  }
  for (const result of okRelations(input.relations || [])) {
    lines.push(compact(
      `ONTOLOGY_QUERY target=${result.target.title} [${result.target.id}] relation=${result.intent.relationKind || 'any'} direction=${result.intent.direction} maxHops=${result.intent.maxHops} matches=${result.matches.length}`,
      1_000,
    ));
    for (const match of result.matches) {
      const path = match.evidencePath.map(formatEdge).join(' ; ');
      lines.push(compact(
        `RELATION target=${result.target.title} [${result.target.id}] match=${match.asset.title} [${match.asset.id}] distance=${match.distance}: ${path}`,
        1_000,
      ));
    }
  }
  for (const path of projectedRelationPaths(input.relations || [])) {
    lines.push(compact(
      `AUTO_RELATION entry=${path.entryTitle} [${path.entryAssetId}] match=${path.assetTitle} [${path.assetId}] relation=${path.relationKind || 'mixed'} direction=${path.direction || 'both'} distance=${path.distance}: ${path.evidencePath.map(formatEdge).join(' ; ')}`,
      1_000,
    ));
  }
  return lines.filter(Boolean).slice(0, 16);
}

function formatEdge(edge: OntologyAssetQueryEvidenceEdge): string {
  return `${edge.fromTitle} [${edge.fromAssetId}] -${edge.kind}-> ${edge.toTitle} [${edge.toAssetId}]`;
}

function evidenceAssetIds(input: OntologyAnswerValidationInput): Set<string> {
  const ids = new Set((input.assets || []).map((asset) => asset.assetId));
  for (const result of okRelations(input.relations || [])) {
    ids.add(result.target.id);
    for (const match of result.matches) ids.add(match.asset.id);
  }
  for (const path of projectedRelationPaths(input.relations || [])) {
    ids.add(path.entryAssetId);
    ids.add(path.assetId);
  }
  return ids;
}

function citedAssetIds(answer: string): string[] {
  return [...answer.matchAll(/\[asset:([A-Za-z0-9_-]+)\]/g)].map((match) => match[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DIRECTIONAL_RELATION_TERMS: Partial<Record<OntologyAssetQueryEvidenceEdge['kind'], readonly string[]>> = {
  depends_on: ['依赖于', '依赖', 'depends on', 'depend on'],
  replaces: ['替代', '取代', 'replaces', 'replace'],
  refines: ['细化', '完善', 'refines', 'refine'],
};

function hasReversedRelationClaim(answer: string, edge: OntologyAssetQueryEvidenceEdge): boolean {
  const terms = DIRECTIONAL_RELATION_TERMS[edge.kind];
  if (!terms?.length) return false;
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, '');
  const normalized = normalize(answer);
  const fromAliases = [edge.fromTitle, `[asset:${edge.fromAssetId}]`]
    .map((value) => escapeRegExp(normalize(value)));
  const toAliases = [edge.toTitle, `[asset:${edge.toAssetId}]`]
    .map((value) => escapeRegExp(normalize(value)));
  const relation = terms.map((term) => escapeRegExp(normalize(term))).join('|');
  return toAliases.some((to) => fromAliases.some((from) => (
    new RegExp(`${to}.{0,40}(?:${relation}).{0,40}${from}`, 'u').test(normalized)
  )));
}

function deterministicChecks(input: OntologyAnswerValidationInput): OntologyAnswerValidationChecks {
  const lines = evidenceLines(input);
  const allowedIds = evidenceAssetIds(input);
  const citations = citedAssetIds(input.answer);
  const distances = okRelations(input.relations || []).flatMap((result) => result.matches.map((match) => match.distance));
  distances.push(...projectedRelationPaths(input.relations || []).map((path) => path.distance));
  const relationEdges = okRelations(input.relations || [])
    .flatMap((result) => result.matches.flatMap((match) => match.evidencePath));
  relationEdges.push(...projectedRelationPaths(input.relations || []).flatMap((path) => path.evidencePath));
  // "直接/间接" is ordinary language in many non-ontology answers (for
  // example, "直接加热"). Only interpret it as relation terminology when
  // this turn actually supplied relation-distance evidence.
  const directnessConsistent = distances.length === 0 || (
    (!/(?:直接|直连|direct(?:ly)?)/iu.test(input.answer) || distances.some((distance) => distance === 1))
    && (!/(?:间接|多跳|indirect(?:ly)?)/iu.test(input.answer) || distances.some((distance) => distance > 1))
  );
  return {
    evidenceAvailable: lines.length > 0,
    citationsPresent: citations.length > 0,
    // Asset markers are an optional user-facing affordance. Grounding is
    // carried by the turn-local evidence bundle and persisted receipts, so a
    // normal answer does not have to expose implementation IDs to be valid.
    citationsValid: citations.every((id) => allowedIds.has(id)),
    relationDirectionConsistent: !relationEdges.some((edge) => hasReversedRelationClaim(input.answer, edge)),
    directnessConsistent,
    answerFullyCoveredByJev: answerSummary(input.answer).complete,
  };
}

function asksForTechnicalRelationEvidence(query: string): boolean {
  return /(?:本体|证据路径|关系路径|几跳|跳关系|直接关系|间接关系|关系类型|依赖关系|哪些资产.{0,20}依赖|ontology|evidence\s+path|relation\s+path|direct\s+relation|indirect\s+relation)/iu.test(query);
}

function conservativeAnswer(input: OntologyAnswerValidationInput): string {
  if (!asksForTechnicalRelationEvidence(input.query)) {
    const assetLines = (input.assets || []).map((asset) => (
      `- ${asset.title}：${compact(asset.statement, 500)}`
    ));
    if (!assetLines.length) return '这次没有足够的已读取经验来可靠完成回答，请重试。';
    return [
      '这次生成的具体回答没有通过证据校验，下面只保留当前已确认可用的经验：',
      ...assetLines,
      '你可以重试，系统会继续基于这些经验生成更自然的结果。',
    ].join('\n');
  }

  const sections: string[] = [];
  const relationLines: string[] = [];
  for (const result of okRelations(input.relations || [])) {
    if (!result.matches.length) {
      relationLines.push(
        `- 对“${result.target.title}”的当前查询未发现符合条件的已持久化关系。`,
      );
    }
    for (const match of result.matches) {
      relationLines.push(`- ${match.distance === 1 ? '直接相关' : '间接相关'}：${match.asset.title}`);
    }
  }
  for (const path of projectedRelationPaths(input.relations || [])) {
    relationLines.push(`- ${path.distance === 1 ? '直接相关' : '间接相关'}：${path.assetTitle}`);
  }
  if (relationLines.length) sections.push('根据当前已保存的关系，可以确认：', ...relationLines);

  const assetLines = (input.assets || []).map((asset) => (
    `- ${asset.title}：${compact(asset.statement, 500)}`
  ));
  if (assetLines.length) sections.push('相关经验：', ...assetLines);
  if (!sections.length) return '当前没有足够的已读取资产或关系证据，无法确认该结论。';
  sections.push('以上只包含当前证据能够支持的内容。');
  return sections.join('\n');
}

function hardFailure(checks: OntologyAnswerValidationChecks): string | undefined {
  if (!checks.evidenceAvailable) return '没有可用于验证的已读取资产或关系证据';
  if (checks.citationsPresent && !checks.citationsValid) return '回答引用了本回合证据集合之外的资产';
  if (!checks.relationDirectionConsistent) return '回答中的关系方向与证据路径相反';
  if (!checks.directnessConsistent) return '回答的直接或间接关系表述与证据跳数不一致';
  return undefined;
}

export async function validateOntologyAnswer(
  input: OntologyAnswerValidationInput,
  options: OntologyAnswerValidationOptions = {},
): Promise<OntologyAnswerValidationResult> {
  const normalized: OntologyAnswerValidationInput = {
    ...input,
    query: compact(input.query, 4_000),
    answer: String(input.answer || '').trim().slice(0, 12_000),
  };
  const checks = deterministicChecks(normalized);
  const deterministicFailure = hardFailure(checks);
  if (!checks.evidenceAvailable) {
    return {
      status: 'insufficient',
      answer: conservativeAnswer(normalized),
      originalAnswer: normalized.answer,
      reason: deterministicFailure!,
      checks,
    };
  }
  if (deterministicFailure) {
    return {
      status: 'rejected',
      answer: conservativeAnswer(normalized),
      originalAnswer: normalized.answer,
      reason: deterministicFailure,
      checks,
    };
  }

  // Production validation is deliberately local-only: governed evidence,
  // citation membership, relationship direction and hop semantics are hard
  // checks. External judges remain injectable for isolated experiments, but
  // are never created implicitly from product settings or environment state.
  if (!options.jev) {
    return {
      status: 'validated',
      answer: normalized.answer,
      originalAnswer: normalized.answer,
      reason: '回答通过本地确定性证据与关系检查',
      checks,
    };
  }

  const requestId = compact(input.requestId || `result-${randomUUID()}`, 160);
  const strictRelationValidation = asksForTechnicalRelationEvidence(normalized.query);
  const mode = options.mode || 'observe';
  const jev = options.jev;
  const summary = answerSummary(normalized.answer);
  const hasRelationEvidence = okRelations(normalized.relations || []).length > 0
    || projectedRelationPaths(normalized.relations || []).length > 0;
  const evaluation = await jev.evaluate({
    requestId,
    gate: 'result_validation',
    question: {
      id: RESULT_VALIDATION_QUESTION_ID,
      kind: 'evidence_check',
      text: strictRelationValidation
        ? '判断回答中的本体关系结论是否受资产正文和关系路径支持，尤其检查关系方向、直接/间接含义及是否超出证据；用户可见回答不要求展示资产 ID、关系路径或引用标记，不要仅因缺少这些展示性标记而拒绝；证据不充分时返回 none。'
        : '判断回答是否遵守了能力资产提供的方法、约束和禁用边界。资产在普通任务中是生成指导，不是回答中每个菜名、金额、日期或执行细节的唯一事实来源；不要因为模型基于用户请求补充了合理的具体方案而拒绝。只有回答违背资产的关键约束或冒充资产中不存在的事实时才返回 none。',
    },
    query: normalized.query || '验证能力资产证据回答',
    candidates: [{
      id: ANSWER_CANDIDATE_ID,
      summary: summary.summary,
      source: (normalized.assets?.length || 0) > 0 && hasRelationEvidence
        ? 'hybrid'
        : hasRelationEvidence ? 'ontology' : 'semantic',
      evidence: evidenceLines(normalized),
    }],
  }, { ...(options.signal ? { signal: options.signal } : {}) });

  if (evaluation.status !== 'ok') {
    return {
      status: 'fallback',
      answer: normalized.answer,
      originalAnswer: normalized.answer,
      reason: `Jev 不可用；确定性引用和关系检查已通过：${evaluation.reason}`,
      checks,
      jev: evaluation,
    };
  }

  const decision = evaluation.response.decision;
  const threshold = boundedScore(options.minimumScore);
  const accepted = decision.type === 'select'
    ? decision.candidateIds.includes(ANSWER_CANDIDATE_ID)
    : decision.type === 'score'
      ? (decision.scores.find((entry) => entry.candidateId === ANSWER_CANDIDATE_ID)?.score || 0) >= threshold
      : false;
  return accepted && summary.complete
    ? {
      status: 'validated',
      answer: normalized.answer,
      originalAnswer: normalized.answer,
      reason: '回答通过本地硬检查和 Jev 证据充分性判断',
      checks,
      jev: evaluation,
    }
    : accepted
      ? {
        status: 'observed',
        answer: normalized.answer,
        originalAnswer: normalized.answer,
        reason: 'Jev 对回答摘要判断通过，但完整回答超过校验窗口；观察模式保留已生成结果',
        checks,
        jev: evaluation,
      }
    : mode === 'enforce' && strictRelationValidation
      ? {
        status: 'rejected',
        answer: conservativeAnswer(normalized),
        originalAnswer: normalized.answer,
        reason: decision.type === 'clarify'
          ? decision.question
          : decision.type === 'none'
            ? decision.reason || 'Jev 判定回答缺少充分证据'
            : `Jev 证据充分性评分低于 ${threshold}`,
        checks,
        jev: evaluation,
      }
      : {
        status: 'observed',
        answer: normalized.answer,
        originalAnswer: normalized.answer,
        reason: decision.type === 'clarify'
          ? `Jev 建议补充信息，但观察模式保留已生成结果：${decision.question}`
          : decision.type === 'none'
            ? `Jev 建议复核，但观察模式保留已生成结果：${decision.reason || '未选择回答候选'}`
            : `Jev 适用性评分低于 ${threshold}，但观察模式保留已生成结果`,
        checks,
        jev: evaluation,
      };
}

export async function recordOntologyAnswerValidation(
  userId: string,
  input: OntologyAnswerValidationInput,
  result: OntologyAnswerValidationResult,
): Promise<OntologyAnswerValidationReceipt> {
  const evaluation = result.jev;
  const decision = evaluation?.status === 'ok' ? evaluation.response.decision : undefined;
  const score = decision?.type === 'score'
    ? decision.scores.find((entry) => entry.candidateId === ANSWER_CANDIDATE_ID)?.score
    : undefined;
  const receipt: OntologyAnswerValidationReceipt = {
    schemaVersion: 1,
    ownerId: userId,
    id: `oav-${randomUUID()}`,
    queryHash: hash(String(input.query || '')),
    answerHash: hash(result.originalAnswer),
    approvedAnswerHash: hash(result.answer),
    status: result.status,
    reason: compact(result.reason, 500),
    assetIds: [...evidenceAssetIds(input)].sort(),
    relationPathCount: okRelations(input.relations || []).reduce((count, item) => count + item.matches.length, 0)
      + projectedRelationPaths(input.relations || []).length,
    ...(evaluation ? { jevStatus: evaluation.status, jevAttempts: evaluation.attempts } : {}),
    ...(evaluation?.latencyMs !== undefined ? { jevLatencyMs: evaluation.latencyMs } : {}),
    ...(decision ? { jevDecisionType: decision.type } : {}),
    ...(score !== undefined ? { jevScore: score } : {}),
    ...(evaluation?.status === 'fallback' ? { jevFallbackReason: evaluation.reason } : {}),
    answerFullyCoveredByJev: result.checks.answerFullyCoveredByJev,
    createdAt: new Date().toISOString(),
  };
  await appendRecallJsonlRecord(userId, 'ontology-answer-validations', 'events', receipt);
  return receipt;
}
