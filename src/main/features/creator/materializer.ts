import { createHash, randomUUID } from 'node:crypto';

import {
  createCustomAgentForUser,
  deleteCustomAgentForUser,
  getAgentRuntimeSpecForUser,
  type Agent,
  type AgentInput,
  type AgentCreatorBinding,
  type CreateAgentOptions,
  type UpdateAgentFields,
} from '../agents';
import { listSkillsForUser, type SkillListing } from '../skills';
import { getActiveUserId } from '../users';
import { nameDisplayWidth, NAME_DISPLAY_MAX_UNITS } from '../../util/name-limit';
import { fileEditLock } from '../../util/locks';
import { userCreatorAgentBindingFile } from '../../paths';
import {
  buildCreatorCapabilityCatalog,
  creatorCatalogLogicalId,
  type CreatorCapabilityDescriptor,
} from './catalog';
import {
  readCreatorAgentBinding,
  saveCreatorAgentBinding,
  creatorBindingPolicyMatchesManifest,
  type CreatorAgentBinding,
  type CreatorAgentBindingPolicy,
} from './agent-binding-store';
import {
  listCreatorAudit,
  readCreatorDraft,
  readCreatorPresetVersion,
  type CreatorAuditRecord,
} from './store';
import type { CreatorPresetManifestV1 } from './types';
import { creatorManifestDigest } from './verification-service';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export interface CreatorPresetRef {
  presetId: string;
  version: string;
  manifestDigest: string;
}

export interface CreatorResolvedCapabilities {
  skillIds: string[];
}

export interface CreatorMaterializerDependencies {
  getActiveUserId?: () => string;
  readVersion?: typeof readCreatorPresetVersion;
  readDraft?: typeof readCreatorDraft;
  listAudit?: typeof listCreatorAudit;
  resolveCapabilities?: (
    userId: string,
    manifest: Readonly<CreatorPresetManifestV1>,
  ) => Promise<CreatorResolvedCapabilities>;
  buildCatalog?: typeof buildCreatorCapabilityCatalog;
  listSkills?: (userId: string) => Promise<SkillListing[]>;
  readBinding?: typeof readCreatorAgentBinding;
  saveBinding?: typeof saveCreatorAgentBinding;
  createAgent?: (userId: string, options: CreateAgentOptions) => Promise<Agent | null>;
  updateAgent?: (
    userId: string,
    agentId: string,
    updates: UpdateAgentFields,
  ) => Promise<Agent | null>;
  getAgent?: (userId: string, agentId: string) => Promise<Agent | null>;
  deleteAgent?: (userId: string, agentId: string) => Promise<boolean>;
  now?: () => string;
  createRevision?: () => string;
}

export interface CreatorPresetMaterializer {
  materializeCreatorPreset(userId: string, presetRef: CreatorPresetRef): Promise<CreatorAgentBinding>;
}

function assertPresetRef(value: CreatorPresetRef): void {
  if (
    !value
    || typeof value !== 'object'
    || !IDENTIFIER.test(value.presetId)
    || !IDENTIFIER.test(value.version)
    || !DIGEST.test(value.manifestDigest)
  ) throw new Error('creator_materialization_ref_invalid');
}

function metadata(record: CreatorAuditRecord): Record<string, unknown> {
  return record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : {};
}

function sameStringSet(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const left = actual.filter((value): value is string => typeof value === 'string');
  if (left.length !== actual.length) return false;
  return new Set(left).size === left.length
    && left.every((value) => expected.includes(value))
    && expected.every((value) => left.includes(value));
}

function exactlyOne<T>(items: readonly T[]): T | null {
  return items.length === 1 ? items[0] : null;
}

/**
 * Publication is an output of the Creator control plane, not an authority by
 * itself. Reconstruct the full linked evidence chain before an Agent is made:
 * saved draft -> passed verification -> approval -> immutable version write ->
 * lifecycle publication. Any missing or ambiguous link fails closed.
 */
interface CreatorLifecycleEvidence {
  draftId: string;
  draftManifestDigest: string;
  verificationRunId: string;
}

