import { createHash } from 'node:crypto';

import { AGENT_CAPABILITIES, type AgentCapability } from '../agent_execution/capability-catalog';
import { listModelsForUser, listProvidersForUser, type ProviderEntry } from '../auth';
import { listSkillsForUser, type SkillListing } from '../skills';
import { getActiveUserId } from '../users';
import { forEachOwnEnumerableCreatorKey, validateCreatorCatalogText } from './schema';

export type CreatorCapabilityPermission = 'read' | 'write' | 'network' | 'cost' | 'side-effect';

export interface CreatorCapabilityDescriptor {
  capabilityId: string;
  version: string;
  kind: 'model' | 'skill' | 'tool';
  displayName: string;
  available: boolean;
  permissions: CreatorCapabilityPermission[];
  sourceRef: string;
  health: 'ready' | 'degraded' | 'unavailable';
}

export interface CreatorCatalogDependencies {
  getActiveUserId?: () => string;
  listProviders?: (userId: string) => Promise<{ providers: ProviderEntry[] }>;
  listModels?: (userId: string, providerId: string) => Promise<{ models: { id: string; name: string }[] }>;
  listSkills?: (userId: string) => Promise<SkillListing[]>;
  signal?: AbortSignal;
}

class CreatorCatalogError extends Error {
  constructor(code: 'creator_user_not_active' | 'creator_catalog_dependency_failed') {
    super(code);
    this.name = 'CreatorCatalogError';
  }
}

class CreatorCatalogCancelledError extends Error {
  constructor() {
    super('creator_catalog_cancelled');
    this.name = 'CreatorCatalogCancelledError';
  }
}

const MAX_CATALOG_ITEMS = 64;
const MAX_MODEL_ITEMS = 24;
const MAX_DESCRIPTOR_INPUT_ITEMS = 256;
const MAX_PROVIDER_INPUT_ITEMS = 256;
const MAX_MODEL_INPUT_ITEMS = 64;
const MAX_SKILL_INPUT_ITEMS = 256;
const MAX_DISPLAY_NAME = 160;
const MAX_PROVIDER_STRING_SCAN = 512;
const MAX_DESCRIPTOR_PERMISSIONS = 16;
const SAFE_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const PERMISSIONS = new Set<CreatorCapabilityPermission>(['read', 'write', 'network', 'cost', 'side-effect']);
const DESCRIPTOR_KEYS = new Set([
  'capabilityId', 'version', 'kind', 'displayName', 'available', 'permissions', 'sourceRef', 'health',
]);

function containsSensitiveValue(value: string): boolean {
  return validateCreatorCatalogText(value) !== null;
}

