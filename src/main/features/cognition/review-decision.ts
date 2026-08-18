/**
 * Review Decision Ledger — 候选审查决定的审计记录（PRD §9.1 ReviewDecision）。
 *
 * 解决两个产品契约问题：
 * 1. 短确认语前指绑定（FR-REV-03）："采用/确认/是"必须绑定原建议
 *    （antecedent_ref）、决定类型、作用域和替代关系；无法唯一解析时
 *    不得写入（调用方必须显式传 antecedent_ref，缺省拒绝）。
 * 2. 拒绝/暂缓抑制（FR-EXT-07）：同候选被 defer/reject 后，无新 Evidence
 *    不得重复提示——列表层通过本账本过滤（不侵入三个底层候选存储）。
 *
 * 存储：`<uid>/cloud/mate_agent/review-decisions/<candidate_id>.jsonl`
 * （append-only；每候选一文件；与资产事件账本同模式）。
 */

import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { appendJsonlAtomic, readJsonl, nowIso } from '../../storage';
import { mateAgentReviewDecisionsDir } from '../../paths';
import { maskId } from '../../util/log-redact';

const log = createLogger('review-decision');

/** 候选审查四决定（PRD §5.6 候选卡：保存/修改后保存/暂缓/拒绝）。 */
export type ReviewDecisionType = 'accept' | 'modify' | 'defer' | 'reject' | 'ignore' | 'keep_current' | 'trial';
export type ReviewDecisionActor = 'user' | 'system';

export interface ReviewDecision {
  decision_id: string;
  /** 被审查的候选（稳定 ID，如 `p3394_experience:xxx`）。 */
  target_ref: string;
  /** 前指建议（短确认语场景必填；无唯一前指不得写入）。 */
  antecedent_ref?: string;
  decision_type: ReviewDecisionType;
  /** 用户原始表达或规范化决定。 */
  decision: string;
  /** Who applied the decision. Automatic capture writes are explicitly system-authored. */
  actor?: ReviewDecisionActor;
  /** 作用域（PRD：必须绑定作用域；缺省 'default'）。 */
  scope?: string;
  /** 来源信号引用（Teaching Signal / 对话消息 id）。 */
  source_signal_ref?: string;
  /** 被取代的旧决定（如 reject 后 accept 覆盖）。 */
  supersedes_ref?: string;
  reason?: string;
  /** modify 时的用户修改内容。 */
  modified_content?: string;
  /** Stable retry boundary supplied by the confirmation workflow. */
  idempotency_key?: string;
  asset_id?: string;
  outcome?: 'recorded' | 'asset_created' | 'asset_failed';
  failure_code?: string;
  timestamp: string;
}

export interface WriteReviewDecisionInput {
  targetRef: string;
  decisionType: ReviewDecisionType;
  decision: string;
  actor?: ReviewDecisionActor;
  antecedentRef?: string;
  scope?: string;
  sourceSignalRef?: string;
  supersedesRef?: string;
  reason?: string;
  modifiedContent?: string;
  idempotencyKey?: string;
  decisionId?: string;
}

function assertDecisionType(v: unknown): asserts v is ReviewDecisionType {
  const allowed: readonly string[] = ['accept', 'modify', 'defer', 'reject', 'ignore', 'keep_current', 'trial'];
  if (typeof v !== 'string' || !allowed.includes(v)) throw new Error('invalid review decision type');
}

/** 短确认语义：decision 属于 "采用/确认/是" 类短确认时必须带 antecedent_ref。 */
const SHORT_CONFIRMATIONS = new Set(['accept', 'yes', 'confirm', '采用', '确认', '是', 'ok', 'yes']);

export function isShortConfirmation(decision: string): boolean {
  return SHORT_CONFIRMATIONS.has(decision.trim().toLowerCase());
}

export function reviewDecisionLogPath(uid: string, targetRef: string): string {
  // targetRef 可能是 `source:xxx` 形式——文件名仅取候选 id 段，防止路径注入
  const safeTail = targetRef.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(mateAgentReviewDecisionsDir(uid), `${safeTail}.jsonl`);
}

/**
 * 写入一条审查决定。短确认语缺 antecedent_ref 时拒绝写入
 * （FR-REV-03：无法唯一解析时不得生效，正式资产零变化）。
 */
