/**
 * @alias 便利入口（标准指南 §7.2/§7.3）与防误调用（§17.4 E4）。
 *
 * 自然语言 `@alias` 只是便利入口：Client Hook / 工具调用方提供的自由
 * 文本**行首**的 @token 才解析为收件人。规则刻意保守——引用文本中的
 * @alias（"他说 @hermes 不行"、引用块、未注册的 @提及）绝不触发
 * Agent 调用；解析结果只返回建议收件人，发送与身份验证仍由调用方经
 * 正常协商链完成（expected_identity fail-closed，A4）。
 */

export interface MentionLookupRecord {
  agent_id: string;
  expected_identity?: string;
}

export interface MentionLookup {
  (aliasOrId: string): MentionLookupRecord | null;
}

export interface MentionResolution {
  /** 注册表中的 agent_id（非 alias 文本）。 */
  agentId: string;
  /** 去掉 @ 前缀的原始 token。 */
  alias: string;
  /** 去掉行首 @token 后的剩余正文（trimStart）。 */
  rest: string;
  /** 注册表声明的 expected_identity（协商时必须验证，A4）。 */
  expectedIdentity?: string;
}

const ALIAS_TOKEN_MAX = 64;

function isAliasChar(ch: string): boolean {
  return /[A-Za-z0-9_.-]/.test(ch);
}

/** 解析文本行首的 @alias 为注册 peer。任何不满足保守规则的情况返回
 *  null（保持原文，不触发调用）。 */
export function resolveLeadingMention(text: string, lookup: MentionLookup): MentionResolution | null {
  const raw = String(text ?? '');
  if (!raw.startsWith('@')) return null;
  let end = 1;
  while (end < raw.length && end - 1 < ALIAS_TOKEN_MAX && isAliasChar(raw[end])) end += 1;
  const alias = raw.slice(1, end);
  if (!alias) return null;
  const after = raw[end];
  if (after !== undefined && after !== ' ' && after !== '\t' && after !== '\n') return null;
  const record = lookup(alias);
  if (!record || !record.agent_id) return null; // 未注册的 @提及不是 Agent 调用
  return {
    agentId: record.agent_id,
    alias,
    rest: raw.slice(end).trimStart(),
    ...(record.expected_identity ? { expectedIdentity: record.expected_identity } : {}),
  };
}

/** 工具入参的 peer 字段允许 "@hermes" 便利写法：剥掉一个前导 @ 再交给
 *  注册表解析（alias 与 agent_id 都可命中）。 */
export function normalizePeerParam(peer: string): string {
  const raw = String(peer ?? '').trim();
  return raw.startsWith('@') ? raw.slice(1) : raw;
}
