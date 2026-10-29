/** Source-grounded ontology proposals; materialization shares the cognition commit. */
import { createHash } from 'node:crypto';
import { checkedStockOrganizationRevision } from './stock-organization-provenance';
import { z } from 'zod';
import { withCognitionSourceDependency } from '../cognition_bridge';
import { applyOntologyCommand, moduleCanUse, validateOntologyCommand, type OntologyAction } from '../cognition/ontology/commands';
import { boundedJson, emptyOntologyDocument, OntologyError, validateOntologyId, validateOntologyRecord, type OntologyDocument, type OntologyRecord } from '../cognition/ontology/model';
import { readOntologyDocument } from '../cognition/ontology/service';
import { normalizeAbilityAssetOntologyRefs, type CanonicalAbilityAssetOntologyRef } from './ontology-refs';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import type { RecallAbilityAssetScopePolicy } from './scope-policy';
import { ontologyModuleVisibleToTask } from '../cognition/ontology/query';
import { tokenize } from '../search/tokenize';
import { ontologyScopeViolations as scopeViolations } from '../cognition/ontology/cognition-scope';
import { ONTOLOGY_RULE_SEMANTICS } from './ontology-rule-semantics';

export interface OntologyFormationPlan {
  schemaVersion: 1; ownerId?: string; candidateId: string; baselineRevision: number; commandId: string;
  actions: OntologyAction[]; refs: CanonicalAbilityAssetOntologyRef[];
  requiresTReview: boolean; blockedReasons: string[]; reason: string; evidence: string[];
  previewChanges: Array<{ intent: string; recordId: string; box: 'T' | 'R' | 'A'; before?: OntologyRecord; after: OntologyRecord }>;
  effectiveFrom?: string;
}
const proposalSchema = z.object({ actions: z.array(z.unknown()).max(50).default([]), refs: z.array(z.unknown()).max(100).default([]),
  reason: z.string().trim().min(1).max(2000), evidence: z.array(z.string().min(1).max(160)).min(1).max(100),
  identityEvidence: z.array(z.object({ recordId: z.string(), reason: z.string().trim().min(5).max(2000),
    evidence: z.array(z.string().min(1).max(160)).min(1).max(100) }).strict()).max(50).default([]),
}).strict();
const box = (record: OntologyRecord): 'T' | 'R' | 'A' => ['module', 'definition', 'reference'].includes(record.kind) ? 'T' : record.kind === 'rule' ? 'R' : 'A';
function assertSafeFormationPersistence(value: unknown): void {
  boundedJson(value);
  const pending = [value], strings: string[] = [];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') strings.push(item);
    else if (Array.isArray(item)) pending.push(...item);
    else if (item && typeof item === 'object') pending.push(...Object.values(item));
  }
  // Original strings detect whitespace-separated credentials; JSON also checks credential field assignments.
  assertNotForbiddenToPersist([...strings, JSON.stringify(value)]);
}
const referenceKeys = new Set(['moduleId', 'typeId', 'subjectId', 'definitionId', 'targetModuleId', 'targetRecordId', 'recordId', 'targetId', 'subjectTypes', 'objectTypes']);
function reuseStructures(doc: OntologyDocument, actions: OntologyAction[], refs: CanonicalAbilityAssetOntologyRef[], recordedAt: string): OntologyAction[] {
  const redirects = new Map<string, string>();
  function rewrite(value: unknown, key = ''): unknown {
    if (typeof value === 'string') return referenceKeys.has(key) ? redirects.get(value) ?? value : value;
    if (Array.isArray(value)) return value.map(child => rewrite(child, key));
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(object).map(([field, child]) => [field,
      field === 'id' && object.kind === 'entity' && typeof child === 'string' ? redirects.get(child) ?? child
        : field === 'equals' && object.kind === 'task' && object.field === 'entityId' && typeof child === 'string' ? redirects.get(child) ?? child : rewrite(child, field)]));
  }
  const comparable = (record: OntologyRecord) => JSON.stringify(Object.fromEntries(Object.entries(record)
    .filter(([key]) => !['id', 'version', 'status', 'source', 'createdAt', 'updatedAt'].includes(key)).sort(([a], [b]) => a.localeCompare(b))));
  // Reuse only fully identical structural contracts; names alone never establish identity.
  for (let pass = 0; pass < 3; pass++) for (const action of actions) {
    if (action.intent !== 'create' || !action.recordId || redirects.has(action.recordId)
      || !['module', 'definition', 'reference'].includes(String(action.record.kind))) continue;
    const normalized = validateOntologyRecord({ ...(rewrite(action.record) as Record<string, unknown>), id: action.recordId, version: 1,
      status: 'active', access: action.record.access ?? 'task', source: { kind: 'candidate', label: action.sourceLabel }, createdAt: recordedAt, updatedAt: recordedAt });
    const match = Object.values(doc.records).find(record => record.status === 'active' && record.kind === normalized.kind && comparable(record) === comparable(normalized));
    if (match) redirects.set(action.recordId, match.id);
  }
  for (let index = 0; index < refs.length; index++) refs[index] = rewrite(refs[index]) as CanonicalAbilityAssetOntologyRef;
  // groupId is a compatibility alias, not a second identity.
  refs.forEach(ref => { ref.groupId = ref.moduleId; });
  return actions.filter(action => action.intent !== 'create' || !redirects.has(action.recordId!)).map(action => rewrite(action) as OntologyAction);
}
function commandId(candidateId: string, value: unknown): string {
  return 'formation-' + createHash('sha256').update(JSON.stringify([candidateId, value])).digest('hex').slice(0, 32);
}
function formationCommandId(candidateId: string, baselineRevision: number, actions: OntologyAction[]): string {
  // Dependency refs can point at generated successor ids; they cannot participate in their own id seed.
  return commandId(candidateId, [baselineRevision, actions]);
}
function successorId(ownerId: string, command: string, index: number): string {
  return 'ont-' + createHash('sha256').update(`${ownerId}:${command}:${index}-successor`).digest('hex').slice(0, 24);
}
export function bindOntologyFormationPlan(candidateId: string, plan: OntologyFormationPlan): OntologyFormationPlan {
  validateOntologyId(candidateId);
  const next = structuredClone(plan);
  next.candidateId = candidateId; next.commandId = formationCommandId(candidateId, plan.baselineRevision, plan.actions);
  const redirects = new Map<string, string>();
  if (plan.ownerId) plan.actions.forEach((action, index) => {
    if (action.intent === 'change' || action.intent === 'correct') redirects.set(successorId(plan.ownerId!, plan.commandId, index), successorId(plan.ownerId!, next.commandId, index));
  });
  next.refs.forEach(ref => { ref.recordId = redirects.get(ref.recordId) ?? ref.recordId; });
  next.previewChanges.forEach(row => {
    row.after.id = redirects.get(row.after.id) ?? row.after.id; row.recordId = row.after.id;
    if (row.after.source.kind === 'candidate' && row.after.source.recordId === plan.candidateId) row.after.source.recordId = candidateId;
  });
  return next;
}
function normalizeActionEnvelope(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const action = structuredClone(raw) as Record<string, unknown>;
  if (['change', 'correct'].includes(String(action.intent)) && action.patch && typeof action.patch === 'object' && !Array.isArray(action.patch)) {
    const patch = action.patch as Record<string, unknown>, keys = Object.keys(patch);
    if (keys.length && keys.every(key => ['object', 'subjectId', 'certainty'].includes(key) && !Object.hasOwn(action, key))) {
      Object.assign(action, patch); delete action.patch;
    }
  }
  if (action.intent !== 'create' || !action.record || typeof action.record !== 'object' || Array.isArray(action.record)) return action;
  const record = action.record as Record<string, unknown>;
  if (record.kind !== undefined) return action;
  const shapes: Array<[string, string[]]> = [['assertion', ['moduleId', 'subjectId', 'definitionId', 'object', 'validity']],
    ['rule', ['moduleId', 'name', 'requirement', 'strength', 'condition', 'effect', 'exception']]];
  const matched = shapes.filter(([, fields]) => fields.every(key => Object.hasOwn(record, key)));
  // A missing syntactic discriminator is recoverable only from one complete, unambiguous shape.
  if (matched.length === 1) record.kind = matched[0][0];
  return action;
}

