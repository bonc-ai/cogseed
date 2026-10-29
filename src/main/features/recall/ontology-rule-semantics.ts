/** Shared source-meaning contract for formation, batch correction and automatic
 * approval. It is semantic guidance, never a keyword-to-permission compiler. */
import { z } from 'zod';
import { validateOntologyRecord } from '../cognition/ontology/model';
import { parseCaptureGroundingAssessment, type GroundingSource } from './capture-grounding';

export const ONTOLOGY_RULE_SEMANTICS = `Preserve each rule's actual modality, conditions, exceptions and typed effect from the whole attributed source. required means an obligation/prohibition when its conditions hold; default means a defeasible default preference; suggestion is optional advice; logic is an explicitly supported logical rule. A conditional obligation is still required, not default merely because it has an exception. Do not classify by spotting a word such as "must": a quotation, rejected proposal, negated obligation or someone else's statement does not establish the user's rule. Never weaken an obligation to default/suggestion, strengthen a preference, erase a condition/exception, or invent an executable binding. A correct complete requirement body cannot compensate for incorrect structured fields. Reconstruct the expected contract from source meaning, not from a proposed metadata value or a preservation boolean.
A required rule may legitimately retain effect:{kind:'note'} when its natural-language obligation has no supported deterministic adapter. That preserves mandatory meaning but does not claim machine enforcement. required_section requires a source-supported exact Markdown heading/content contract, not merely an instruction to mention a topic or include a table column. Do not invent a heading name or task-purpose vocabulary to make a rule executable. Keep supported conditions and exceptions even when the host must report them as not machine checkable. Unknown meaning/binding stays unresolved for review; it is not permission to act.`;

export const formationRuleRevisionSchema = z.object({ recordId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(160),
  strength: z.enum(['required', 'default', 'suggestion', 'logic']), condition: z.unknown().nullable(),
  effect: z.unknown(), exception: z.string().max(4000),
}).strict().refine(value => Object.hasOwn(value, 'condition') && Object.hasOwn(value, 'effect'), 'complete rule semantics required');
export type FormationRuleRevision = z.infer<typeof formationRuleRevisionSchema>;
export type FormationRuleContext = { id: string; kind: string; version?: number; moduleId?: string; name?: string; requirement?: string;
  strength?: unknown; condition?: unknown; effect?: unknown; exception?: unknown };
type RuleContext = FormationRuleContext;
const semanticFields = ['strength', 'condition', 'effect', 'exception'] as const;
const preservationFields = ['strengthPreserved', 'conditionPreserved', 'effectPreserved', 'exceptionPreserved'] as const;
const ruleCheckSchema = z.object({ recordId: z.string(), strength: z.enum(['required', 'default', 'suggestion', 'logic']),
  condition: z.unknown().nullable(), effect: z.unknown(), exception: z.string().max(4000),
  checks: z.object({ strengthPreserved: z.boolean(), conditionPreserved: z.boolean(), effectPreserved: z.boolean(), exceptionPreserved: z.boolean() }).strict(),
  evidence: z.array(z.unknown()).max(32),
}).strict().refine(value => Object.hasOwn(value, 'condition') && Object.hasOwn(value, 'effect'), 'complete checked rule semantics required');
export type FormationRuleCheck = Omit<z.infer<typeof ruleCheckSchema>, 'evidence'> & { evidence: Array<{ label: string; quote: string }> };
export const ONTOLOGY_RULE_CHECK_PROTOCOL = `For EVERY resulting R action or referenced R return ruleChecks:[{recordId,strength,condition,effect,exception,checks:{strengthPreserved,conditionPreserved,effectPreserved,exceptionPreserved},evidence:[{label,quote}]}]. Include all four actual resulting field values, including null condition, note effect and empty exception. Each boolean independently evaluates that field against the whole attributed approved source. Cite literal approved user evidence for every fully supported rule. Do not use the overall five checks or prose saying "already corrected" as a substitute. When ruleRevisions are allowed, the checked values MUST equal the actual four fields explicitly supplied by that revision; without a revision they MUST equal the original resulting rule. Never describe a revision that is absent from ruleRevisions. Every rule id occurs exactly once; a missing/duplicate id, missing field, value mismatch or false check cannot be accepted.`;