export async function writeReviewDecision(
  uid: string,
  input: WriteReviewDecisionInput,
): Promise<ReviewDecision> {
  if (!input.targetRef || typeof input.targetRef !== 'string') throw new Error('invalid review target');
  assertDecisionType(input.decisionType);
  if (!input.decision || typeof input.decision !== 'string') throw new Error('invalid review decision');
  if (input.actor !== undefined && input.actor !== 'user' && input.actor !== 'system') {
    throw new Error('invalid review decision actor');
  }
  if (isShortConfirmation(input.decision) && !input.antecedentRef) {
    throw new Error('short confirmation requires antecedent_ref');
  }

  const normalizedKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (normalizedKey) {
    const existing = (await listReviewDecisions(uid, input.targetRef))
      .find((decision) => decision.idempotency_key === normalizedKey);
    if (existing) return existing;
  }
  const decisionId = input.decisionId || (normalizedKey
    ? `rd_${createHash('sha256').update(`${input.targetRef}\n${normalizedKey}`).digest('hex').slice(0, 24)}`
    : `rd_${randomUUID().replace(/-/g, '').slice(0, 24)}`);
  if (!/^rd_[A-Za-z0-9_-]{8,64}$/.test(decisionId)) throw new Error('invalid review decision id');
  const record: ReviewDecision = {
    decision_id: decisionId,
    target_ref: input.targetRef,
    ...(input.antecedentRef ? { antecedent_ref: input.antecedentRef } : {}),
    decision_type: input.decisionType,
    decision: input.decision,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.sourceSignalRef ? { source_signal_ref: input.sourceSignalRef } : {}),
    ...(input.supersedesRef ? { supersedes_ref: input.supersedesRef } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.modifiedContent ? { modified_content: input.modifiedContent } : {}),
    ...(normalizedKey ? { idempotency_key: normalizedKey } : {}),
    outcome: 'recorded',
    timestamp: nowIso(),
  };
  await appendJsonlAtomic<ReviewDecision>(reviewDecisionLogPath(uid, input.targetRef), record);
  log.info(`review decision actor=${input.actor || 'user'} user=${maskId(uid)} target=${maskId(input.targetRef)} type=${input.decisionType}`);
  return record;
}

export async function readReviewDecision(
  uid: string,
  targetRef: string,
  decisionId: string,
): Promise<ReviewDecision | undefined> {
  return (await listReviewDecisions(uid, targetRef)).find((decision) => decision.decision_id === decisionId);
}

/** Append the immutable outcome of a decision. Latest record for the id is authoritative. */
export async function recordReviewDecisionOutcome(
  uid: string,
  targetRef: string,
  decisionId: string,
  outcome: { assetId?: string; failureCode?: string },
): Promise<ReviewDecision> {
  const current = await readReviewDecision(uid, targetRef, decisionId);
  if (!current) throw new Error('review decision not found');
  if (current.asset_id) return current;
  const updated: ReviewDecision = {
    ...current,
    ...(outcome.assetId ? { asset_id: outcome.assetId } : {}),
    failure_code: outcome.failureCode,
    outcome: outcome.assetId ? 'asset_created' : 'asset_failed',
    timestamp: nowIso(),
  };
  await appendJsonlAtomic<ReviewDecision>(reviewDecisionLogPath(uid, targetRef), updated);
  return updated;
}

/** 某候选的全部审查决定（按追加顺序）。 */
export async function listReviewDecisions(uid: string, targetRef: string): Promise<ReviewDecision[]> {
  const records = await readJsonl<ReviewDecision>(reviewDecisionLogPath(uid, targetRef), 10000);
  const latest = new Map<string, ReviewDecision>();
  for (const record of records) {
    // Reinsert outcome records so decision order follows the append-only ledger,
    // rather than the first occurrence of a decision id.
    latest.delete(record.decision_id);
    latest.set(record.decision_id, record);
  }
  return [...latest.values()];
}

/**
 * 该候选是否被"抑制"（最近决定为 defer 或 reject，且之后没有 accept 覆盖）。
 * 列表层据此过滤，避免同一 Evidence 重复提示（FR-EXT-07）。
 */
export async function isCandidateSuppressed(uid: string, targetRef: string): Promise<boolean> {
  const decisions = await listReviewDecisions(uid, targetRef);
  if (!decisions.length) return false;
  const last = decisions[decisions.length - 1];
  return last.decision_type === 'defer'
    || last.decision_type === 'reject'
    || last.decision_type === 'ignore'
    || last.decision_type === 'keep_current';
}