function assertMaterializableLifecycle(
  records: readonly CreatorAuditRecord[],
  presetRef: CreatorPresetRef,
  manifest: Readonly<CreatorPresetManifestV1>,
): CreatorLifecycleEvidence {
  if (manifest.presetId !== presetRef.presetId || manifest.version !== presetRef.version) {
    throw new Error('creator_preset_not_materializable');
  }
  const byEvent = (event: string, predicate: (record: CreatorAuditRecord) => boolean) => records.filter((record) => (
    record.event === event && predicate(record)
  ));
  const publishedVersion = exactlyOne(byEvent('preset.version_published', (record) => (
    record.presetId === presetRef.presetId && record.version === presetRef.version
  )));
  const publishedLifecycle = exactlyOne(byEvent('creator.lifecycle.published', (record) => (
    record.presetId === presetRef.presetId && record.version === presetRef.version
  )));
  if (!publishedVersion || !publishedLifecycle
      || typeof publishedVersion.draftId !== 'string'
      || publishedVersion.draftId !== publishedLifecycle.draftId) {
    throw new Error('creator_preset_not_materializable');
  }

  const draftId = publishedVersion.draftId;
  const publishedMetadata = metadata(publishedLifecycle);
  const draftSaved = exactlyOne(byEvent('draft.saved', (record) => (
    record.presetId === presetRef.presetId
    && record.draftId === draftId
    && metadata(record).manifestDigest === publishedMetadata.draftManifestDigest
  )));
  const verificationRunId = publishedMetadata.verificationRunId;
  const draftManifestDigest = publishedMetadata.draftManifestDigest;
  if (typeof verificationRunId !== 'string' || !IDENTIFIER.test(verificationRunId)
      || typeof draftManifestDigest !== 'string' || !DIGEST.test(draftManifestDigest)) {
    throw new Error('creator_preset_not_materializable');
  }
  const verification = exactlyOne(byEvent('creator.verification.recorded', (record) => (
    record.presetId === presetRef.presetId
    && record.draftId === draftId
    && metadata(record).verificationRunId === verificationRunId
    && metadata(record).status === 'passed'
  )));
  const verified = exactlyOne(byEvent('creator.lifecycle.verified', (record) => (
    record.presetId === presetRef.presetId
    && record.draftId === draftId
    && metadata(record).verificationRunId === verificationRunId
  )));
  const approval = exactlyOne(byEvent('creator.lifecycle.approved', (record) => (
    record.presetId === presetRef.presetId
    && record.draftId === draftId
    && metadata(record).manifestDigest === draftManifestDigest
    && metadata(record).verificationRunId === verificationRunId
  )));
  const publishedDigest = publishedMetadata.manifestDigest;
  if (!draftSaved || !verification || !verified || !approval
      || typeof publishedDigest !== 'string'
      || !DIGEST.test(publishedDigest)
      || publishedDigest !== presetRef.manifestDigest
      || publishedMetadata.draftManifestDigest !== metadata(draftSaved).manifestDigest
      || metadata(verification).manifestDigest !== metadata(draftSaved).manifestDigest
      || metadata(verified).manifestDigest !== metadata(draftSaved).manifestDigest
      || !sameStringSet(metadata(approval).approvedCapabilities, manifest.capabilities.map((item) => item.capabilityId))
      || !sameStringSet(metadata(approval).approvedSideEffects, manifest.permissions.sideEffects)) {
    throw new Error('creator_preset_not_materializable');
  }

  const relevant = records.filter((record) => (
    record.presetId === presetRef.presetId
    && record.version === presetRef.version
    && ['creator.lifecycle.published', 'creator.lifecycle.active', 'creator.lifecycle.disabled', 'creator.lifecycle.rolled_back'].includes(record.event)
  ));
  const latest = relevant.at(-1)?.event;
  if (latest !== 'creator.lifecycle.published' && latest !== 'creator.lifecycle.active') {
    throw new Error('creator_preset_not_materializable');
  }
  return { draftId, draftManifestDigest, verificationRunId };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function immutableBinding(binding: CreatorAgentBinding): CreatorAgentBinding {
  return deepFreeze(structuredClone(binding));
}

function sanitizeAgentNamePart(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_\-\u4E00-\u9FFF]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function shortVersionSuffix(version: string): string {
  const clean = sanitizeAgentNamePart(version) || 'version';
  const direct = `-v${clean}`;
  if (nameDisplayWidth(direct) < NAME_DISPLAY_MAX_UNITS) return direct;
  const digest = createHash('sha256').update(version).digest('hex').slice(0, 12);
  return `-v${digest}`;
}

function truncateDisplayName(value: string, suffix: string): string {
  const maxBase = Math.max(1, NAME_DISPLAY_MAX_UNITS - nameDisplayWidth(suffix));
  let base = '';
  for (const char of sanitizeAgentNamePart(value) || 'Creator-Agent') {
    if (nameDisplayWidth(base + char) > maxBase) break;
    base += char;
  }
  return `${base.replace(/-+$/g, '') || 'C'}${suffix}`;
}

function creatorAgentName(manifest: CreatorPresetManifestV1): string {
  // Governed Agent 创建师 drafts already passed the Agent config-sheet
  // boundary. Preserve the user-visible name exactly; the legacy Creator
  // preset path keeps its collision-safe version suffix for compatibility.
  return manifest.agent ? manifest.displayName : truncateDisplayName(manifest.displayName, shortVersionSuffix(manifest.version));
}

function creatorWorkflow(manifest: CreatorPresetManifestV1): string {
  if (manifest.agent) {
    // The workflow is user-authored runtime guidance. Do not wrap or rewrite
    // it during materialization; only append a single immutable provenance
    // line so an Agent can be traced back to its Creator preset.
    return `${manifest.prompt.systemSections.join('\n\n')}\n\nCreator governance binding: ${manifest.presetId}@${manifest.version}`;
  }
  const sections = manifest.prompt.systemSections.join(', ');
  const tools = manifest.permissions.tools.join(', ') || 'none';
  return [
    `Creator preset: ${manifest.presetId} version ${manifest.version}.`,
    `Model policy: ${manifest.model.providerId}/${manifest.model.modelId}.`,
    `System sections: ${sections}.`,
    `Approved local tools: ${tools}.`,
    'Use only the approved materialized skills and existing main-process policy gates.',
    'Return a bounded response and do not perform unapproved side effects.',
  ].join('\n\n');
}

function creatorProvenance(
  manifest: Readonly<CreatorPresetManifestV1>,
  manifestDigest: string,
  materializationRevision: string,
): AgentCreatorBinding {
  return {
    schemaVersion: 1,
    presetId: manifest.presetId,
    version: manifest.version,
    manifestDigest,
    materializationRevision,
  };
}

function createOptions(
  manifest: Readonly<CreatorPresetManifestV1>,
  provenance: AgentCreatorBinding,
): CreateAgentOptions {
  const authored = manifest.agent;
  return {
    name: creatorAgentName(manifest),
    description: manifest.description,
    ...(authored?.description_zh !== undefined ? { description_zh: authored.description_zh } : {}),
    ...(authored?.description_en !== undefined ? { description_en: authored.description_en } : {}),
    workflow: creatorWorkflow(manifest),
    ...(authored?.icon !== undefined ? { icon: authored.icon } : {}),
    ...(authored?.color !== undefined ? { color: authored.color } : {}),
    ...(authored?.interactive !== undefined ? { interactive: authored.interactive } : {}),
    ...(authored?.knowhow !== undefined ? { knowhow: [...authored.knowhow] } : {}),
    ...(authored?.standards !== undefined ? { standards: [...authored.standards] } : {}),
    ...(authored?.inputs !== undefined ? { inputs: structuredClone(authored.inputs) as unknown as AgentInput[] } : {}),
    skill_list: [],
    runtime: { kind: 'in_process' },
    category: authored?.category ?? 'general',
    output_format: 'text',
    default_model: { provider: manifest.model.providerId, model: manifest.model.modelId },
    creator_binding: provenance,
  };
}

async function resolveCreatorCapabilities(
  userId: string,
  manifest: Readonly<CreatorPresetManifestV1>,
  buildCatalog: typeof buildCreatorCapabilityCatalog,
  readSkills: (userId: string) => Promise<SkillListing[]>,
): Promise<CreatorResolvedCapabilities> {
  const [catalog, skills] = await Promise.all([buildCatalog(userId), readSkills(userId)]);
  const required = new Set([
    creatorCatalogLogicalId('model', manifest.model.providerId, manifest.model.modelId),
    ...manifest.capabilities.map((item) => item.capabilityId),
    ...manifest.permissions.tools,
  ]);
  const descriptors = new Map<string, CreatorCapabilityDescriptor>(
    catalog.map((item) => [item.capabilityId, item]),
  );
  for (const capabilityId of required) {
    const selected = manifest.capabilities.find((item) => item.capabilityId === capabilityId);
    const descriptor = descriptors.get(capabilityId);
    if (!descriptor || !descriptor.available || descriptor.health === 'unavailable') {
      throw new Error('creator_capability_unavailable');
    }
    if (selected && descriptor.version !== selected.version) throw new Error('creator_capability_version_mismatch');
  }

  const skillByCapability = new Map(
    skills.map((skill) => [creatorCatalogLogicalId('skill', skill.id), skill.id]),
  );
  const skillIds: string[] = [];
  for (const item of manifest.capabilities) {
    if (descriptors.get(item.capabilityId)?.kind !== 'skill') continue;
    const skillId = skillByCapability.get(item.capabilityId);
    if (!skillId) throw new Error('creator_capability_unavailable');
    if (!skillIds.includes(skillId)) skillIds.push(skillId);
  }
  return { skillIds };
}

function assertResolvedCapabilityScope(
  manifest: Readonly<CreatorPresetManifestV1>,
  resolved: CreatorResolvedCapabilities,
  skills: readonly SkillListing[],
): void {
  if (!resolved || !Array.isArray(resolved.skillIds) || resolved.skillIds.length > 64) {
    throw new Error('creator_capability_scope_invalid');
  }
  const approvedSkillIds = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (!capability.capabilityId.startsWith('skill.')) continue;
    const directId = capability.capabilityId.slice('skill.'.length);
    if (IDENTIFIER.test(directId)) approvedSkillIds.add(directId);
    for (const skill of skills) {
      if (creatorCatalogLogicalId('skill', skill.id) === capability.capabilityId) approvedSkillIds.add(skill.id);
    }
  }
  const seen = new Set<string>();
  for (const skillId of resolved.skillIds) {
    if (!IDENTIFIER.test(skillId) || seen.has(skillId) || !approvedSkillIds.has(skillId)) {
      throw new Error('creator_capability_scope_invalid');
    }
    seen.add(skillId);
  }
  const approvedSkillCount = manifest.capabilities.filter((item) => item.capabilityId.startsWith('skill.')).length;
  if (approvedSkillCount > 0 && resolved.skillIds.length === 0) {
    throw new Error('creator_capability_scope_invalid');
  }
}