/** A model envelope may explicitly reference this cognition's one body. It is
 * resolved before canonical validation; missing/ambiguous intent is never
 * repaired, and an independently supplied conflicting body remains a conflict. */
export function resolveSharedRuleBodyEnvelope(doc: OntologyDocument, raw: unknown,
  refs: CanonicalAbilityAssetOntologyRef[], judgment: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const action = raw as Record<string, unknown>;
  const payload = action.intent === 'create' ? action.record : action.intent === 'update' ? action.patch : undefined;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(payload, 'requirementSource')) return raw;
  const fields = payload as Record<string, unknown>;
  if (fields.requirementSource !== 'cognition_body' || typeof judgment !== 'string' || !judgment.trim())
    throw new OntologyError('invalid_input', 'invalid explicit cognition body reference');
  const matching = refs.filter(ref => ref.recordId === action.recordId);
  if (matching.length !== 1 || matching[0].versionPolicy !== 'current' || matching[0].sharedBody !== true)
    throw new OntologyError('invalid_reference', 'explicit cognition body requires one current shared rule reference');
  const ref = matching[0];
  if (action.intent === 'create') {
    if (fields.kind !== 'rule' || fields.moduleId !== ref.moduleId)
      throw new OntologyError('invalid_reference', 'explicit cognition body must target its own rule module');
  } else {
    const existing = typeof action.recordId === 'string' ? doc.records[action.recordId] : undefined;
    if (!existing || existing.kind !== 'rule' || existing.status !== 'active' || existing.moduleId !== ref.moduleId)
      throw new OntologyError('invalid_reference', 'explicit cognition body target is not the current canonical rule');
  }
  if (Object.hasOwn(fields, 'requirement') && fields.requirement !== judgment)
    throw new OntologyError('shared_body_mismatch', 'explicit cognition body conflicts with the supplied rule text');
  const resolved = structuredClone(action);
  const body = (action.intent === 'create' ? resolved.record : resolved.patch) as Record<string, unknown>;
  body.requirement = judgment;
  delete body.requirementSource;
  return resolved;
}
/** Prepare a visible blocked plan; the commit repeats this against actual persisted asset restrictions. */
export function validateOntologyFormationScope(userId: string, doc: OntologyDocument, input: OntologyFormationPlan | undefined,
  scopePolicy?: RecallAbilityAssetScopePolicy): OntologyFormationPlan | undefined {
  if (!input) return undefined;
  if (doc.ownerId !== userId || input.ownerId && input.ownerId !== userId) throw new OntologyError('invalid_user', 'formation scope owner mismatch');
  const plan = structuredClone(input);
  const preview = { ...doc, records: { ...doc.records } };
  for (const row of plan.previewChanges) preview.records[row.after.id] = row.after;
  const records = plan.previewChanges.map(row => row.after);
  const violations = scopeViolations(preview, records, scopePolicy);
  plan.blockedReasons = [...new Set([...plan.blockedReasons, ...violations])];
  return plan;
}
/** Invalid proposals remain visible and block confirmation; they are never silently dropped. */
export function parseOntologyFormationProposal(doc: OntologyDocument, candidateId: string, raw: unknown,
  judgment = '', recordedAt = new Date().toISOString(), target: 'cognition' | 'ontology' = 'cognition'): OntologyFormationPlan | undefined {
  if (raw === undefined || raw === null) return undefined;
  assertSafeFormationPersistence(raw);
  validateOntologyId(candidateId);
  const plan: OntologyFormationPlan = { schemaVersion: 1, ownerId: doc.ownerId, candidateId, baselineRevision: doc.revision, commandId: '', actions: [], refs: [],
    requiresTReview: false, blockedReasons: [], reason: '', evidence: [], previewChanges: [] };
  try {
    const proposal = proposalSchema.parse(raw);
    plan.reason = proposal.reason; plan.evidence = proposal.evidence;
    plan.refs = normalizeAbilityAssetOntologyRefs(proposal.refs).map(ref => {
      if (!ref.moduleId || !ref.recordId || !ref.versionPolicy) throw new OntologyError('invalid_reference', 'formation requires canonical record references');
      return ref as CanonicalAbilityAssetOntologyRef;
    });
    if (target === 'ontology' && plan.refs.some(ref => ref.sharedBody))
      throw new OntologyError('shared_body_mismatch', 'ontology-only changes cannot claim a cognition body');
    if (new Set(plan.refs.map(ref => `${ref.moduleId}\0${ref.recordId}`)).size !== plan.refs.length)
      throw new OntologyError('invalid_reference', 'duplicate canonical formation references');
    if (proposal.actions.length) {
      const actions = proposal.actions.map(action => resolveSharedRuleBodyEnvelope(doc, action, plan.refs, judgment))
        .map(normalizeActionEnvelope);
      assertSafeFormationPersistence(actions);
      plan.actions = validateOntologyCommand({ commandId: 'proposal', expectedRevision: doc.revision, actions }).actions;
      if (plan.actions.some(action => action.intent === 'create' && !action.recordId))
        throw new OntologyError('invalid_input', 'proposed creations require explicit record ids');
      plan.actions = reuseStructures(doc, plan.actions, plan.refs, recordedAt);
    }
    plan.commandId = formationCommandId(candidateId, plan.baselineRevision, plan.actions);
    const outcome = plan.actions.length ? applyOntologyCommand(doc, { commandId: plan.commandId, expectedRevision: doc.revision, actions: plan.actions }, recordedAt,
      { kind: 'candidate', recordId: candidateId, label: target === 'ontology' ? '本体独立形成与更新' : '认知形成关联本体' }) : undefined;
    const preview = outcome?.document ?? doc;
    plan.previewChanges = (outcome?.document.history ?? []).filter(row => row.commandId === plan.commandId)
      .map(row => ({ intent: row.intent, recordId: row.after.id, box: box(row.after), ...(row.before ? { before: row.before } : {}), after: row.after }));
    plan.requiresTReview = plan.previewChanges.some(row => row.box === 'T');
    plan.actions.forEach((action, index) => {
      if (action.intent === 'change' || action.intent === 'correct') for (const ref of plan.refs)
        if (ref.versionPolicy === 'current' && ref.recordId === action.recordId) ref.recordId = successorId(doc.ownerId, plan.commandId, index);
    });
    const supersededIds = new Set(plan.previewChanges.flatMap(row => row.after.kind === 'assertion' && row.after.supersedesId ? [row.after.supersedesId] : []));
    // A model can omit a display link while still proposing a fully validated dependency.
    // Every new/current fact or identity in this group remains explicitly linked to its cognition.
    for (const row of plan.previewChanges) if (row.after.status === 'active' && ['entity', 'assertion'].includes(row.after.kind)
      && !supersededIds.has(row.after.id) && !plan.refs.some(ref => ref.recordId === row.after.id))
      plan.refs.push({ groupId: (row.after as Exclude<OntologyRecord, { kind: 'module' }>).moduleId,
        moduleId: (row.after as Exclude<OntologyRecord, { kind: 'module' }>).moduleId, recordId: row.after.id, versionPolicy: 'current' });
    for (const row of plan.previewChanges) {
      const identityEdit = plan.actions.some(action => action.intent === 'update' && action.recordId === row.after.id
        && ['name', 'aliases', 'typeId', 'identityStatus'].some(key => Object.hasOwn(action.patch, key)));
      if (row.after.kind === 'entity' && row.after.identityStatus === 'confirmed'
        && (!row.before || row.before.kind !== 'entity' || row.before.identityStatus !== 'confirmed' || identityEdit)) {
        const evidence = proposal.identityEvidence.find(item => item.recordId === row.after.id);
        if (!evidence || evidence.evidence.some(id => !proposal.evidence.includes(id))) plan.blockedReasons.push('identity_evidence_required:' + row.after.id);
      }
      if (row.after.certainty === 'inferred' || row.after.certainty === 'unknown'
        || (row.after.kind === 'entity' && row.after.identityStatus === 'unresolved')) plan.blockedReasons.push('uncertain_ontology:' + row.after.id);
    }
    for (const ref of plan.refs) {
      const record = preview.records[ref.recordId], module = preview.records[ref.moduleId];
      if (!record || record.status !== 'active' || !module || module.kind !== 'module' || module.status !== 'active'
        || !moduleCanUse(preview, ref.moduleId, record)) throw new OntologyError('invalid_reference', 'ontology reference is unavailable');
      if (ref.versionPolicy === 'pinned' && ref.targetVersion !== record.version
        && !preview.history.some(row => row.after.id === record.id && row.after.version === ref.targetVersion))
        throw new OntologyError('invalid_reference', 'pinned ontology version is unavailable');
      if (ref.sharedBody && (record.kind !== 'rule' || record.requirement !== judgment))
        throw new OntologyError('shared_body_mismatch', 'shared rule must use the complete cognition body');
    }
    // Every proposed rule needs one cognition body binding, preventing parallel editable copies.
    for (const row of plan.previewChanges) if (target === 'cognition' && row.after.kind === 'rule' && row.after.status === 'active'
      && !plan.refs.some(ref => ref.recordId === row.after.id && ref.sharedBody)) plan.blockedReasons.push('shared_rule_reference_required:' + row.after.id);
    const effective = plan.actions.find(action => action.intent === 'change');
    if (effective?.intent === 'change') plan.effectiveFrom = effective.effectiveFrom;
  } catch (error) {
    plan.blockedReasons.push(error instanceof OntologyError ? error.code : 'invalid_ontology_proposal');
  }
  if (!plan.commandId) plan.commandId = commandId(candidateId, raw);
  return plan;
}

