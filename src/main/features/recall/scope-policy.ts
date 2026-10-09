import { safeId } from '../../storage';

// ── 受控 scope 词表（A 轨道 · 2026-09-13 枚举化）─────────────────────────
//
// 自由文本 scope（"用户全局画像"、"该用户的身份与沟通定位…"）在自动投影里
// 永远匹配不上任务词（context-projection.ts:347 注释早预言：purpose='review'
// 等任务词下这类资产被 scope_mismatch 剔除）——用户确认过的资产在正式通道
// 全部失效，只剩画像旁路在起作用（实机 09-12：proj-a3ae7e6a3646
// assetIds=[]、两条身份资产 omittedRefs=scope_mismatch）。
//
// 词表与 KStar 线（extraction-service.scopeForTask）的五个任务类型词对齐，
// 另有 'space:<id>'（空间限定）与 '*'（显式通配）两个结构形态。词表是
// **目标不是闸门**：产生线经 normalizeAssetScopeValue 尽力归一，归不了的
// 保留原值（软着陆——匹配层的 token 软匹配本就兜底，硬拒会拦存量与
// LLM 产出）。
export const RECALL_SCOPE_TERMS = ['general', 'report', 'code', 'review', 'product'] as const;
export type RecallScopeTerm = (typeof RECALL_SCOPE_TERMS)[number];

export function isRecallScopeTerm(value: string): boolean {
  return (RECALL_SCOPE_TERMS as readonly string[]).includes(String(value || '').trim().toLowerCase());
}

/** 明确的全局语义（中英文措辞）→ 'general'。中招即归一。 */
const GLOBAL_SCOPE_HINTS = [
  '全局', '通用', '画像', '所有对话', '所有会话', '跨会话', '不限空间',
  '任何任务', 'global', 'general', 'personal', 'user',
];

/** 资产**写入点**的 scope 归一（2026-09-19 刀一）：三档——
 *  ① 词表值/中文全局提示 → 软归一为词表值；
 *  ② 合法自定义词条（≤20 字、无句读分隔、非"…时"句式）→ 原样保留——
 *     scope 不是封闭五值枚举，自定义词条（'architecture-review' 等）是
 *     体系内合法形态；
 *  ③ 适用场景描述句（"新增、审核、晋升认知资产条目时"这类、含顿号/句读/
 *     超长/以"时"结尾）→ 兜底 'general'——它们是 applicableWhen 的内容
 *     走错了门，不进 scope。
 *  只在 create/update 的输入口调用；读取口（asAsset）不动——存量自由文本
 *  由既有 migrateLegacyFreeTextScopes 轨道处理，读时强归一会破坏词条语义。 */