function bindingPolicy(
  manifest: Readonly<CreatorPresetManifestV1>,
  resolved: CreatorResolvedCapabilities,
): CreatorAgentBindingPolicy {
  return {
    model: structuredClone(manifest.model),
    skillIds: [...resolved.skillIds],
    capabilityIds: manifest.capabilities.map((item) => item.capabilityId),
    runtime: structuredClone(manifest.runtime),
    permissions: structuredClone(manifest.permissions),
  };
}

function sameProvenance(
  actual: AgentCreatorBinding | undefined,
  expected: AgentCreatorBinding,
): boolean {
  return !!actual
    && actual.schemaVersion === expected.schemaVersion
    && actual.presetId === expected.presetId
    && actual.version === expected.version
    && actual.manifestDigest === expected.manifestDigest
    && actual.materializationRevision === expected.materializationRevision;
}

function assertPersistedAgent(
  agent: Agent | null,
  agentId: string,
  skillIds: readonly string[],
  provenance: AgentCreatorBinding,
): Agent {
  if (!agent || agent.agent_id !== agentId || agent.source !== 'custom') {
    throw new Error('creator_materialized_agent_missing');
  }
  const actualSkills = [...(agent.skill_list ?? [])].sort();
  const expectedSkills = [...skillIds].sort();
  if (
    actualSkills.length !== expectedSkills.length
    || actualSkills.some((value, index) => value !== expectedSkills[index])
    || !sameProvenance(agent.creator_binding, provenance)
  ) throw new Error('creator_materialized_agent_invalid');
  return agent;
}

