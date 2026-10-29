/**
 * 转写纠错 · 高危候选的**用户点选确认**状态机（会议工作流用）
 *
 * 为什么需要它：纠错引擎对两字中文词一律派生 `high` 且**不自动应用**——这正确地
 * 拦住了「建立健全的机制 → 建立鉴权的机制」那类事故，但也意味着这类替换必须由人
 * 逐条拍板。面板里这件事是人点出来的；当纠错由 **agent 在会议流程里**执行时，
 * agent 没有界面，只能把"要问什么"交给渲染层渲染成一张可点选的卡片，再把结果取回。
 *
 * 与 `delete-file-confirm` 同构（照搬其 token 模型，含它踩过的坑）：
 *
 *   1. 工具调用 `createGlossaryConfirmation(...)` → 同步拿到 token；
 *      同时 `broadcastToRenderer('transcript_glossary.confirmation_required', ...)`
 *      把候选清单推给渲染层。
 *   2. 工具 `await waitForGlossaryConfirmationVisible(token)` —— 等渲染层确认卡片
 *      **真的挂上了**再告诉模型"让用户去点"。不等就返回，会让模型对着不存在的卡片
 *      说"请点击"，用户看不到任何东西（这是 delete_file 那套明确记录过的问题）。
 *   3. 用户勾选 → 渲染层 `transcript_glossary.confirm` → `resolveGlossaryConfirmation`
 *      把 `accepted` 集合落进 token 条目。
 *   4. 模型（**下一轮**，用户回复之后）再调 `transcript_glossary_apply`
 *      带上 `confirmation_token` → 工具 `consumeGlossaryConfirmation` 取回选中的
 *      `entryRef` 列表，把它们作为 `acceptedIds` 交给 `applyCorrections`。
 *      `acceptedIds` 一旦提供就**完全取代**风险等级过滤，所以未被勾选的高危项
 *      不会因为"顺便放开了 high"而被改掉。
 *
 * 三个刻意的不变量：
 *   - **一次性**：consume 即删，令牌不可重放（用户只授权了那一次）。
 *   - **绑定正文**：条目里存正文 sha256；consume 时比对，正文变了就判 `stale`，
 *     避免"用户对着 A 稿点的勾"被套用到 B 稿上。
 *   - **未勾选 = 不改**：`accepted` 为空也是合法结果（用户全不选），
 *     此时只应用非高危项，且如实告知。
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { userTranscriptInteractionDir } from '../paths';
import { readJsonSync, writeJsonSync, safeId } from '../storage';
import { broadcastToRenderer } from '../ipc';
import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import type { CorrectionCandidate } from './transcript_auto_correct';

const log = createLogger('glossary-confirm');

/** 与 delete-file-confirm 同量级：够用户开完会回来点，又不至于堆一堆僵尸令牌。 */
const CONFIRM_TTL_MS = 30 * 60_000;
const _GC_INTERVAL_MS = 5 * 60_000;
/** 等渲染层"卡片已挂载"确认的时限。超时不算失败——卡片可能仍然可点，只是没回执。 */
const CONFIRM_VISIBLE_ACK_TIMEOUT_MS = 1200;

/** 推给渲染层的候选行（已按 entryRef 聚合，一条词一次决定）。 */
export interface GlossaryConfirmItem {
  /** 扫描期 ref：consume 时按它回填 `acceptedIds`。 */
  entryRef: string;
  wrong: string;
  correct: string;
  action: 'replace' | 'delete';
  riskLevel: 'low' | 'medium' | 'high';
  /** 命中次数（同一词在正文出现多次）。 */
  count: number;
  /** 首次命中的上下文预览，供用户判断。 */
  context: string;
  /** 该词条被忽略过的次数（>0 = 降权，默认不勾）。 */
  ignoredCount: number;
  fromModel?: boolean;
}