/** Stored previews are validated without rebasing them onto a newer document. */
export function normalizeOntologyFormationPlan(userId: string, candidateId: string, value: unknown): OntologyFormationPlan | undefined {
  if (value === undefined) return undefined;
  assertSafeFormationPersistence(value);
  validateOntologyId(userId); validateOntologyId(candidateId);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed ontology formation plan');
  const plan = structuredClone(value) as OntologyFormationPlan;
  if (plan.schemaVersion !== 1 || (plan.ownerId !== undefined && plan.ownerId !== userId) || plan.candidateId !== candidateId || !Number.isSafeInteger(plan.baselineRevision) || plan.baselineRevision < 0
    || !Array.isArray(plan.actions) || plan.actions.length > 50 || !Array.isArray(plan.refs)
    || !Array.isArray(plan.previewChanges) || !Array.isArray(plan.blockedReasons) || plan.blockedReasons.some(item => typeof item !== 'string')
    || typeof plan.reason !== 'string' || !Array.isArray(plan.evidence) || plan.evidence.some(item => typeof item !== 'string'))
    throw new Error('malformed ontology formation plan');
  validateOntologyId(plan.commandId);
  if (plan.actions.length) plan.actions = validateOntologyCommand({ commandId: plan.commandId, expectedRevision: plan.baselineRevision, actions: plan.actions }).actions;
  plan.refs = normalizeAbilityAssetOntologyRefs(plan.refs).map(ref => {
    if (!ref.moduleId || !ref.recordId || !ref.versionPolicy) throw new Error('malformed formation reference');
    return ref as CanonicalAbilityAssetOntologyRef;
  });
  plan.previewChanges = plan.previewChanges.map(row => {
    const after = validateOntologyRecord(row.after);
    return { ...row, recordId: after.id, box: box(after), after, ...(row.before ? { before: validateOntologyRecord(row.before) } : {}) };
  });
  plan.requiresTReview = plan.previewChanges.some(row => box(row.after) === 'T')
    || plan.actions.some(action => action.intent === 'create' && ['module', 'definition', 'reference'].includes(String(action.record.kind)));
  if (plan.commandId !== formationCommandId(candidateId, plan.baselineRevision, plan.actions) && !plan.blockedReasons.length)
    throw new Error('malformed ontology formation command identity');
  return plan;
}