function provenanceFromBinding(binding: CreatorAgentBinding): AgentCreatorBinding {
  return {
    schemaVersion: 1,
    presetId: binding.presetId,
    version: binding.version,
    manifestDigest: binding.manifestDigest,
    materializationRevision: binding.materializationRevision,
  };
}

async function cleanupCreatedAgent(
  deleteAgent: (userId: string, agentId: string) => Promise<boolean>,
  userId: string,
  agentId: string,
): Promise<void> {
  let deleted = false;
  try {
    deleted = await deleteAgent(userId, agentId);
  } catch {
    throw new Error('creator_materialization_cleanup_failed');
  }
  if (!deleted) throw new Error('creator_materialization_cleanup_failed');
}

export function createCreatorPresetMaterializer(
  deps: CreatorMaterializerDependencies = {},
): CreatorPresetMaterializer {
  const activeUserId = deps.getActiveUserId ?? getActiveUserId;
  const readVersion = deps.readVersion ?? readCreatorPresetVersion;
  const listAudit = deps.listAudit ?? listCreatorAudit;
  const buildCatalog = deps.buildCatalog ?? buildCreatorCapabilityCatalog;
  const readSkills = deps.listSkills ?? listSkillsForUser;
  const resolveCapabilities = deps.resolveCapabilities
    ?? ((userId, manifest) => resolveCreatorCapabilities(userId, manifest, buildCatalog, readSkills));
  const usesCustomCapabilityResolver = deps.resolveCapabilities !== undefined;
  const readDraft = deps.readDraft ?? readCreatorDraft;
  const readBinding = deps.readBinding ?? readCreatorAgentBinding;
  const saveBinding = deps.saveBinding ?? saveCreatorAgentBinding;
  const createAgent = deps.createAgent ?? createCustomAgentForUser;
  const getExistingAgent = deps.getAgent ?? getAgentRuntimeSpecForUser;
  const deleteAgent = deps.deleteAgent ?? deleteCustomAgentForUser;
  const now = deps.now ?? (() => new Date().toISOString());
  const createRevision = deps.createRevision ?? randomUUID;

  return {
    async materializeCreatorPreset(userId, presetRef) {
      assertPresetRef(presetRef);
      if (activeUserId() !== userId) throw new Error('creator_active_user_mismatch');

      return fileEditLock(userCreatorAgentBindingFile(userId, presetRef.presetId)).runExclusive(async () => {
        const manifest = await readVersion(userId, presetRef.presetId, presetRef.version);
        if (!manifest) throw new Error('creator_preset_version_not_found');
        const immutableManifest = deepFreeze(structuredClone(manifest));
        if (creatorManifestDigest(immutableManifest) !== presetRef.manifestDigest) {
          throw new Error('creator_manifest_digest_mismatch');
        }
        const lifecycleEvidence = assertMaterializableLifecycle(
          await listAudit(userId),
          presetRef,
          immutableManifest,
        );
        const draft = await readDraft(userId, lifecycleEvidence.draftId);
        if (!draft
            || draft.manifest.presetId !== immutableManifest.presetId
            || creatorManifestDigest(draft.manifest) !== lifecycleEvidence.draftManifestDigest
            || !sameStringSet(
              draft.manifest.capabilities.map((item) => item.capabilityId),
              immutableManifest.capabilities.map((item) => item.capabilityId),
            )
            || creatorManifestDigest({ ...draft.manifest, version: immutableManifest.version })
              !== creatorManifestDigest(immutableManifest)) {
          throw new Error('creator_preset_not_materializable');
        }

        const existingBinding = await readBinding(userId, presetRef.presetId, presetRef.version);
        if (existingBinding) {
          if (existingBinding.manifestDigest !== presetRef.manifestDigest) {
            throw new Error('creator_agent_binding_conflict');
          }
          if (!creatorBindingPolicyMatchesManifest(existingBinding.policy, immutableManifest)) {
            throw new Error('creator_capability_scope_invalid');
          }
          const boundAgent = await getExistingAgent(userId, existingBinding.agentId);
          if (!boundAgent) throw new Error('creator_bound_agent_missing');
          assertPersistedAgent(
            boundAgent,
            existingBinding.agentId,
            existingBinding.policy.skillIds,
            provenanceFromBinding(existingBinding),
          );
          return immutableBinding(existingBinding);
        }

        const resolved = await resolveCapabilities(userId, immutableManifest);
        assertResolvedCapabilityScope(
          immutableManifest,
          resolved,
          usesCustomCapabilityResolver ? [] : await readSkills(userId),
        );
        const materializationRevision = createRevision();
        const provenance = creatorProvenance(
          immutableManifest,
          presetRef.manifestDigest,
          materializationRevision,
        );
        let createdAgent: Agent | null = null;
        try {
          createdAgent = await createAgent(userId, {
            ...createOptions(immutableManifest, provenance),
            skill_list: [...resolved.skillIds],
          });
          if (!createdAgent || createdAgent.source !== 'custom') {
            throw new Error('creator_agent_create_failed');
          }
          assertPersistedAgent(
            await getExistingAgent(userId, createdAgent.agent_id),
            createdAgent.agent_id,
            resolved.skillIds,
            provenance,
          );
          const binding: CreatorAgentBinding = {
            schemaVersion: 1,
            presetId: immutableManifest.presetId,
            version: immutableManifest.version,
            manifestDigest: presetRef.manifestDigest,
            agentId: createdAgent.agent_id,
            materializedAt: now(),
            materializationRevision,
            policy: bindingPolicy(immutableManifest, resolved),
          };
          return immutableBinding(await saveBinding(userId, binding));
        } catch (error) {
          if (createdAgent) await cleanupCreatedAgent(deleteAgent, userId, createdAgent.agent_id);
          throw error;
        }
      });
    },
  };
}