const contractSchema = z.object({ strength: z.enum(['required', 'default', 'suggestion', 'logic']), condition: z.unknown().nullable(),
  effect: z.unknown(), exception: z.string().max(4000) }).strict()
  .refine(value => Object.hasOwn(value, 'condition') && Object.hasOwn(value, 'effect'), 'complete source contract required');
const fieldEvidenceSchema = z.object({ strength: z.array(z.unknown()).min(1).max(8), condition: z.array(z.unknown()).max(8),
  effect: z.array(z.unknown()).max(8), exception: z.array(z.unknown()).max(8) }).strict();
const sourceConclusionSchema = z.discriminatedUnion('status', [
  z.object({ recordId: z.string(), status: z.literal('resolved'), expectedContract: contractSchema,
    topicEvidence: z.array(z.unknown()).min(1).max(8), fieldEvidence: fieldEvidenceSchema }).strict(),
  z.object({ recordId: z.string(), status: z.enum(['unresolved', 'not_supported']), reason: z.string().trim().min(1).max(1000) }).strict(),
]);
type LiteralEvidence = { label: string; quote: string };
export type SourceRuleConclusion = { recordId: string; status: 'resolved'; expectedContract: Omit<FormationRuleRevision, 'recordId'>;
  topicEvidence: LiteralEvidence[]; fieldEvidence: Record<typeof semanticFields[number], LiteralEvidence[]> }
  | { recordId: string; status: 'unresolved' | 'not_supported'; reason: string };
export const SOURCE_RULE_CANONICAL_SCHEMA = `expectedContract is a strict canonical object, not prose:
{strength:'required'|'default'|'suggestion'|'logic',condition:null|Condition,effect:Effect,exception:string}.
Condition = {kind:'task',field:'purpose'|'taskKind'|'entityId',equals:string} | {kind:'assertion',subjectId:string,definitionId:string,object?:{kind:'entity',id:string}|{kind:'literal',valueType:'text'|'number'|'boolean'|'date',value:string|number|boolean}} | {kind:'all'|'any',conditions:Condition[]} | {kind:'not',condition:Condition}.
Effect = {kind:'note'} | {kind:'include_recipient',entityId:string} | {kind:'required_section',name:string} | {kind:'choice',key:string,value:string}.
condition MUST NOT be a natural-language string. Keep condition:null when there is no exact supported machine predicate; preserve semantic applicability in the complete requirement and supported exception, never invent a task purpose to manufacture a binding. exception MUST always be a string, using '' when none; never null or an array. effect MUST be an object of the listed exact shape, not a string; use {kind:'note'} when there is no supported deterministic adapter. For example an ordinary mandatory prose rule without a machine adapter is {strength:'required',condition:null,effect:{kind:'note'},exception:''}.
Canonical example: source label m1 says "Deployment reviews must include risks; ordinary meetings are exempt." Without an exact supported machine predicate or heading binding, return expectedContract:{strength:'required',condition:null,effect:{kind:'note'},exception:'ordinary meetings are exempt'}, fieldEvidence:{strength:[{label:'m1',quote:'Deployment reviews must include risks'}],condition:[],effect:[],exception:[{label:'m1',quote:'ordinary meetings are exempt'}]}. Keep the complete applicability in the unchanged requirement. Do not return condition:'deployment reviews', exception:null, or invent a required_section heading. A source saying "I prefer brief answers" supports default, not required; quoted or rejected obligations do not establish the user's rule.
Every literal quote must be one exact contiguous substring of its source. Never replace skipped text with '...' or '…', combine fragments, rewrite a noun, or normalize punctuation. An ellipsis is literal only if it exists in the actual source. Use an exact shorter quote or approvedQuoteIndex instead of inventing an abbreviated quotation.`;
export const SOURCE_RULE_CONCLUSION_PROTOCOL = `Proposed R strength/condition/effect/exception are intentionally hidden. For EVERY ruleSourceRequests entry independently reconstruct its complete expected contract from the attributed USER source and legitimate confirmed before/pinned meaning. Return sourceRuleConclusions:[{recordId,status:'resolved',expectedContract:{strength,condition,effect,exception},topicEvidence:[{label,approvedQuoteIndex:0}],fieldEvidence:{strength:[{label,quote}],condition:[],effect:[],exception:[]}}]. Use the actual recordId exactly once. Do not return ruleChecks, preservation booleans or ruleRevisions; the host compares the source conclusion to the hidden actual proposal and generates any owned four-field revision itself.
approvedQuotes are value-selected TOPIC ANCHORS, not a user's word-by-word saving permission. topicEvidence for each whole R must overlap its retained value topic. Each field's literal evidence may come from the same topic's complete admitted USER text, even outside the anchor: preserve the requirement, force, conditions, negations, exceptions, final corrections and explicit referents together. For example an anchored exception "ordinary meetings do not add these columns" can refer to the same message's mandatory deployment-review requirement. Same message/paragraph alone is NOT proof of same topic; another project, independent fact, unadopted assistant advice or unrelated rule cannot hitchhike on that anchor. Explain the expected canonical fields through source evidence, not by copying a candidate or matching a force keyword. Cite strength evidence always; cite explicit condition, non-note typed effect and nonempty exception in their own fieldEvidence. Empty arrays are allowed for null condition, note effect and no exception. Do not invent a binding to fill a field. If the source cannot establish a complete meaning, return {recordId,status:'unresolved'|'not_supported',reason} without a contract. A resolved source conclusion is not permission to save and cannot change an unowned referenced R.
${SOURCE_RULE_CANONICAL_SCHEMA}`;

