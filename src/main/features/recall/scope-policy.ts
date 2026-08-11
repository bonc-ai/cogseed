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