function hashSegment(value: string): string {
  return `id-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

/** Keep catalog identifiers inside the Creator schema's logical-ID boundary. */
function logicalIdSegment(value: string): string {
  if (SAFE_ID_SEGMENT.test(value) && !containsSensitiveValue(value)) return value;
  return hashSegment(value);
}

export function creatorCatalogLogicalId(prefix: string, ...segments: string[]): string {
  return [prefix, ...segments.map(logicalIdSegment)].join('.');
}

function safeDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  if (value.length > MAX_PROVIDER_STRING_SCAN) return '[REDACTED]';
  if (containsSensitiveValue(value)) return '[REDACTED]';
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  return [...cleaned].slice(0, MAX_DISPLAY_NAME).join('');
}

function safeVersion(value: unknown): { value: string; valid: boolean } {
  if (value === undefined || value === '') return { value: '1', valid: true };
  if (typeof value === 'string' && VERSION.test(value) && !containsSensitiveValue(value)) {
    return { value, valid: true };
  }
  return { value: '1', valid: false };
}

function boundedDependencyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_PROVIDER_STRING_SCAN ? value : undefined;
}

function boundedPermissions(value: unknown): CreatorCapabilityPermission[] | null {
  if (!Array.isArray(value)) return null;
  let length: number;
  try { length = value.length; } catch { return null; }
  if (!Number.isSafeInteger(length) || length > MAX_DESCRIPTOR_PERMISSIONS) return null;
  const result: CreatorCapabilityPermission[] = [];
  try {
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return null;
      const permission = value[index];
      if (!PERMISSIONS.has(permission as CreatorCapabilityPermission)) return null;
      result.push(permission as CreatorCapabilityPermission);
    }
  } catch {
    return null;
  }
  return result;
}

function samePermissions(actual: readonly CreatorCapabilityPermission[], expected: readonly CreatorCapabilityPermission[]): boolean {
  return actual.length === expected.length && actual.every((permission, index) => permission === expected[index]);
}

function permissionsMatch(value: unknown, expected: readonly CreatorCapabilityPermission[]): boolean {
  if (!Array.isArray(value)) return false;
  let length: number;
  try { length = value.length; } catch { return false; }
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DESCRIPTOR_PERMISSIONS
    || length !== expected.length) return false;
  try {
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || value[index] !== expected[index]) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function sanitizeDescriptor(value: unknown): CreatorCapabilityDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<CreatorCapabilityDescriptor>;
  let keysValid = true;
  if (!forEachOwnEnumerableCreatorKey(value, DESCRIPTOR_KEYS.size + 1, (key) => {
    if (!DESCRIPTOR_KEYS.has(key)) keysValid = false;
  }) || !keysValid) return null;
  if (raw.kind !== 'model' && raw.kind !== 'skill' && raw.kind !== 'tool') return null;
  if (typeof raw.capabilityId !== 'string'
    || raw.capabilityId.length > 128
    || !LOGICAL_ID.test(raw.capabilityId)
    || containsSensitiveValue(raw.capabilityId)) return null;
  if (raw.kind === 'tool') {
    const capability = AGENT_CAPABILITIES.find((candidate) => raw.capabilityId === `tool.${candidate}`);
    if (!capability) return null;
    const canonical = toolDescriptor(capability);
    const permissions = boundedPermissions(raw.permissions);
    if (!permissions || !samePermissions(permissions, canonical.permissions)) return null;
    if (raw.available === true && !canonical.available) return null;
    if (typeof raw.available !== 'boolean') return null;
    return {
      ...canonical,
      available: raw.available,
      health: raw.available ? canonical.health : 'unavailable',
    };
  }
  const version = safeVersion(raw.version);
  const permissions = boundedPermissions(raw.permissions);
  const expectedPermissions: CreatorCapabilityPermission[] = raw.kind === 'model' ? ['cost'] : ['read'];
  if (!permissions || !samePermissions(permissions, expectedPermissions)) return null;
  const available = raw.available === true && version.valid;
  const health = available && (raw.health === 'ready' || raw.health === 'degraded')
    ? raw.health
    : 'unavailable';
  const sourceRef = typeof raw.sourceRef === 'string' ? raw.sourceRef : '';
  if (sourceRef.length > MAX_PROVIDER_STRING_SCAN
    || !LOGICAL_ID.test(sourceRef)
    || containsSensitiveValue(sourceRef)) return null;
  const trustedSource = raw.kind === 'model'
    ? sourceRef.startsWith('provider.')
      && raw.capabilityId.startsWith(`model.${sourceRef.slice('provider.'.length)}.`)
      && raw.capabilityId.length > `model.${sourceRef.slice('provider.'.length)}.`.length
    : sourceRef.startsWith('skill.')
      && sourceRef.endsWith(`.${raw.capabilityId.slice('skill.'.length)}`)
      && sourceRef.length > `skill.${raw.capabilityId.slice('skill.'.length)}`.length;
  if (!trustedSource) return null;
  return {
    capabilityId: raw.capabilityId,
    version: version.value,
    kind: raw.kind,
    displayName: safeDisplayName(raw.displayName, raw.kind === 'model' ? 'Model' : raw.kind === 'skill' ? 'Skill' : 'Tool'),
    available,
    permissions,
    sourceRef,
    health,
  };
}

function takeBounded<T>(input: Iterable<T>, limit: number): T[] {
  const result: T[] = [];
  try {
    const iterator = input[Symbol.iterator]();
    while (result.length < limit) {
      const next = iterator.next();
      if (next.done) break;
      result.push(next.value);
    }
  } catch {
    throw new CreatorCatalogError('creator_catalog_dependency_failed');
  }
  return result;
}

export function sanitizeCreatorCapabilityCatalog(input: readonly unknown[]): CreatorCapabilityDescriptor[] {
  const result: CreatorCapabilityDescriptor[] = [];
  const seen = new Set<string>();
  for (const raw of takeBounded(input, MAX_DESCRIPTOR_INPUT_ITEMS)) {
    let descriptor: CreatorCapabilityDescriptor | null = null;
    try {
      descriptor = sanitizeDescriptor(raw);
    } catch {
      descriptor = null;
    }
    if (!descriptor || seen.has(descriptor.capabilityId)) continue;
    seen.add(descriptor.capabilityId);
    result.push(descriptor);
    if (result.length === MAX_CATALOG_ITEMS) break;
  }
  return result;
}

/** Validate an externally supplied snapshot without trusting ignored fields. */
export function validateCreatorCatalogSnapshot(input: unknown): {
  valid: boolean;
  catalog: CreatorCapabilityDescriptor[];
} {
  try {
    if (!Array.isArray(input)
      || !Number.isSafeInteger(input.length)
      || input.length < 0
      || input.length > MAX_CATALOG_ITEMS) return { valid: false, catalog: [] };
    const catalog: CreatorCapabilityDescriptor[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < input.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) return { valid: false, catalog: [] };
      const raw = input[index];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { valid: false, catalog: [] };
      let keysValid = true;
      if (!forEachOwnEnumerableCreatorKey(raw, DESCRIPTOR_KEYS.size + 1, (key) => {
        if (!DESCRIPTOR_KEYS.has(key)) keysValid = false;
      }) || !keysValid) return { valid: false, catalog: [] };
      const descriptor = sanitizeDescriptor(raw);
      const source = raw as Partial<CreatorCapabilityDescriptor>;
      if (!descriptor
        || typeof source.version !== 'string'
        || !VERSION.test(source.version)
        || typeof source.displayName !== 'string'
        || source.displayName.length > MAX_DISPLAY_NAME
        || (source.kind !== 'tool' && source.displayName !== descriptor.displayName)
        || typeof source.sourceRef !== 'string'
        || source.sourceRef !== descriptor.sourceRef
        || source.health !== descriptor.health
        || typeof source.available !== 'boolean'
        || source.available !== descriptor.available
        || !permissionsMatch(source.permissions, descriptor.permissions)) {
        return { valid: false, catalog: [] };
      }
      if (seen.has(descriptor.capabilityId)) return { valid: false, catalog: [] };
      seen.add(descriptor.capabilityId);
      catalog.push(descriptor);
    }
    return { valid: true, catalog };
  } catch {
    return { valid: false, catalog: [] };
  }
}

function throwIfCatalogAborted(signal: AbortSignal | undefined): void {
  try {
    if (signal?.aborted) throw new CreatorCatalogCancelledError();
  } catch (error) {
    if (error instanceof CreatorCatalogCancelledError) throw error;
    throw new CreatorCatalogCancelledError();
  }
}

async function awaitCatalogOperation<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const settled = Promise.resolve(operation);
  void settled.catch(() => undefined);
  throwIfCatalogAborted(signal);
  if (!signal) return settled;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new CreatorCatalogCancelledError());
    try {
      signal.addEventListener('abort', onAbort, { once: true });
    } catch {
      try { signal.removeEventListener('abort', onAbort); } catch { /* contain hostile signals */ }
      reject(new CreatorCatalogCancelledError());
    }
  });
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    try { signal.removeEventListener('abort', onAbort); } catch { /* contain hostile signals */ }
  }
}

const TOOL_PERMISSIONS: Record<AgentCapability, CreatorCapabilityPermission[]> = {
  file: ['read'],
  shell: ['side-effect'],
  skill: ['read'],
  kb: ['read'],
  search: ['read'],
  connector: ['network', 'side-effect'],
  browser: ['read', 'network'],
  office: ['read'],
  history: ['read'],
};

function toolDescriptor(capability: AgentCapability): CreatorCapabilityDescriptor {
  const allowed = capability !== 'shell' && capability !== 'browser' && capability !== 'connector';
  return {
    capabilityId: creatorCatalogLogicalId('tool', capability),
    version: '1',
    kind: 'tool',
    displayName: capability,
    available: allowed,
    permissions: [...TOOL_PERMISSIONS[capability]],
    sourceRef: creatorCatalogLogicalId('agent-capability', capability),
    health: allowed ? 'ready' : 'unavailable',
  };
}

function skillHealth(skill: SkillListing): Pick<CreatorCapabilityDescriptor, 'available' | 'health'> {
  if (!skill.enabled || skill.security?.status === 'withheld') {
    return { available: false, health: 'unavailable' };
  }
  if (skill.security?.status === 'risk' || skill.security?.status === 'unchecked') {
    return { available: true, health: 'degraded' };
  }
  return { available: true, health: 'ready' };
}

export async function buildCreatorCapabilityCatalog(
  userId: string,
  deps: CreatorCatalogDependencies = {},
): Promise<CreatorCapabilityDescriptor[]> {
  try {
    throwIfCatalogAborted(deps.signal);
    const activeUserId = (deps.getActiveUserId ?? getActiveUserId)();
    if (!userId || activeUserId !== userId) throw new CreatorCatalogError('creator_user_not_active');

    const providerResult = await awaitCatalogOperation((deps.listProviders ?? listProvidersForUser)(userId), deps.signal);
    throwIfCatalogAborted(deps.signal);
    const configuredProviders: ProviderEntry[] = [];
    for (const provider of takeBounded(providerResult.providers, MAX_PROVIDER_INPUT_ITEMS)) {
      if (!boundedDependencyString(provider?.id)) continue;
      if (Array.isArray(provider.profiles) && provider.profiles.length > 0) configuredProviders.push(provider);
      if (configuredProviders.length === 64) break;
    }
    const modelLists: Array<{ provider: ProviderEntry; models: { id: string; name: string }[] }> = [];
    const providers = configuredProviders.slice(0, 64);
    let modelCount = 0;
    for (let offset = 0; offset < providers.length && modelCount < MAX_MODEL_ITEMS; offset += 4) {
      const batch = providers.slice(offset, offset + 4);
      const results = await Promise.all(batch.map(async (provider) => ({
        provider,
        models: takeBounded((await awaitCatalogOperation((deps.listModels ?? listModelsForUser)(userId, provider.id), deps.signal)).models, MAX_MODEL_INPUT_ITEMS)
          .filter((model): model is { id: string; name: string } => (
            !!model && typeof model === 'object'
            && typeof model.id === 'string' && typeof model.name === 'string'
            && model.id.length <= MAX_PROVIDER_STRING_SCAN
            && model.name.length <= MAX_PROVIDER_STRING_SCAN
          )),
      })));
      throwIfCatalogAborted(deps.signal);
      modelLists.push(...results);
      modelCount += results.reduce((count, item) => count + item.models.length, 0);
    }
    const models = sanitizeCreatorCapabilityCatalog(modelLists.flatMap(({ provider, models: providerModels }) => providerModels.map((model) => ({
      capabilityId: creatorCatalogLogicalId('model', provider.id, model.id),
      version: '1',
      kind: 'model' as const,
      displayName: model.name || model.id,
      available: true,
      permissions: ['cost'] as CreatorCapabilityPermission[],
      sourceRef: creatorCatalogLogicalId('provider', provider.id),
      health: 'ready' as const,
    })))).slice(0, MAX_MODEL_ITEMS);

    const listedSkills = await awaitCatalogOperation((deps.listSkills ?? listSkillsForUser)(userId), deps.signal);
    throwIfCatalogAborted(deps.signal);
    if (!Array.isArray(listedSkills) || listedSkills.length > MAX_SKILL_INPUT_ITEMS) {
      throw new CreatorCatalogError('creator_catalog_dependency_failed');
    }
    const skills = sanitizeCreatorCapabilityCatalog(listedSkills.map((skill) => ({
      capabilityId: creatorCatalogLogicalId('skill', boundedDependencyString(skill.id) ?? '[invalid-skill]'),
      version: boundedDependencyString(skill.version) || '1',
      kind: 'skill' as const,
      displayName: boundedDependencyString(skill.name) || boundedDependencyString(skill.id) || 'Skill',
      ...skillHealth(skill),
      permissions: ['read'] as CreatorCapabilityPermission[],
      sourceRef: creatorCatalogLogicalId('skill', boundedDependencyString(skill.source) ?? '[invalid-source]', boundedDependencyString(skill.id) ?? '[invalid-skill]'),
    })));

    return sanitizeCreatorCapabilityCatalog([
      ...models,
      ...AGENT_CAPABILITIES.map(toolDescriptor),
      ...skills,
    ]);
  } catch (error) {
    if (error instanceof CreatorCatalogError || error instanceof CreatorCatalogCancelledError) throw error;
    throw new CreatorCatalogError('creator_catalog_dependency_failed');
  }
}