export function formationRuleContext(ontology: unknown): RuleContext[] {
  const context = ontology as { records?: unknown; history?: Array<{ after: RuleContext }> } | undefined;
  return [...(Array.isArray(context?.records) ? context.records : context?.records && typeof context.records === 'object' ? Object.values(context.records) : []),
    ...(Array.isArray(context?.history) ? context.history.map(row => row.after) : [])] as RuleContext[];
}

function validateSemantics(value: FormationRuleRevision): void {
  const { recordId, ...fields } = value;
  validateOntologyRecord({ id: recordId, kind: 'rule', version: 1, status: 'active', access: 'task',
    createdAt: null, updatedAt: null, source: { kind: 'user', label: 'semantic revision validation' },
    moduleId: 'validation-module', name: 'semantic revision', requirement: 'unchanged source-bound body', ...fields });
}
function isRuleCreate(record: Record<string, unknown> | undefined): boolean {
  return record?.kind === 'rule' || !!record && record.kind === undefined
    && ['moduleId', 'name', 'requirement', ...semanticFields].every(key => Object.hasOwn(record, key));
}
/** Materialize the exact resulting metadata, including inherited update fields
 * and canonical R references. This is a snapshot, not semantic inference. */
export function formationRuleContracts(raw: unknown, records: readonly RuleContext[] = []): FormationRuleRevision[] {
  const proposal = raw as { actions?: Array<Record<string, unknown>>; refs?: Array<{ recordId?: string; versionPolicy?: string; targetVersion?: number }> } | undefined;
  const resulting = new Map<string, FormationRuleRevision>();
  for (const action of Array.isArray(proposal?.actions) ? proposal.actions : []) {
    const recordId = String(action.recordId);
    const existing = records.find(record => record.id === recordId);
    const fields = action.intent === 'create' && isRuleCreate(action.record as Record<string, unknown>) ? action.record
      : action.intent === 'update' && existing?.kind === 'rule' ? { ...existing, ...action.patch as object } : undefined;
    if (!fields) continue;
    if (resulting.has(recordId)) throw new Error('duplicate resulting rule action');
    const contract = formationRuleRevisionSchema.parse({ recordId,
      ...Object.fromEntries(semanticFields.filter(key => Object.hasOwn(fields as object, key)).map(key => [key, (fields as Record<string, unknown>)[key]])) });
    validateSemantics(contract); resulting.set(recordId, contract);
  }
  for (const ref of Array.isArray(proposal?.refs) ? proposal.refs : []) {
    if (resulting.has(String(ref.recordId))) {
      if (ref.versionPolicy === 'pinned') throw new Error('one rule action check cannot stand in for a separate pinned version');
      continue;
    }
    const known = records.filter(record => record.id === ref.recordId && record.kind === 'rule');
    const record = ref.versionPolicy === 'pinned' ? known.find(record => record.version === ref.targetVersion) : known[0];
    if (!record && known.length) throw new Error('pinned rule semantics are unavailable; current metadata is not the pinned version');
    if (!record) continue;
    const contract = formationRuleRevisionSchema.parse({ recordId: record.id, ...Object.fromEntries(semanticFields.map(key => [key, record[key]])) });
    validateSemantics(contract); resulting.set(record.id, contract);
  }
  return [...resulting.values()];
}