export async function isCreatorPresetMaterializedForRuntime(
  userId: string,
  presetId: string,
  version: string,
  manifestDigest: string,
): Promise<boolean> {
  if (!IDENTIFIER.test(userId) || !IDENTIFIER.test(presetId) || !IDENTIFIER.test(version)
      || !DIGEST.test(manifestDigest)) return false;
  try {
    const binding = await readCreatorAgentBinding(userId, presetId, version);
    if (!binding || binding.manifestDigest !== manifestDigest) return false;
    const manifest = await readCreatorPresetVersion(userId, presetId, version);
    if (!manifest || creatorManifestDigest(manifest) !== manifestDigest
        || !creatorBindingPolicyMatchesManifest(binding.policy, manifest)) return false;
    const agent = await getAgentRuntimeSpecForUser(userId, binding.agentId);
    assertPersistedAgent(
      agent,
      binding.agentId,
      binding.policy.skillIds,
      provenanceFromBinding(binding),
    );
    return true;
  } catch {
    return false;
  }
}

const defaultCreatorPresetMaterializer = createCreatorPresetMaterializer();

export async function materializeCreatorPreset(
  userId: string,
  presetRef: CreatorPresetRef,
): Promise<CreatorAgentBinding> {
  return defaultCreatorPresetMaterializer.materializeCreatorPreset(userId, presetRef);
}
