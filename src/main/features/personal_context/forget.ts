/**
 * 按范围遗忘（设计稿 §6 / 命令草案 docs/research/2026-08-10-permission-forget-command-draft.md）。
 *
 * 纯逻辑 + 薄 IO：scope 文法解析与匹配计算是纯函数（可单测）；
 * preview/execute 通过现有公开 API 落盘（registry 标记失效、候选驳回、
 * 游标重置），不修改 registry.ts / personal_ontology_* 任何文件。
 *
 * 语义（草案 §4）：
 * - 默认「失效保留」：注册表引用 markInvalid（资源保留、场景不可见），
 *   候选 rejectCandidates（不再回流），本体已确认事实不动（标记来源失效
 *   由本体管线处理，超出本模块）；
 * - 游标按范围重置：匹配 provider 的同步水位 regress 到空游标，重新授权
 *   后从回填窗口重拉；
 * - 全部动作幂等：重复执行同 scope 不产生新变化。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userCloudRoot } from '../../paths';
import { nowIso } from '../../storage';
import { createLogger } from '../../logger';
import { parseResourceKey, RESOURCE_TYPES, type ResourceType } from './contract';
import { PersonalContextRegistry, PersonalContextCursorStore, type RegistryEntry } from './registry';
import * as ontologyCandidates from '../personal_ontology_candidates';
import type { CandidateUpdate } from '../personal_ontology_candidates';

const log = createLogger('personal-context:forget');

// ── scope 模型与文法（纯函数）────────────────────────────────────────────

export interface ForgetScope {
  /** true = 全部 provider（`all` / `feishu:all`） */
  all: boolean;
  /** provider 前缀（当前仅 `feishu` 已实现） */
  provider?: string;
  /** 资源类型子集；缺省 = provider 全部类型 */
  types?: ResourceType[];
  /** 单资源稳定 id（`feishu:calendar:cal_xxx` 的尾段） */
  resourceStableId?: string;
  /** ISO 日期：仅影响该日期及之后首次观察到的资源 */
  since?: string;
}

export type ParseForgetScopeResult =
  | { ok: true; scope: ForgetScope }
  | { ok: false; error: string };

const FORGET_HELP = '用法：/遗忘 <范围>，如 /遗忘 feishu:calendar、/遗忘 feishu:calendar:cal_xxx、/遗忘 all';

/** scope 文法解析（草案 §3.1）：
 *   all | <provider>:all | <provider> | <provider>:<type> |
 *   <provider>:<type>:<stableId> | <provider>:<type>:since:<date> |
 *   <provider>:since:<date> */
export function parseForgetScope(raw: string): ParseForgetScopeResult {
  const input = typeof raw === 'string' ? raw.trim() : '';
  if (!input) return { ok: false, error: FORGET_HELP };

  const segments = input.split(':');
  if (input === 'all') return { ok: true, scope: { all: true } };

  const provider = segments[0];
  if (provider === 'all') return { ok: true, scope: { all: true } };
  if (provider !== 'feishu') {
    return { ok: false, error: `未知 provider「${provider}」（当前支持 feishu）` };
  }

  const scope: ForgetScope = { all: false, provider };
  const rest = segments.slice(1);

  if (rest.length === 1 && rest[0] === 'all') {
    return { ok: true, scope: { all: true, provider } };
  }

  let type: string | undefined;
  let stableId: string | undefined;
  let since: string | undefined;

  // 前两段（可选）：type、stableId
  if (rest.length >= 1 && rest[0] !== 'since') {
    type = rest[0];
    if (!RESOURCE_TYPES.includes(type as ResourceType)) {
      return { ok: false, error: `未知资源类型「${type}」（支持：${RESOURCE_TYPES.join(' / ')}）` };
    }
    scope.types = [type as ResourceType];
    if (rest.length >= 2 && rest[1] !== 'since') {
      stableId = rest[1];
      if (!/^[A-Za-z0-9_-]+$/.test(stableId)) {
        return { ok: false, error: `资源 id「${stableId}」含非法字符` };
      }
      scope.resourceStableId = stableId;
    }
  }

  // 可选：since:<date>
  const sinceIdx = rest.indexOf('since');
  if (sinceIdx !== -1) {
    const dateText = rest[sinceIdx + 1];
    if (!dateText || !/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
      return { ok: false, error: 'since 需要日期参数，格式 YYYY-MM-DD（如 2026-07-01）' };
    }
    const d = new Date(`${dateText}T00:00:00`);
    if (Number.isNaN(d.getTime())) return { ok: false, error: `日期「${dateText}」非法` };
    since = dateText;
    scope.since = since;
    // since 只允许出现在末尾两段（type [stableId] 之后）
    if (sinceIdx !== rest.length - 2) {
      return { ok: false, error: FORGET_HELP };
    }
  }

  // 多余段
  const consumed = (type ? 1 : 0) + (stableId ? 1 : 0) + (since ? 2 : 0);
  if (consumed !== rest.length) return { ok: false, error: FORGET_HELP };

  return { ok: true, scope };
}

/** scope 的人类可读描述（用于预览/审计文案）。 */
export function describeScope(scope: ForgetScope): string {
  if (scope.all && !scope.provider) return 'all';
  const parts = [scope.provider ?? 'all'];
  if (scope.all) return parts.join(':') + ':all';
  if (scope.types) parts.push(scope.types.join('+'));
  if (scope.resourceStableId) parts.push(scope.resourceStableId);
  if (scope.since) parts.push(`since:${scope.since}`);
  return parts.join(':');
}

