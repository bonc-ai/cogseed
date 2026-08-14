import { safeId } from '../../storage';

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
  return out.length ? out : undefined;
}

export interface AssetScopeContext {
  /** Projection purpose (matched against purposeTags). */
  purpose?: string;
  /** Projection/workspace id (matched against workspaceIds/projectIds). */
  workspaceId?: string;
  /** Conversation kind (matched against conversationKinds). */
  conversationKind?: string;
  /** True when the conversation kind was actually resolved; unknown kinds
   *  pass a conversationKinds restriction instead of failing closed. */
  conversationKindKnown?: boolean;
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

/** Structured scope-policy gate. Unknown workspace dimensions are treated as
 *  "not allowed" when the policy restricts them (fail-closed); an unknown
 *  conversation kind passes the conversationKinds restriction (fail-open,
 *  M7) so non-standard conversations are not silently excluded. */
export function isAssetScopeAllowed(
  policy: RecallAbilityAssetScopePolicy | undefined,
  context: AssetScopeContext,
): boolean {
  if (!policy) return true;
  if (policy.purposeTags?.length && !policy.purposeTags.some((tag) => matchesScopeToken(context.purpose, tag))) {
    return false;
  }
  const hasWorkspaceRestriction = Boolean(policy.workspaceIds?.length || policy.projectIds?.length);
  if (hasWorkspaceRestriction && !context.workspaceId) return false;
  if (policy.workspaceIds?.length && !policy.workspaceIds.includes(context.workspaceId!)) return false;
  if (policy.projectIds?.length && !policy.projectIds.includes(context.workspaceId!)) return false;
  if (
    policy.conversationKinds?.length
    && (context.conversationKindKnown ?? true)
    && !policy.conversationKinds.includes(context.conversationKind || '')
  ) return false;
  return true;
}

export function normalizeAbilityAssetScopePolicy(value: unknown): RecallAbilityAssetScopePolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid ability asset scope policy');
  const input = value as Record<string, unknown>;
  const out: RecallAbilityAssetScopePolicy = {};
  for (const field of FIELDS) {
    const normalized = normalizeList(input[field], field);
    if (normalized) out[field] = normalized;
  }
  for (const key of Object.keys(input)) {
    if (!FIELDS.includes(key as keyof RecallAbilityAssetScopePolicy)) throw new Error('invalid ability asset scope policy');
  }
  return Object.keys(out).length ? out : undefined;
}