/** Receipts bind the full request, including its actual pre-commit revision.
 * Replays retain that revision even when later commands advanced the document. */
function confirmationRevision(userId: string, plan: OntologyFormationPlan, current: OntologyDocument): number {
  const receipt = current.receipts[plan.commandId];
  if (receipt) return receipt.revision - 1;
  const expected = checkedStockOrganizationRevision(userId, plan, current.revision) ?? plan.baselineRevision;
  if (current.revision !== expected) throw new OntologyError('baseline_changed', 'ontology changed; compare the proposal again');
  return expected;
}

export async function withOntologyFormationPromotion<T>(userId: string, input: OntologyFormationPlan | undefined,
  actor: 'user' | 'system', work: () => Promise<T>): Promise<T> {
  if (!input) return work();
  const plan = normalizeOntologyFormationPlan(userId, input.candidateId, input)!;
  if (plan.blockedReasons.length) throw new OntologyError('formation_blocked', 'ontology dependencies require review', { reasons: plan.blockedReasons });
  if (actor === 'system' && plan.requiresTReview) throw new OntologyError('t_review_required', 'ontology structure requires user confirmation');
  let boundAssetId: string | undefined;
  return withCognitionSourceDependency(userId, 'ability-assets', (store, asset) => {
    // Optional metadata writes after the first commit must not re-run dependency binding.
    if (asset.candidateId !== plan.candidateId && !(asset.sourceCandidateIds as string[] | undefined)?.includes(plan.candidateId)) return;
    if (boundAssetId === asset.id) return;
    const current = store.ontology ?? emptyOntologyDocument(userId);
    if (actor === 'system' && plan.actions.some(action => action.intent === 'create'
      ? ['module', 'definition', 'reference'].includes(String(action.record.kind))
      : ['module', 'definition', 'reference'].includes(current.records[action.recordId]?.kind)))
      throw new OntologyError('t_review_required', 'ontology structure requires user confirmation');
    const expectedRevision = confirmationRevision(userId, plan, current);
    const result = plan.actions.length ? applyOntologyCommand(current, { commandId: plan.commandId, expectedRevision, actions: plan.actions }, new Date().toISOString(),
      { kind: 'candidate', recordId: plan.candidateId, label: '认知形成关联本体' }) : undefined;
    const next = result?.document ?? current;
    const violations = scopeViolations(next, (result?.receipt.changedIds ?? []).map(id => next.records[id]), asset.scopePolicy as RecallAbilityAssetScopePolicy | undefined);
    if (violations.length) throw new OntologyError('formation_blocked', 'ontology dependencies exceed the cognition scope', { reasons: violations });
    for (const id of result?.receipt.changedIds ?? []) {
      const record = next.records[id];
      if (record.source.kind !== 'candidate' || record.source.recordId !== plan.candidateId) continue;
      const sources = record.source.refs ?? [];
      if (!sources.some(source => source.kind === 'asset' && source.id === asset.id)) sources.push({ kind: 'asset', id: String(asset.id) });
      record.source = { ...record.source, refs: sources };
      next.history.filter(row => row.commandId === plan.commandId && row.after.id === id).forEach(row => { row.after.source = record.source; });
    }
    const replacedFacts = new Set(plan.actions.filter(action => action.intent === 'change' || action.intent === 'correct').map(action => action.recordId!));
    const refs = normalizeAbilityAssetOntologyRefs(asset.ontologyRefs ?? []).filter(ref => !(ref.versionPolicy === 'current' && replacedFacts.has(ref.recordId!)));
    for (const ref of plan.refs) {
      const record = next.records[ref.recordId];
      if (!record || record.status !== 'active' || !moduleCanUse(next, ref.moduleId, record)) throw new OntologyError('invalid_reference', 'formation reference changed');
      if (ref.sharedBody) {
        if (record.kind !== 'rule' || record.requirement !== asset.statement) throw new OntologyError('shared_body_mismatch', 'cognition and rule bodies differ');
        const owner = current.records[ref.recordId]?.source.refs?.find(source => source.kind === 'asset')
          ?? record.source.refs?.find(source => source.kind === 'asset');
        if (owner && owner.id !== asset.id) throw new OntologyError('shared_body_owner_conflict', 'rule body already belongs to another cognition');
        const source = { ...record.source, refs: [...(record.source.refs ?? []).filter(source => source.kind !== 'asset'), { kind: 'asset' as const, id: String(asset.id) }] };
        record.source = source;
        next.history.filter(row => row.commandId === plan.commandId && row.after.id === record.id).forEach(row => { row.after.source = source; });
      }
      const index = refs.findIndex(existing => existing.recordId === ref.recordId && existing.moduleId === ref.moduleId);
      if (index < 0) refs.push(ref); else refs[index] = ref;
    }
    if (refs.length) asset.ontologyRefs = refs;
    store.ontology = next;
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > 16 * 1024 * 1024)
      throw new OntologyError('capacity_exceeded', 'ontology document exceeds size limit');
    boundAssetId = String(asset.id);
    if (result && !result.duplicate) {
      store.pendingJournal ??= [];
      store.pendingJournal.push({ key: `ontology-${plan.commandId}`, line: { at: new Date().toISOString(), kind: 'ontology', receipt: result.receipt } });
    }
  }, work);
}