export function resolveScopeForAsset(raw: string): string {
  const normalized = normalizeAssetScopeValue(raw);
  if (normalized) return normalized;
  const text = String(raw || '').trim();
  if (!text) return 'general';
  // 组合词条（'review,project'）是合法形态：按分隔符拆段，每段都是合法
  // 词条（≤20 字、非"…时"句式、无句号）才整串保留；任一段不合格（如
  // "新增、审核、晋升认知资产条目时"的末段是适用条件句）兜底 general。
  const segments = text.split(/[、,，;；]/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return 'general';
  const allTerms = segments.every((segment) =>
    segment.length <= 20 && !segment.endsWith('时') && !/[。！？]/.test(segment));
  return allTerms ? text : 'general';
}

/** 自由文本 scope → 词表值（软归一）。
 *  返回 null = 无法安全归一，调用方保留原值。幂等：词表值原样返回。 */
export function normalizeAssetScopeValue(raw: string): RecallScopeTerm | null {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;
  if (isRecallScopeTerm(text)) return text as RecallScopeTerm;
  if (GLOBAL_SCOPE_HINTS.some((hint) => text.includes(hint))) return 'general';
  return null;
}

/** 资产的作用域白名单。每个字段三态：缺失=没有限制，`[]`=一个都不允许，
 *  非空=只允许列出的这些。消费方不得把缺失和空数组当成同一件事。 */
export interface RecallAbilityAssetScopePolicy {
  purposeTags?: string[];
  agentIds?: string[];
  roleIds?: string[];
  projectIds?: string[];
  workspaceIds?: string[];
  conversationKinds?: string[];
  fileKinds?: string[];
}

const FIELDS: Array<keyof RecallAbilityAssetScopePolicy> = [
  'purposeTags',
  'agentIds',
  'roleIds',
  'projectIds',
  'workspaceIds',
  'conversationKinds',
  'fileKinds',
];

function normalizeToken(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`invalid ability asset scope policy ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 120) throw new Error(`invalid ability asset scope policy ${field}`);
  return text;
}

/** 归一化一个白名单字段。**三态，不塌成两态**：
 *
 *    undefined  没有限制——默认允许符合其他条件的对象使用
 *    []         明确一个都不允许
 *    [a, b]     只允许这两个
 *
 *  早先这里写的是 `out.length ? out : undefined`，把空数组塌成「没有限制」。
 *  那是个权限洞：过滤方拿到同一个值，放行会外发本该拦死的资产，拦死会让
 *  所有没设限的资产一起失效——两边都错，且看不出是哪边错。
 *
 *  资产已经有 sensitivity / scope / applicableWhen / forbiddenWhen 几道边界，
 *  这一道塌了，整个权限模型就漏了。
 *
 *  也刻意**不**禁止空数组：`status` 的 paused/revoked 已经在表达「停用」，
 *  再让这里承担一次会让两套语义打架。 */
function normalizeList(value: unknown, field: keyof RecallAbilityAssetScopePolicy): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`invalid ability asset scope policy ${field}`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const token = normalizeToken(raw, String(field));
    if ((field.endsWith('Ids') || field === 'conversationKinds') && !safeId(token)) throw new Error(`invalid ability asset scope policy ${field}`);
    const key = token.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  if (out.length > 50) throw new Error(`invalid ability asset scope policy ${field}`);
  return out;
}

export interface AssetScopeContext {
  /** Projection purpose (matched against purposeTags). */
  purpose?: string;
  /** Target Agent id (matched against agentIds). */
  agentId?: string;
  /** Target role id (matched against roleIds). */
  roleId?: string;
  /** Project id (matched against projectIds). */
  projectId?: string;
  /** Workspace/space id (matched against workspaceIds). */
  workspaceId?: string;
  /** Conversation kind (matched against conversationKinds). */
  conversationKind?: string;
  /** File kinds present in this run (matched against fileKinds). */
  fileKinds?: readonly string[];
}

/** Single whole-word token matcher used by BOTH asset.scope terms and
 *  scopePolicy.purposeTags (M1): an ASCII token must appear as a whole word
 *  ('review' matches "review knowledge" but not "reviewing" or "research");
 *  CJK/other tokens use plain containment. */
export function matchesScopeToken(value: string | undefined, token: string): boolean {
  if (!value) return false;
  const haystack = value.toLocaleLowerCase();
  const needle = token.toLocaleLowerCase();
  if (needle.length < 2) return false;
  if (/^[a-z0-9]+$/.test(needle)) {
    return new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`).test(haystack);
  }
  return haystack.includes(needle);
}