function ownedRuleIds(raw: unknown, records: readonly RuleContext[]): Set<string> {
  const actions = (raw as { actions?: Array<Record<string, unknown>> } | undefined)?.actions;
  return new Set((Array.isArray(actions) ? actions : []).filter(action => action.intent === 'create' ? isRuleCreate(action.record as Record<string, unknown>)
    : action.intent === 'update' && records.some(record => record.id === action.recordId && record.kind === 'rule')).map(action => String(action.recordId)));
}
/** A metadata-free request about source meaning. Confirmed before/pinned data
 * remains visible; unlike the proposed fields it is an actual prior baseline. */
export function formationRuleSourceRequests(raw: unknown, records: readonly RuleContext[], judgment: string) {
  const proposal = raw as { actions?: Array<Record<string, unknown>>; refs?: Array<{ recordId?: string; versionPolicy?: string; targetVersion?: number }> } | undefined;
  return formationRuleContracts(raw, records).map(contract => {
    const action = proposal?.actions?.find(action => action.recordId === contract.recordId && ['create', 'update'].includes(String(action.intent)));
    const ref = proposal?.refs?.find(ref => ref.recordId === contract.recordId);
    const before = records.find(record => record.id === contract.recordId && record.kind === 'rule'
      && (ref?.versionPolicy !== 'pinned' || record.version === ref.targetVersion));
    const payload = (action?.intent === 'create' ? action.record : action?.patch) as Record<string, unknown> | undefined;
    const requirement = payload?.requirementSource === 'cognition_body' ? judgment : payload?.requirement ?? before?.requirement;
    return { recordId: contract.recordId, intent: action?.intent || 'reference',
      ...(payload?.moduleId || before?.moduleId ? { moduleId: payload?.moduleId || before?.moduleId } : {}),
      ...(payload?.name || before?.name ? { name: payload?.name || before?.name } : {}),
      requirement, ...(action?.expectedVersion ? { expectedVersion: action.expectedVersion } : {}),
      ...(ref ? { versionPolicy: ref.versionPolicy, ...(ref.targetVersion ? { targetVersion: ref.targetVersion } : {}) } : {}),
      ...(before ? { before } : {}) };
  });
}
function blindProposal(raw: unknown, records: readonly RuleContext[]): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const copy = structuredClone(raw) as Record<string, unknown>;
  const ids = ownedRuleIds(raw, records);
  const omit = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of semanticFields) delete (value as Record<string, unknown>)[key];
  };
  if (Array.isArray(copy.actions)) for (const action of copy.actions as Array<Record<string, unknown>>) if (ids.has(String(action.recordId))) {
    omit(action.intent === 'create' ? action.record : action.patch);
    delete action.sourceLabel; // producer commentary is not source evidence
  }
  if (Array.isArray(copy.previewChanges)) for (const change of copy.previewChanges as Array<{ after?: { id?: string }; before?: unknown }>) {
    // A producer can name any object "before". Only host records in
    // ruleSourceRequests/ontology may supply confirmed current/pinned meaning.
    delete change.before;
    const after = change.after as Record<string, unknown> | undefined;
    if (after) { delete after.createdAt; delete after.updatedAt; }
    if (ids.has(String(after?.id))) {
      omit(after);
      if (after?.source && typeof after.source === 'object') delete (after.source as Record<string, unknown>).label;
    }
  }
  for (const key of ['reason', 'commandId', 'ruleContracts', 'ruleChecks', 'ruleRevisions', 'sourceRuleConclusions']) delete copy[key];
  return copy;
}
/** Build a typed blind view, rather than regex-editing source prose. Removes
 * proposal metadata at all plan/action/after copies and producer explanations;
 * full quoted user text and host canonical/pinned context are untouched. */