/** Commit an ontology-only group in the same authoritative draft as its
 * candidate's terminal state. No ability asset or second transaction is made. */
export async function withOntologyOnlyFormation<T>(userId: string, input: OntologyFormationPlan,
  work: () => Promise<T>, actor: 'user' | 'system' = 'user'): Promise<T> {
  const plan = normalizeOntologyFormationPlan(userId, input.candidateId, input)!;
  if (plan.blockedReasons.length || !plan.actions.length || plan.refs.some(ref => ref.sharedBody))
    throw new OntologyError('formation_blocked', 'ontology-only proposal requires a complete independent plan', { reasons: plan.blockedReasons });
  return withCognitionSourceDependency(userId, 'candidates', (store, candidate) => {
    if (candidate.id !== plan.candidateId || candidate.proposalTarget !== 'ontology' || candidate.status !== 'integrated')
      throw new OntologyError('invalid_input', 'ontology-only commit must finalize its own candidate');
    const current = store.ontology ?? emptyOntologyDocument(userId);
    const expectedRevision = confirmationRevision(userId, plan, current);
    for (const action of plan.actions) {
      const record = action.intent === 'create' ? undefined : current.records[action.recordId];
      if (actor === 'system' && ['module', 'definition', 'reference'].includes(action.intent === 'create' ? String(action.record.kind) : record?.kind))
        throw new OntologyError('t_review_required', 'ontology structure requires user confirmation');
      if (record?.kind === 'rule' && record.source.refs?.some(ref => ref.kind === 'asset'))
        throw new OntologyError('shared_body_owner_conflict', 'bound rule changes require their cognition in the same group');
    }
    const now = new Date().toISOString();
    const result = applyOntologyCommand(current, { commandId: plan.commandId, expectedRevision, actions: plan.actions }, now,
      { kind: 'candidate', recordId: plan.candidateId, label: '本体独立形成与更新' });
    const violations = scopeViolations(result.document, result.receipt.changedIds.map(id => result.document.records[id]),
      candidate.scopePolicy as RecallAbilityAssetScopePolicy | undefined);
    if (violations.length) throw new OntologyError('formation_blocked', 'ontology changes exceed source scope', { reasons: violations });
    for (const ref of plan.refs) {
      const record = result.document.records[ref.recordId];
      if (!record || record.status !== 'active' || !moduleCanUse(result.document, ref.moduleId, record))
        throw new OntologyError('invalid_reference', 'ontology formation reference changed');
    }
    if (Buffer.byteLength(JSON.stringify(result.document), 'utf8') > 16 * 1024 * 1024)
      throw new OntologyError('capacity_exceeded', 'ontology document exceeds size limit');
    store.ontology = result.document;
    const moduleIds = [...new Set(result.receipt.changedIds.map(id => {
        const record = result.document.records[id];
        return record.kind === 'module' ? record.id : record.moduleId;
      }))];
    if (!result.receipt.changedIds.length || moduleIds.length > 20)
      throw new OntologyError('capacity_exceeded', 'ontology group exceeds confirmation receipt bounds');
    candidate.ontologyHandoff = { status: 'integrated', commandId: plan.commandId,
      recordIds: result.receipt.changedIds, moduleIds, ontologyRevision: result.receipt.revision, committedAt: result.receipt.recordedAt };
    if (!result.duplicate) {
      store.pendingJournal ??= [];
      store.pendingJournal.push({ key: `ontology-${plan.commandId}`, line: { at: now, kind: 'ontology', receipt: result.receipt } });
    }
  }, work);
}