interface Entry {
  agentId?: string;
  taskId?: string;
  resumePromise?: Promise<void>;
  userId?: string;
  cid?: string;
  docId: string;
  textSha256: string;
  items: GlossaryConfirmItem[];
  accepted: Set<string> | null;
  /** Refs the human actually decided. Absent = every item on the card. A
   * partial text reply leaves the rest for a fresh, smaller card. */
  decided?: string[];
  /** User-supplied replacement text per accepted ref (「X 是 Y」). */
  rewrites?: Record<string, string>;
  /** A text reply to this card could not be read as decisions. A bare 「确认」
   * after that most likely answers the Agent's clarifying question, not the
   * card, so it must not approve every item. */
  unparsedReply?: boolean;
  visible: boolean;
  created_at_ms: number;
}

const _entries = new Map<string, Entry>();
function loadEntries(userId: string): void {
  if (!safeId(userId)) return;
  const saved = readJsonSync<any>(path.join(userTranscriptInteractionDir(userId), 'confirmations.json'));
  for (const row of Array.isArray(saved?.entries) ? saved.entries : []) {
    if (row.userId !== userId || typeof row.token !== 'string' || _entries.has(row.token)
      || !Array.isArray(row.items) || !Number.isFinite(row.created_at_ms) || Date.now() - row.created_at_ms > CONFIRM_TTL_MS) continue;
    _entries.set(row.token, { ...row, accepted: Array.isArray(row.accepted) ? new Set(row.accepted) : null });
  }
}
function persistEntries(userId?: string): void {
  if (!userId || !safeId(userId)) return;
  writeJsonSync(path.join(userTranscriptInteractionDir(userId), 'confirmations.json'), { entries:
    [..._entries].filter(([, entry]) => entry.userId === userId && Date.now() - entry.created_at_ms <= CONFIRM_TTL_MS)
      .map(([token, { resumePromise: _resume, ...entry }]) => ({ ...entry, token, accepted: entry.accepted ? [...entry.accepted] : null })) });
}
const _visibleWaiters = new Map<string, Array<{ resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>>();

export interface CreateGlossaryConfirmationInput {
  agentId?: string;
  taskId?: string;
  userId?: string;
  text: string;
  docId: string;
  items: GlossaryConfirmItem[];
  /** 触发这次确认的会话 id，渲染层据此把卡片挂到正确的对话容器。 */
  cid?: string;
  /** 当前可见的 actor turn，渲染层据此把同一轮的多张卡片合并。 */
  turnId?: string;
}

export interface CreateGlossaryConfirmationResult {
  token: string;
  /** 渲染层是否在时限内确认卡片已挂载。false 时仍可让用户点，但要在文案上兜底。 */
  visible: boolean;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function resolveVisibleWaiters(token: string, ok: boolean): void {
  const waiters = _visibleWaiters.get(token);
  if (!waiters) return;
  _visibleWaiters.delete(token);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(ok);
  }
}

function deleteEntry(token: string): boolean {
  const userId = _entries.get(token)?.userId;
  const existed = _entries.delete(token);
  persistEntries(userId);
  resolveVisibleWaiters(token, false);
  return existed;
}

// 单次周期 GC：过期的（无论是否已被确认）一律清掉，避免 granted 令牌长期滞留。
setInterval(() => {
  const now = Date.now();
  for (const [token, e] of _entries) {
    if (now - e.created_at_ms > CONFIRM_TTL_MS) deleteEntry(token);
  }
}, _GC_INTERVAL_MS).unref?.();

/**
 * 造一张待点选的卡片：发广播 + 返回 token，并**等到渲染层确认已挂载**才返回。
 *
 * 返回 `visible: false` 不代表失败：可能是渲染层没有对应容器（例如后台会话），
 * 卡片仍可点。调用方据此决定是否在文案里加一句"如果没看到卡片，请告诉我"。
 */
export async function createGlossaryConfirmation(
  input: CreateGlossaryConfirmationInput,
): Promise<CreateGlossaryConfirmationResult> {
  if (input.userId) loadEntries(input.userId);
  const token = crypto.randomBytes(12).toString('hex');
  _entries.set(token, {
    userId: input.userId,
    agentId: input.agentId,
    taskId: input.taskId,
    cid: input.cid,
    docId: input.docId,
    textSha256: sha256(input.text),
    items: input.items,
    accepted: null,
    visible: false,
    created_at_ms: Date.now(),
  });
  persistEntries(input.userId);

  try {
    broadcastToRenderer('transcript_glossary.confirmation_required', {
      confirm_id: token,
      doc_id: input.docId,
      items: input.items,
      cid: input.cid ?? '',
      turn_id: input.turnId ?? '',
    });
  } catch (err) {
    log.warn('emit confirmation_required failed', {
      confirmation_id: maskId(token),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const visible = await waitForGlossaryConfirmationVisible(token);
  return { token, visible };
}

/** 渲染层回执：内联卡片**确实已挂载**到可见容器后才允许调用。 */
export function markGlossaryConfirmationVisible(token: string): boolean {
  const entry = _entries.get(token);
  if (!entry) {
    log.warn('markVisible unknown token', { confirmation_id: maskId(token), pending: _entries.size });
    return false;
  }
  entry.visible = true;
  persistEntries(entry.userId);
  resolveVisibleWaiters(token, true);
  return true;
}

export function waitForGlossaryConfirmationVisible(
  token: string,
  timeoutMs = CONFIRM_VISIBLE_ACK_TIMEOUT_MS,
): Promise<boolean> {
  const entry = _entries.get(token);
  if (!entry) return Promise.resolve(false);
  if (entry.visible) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const waiters = _visibleWaiters.get(token) || [];
      const next = waiters.filter((w) => w.resolve !== resolve);
      if (next.length) _visibleWaiters.set(token, next);
      else _visibleWaiters.delete(token);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const waiters = _visibleWaiters.get(token) || [];
    waiters.push({ resolve, timer });
    _visibleWaiters.set(token, waiters);
  });
}

/**
 * IPC 入口：`transcript_glossary.confirm`。
 *
 * `accepted` 里放的是**用户勾选的 entryRef**；`acceptAll: true` 表示"全选"
 * （渲染层也可能直接把全部 ref 放进 accepted，两种都支持）。
 * 只接受 token 里真实存在的 ref——不信任渲染层传来的任意集合。
 */
export function resolveGlossaryConfirmation(
  token: string,
  accepted: readonly string[],
  acceptAll = false,
  partial?: { decided: readonly string[]; rewrites?: Record<string, string> },
): boolean {
  const entry = _entries.get(token);
  if (!entry) {
    log.warn('resolve unknown token', { confirmation_id: maskId(token), pending: _entries.size });
    return false;
  }
  if (entry.accepted) {
    log.warn('resolve duplicate', { confirmation_id: maskId(token) });
    return false;
  }
  const known = new Set(entry.items.map((i) => i.entryRef));
  const picked = new Set<string>();
  if (acceptAll) {
    for (const ref of known) picked.add(ref);
  } else {
    for (const ref of accepted) {
      const value = String(ref || '');
      if (known.has(value)) picked.add(value);
    }
  }
  if (partial) {
    entry.decided = partial.decided.filter((ref) => known.has(ref));
    for (const ref of picked) if (!entry.decided.includes(ref)) picked.delete(ref);
    const rewrites = Object.entries(partial.rewrites ?? {}).filter(([ref]) => picked.has(ref));
    if (rewrites.length) entry.rewrites = Object.fromEntries(rewrites);
  }
  entry.accepted = picked;
  persistEntries(entry.userId);
  log.info('resolve completed', { confirmation_id: maskId(token), picked: picked.size, offered: known.size });
  return true;
}

/** Resolve and resume through the owning conversation/actor, never the active
 * renderer composer. Duplicate clicks share the same enqueue promise. */
export async function submitGlossaryConfirmation(userId: string, token: string, accepted: string[], acceptAll: boolean): Promise<{ ok: boolean; resumed: boolean }> {
  loadEntries(userId);
  const entry = _entries.get(token);
  if (!entry || entry.userId !== userId || Date.now() - entry.created_at_ms > CONFIRM_TTL_MS) return { ok: false, resumed: false };
  if (!entry.accepted && !resolveGlossaryConfirmation(token, accepted, acceptAll)) return { ok: false, resumed: false };
  if (!entry.agentId || !entry.cid || !entry.taskId) return { ok: true, resumed: false };
  if (!entry.resumePromise) {
    entry.resumePromise = (async () => {
      const { cogseedRuntimeController } = await import('./cogseed_backend/runtime-controller');
      await cogseedRuntimeController.waitForTaskTurn(userId, entry.taskId!);
      const { enqueue } = await import('./group_chat/bus');
      await enqueue({ uid: userId, cid: entry.cid!, fromActorId: 'user',
        text: (await import('../i18n')).t('transcript.confirm_continue'),
        forceTo: [entry.agentId!],
      });
    })().catch(error => { entry.resumePromise = undefined; throw error; });
  }
  await entry.resumePromise;
  return { ok: true, resumed: true };
}

type ReplyClause =
  | { kind: 'rest'; accept: boolean }
  | { kind: 'decide'; accept: boolean; terms: string[] }
  | { kind: 'rewrite'; term: string; correct: string }
  | { kind: 'filler' };

const ACCEPT_ALL = /^(?:确认|确认修改|全部(?:都)?改|全部修改|都改|按建议改)$/;
const REJECT_ALL = /^(?:都不(?:用)?改|全部保留|全部不改|不用改)$/;
const REST = /^(?:其他|其余|剩下(?:的)?)(?:的)?(?:全部|都)?(.+)$/;
const REJECT = /^(.+?)\s*(?:不(?:用|需要)?改|保留(?:原文)?|是对的|没错|不变)$/;
const REWRITE = /^(.+?)\s*(?:应该是|应为|改成|改为|是|->|→|=)\s*(.+)$/;
const ACCEPT = /^(.+?)\s*(?:要改|可以改|改)$/;

function normalizeTerm(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s「」『』“”"']/g, '');
}

function parseReplyClause(clause: string): ReplyClause | null {
  if (/^(?:ok|okay|好|好的|嗯|行|收到)$/i.test(clause)) return { kind: 'filler' };
  if (ACCEPT_ALL.test(clause)) return { kind: 'rest', accept: true };
  if (REJECT_ALL.test(clause)) return { kind: 'rest', accept: false };
  const rest = REST.exec(clause)?.[1].trim();
  if (rest) {
    if (/^(?:修改|改|确认)$/.test(rest)) return { kind: 'rest', accept: true };
    if (/^(?:不(?:用)?改|保留(?:原文)?)$/.test(rest)) return { kind: 'rest', accept: false };
    return null;
  }
  const split = (terms: string) => terms.split(/[、/]/).map(term => term.trim());
  const reject = REJECT.exec(clause);
  if (reject) return { kind: 'decide', accept: false, terms: split(reject[1]) };
  const rewrite = REWRITE.exec(clause);
  if (rewrite) {
    const correct = rewrite[2].trim().replace(/^[「“"']|[」”"']$/g, '').trim();
    return correct && correct.length <= 50 ? { kind: 'rewrite', term: rewrite[1], correct } : null;
  }
  const accept = ACCEPT.exec(clause);
  return accept ? { kind: 'decide', accept: true, terms: split(accept[1]) } : null;
}

/** Turn a short human reply into per-item decisions. Every clause must name a
 * card item (or "the rest"); anything else is not a decision and returns null,
 * leaving interpretation to the Agent. Unmentioned items stay undecided. */
export function parseGlossaryTextReply(text: string, items: readonly GlossaryConfirmItem[]): {
  accepted: string[]; decided: string[]; rewrites: Record<string, string>;
  /** False when the reply decided everything without naming any item. */
  namedItems: boolean;
} | null {
  const reply = text.trim().replace(/[。！!]+$/, '').trim();
  // Questions are not decisions, even without a question mark (「佳伟是谁」).
  if (!reply || reply.length > 500 || /[?？]|谁|什么|啥|哪(?:个|位|里)|[吗呢嘛](?=$|[，,；;。\s])/.test(reply)) return null;
  const decisions = new Map<string, { accept: boolean; correct?: string }>();
  let rest: boolean | undefined;
  let named = false;
  const decide = (term: string, accept: boolean, correct?: string): boolean => {
    const key = normalizeTerm(term);
    const matches = key ? items.filter(item => normalizeTerm(item.wrong) === key) : [];
    if (!matches.length) return false;
    named = true;
    for (const item of matches) {
      // 「X 是 <建议写法>」 is acceptance; 「X 是 X」 keeps the original.
      const keep = correct !== undefined && normalizeTerm(correct) === normalizeTerm(item.wrong);
      const next = keep ? { accept: false } : correct !== undefined && normalizeTerm(correct) !== normalizeTerm(item.correct)
        ? { accept: true, correct } : { accept: keep ? false : accept };
      const prior = decisions.get(item.entryRef);
      if (prior && (prior.accept !== next.accept || prior.correct !== next.correct)) return false;
      decisions.set(item.entryRef, next);
    }
    return true;
  };
  for (const raw of reply.split(/[，,；;。\n]+/)) {
    // 「其他都改了」「都不用改吧」: sentence-final particles carry no decision.
    const clause = raw.trim().replace(/[了吧哈啊呀哦]+$/u, '').trim();
    if (!clause) continue;
    const parsed = parseReplyClause(clause);
    if (!parsed) return null;
    if (parsed.kind === 'filler') continue;
    if (parsed.kind === 'rest') {
      if (rest !== undefined && rest !== parsed.accept) return null;
      rest = parsed.accept;
    } else if (parsed.kind === 'rewrite') {
      if (!decide(parsed.term, true, parsed.correct)) return null;
    } else if (!parsed.terms.length || !parsed.terms.every(term => decide(term, parsed.accept))) {
      return null;
    }
  }
  if (rest !== undefined) {
    for (const item of items) if (!decisions.has(item.entryRef)) decisions.set(item.entryRef, { accept: rest });
  }
  if (!decisions.size) return null;
  const rewrites: Record<string, string> = {};
  for (const [ref, decision] of decisions) if (decision.correct !== undefined) rewrites[ref] = decision.correct;
  return {
    accepted: [...decisions].filter(([, decision]) => decision.accept).map(([ref]) => ref),
    decided: [...decisions.keys()],
    rewrites,
    namedItems: named,
  };
}

/** Only the human-message ingress calls this. It never parses agent prose or
 * transcript text as authorization and never enqueues a second continuation.
 * A partial reply records only what it names; apply re-asks the rest. */
export function resolveGlossaryTextReply(userId: string, input: {
  cid: string; agentId: string; taskId: string; text: string;
}): boolean {
  loadEntries(userId);
  const pending = [..._entries].filter(([, entry]) => entry.userId === userId
    && entry.cid === input.cid && entry.agentId === input.agentId && entry.taskId === input.taskId
    && !entry.accepted && entry.visible && Date.now() - entry.created_at_ms <= CONFIRM_TTL_MS);
  if (pending.length !== 1) return false;
  const [token, entry] = pending[0];
  const parsed = parseGlossaryTextReply(input.text, entry.items);
  if (!parsed || (entry.unparsedReply && !parsed.namedItems)) {
    if (!entry.unparsedReply) { entry.unparsedReply = true; persistEntries(entry.userId); }
    return false;
  }
  if (!resolveGlossaryConfirmation(token, parsed.accepted, false, parsed)) return false;
  broadcastToRenderer('transcript_glossary.confirmation_required', { confirm_id: token, cid: entry.cid,
    status: 'resolved', accepted: [...entry.accepted!] });
  return true;
}

export function hasScopedGlossaryConfirmation(userId: string, cid: string, agentId: string, taskId: string): boolean {
  loadEntries(userId);
  return [..._entries.values()].some(entry => entry.userId === userId && entry.cid === cid
    && entry.agentId === agentId && entry.taskId === taskId && Date.now() - entry.created_at_ms <= CONFIRM_TTL_MS);
}

export type ConsumeGlossaryOutcome =
  | { outcome: 'accepted'; acceptedIds: string[]; decidedIds: string[]; rewrites?: Record<string, string> }
  | { outcome: 'pending' }
  | { outcome: 'stale' }
  | { outcome: 'invalid' };

/**
 * 工具侧：取回用户的选择并**一次性消费**令牌。
 *
 *  - `accepted`：返回用户勾选的 `entryRef`（可能为空集 = 用户全不选，合法）。
 *  - `pending`：卡片还没被点，让模型等用户回复。
 *  - `stale`：正文与发卡时不一致 → 令牌作废，必须重新扫描重新确认。
 *  - `invalid`：未知 / 过期 / 重复使用。
 */
export function consumeGlossaryConfirmation(token: string, text: string, scope?: { userId: string; cid?: string; docId: string }): ConsumeGlossaryOutcome {
  if (scope?.userId) loadEntries(scope.userId);
  const entry = _entries.get(token);
  if (!entry) {
    log.warn('consume unknown token', { confirmation_id: maskId(token), pending: _entries.size });
    return { outcome: 'invalid' };
  }
  if (Date.now() - entry.created_at_ms > CONFIRM_TTL_MS) { deleteEntry(token); return { outcome: 'invalid' }; }
  if (scope && (entry.userId !== scope.userId || entry.cid !== scope.cid || entry.docId !== scope.docId)) {
    return { outcome: 'invalid' };
  }
  if (entry.textSha256 !== sha256(text)) {
    log.warn('consume text mismatch (stale token)', { confirmation_id: maskId(token) });
    deleteEntry(token);
    return { outcome: 'stale' };
  }
  if (!entry.accepted) return { outcome: 'pending' };
  const acceptedIds = [...entry.accepted];
  deleteEntry(token); // 一次性：消费即删，不可重放
  return { outcome: 'accepted', acceptedIds, decidedIds: entry.decided ?? entry.items.map((item) => item.entryRef),
    ...(entry.rewrites ? { rewrites: entry.rewrites } : {}) };
}

/** A resumed Worker has no earlier tool history. Recover only the user's
 * submitted decision for this exact user, conversation, document and text. */
export function findResolvedGlossaryConfirmation(userId: string, cid: string | undefined, docId: string, text: string): string | undefined {
  loadEntries(userId);
  if (!cid) return undefined;
  for (const [token, entry] of _entries) {
    if (entry.userId === userId && entry.cid === cid && entry.docId === docId
      && entry.textSha256 === sha256(text) && entry.accepted
      && Date.now() - entry.created_at_ms <= CONFIRM_TTL_MS) return token;
  }
  return undefined;
}

/** Rebuild the current conversation's pending controls after history repaint
 * or renderer restart. Visibility is not resolution; never consume a decision
 * just because a previous DOM once acknowledged the card. */
export function listPendingGlossaryConfirmations(userId: string, cid: string) {
  if (!safeId(userId) || !safeId(cid)) return [];
  loadEntries(userId);
  return [..._entries].filter(([, entry]) => entry.userId === userId && entry.cid === cid
    && entry.accepted === null && Date.now() - entry.created_at_ms <= CONFIRM_TTL_MS)
    .map(([token, entry]) => ({ confirm_id: token, cid, doc_id: entry.docId,
      turn_id: token, items: entry.items }));
}

/**
 * 由扫描候选构造卡片条目：按 `entryRef` 聚合（同一词出现多次只问一次）。
 *
 * 与面板的 `groupCandidates` 同语义（面板在渲染层做同一件事），
 * 这里在主进程做，是为了把"问什么"在发卡时**冻结**下来——渲染层只负责勾选，
 * 不再自己推导候选，避免两边规则漂移。
 */
export function buildConfirmItems(
  candidates: readonly CorrectionCandidate[],
  limit = 40,
): GlossaryConfirmItem[] {
  const byRef = new Map<string, GlossaryConfirmItem>();
  for (const c of candidates) {
    const ref = String(c.entryRef || '');
    if (!ref) continue;
    const existing = byRef.get(ref);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byRef.set(ref, {
      entryRef: ref,
      wrong: String(c.wrong || ''),
      correct: String(c.correct || ''),
      action: c.action === 'delete' ? 'delete' : 'replace',
      riskLevel: c.riskLevel,
      count: 1,
      context: String(c.context || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      ignoredCount: Number(c.ignoredCount || 0),
      ...(c.fromModel ? { fromModel: true } : {}),
    });
  }
  return [...byRef.values()].slice(0, limit);
}
