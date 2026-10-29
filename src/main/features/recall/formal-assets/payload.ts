/** Type-specific contracts derived losslessly from established content and boundaries. */
import type { RecallAbilityAssetRecord } from '../candidate-service';
import type { FormalAssetPayload } from './types';
const SLOT = /\{\{([^{}\r\n]+)\}\}/g;
export function templateSlotNames(statement: string): string[] {
  const names = [...new Set([...statement.matchAll(SLOT)].map(match => match[1].trim()))];
  if (names.some(name => !name || name.length > 100) || names.length > 50) throw new Error('invalid template slots');
  return names;
}
export function buildFormalAssetPayload(record: RecallAbilityAssetRecord): FormalAssetPayload {
  switch (record.type) {
    case 'cognition': return { kind: 'cognition' };
    case 'rule': return { kind: 'rule', action: record.statement, applicableWhen: record.applicableWhen ?? [],
      forbiddenWhen: record.forbiddenWhen ?? [], boundaryRecorded: record.applicableWhen !== undefined && record.forbiddenWhen !== undefined,
      ...(record.causalRule ? { causalRule: record.causalRule } : {}) };
    case 'template': {
      try { return { kind: 'template', body: record.statement, slots: templateSlotNames(record.statement).map(name => ({ name, required: true })) }; }
      catch { return { kind: 'template', body: record.statement, slots: [], structureError: '模板槽位超出结构限制，请编辑后再填写。' }; }
    }
    case 'skill_method': return { kind: 'skill_method', steps: record.statement.split('\n').flatMap(line => {
      const match = /^\s*\d+[.)、]\s+(.+)$/u.exec(line); return match ? [match[1]] : [];
    }) };
    case 'fact': return { kind: 'fact' };
    default: return { kind: 'personal' };
  }
}
/** Single-pass interpolation: values cannot execute code or introduce new substitutions. */
export function instantiateAssetTemplate(record: RecallAbilityAssetRecord, values: unknown): string {
  if (record.type !== 'template') throw new Error('asset is not a template');
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('template values must be an object');
  const input = values as Record<string, unknown>;
  const names = templateSlotNames(record.statement);
  if (Object.keys(input).some(key => !names.includes(key))) throw new Error('unknown template slot');
  if (names.some(name => !Object.hasOwn(input, name) || typeof input[name] !== 'string' || !String(input[name]).trim() || String(input[name]).length > 4000)) throw new Error('missing or invalid template slot');
  const result = record.statement.replace(SLOT, (_whole, name: string) => String(input[name.trim()]));
  if (result.length > 20000) throw new Error('template instance is too large');
  return result;
}

/** Enrich only from the installed binding; never infer an executable skill from prose. */
export async function resolveFormalAssetPayload(userId: string, record: RecallAbilityAssetRecord): Promise<FormalAssetPayload> {
  const payload = buildFormalAssetPayload(record);
  if (payload.kind !== 'skill_method') return payload;
  const { readSkillBinding, bindingIsStale } = await import('../skill-binding-service');
  const binding = await readSkillBinding(userId, record.id);
  if (binding) payload.skillReference = { skillId: binding.skillId, assetVersion: binding.installedAssetVersion,
    manifestHash: binding.currentManifestHash, stale: bindingIsStale(binding, String(record.activeVersion || record.version)) };
  return payload;
}