export function buildOntologyFormationContext(userId: string, doc = readOntologyDocument(userId), input: {
  queryText?: string; projectId?: string; workspaceId?: string; maxChars?: number; scopeBound?: boolean;
} = {}): { revision: number; records: OntologyRecord[]; truncated: boolean } {
  if (doc.ownerId !== userId) throw new OntologyError('invalid_user', 'ontology context owner mismatch');
  const scoped = input.scopeBound || input.projectId !== undefined || input.workspaceId !== undefined;
  const modules = new Set(Object.values(doc.records).filter(record => record.kind === 'module' && record.status === 'active'
    && (!scoped || ontologyModuleVisibleToTask(record, input))).map(record => record.id));
  const active = Object.values(doc.records).filter(record => record.status === 'active'
    && modules.has(record.kind === 'module' ? record.id : record.moduleId));
  const available = new Map(active.map(record => [record.id, record]));
  const query = new Set(tokenize(input.queryText || '').filter(term => term.length > 1));
  const score = (record: OntologyRecord) => {
    const terms = new Set(tokenize(JSON.stringify(record)).filter(term => term.length > 1));
    return [...query].reduce((value, term) => value + Number(terms.has(term)), 0);
  };
  const scores = new Map(active.map(record => [record.id, score(record)]));
  active.sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || Number(box(a) === 'T') - Number(box(b) === 'T') || a.id.localeCompare(b.id));
  const records: OntologyRecord[] = [], selected = new Set<string>();
  const maxChars = input.maxChars ?? 60_000;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 128_000) throw new OntologyError('invalid_input', 'invalid ontology comparison budget');
  let size = 0;
  const dependencies = (record: OntologyRecord, pending = new Map<string, OntologyRecord>()): Map<string, OntologyRecord> => {
    if (selected.has(record.id) || pending.has(record.id)) return pending;
    pending.set(record.id, record);
    const visit = (value: unknown, key = '') => {
      if (typeof value === 'string' && referenceKeys.has(key) && available.has(value)) dependencies(available.get(value)!, pending);
      else if (Array.isArray(value)) value.forEach(child => visit(child, key));
      else if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        if (object.kind === 'entity' && typeof object.id === 'string' && available.has(object.id)) dependencies(available.get(object.id)!, pending);
        if (object.kind === 'task' && object.field === 'entityId' && typeof object.equals === 'string' && available.has(object.equals)) dependencies(available.get(object.equals)!, pending);
        Object.entries(object).forEach(([field, child]) => visit(child, field));
      }
    };
    visit(record);
    return pending;
  };
  for (const record of active) {
    const closure = [...dependencies(record).values()];
    const length = closure.reduce((value, dependency) => value + JSON.stringify(dependency).length, 0);
    if (size + length > maxChars) continue;
    for (const dependency of closure) { records.push(dependency); selected.add(dependency.id); }
    size += length;
  }
  return { revision: doc.revision, records, truncated: records.length !== active.length };
}