export function blindFormationRuleCandidate<T extends object>(candidate: T, records: readonly RuleContext[]): T {
  const copy = structuredClone(candidate) as Record<string, unknown>;
  if (copy.ontologyChanges) copy.ontologyChanges = blindProposal(copy.ontologyChanges, records);
  if (copy.ontologyFormation) copy.ontologyFormation = blindProposal(copy.ontologyFormation, records);
  if (copy.comparison && typeof copy.comparison === 'object') delete (copy.comparison as Record<string, unknown>).reason;
  for (const key of ['ruleContracts', 'ruleChecks', 'ruleRevisions', 'sourceRuleConclusions']) delete copy[key];
  return copy as T;
}

/** Field evidence can cite any exact passage of the same admitted user source.
 * Topic anchoring is required once for the whole R, not once per field. */
export function parseSourceRuleConclusions(raw: unknown, contracts: readonly FormationRuleRevision[], sources: GroundingSource[]): SourceRuleConclusion[] {
  if (raw === undefined && !contracts.length) return [];
  const values = z.array(sourceConclusionSchema).max(100).parse(raw);
  if (values.length !== contracts.length) throw new Error('incomplete source rule conclusions');
  const seen = new Set<string>();
  const evidence = (refs: unknown[], anchor: boolean) => parseCaptureGroundingAssessment(JSON.stringify({ supported: anchor,
    noUnsupportedClaims: anchor, scopePreserved: anchor, finalDecisionPreserved: anchor, priorContentPreserved: anchor, evidence: refs }), sources).evidence;
  return values.map((value): SourceRuleConclusion => {
    if (!contracts.some(contract => contract.recordId === value.recordId) || seen.has(value.recordId)) throw new Error('unknown or duplicate source rule conclusion');
    seen.add(value.recordId);
    if (value.status !== 'resolved') return { recordId: value.recordId, status: value.status, reason: value.reason };
    validateSemantics({ recordId: value.recordId, ...value.expectedContract });
    if (value.expectedContract.condition !== null && !value.fieldEvidence.condition.length
      || (value.expectedContract.effect as { kind: string }).kind !== 'note' && !value.fieldEvidence.effect.length
      || value.expectedContract.exception.length > 0 && !value.fieldEvidence.exception.length) throw new Error('source contract field lacks evidence');
    return { recordId: value.recordId, status: 'resolved', expectedContract: { strength: value.expectedContract.strength,
      condition: value.expectedContract.condition, effect: value.expectedContract.effect, exception: value.expectedContract.exception },
      topicEvidence: evidence(value.topicEvidence, true), fieldEvidence: {
      strength: evidence(value.fieldEvidence.strength, false), condition: evidence(value.fieldEvidence.condition, false),
      effect: evidence(value.fieldEvidence.effect, false), exception: evidence(value.fieldEvidence.exception, false) } };
  });
}

/** The checker never supplies a patch. The host compares its independent source
 * conclusion with the CURRENT full proposal on every use, including cache hits.
 * A referenced R cannot acquire a new action through this correction channel. */
export function deriveFormationRuleRevisions(raw: unknown, conclusions: readonly SourceRuleConclusion[], records: readonly RuleContext[], repairOwned: boolean) {
  const contracts = formationRuleContracts(raw, records), owned = ownedRuleIds(raw, records);
  const ruleRevisions: FormationRuleRevision[] = [];
  const differences: Array<{ recordId: string; fields: Array<typeof semanticFields[number]>; repairable: boolean }> = [];
  let supported = conclusions.length === contracts.length;
  for (const contract of contracts) {
    const conclusion = conclusions.find(row => row.recordId === contract.recordId);
    if (!conclusion || conclusion.status !== 'resolved') { supported = false; continue; }
    const fields = semanticFields.filter(key => stable(contract[key]) !== stable(conclusion.expectedContract[key]));
    if (!fields.length) continue;
    const repairable = owned.has(contract.recordId) && repairOwned;
    differences.push({ recordId: contract.recordId, fields, repairable });
    if (repairable) ruleRevisions.push({ recordId: contract.recordId, ...conclusion.expectedContract });
    else supported = false;
  }
  if (ruleRevisions.length) reviseFormationRuleSemantics(raw, ruleRevisions, records);
  return { supported, ruleRevisions, differences };
}
function stable(value: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  return JSON.stringify(canonical(value));
}
/** Exact metadata is host-verifiable; its meaning remains an explicit
 * source-bound model assessment. Omitted repairs can never be inferred. */