/** Split a sentence/scope into length>=2 tokens by punctuation/whitespace. */
export function splitScopeTerms(value: string): string[] {
  return String(value || '')
    .split(/[\s,，;；、()（）\[\]【】/\\\-—]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

/** Cross-language scope aliases: an ASCII tag (e.g. 'review') also matches
 *  CJK purpose tokens (审查/审计/检查), so a Chinese task goal does not
 *  silently fall out of a short ASCII scope. Shared with the rule engine. */
const SCOPE_LANGUAGE_ALIASES: Record<string, string[]> = {
  review: ['审查', '审计', '检查', '评审'],
  code: ['代码', '函数', '缺陷', '测试'],
  report: ['报告', '总结', '文档', '文件'],
  product: ['产品', '架构', '决策'],
  general: [],
};

/** Bidirectional token containment (CJK) / exact token equality (ASCII) with
 *  a cross-language alias bridge. Shared by soft scope matching and the
 *  rule engine's text trigger evaluation. */
export function scopeTokenMatches(haystackTokens: string[], needle: string): boolean {
  const lowerNeedle = needle.toLocaleLowerCase();
  for (const token of haystackTokens) {
    if (token.length < 2) continue;
    const lowerToken = token.toLocaleLowerCase();
    // ASCII side stays whole-word (no cat→category substring bleed), plus a
    // fixed alias table bridges ASCII tags to CJK purpose words.
    if (/^[a-z0-9]+$/i.test(needle) || /^[a-z0-9]+$/i.test(token)) {
      if (lowerToken === lowerNeedle) return true;
      const aliases = SCOPE_LANGUAGE_ALIASES[lowerNeedle] || SCOPE_LANGUAGE_ALIASES[lowerToken] || [];
      if (aliases.some((alias) => lowerToken.includes(alias) || lowerNeedle.includes(alias))) return true;
      continue;
    }
    // CJK sides match by bidirectional containment.
    if (lowerToken.includes(lowerNeedle) || lowerNeedle.includes(lowerToken)) return true;
  }
  return false;
}

/** Soft scope match: short tag list or free-form sentence. Exact whole-token
 *  matching runs first; when that misses, both sides are tokenized and any
 *  bidirectional token containment (CJK) / equal token (ASCII) passes. */
export function scopeIncludes(scope: string, text: string): boolean {
  const terms = scope.split(',').map((term) => term.trim()).filter(Boolean);
  if (terms.includes('*')) return true;
  // general（通用）是显式通配：general 资产适用于任意 purpose/任务，不应被
  // 特定 purpose（如 KSTAR 硬编码的 'review'）过滤掉。实机 72% 资产为
  // general scope，KSTAR 投影 purpose='review' 时 36% 投影因此为空
  // （2026-08-17 观测：84 个投影 31 个 assets=0）。
  if (terms.includes('general')) return true;
  if (terms.some((term) => matchesScopeToken(text, term))) return true;
  const textTokens = splitScopeTerms(text);
  return splitScopeTerms(scope).some((token) => scopeTokenMatches(textTokens, token));
}

/** One allow-list dimension with three-state semantics:
 *
 *   undefined  unrestricted
 *   []         deny all
 *   [a, b]     require a known matching value
 *
 * Unknown runtime context is deliberately fail-closed once an asset declares
 * a restriction. Otherwise callers can bypass a policy simply by omitting the
 * corresponding context field. */
function allowsScalar(allowed: readonly string[] | undefined, actual: string | undefined): boolean {
  if (allowed === undefined) return true;
  if (!allowed.length || actual === undefined) return false;
  return allowed.includes(actual);
}

function allowsFiles(allowed: readonly string[] | undefined, actual: readonly string[] | undefined): boolean {
  if (allowed === undefined) return true;
  if (!allowed.length || !actual?.length) return false;
  // A mixed input must stay inside the declared boundary; one allowed file
  // must not smuggle a second, disallowed kind into the same run.
  return actual.every((kind) => allowed.includes(kind));
}

/** Structured scope-policy gate. All declared dimensions are combined with
 * AND semantics and use the same fail-closed three-state rule. */
export function isAssetScopeAllowed(
  policy: RecallAbilityAssetScopePolicy | undefined,
  context: AssetScopeContext,
): boolean {
  if (!policy) return true;
  if (policy.purposeTags !== undefined) {
    if (policy.purposeTags.length === 0) return false;
    if (!policy.purposeTags.some((tag) => matchesScopeToken(context.purpose, tag))) return false;
  }
  if (!allowsScalar(policy.agentIds, context.agentId)) return false;
  if (!allowsScalar(policy.roleIds, context.roleId)) return false;
  if (!allowsScalar(policy.projectIds, context.projectId)) return false;
  if (!allowsScalar(policy.workspaceIds, context.workspaceId)) return false;
  if (!allowsScalar(policy.conversationKinds, context.conversationKind)) return false;
  if (!allowsFiles(policy.fileKinds, context.fileKinds)) return false;
  return true;
}

export function normalizeAbilityAssetScopePolicy(value: unknown): RecallAbilityAssetScopePolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid ability asset scope policy');
  const input = value as Record<string, unknown>;
  const out: RecallAbilityAssetScopePolicy = {};
  for (const field of FIELDS) {
    const normalized = normalizeList(input[field], field);
    // 只有 undefined 才算「没写过」。空数组是用户写下的一个决定，要原样留住。
    if (normalized !== undefined) out[field] = normalized;
  }
  for (const key of Object.keys(input)) {
    if (!FIELDS.includes(key as keyof RecallAbilityAssetScopePolicy)) throw new Error('invalid ability asset scope policy');
  }
  return Object.keys(out).length ? out : undefined;
}