/** Shared proposal grammar, independent of the caller's output envelope. */
export const ontologyFormationGrammar = `
Compare the supplied canonical ontology IDs and versions. Reuse existing minimal T concepts and shared entity identities; never seed another person's biography. Preserve owner, project, scope, exact source attribution, uncertainty and validity. Do not equate people by matching names.
judgment contains only the complete natural-language cognition supported by the user's statements, including its applicable limits and exceptions. Put ontology IDs, A/T/R record explanations and implementation commentary only in ontologyChanges; never append them to judgment.
ontologyChanges = {reason: string, evidence: source-label[], actions: OntologyAction[], refs: CanonicalRef[], identityEvidence: [{recordId,reason,evidence:source-label[]}]}. Omit when no justified ontology change or reference exists. An empty actions array is allowed for existing refs. Reason and evidence are required.
Preserve supplied sourceScope. Project/workspace-restricted cognition can change task-visible records only in matching project/workspace modules. A personal module is globally visible to tasks, so it cannot receive restricted facts/rules. If the module cannot represent all supplied restrictions (including agent, role, purpose, conversation or file restrictions), proposed records MUST set access:'owner_only' to prevent task exposure. Existing public T definitions can be referenced without editing or copying them; a definition reference never authorizes broader concrete content. Do not silently broaden scope on either human or automatic confirmation.
actions contains COMMAND ENVELOPES, never bare records. An exact create action shape is {"intent":"create","recordId":"new-safe-ascii-id","sourceLabel":"source-grounded reason","record":{"kind":"assertion","moduleId":"existing-module-id","subjectId":"existing-self-id","definitionId":"existing-preference-definition-id","object":{"kind":"literal","valueType":"text","value":"the explicit user statement including its limits"},"validity":{"from":null,"until":null,"precision":"day","timezone":"Asia/Shanghai"},"certainty":"confirmed"}}. Replace placeholder ids with supplied canonical ids; all proposed ids are ASCII letters/digits/underscore/hyphen. Do NOT put kind/moduleId directly in the action. Do NOT omit intent, recordId, sourceLabel or record. A refs entry for a newly created assertion/rule points to its new recordId, not its definitionId.
When retaining a standing user preference, prepare BOTH the A-box expression evidence (reuse the existing user identity and suitable preference definition if supplied) AND the R-box scoped guidance. The A assertion records what the user expressed; the R rule records when the preference guides future answers, its actual strength and source-supported boundaries. Reuse existing minimum T; do not create a duplicate Person/user/preference type. If a required definition does not exist, propose only the necessary T definition in the same plan for user review. Updating this preference changes the SAME cognition and SAME existing R rule; preserve the A assertion's earlier validity/history with change or correct according to source meaning.
${ONTOLOGY_RULE_SEMANTICS}
Rule-create example ONLY for a source-supported defeasible default preference, not an obligation: {"intent":"create","recordId":"new-safe-rule-id","sourceLabel":"explicit default preference","record":{"kind":"rule","moduleId":"existing-module-id","name":"short rule name","requirementSource":"cognition_body","strength":"default","condition":null,"effect":{"kind":"note"},"exception":"source-supported exception or empty string"}}. For a source-supported obligation use strength:'required', including conditional obligations; note is still valid when there is no supported typed adapter. Its unique matching ref MUST be {"moduleId":"existing-module-id","recordId":"new-safe-rule-id","versionPolicy":"current","sharedBody":true}. requirementSource:'cognition_body' is an explicit envelope reference to the COMPLETE judgment of this same candidate; the host resolves it to the single canonical requirement body and removes the selector before validation/persistence. Prefer this reference and OMIT requirement to avoid copying the same body twice. If requirement is also supplied, it MUST exactly equal judgment; a conflicting copy is blocked, never silently replaced. Only a rule create or an update of the exact existing rule/version/module with its matching current sharedBody ref can use this selector. Never use it for T/A records, another rule target, a pinned ref or unspecified intent. A null condition is allowed when relevant scope is completely preserved in the resolved requirement/exception; never invent a task purpose vocabulary merely to fill a field. Preferred existing rule update shape: {"intent":"update","recordId":"supplied-rule-id","expectedVersion":1,"sourceLabel":"source correction or boundary clarification","patch":{"requirementSource":"cognition_body","exception":"complete supported boundary"}}; use the actual supplied version and its unique current sharedBody ref. Keep every necessary still-valid condition in the complete revised judgment.
Each action needs sourceLabel (a concise source-grounded reason). create requires an explicit safe recordId and record. Record kinds: module {name,description,scope:{kind:'personal'|'project'|'workspace',id?}}, definition {moduleId,name,description,definitionKind:'type'|'relation'|'attribute',subjectTypes:[],objectTypes:[],valueType:'entity'|'text'|'number'|'boolean'|'date',cardinality:'one'|'many',cardinalityAnchor:'subject'|'object'}, entity {moduleId,typeId,name,description,aliases:[],identityStatus:'confirmed'|'unresolved'}, assertion {moduleId,subjectId,definitionId,object:{kind:'entity',id}|{kind:'literal',valueType,value},validity:{from:string|null,until:string|null,precision:'day'|'month',timezone}}, rule {moduleId,name,requirement,strength:'required'|'default'|'suggestion'|'logic',condition:null|Condition,effect:Effect,exception}. Condition = {kind:'task',field:'purpose'|'taskKind'|'entityId',equals:string}|{kind:'assertion',subjectId,definitionId,object?}|{kind:'all'|'any',conditions:Condition[]}|{kind:'not',condition:Condition}. Effect = {kind:'note'}|{kind:'include_recipient',entityId}|{kind:'required_section',name}|{kind:'choice',key,value}. Use typed conditions/effects only when their exact meaning and identity are supported, otherwise preserve natural-language boundaries without inventing an executable binding. create record has no id/version/status/source/timestamps. All records may specify access:'task'|'owner_only', certainty:'confirmed'|'inferred'|'unknown'. identityEvidence is required for each newly confirmed identity, with explicit source labels distinguishing its identity.
update requires recordId, expectedVersion, patch; use it for rules/scope, never overwrite assertions. Correct an erroneous assertion with intent:'correct', recordId,expectedVersion,object or subjectId. A real dated change uses intent:'change' with these fields and effectiveFrom after the prior start (if known) and before the prior end (if known). change/correct use object/subjectId at the ACTION top level, never inside patch: {"intent":"change","recordId":"existing-assertion-id","expectedVersion":1,"effectiveFrom":"source-supported-date","sourceLabel":"source-grounded change reason","object":{"kind":"literal","valueType":"text","value":"complete new fact"}}. Current refs can use the old assertion id; the host redirects them to the exact generated successor. If change time is unknown, retain uncertainty and request review. Never invent a date from extraction time.
CanonicalRef = {moduleId,recordId,versionPolicy:'current'|'pinned',targetVersion? (required only for pinned),sharedBody?:true}. sharedBody:true is ONLY for a rule record reference. Assertion/entity/definition/module references MUST OMIT sharedBody; an A assertion is source-attributed evidence with explicit validity/history, not an independently editable copy of the R guidance body. Every proposed rule representing this cognition MUST resolve to the EXACT COMPLETE judgment and a current sharedBody:true ref. Use requirementSource:'cognition_body' to reference that one body; without an explicit selector, missing text cannot be guessed or filled. Its text, sources and future versions are shared with the cognition. Update existing cognition and its bound rule together; do not create a second contradictory body. Preferences preserve applicable conditions rather than become global obligations. T changes require manual confirmation; A/R changes still require complete source support and no conflict. Cross-module identities require explicit reference records {kind:'reference',moduleId,targetModuleId,targetRecordId?,versionPolicy:'current'|'pinned',targetVersion?} rather than copying identities. A scope update must retain applicable still-valid scope and show before/after via versioned update actions. Output proposals only; do not claim saved or executed effects.
`;