// ── 匹配计算（纯函数）────────────────────────────────────────────────────

/** 注册表条目匹配（可单测）。since 按首次观察时间裁剪。 */
export function matchRegistryEntries(entries: RegistryEntry[], scope: ForgetScope): RegistryEntry[] {
  return entries.filter((entry) => {
    const parsed = parseResourceKey(entry.resource.resourceId);
    if (!parsed) return false;
    if (scope.all && !scope.provider) return true;
    if (scope.provider && parsed.provider !== scope.provider) return false;
    if (scope.types && !scope.types.includes(parsed.type as ResourceType)) return false;
    if (scope.resourceStableId && parsed.stableId !== scope.resourceStableId) return false;
    if (scope.since) {
      const observed = Date.parse(entry.resource.observedAt);
      if (Number.isNaN(observed)) return false;
      if (observed < Date.parse(`${scope.since}T00:00:00`)) return false;
    }
    return true;
  });
}

/** 候选匹配（可单测）：来源引用与 scope provider 前缀一致；单资源时引用须
 *  含稳定 id；types 存在时引用须含对应类型段（ref 形如 `feishu:t1:calendar:…`）。 */
export function matchCandidatesForScope(candidates: CandidateUpdate[], scope: ForgetScope): CandidateUpdate[] {
  return candidates.filter((candidate) => {
    const refs = Array.isArray(candidate.source_memory_refs) ? candidate.source_memory_refs : [];
    if (scope.all && !scope.provider) return refs.length > 0;
    if (!scope.provider) return false;
    if (!refs.some((ref) => ref.startsWith(`${scope.provider}:`) || ref.includes(`:${scope.provider}:`))) {
      return false;
    }
    if (scope.resourceStableId && !refs.some((ref) => ref.includes(scope.resourceStableId))) return false;
    if (scope.types) {
      const matched = refs.some((ref) => scope.types!.some((type) => ref.includes(`:${type}:`)));
      if (!matched) return false;
    }
    return true;
  });
}

// ── 游标 ─────────────────────────────────────────────────────────────────

function cursorsDir(uid: string): string {
  return path.join(userCloudRoot(uid), 'context', 'cursors');
}

/** 列出存在同步游标的 provider（forget 需要知道重置哪些水位）。 */
export function listCursorProviders(uid: string): string[] {
  try {
    return fs.readdirSync(cursorsDir(uid))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''))
      .filter((name) => name && name.length <= 64);
  } catch {
    return [];
  }
}

// ── 预览 / 执行（薄 IO）──────────────────────────────────────────────────

export interface ForgetPreview {
  scopeKey: string;
  resources: RegistryEntry[];
  candidates: CandidateUpdate[];
  /** 将被重置游标的 provider（有游标文件才列出） */
  cursorProviders: string[];
  counts: { resources: number; candidates: number; cursorProviders: number };
}

const registryStore = new PersonalContextRegistry();
const cursorStore = new PersonalContextCursorStore();

/** 预览：只计算影响面，不落盘。确认执行必须绑定本次预览快照（草案 §4.1）。 */
export async function previewForget(uid: string, scope: ForgetScope): Promise<ForgetPreview> {
  const allEntries = await registryStore.list(uid, { includeInvalid: true });
  const resources = matchRegistryEntries(allEntries, scope);
  const pending = await ontologyCandidates.listCandidates(uid);
  const candidates = matchCandidatesForScope(pending.candidate_updates, scope);

  const providersWithCursor = listCursorProviders(uid);
  const cursorProviders = scope.all
    ? providersWithCursor
    : (scope.provider && providersWithCursor.includes(scope.provider) ? [scope.provider] : []);

  return {
    scopeKey: describeScope(scope),
    resources,
    candidates,
    cursorProviders,
    counts: {
      resources: resources.length,
      candidates: candidates.length,
      cursorProviders: cursorProviders.length,
    },
  };
}

export interface ForgetResult {
  scopeKey: string;
  invalidatedResources: number;
  rejectedCandidates: number;
  resetCursors: string[];
}

/** 执行遗忘：注册表标记失效 + 候选驳回 + 游标重置。幂等：重复执行同 scope
 *  markInvalid/reject 均为 no-op，不会扩大影响面。 */
export async function executeForget(uid: string, scope: ForgetScope): Promise<ForgetResult> {
  const scopeKey = describeScope(scope);
  const preview = await previewForget(uid, scope);

  let invalidated = 0;
  for (const entry of preview.resources) {
    if (entry.invalidatedAt) continue; // 已失效：幂等重跑不计数、不扩大影响面
    if (await registryStore.markInvalid(uid, entry.resource.resourceId, `forget:${scopeKey}`)) invalidated += 1;
  }

  let rejected = 0;
  if (preview.candidates.length) {
    const result = await ontologyCandidates.rejectCandidates(
      uid,
      preview.candidates.map((c) => c.candidate_id),
      `forget:${scopeKey}`,
    );
    rejected = result.rejectedCount;
  }

  const resetCursors: string[] = [];
  for (const providerId of preview.cursorProviders) {
    try {
      await cursorStore.regress(uid, providerId, { watermarks: {}, eventIdempotency: [], updatedAt: nowIso() });
      resetCursors.push(providerId);
    } catch (err) {
      log.warn('forget cursor reset failed', { providerId, error: (err as Error).message });
    }
  }

  return {
    scopeKey,
    invalidatedResources: invalidated,
    rejectedCandidates: rejected,
    resetCursors,
  };
}
