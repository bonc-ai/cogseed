import { safeId } from '../../storage';

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