/** Production comparisons obey the same current source admission as task use. */
export async function buildSourceQualifiedOntologyFormationContext(userId: string, doc: OntologyDocument,
  input: Parameters<typeof buildOntologyFormationContext>[2] = {}): Promise<ReturnType<typeof buildOntologyFormationContext>> {
  const { assessOntologySources, ontologyWithAdmittedSources } = await import('../cognition/ontology/source-admission');
  // queryText ranks quoted content; it is not an operational task and may
  // itself describe prohibitions. Keep only the actual source-scope context.
  const status = await assessOntologySources(userId, doc, { projectId: input.projectId, workspaceId: input.workspaceId });
  const admitted = ontologyWithAdmittedSources(doc, status);
  const context = buildOntologyFormationContext(userId, admitted, input);
  const modules = new Set(Object.values(doc.records).filter(record => record.kind === 'module' && record.status === 'active'
    && ontologyModuleVisibleToTask(record, input)).map(record => record.id));
  if (Object.values(doc.records).some(record => record.status === 'active' && record.access === 'task'
    && modules.has(record.kind === 'module' ? record.id : record.moduleId) && status.get(record.id) === 'unavailable')) context.truncated = true;
  return context;
}

/** Conversation extraction owns each proposal inside its candidate. */
export const ontologyFormationPromptContract = `
Use the explicit proposalVersion:2 envelope. A cognition proposal has no ontologyChanges. A joint proposal owns cognition and ontologyChanges. An ontology proposal owns explanation and ontologyChanges, without cognition. Never return ontologyChanges at the top level beside proposals or candidates, and never borrow another group's plan. For ontology-only groups, use explanation.description for the supported change and complete standalone rule.requirement when relevant; omit sharedBody and requirementSource:'cognition_body'. Rules already bound to a cognition must be changed jointly with that cognition. The cognition-body requirements below apply only to joint groups.
${ontologyFormationGrammar}`;