export function validateFormationRuleChecks(raw: unknown, contracts: readonly FormationRuleRevision[], sources: GroundingSource[]): { ruleChecks: FormationRuleCheck[]; supported: boolean } {
  if (raw === undefined && !contracts.length) return { ruleChecks: [], supported: true };
  const values = z.array(ruleCheckSchema).max(100).parse(raw);
  if (values.length !== contracts.length) throw new Error('incomplete per-rule contract checks');
  const seen = new Set<string>();
  const ruleChecks = values.map(value => {
    const expected = contracts.find(contract => contract.recordId === value.recordId);
    if (!expected || seen.has(value.recordId)) throw new Error('unknown or duplicate rule check');
    seen.add(value.recordId);
    if (semanticFields.some(key => stable(value[key]) !== stable(expected[key]))) throw new Error('checked rule differs from actual resulting metadata');
    const preserved = preservationFields.every(key => value.checks[key]);
    const evidence = parseCaptureGroundingAssessment(JSON.stringify({ supported: preserved, noUnsupportedClaims: preserved,
      scopePreserved: preserved, finalDecisionPreserved: preserved, priorContentPreserved: preserved, evidence: value.evidence }), sources).evidence;
    return { ...value, evidence };
  });
  return { ruleChecks, supported: ruleChecks.every(value => preservationFields.every(key => value.checks[key])) };
}

/** Metadata-only repair is bound to exact rule actions, never a replacement
 * cognition, different entity, new action, reference, version or source. The
 * normal ontology parser repeats canonical/reference/scope checks afterward. */
export function reviseFormationRuleSemantics(raw: unknown, revisions: readonly FormationRuleRevision[], existingRules: readonly RuleContext[] = []): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('rule revision has no owned ontology proposal');
  const proposal = structuredClone(raw) as { actions?: Array<Record<string, unknown>> };
  if (!Array.isArray(proposal.actions)) throw new Error('rule revision has no owned actions');
  const seen = new Set<string>();
  for (const input of revisions) {
    const revision = formationRuleRevisionSchema.parse(input);
    if (seen.has(revision.recordId)) throw new Error('duplicate rule semantics revision');
    seen.add(revision.recordId);
    const matches = proposal.actions.filter(action => action.recordId === revision.recordId);
    if (matches.length !== 1) throw new Error('rule semantics revision target is ambiguous');
    const action = matches[0];
    const field = action.intent === 'create' ? 'record' : action.intent === 'update' ? 'patch' : undefined;
    const payload = field && action[field] as Record<string, unknown>;
    const rule = action.intent === 'create' ? isRuleCreate(payload)
      : existingRules.some(record => record.id === revision.recordId && record.kind === 'rule');
    if (!field || !payload || !rule) throw new Error('rule semantics revision cannot change an A/T action');
    const { recordId: _recordId, ...fields } = revision;
    // Validate all four typed fields, without guessing missing fields or
    // inferring strength from the wording of the unchanged requirement.
    validateSemantics(revision);
    action[field] = { ...payload, ...fields };
  }
  return proposal;
}

export function hasFormationRuleChanges(raw: unknown, records: Record<string, { kind: string }>): boolean {
  const proposal = raw as { actions?: Array<Record<string, unknown>>; refs?: Array<{ recordId?: string }> } | undefined;
  return Array.isArray(proposal?.actions) && proposal.actions.some(action => action.intent === 'create'
    ? isRuleCreate(action.record as Record<string, unknown>)
    : action.intent === 'update' && records[String(action.recordId)]?.kind === 'rule')
    || Array.isArray(proposal?.refs) && proposal.refs.some(ref => records[String(ref.recordId)]?.kind === 'rule');
}
