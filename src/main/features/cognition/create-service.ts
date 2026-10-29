/** Explicit conversational creation reuses candidate confirmation, canonical
 * commands and the single cognition master. No raw-store or nightly bypass. */
import { z } from 'zod';
import { cognitionMessageSourceRef } from '../recall/source-locator';
import { t } from '../../i18n';
import { withCognitionCommitLifetime } from '../cognition_kernel/store';
import { withCognitionTransition } from '../cognition_bridge';
import { getConversation } from '../chats';
import { normalizeAbilityAssetScopePolicy, resolveScopeForAsset, type RecallAbilityAssetScopePolicy } from '../recall/scope-policy';
import { requireContentCategory, type CognitionContentCategory } from '../recall/content-category';
import { normalizeCognitionSourceRefsForWrite } from '../recall/source-service';
import { cognitionMessageSourceId } from '../recall/source-catalog';
import { parseOntologyFormationProposal, bindOntologyFormationPlan, resolveSharedRuleBodyEnvelope, validateOntologyFormationScope } from '../recall/ontology-formation';
import { normalizeAbilityAssetOntologyRefs, type CanonicalAbilityAssetOntologyRef } from '../recall/ontology-refs';
import { candidateIdForCaptureKey, confirmRecallOntologyCandidate, promoteRecallCandidate, readRecallCandidate,
  recoverRecallCandidatePromotion, type SaveRecallCandidateInput, type RecallCandidateRecord } from '../recall/candidate-service';
import { readRecallJsonRecord } from '../recall/store';
import { submitCognitionCandidate } from './candidate-submission';
import { readReviewDecision, writeReviewDecision } from './review-decision';
import { readOntologyDocument } from './ontology/service';
import { OntologyError, validateOntologyRecord, type OntologyDocument } from './ontology/model';
import { validateOntologyCommand, type OntologyAction } from './ontology/commands';
import { assertOntologyManagementSources, describeCognitionOntology, type CognitionEditHost, type CognitionEditResult } from './edit-service';
import { assertCognitionManagementActive, confirmCognitionManagement } from './management-confirmation';
import { humanInstructionContractHash, humanInstructionDigest, humanInstructionProvenanceSchema, readHumanInstructionSource,
  verifyHumanInstructionCandidate, withHumanInstructionCreation, type HumanInstructionProvenance } from './human-instruction-provenance';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';

export interface CognitionCreateInput {
  target: 'cognition' | 'ontology' | 'joint';
  cognition?: { title: string; statement: string; value: string; contentCategory?: CognitionContentCategory; scope: string;
    scopePolicy?: RecallAbilityAssetScopePolicy; applicableWhen?: string[]; forbiddenWhen?: string[] };
  explanation?: { title: string; description: string; value: string; scope: string; scopePolicy?: RecallAbilityAssetScopePolicy };
  ontologyChanges?: { actions: OntologyAction[]; refs?: CanonicalAbilityAssetOntologyRef[]; reason: string };
  expectedOntologyRevision?: number; mode?: 'apply_if_authorized' | 'propose'; reason: string;
}
export interface CognitionCreateResult extends CognitionEditResult {
  assetId?: string; candidateId?: string; receiptId?: string; recordIds?: string[]; preview?: string;
}
const text = (max: number) => z.string().trim().min(1).max(max);
const boundaries = z.array(text(500)).max(32).optional();
const scopePolicy = z.record(z.unknown()).optional();
const schema = z.object({ target: z.enum(['cognition', 'ontology', 'joint']),
  cognition: z.object({ title: text(120), statement: text(4000), value: text(4000), scope: text(500),
    contentCategory: z.enum(['rule', 'preference', 'template', 'method', 'lesson', 'unclassified']).optional(),
    scopePolicy, applicableWhen: boundaries, forbiddenWhen: boundaries }).strict().optional(),
  explanation: z.object({ title: text(120), description: text(4000), value: text(4000), scope: text(500), scopePolicy }).strict().optional(),
  ontologyChanges: z.object({ actions: z.array(z.unknown()).min(1).max(50), refs: z.array(z.unknown()).max(100).optional(), reason: text(2000) }).strict().optional(),
  expectedOntologyRevision: z.number().int().nonnegative().optional(), mode: z.enum(['apply_if_authorized', 'propose']).optional(), reason: text(1000),
}).strict();
const list = (values?: readonly string[]) => values?.length ? values.map(value => `• ${value}`).join('\n') : t('cognition.edit.none');
const fail = (code: ConstructorParameters<typeof OntologyError>[0], key: string): never => { throw new OntologyError(code, t(key)); };
function requireCreateIntent(host: CognitionEditHost, previewOnly: boolean): void {
  if (!host.cid || !host.turnId || !host.sourceMessageId || host.sourceMessageFromUser !== true || !host.taskText?.trim())
    fail('not_authorized', 'cognition.create.user_instruction_required');
  const value = host.taskText!;
  if (previewOnly && /预览|草稿|方案|preview|draft|rascunho|prévia|下書き|プレビュー/i.test(value)
    && /认知|本体|cognition|ontology|cogni[cç][aã]o|ontologia|認知|オントロジー/i.test(value)) return;
  if (/(?:不要|不许|禁止|先别|暂不|请勿|do not|don't|n[aã]o|nunca)[^。；;]{0,20}(?:创建|新建|保存|记住|记下|create|save|remember|criar|salvar)/i.test(value)
    || !/创建|新建|新增|保存为|记住|记下|记一条|create|add\b|remember|save\b|criar|adicionar|salvar|memorizar|作成|新規|覚えて/i.test(value)
    || !/认知|本体|资产|偏好|规则|事实|记住|记下|记一条|cognition|ontology|preference|rule\b|remember|memorizar|cogni[cç][aã]o|ontologia|prefer[eê]ncia|認知|オントロジー|覚えて/i.test(value))
    fail('not_authorized', 'cognition.create.user_instruction_required');
}
/** An explicitly requested shared-body creation is one joint decision. A
 * model cannot recover from invalid joint arguments by silently saving half. */
function requireRequestedCreationTarget(host: CognitionEditHost, input: CognitionCreateInput): void {
  const instruction = host.taskText!;
  const newCognition = /(?:新建|新增|创建|保存为|记住|记下)[^。；;\n]{0,160}(?:认知|资产|偏好)|(?:create|add|remember|save)[^.!;\n]{0,160}(?:cognition|preference|asset)|(?:criar|adicionar|salvar|memorizar)[^.!;\n]{0,160}(?:cogni[cç][aã]o|prefer[eê]ncia)|(?:作成|新規)[^。\n]{0,160}(?:認知|好み)/i.test(instruction);
  const sharedBody = /(?:共用|共享)(?:同一份?|完整)?正文|同正文|同一份正文|shar(?:e|ed|ing)[^.!;\n]{0,24}(?:body|text)|compartilh[^.!;\n]{0,24}(?:texto|conte[uú]do)|(?:同じ|共有)[^。\n]{0,16}本文/i.test(instruction);
  const ontology = /本体|ontology|ontologia|オントロジー/i.test(instruction);
  const denySharedBody = /(?:不要|无需|不必|禁止|do not|don't|n[aã]o)[^。；;\n]{0,24}(?:共用|共享|shar|compartilh)/i.test(instruction);
  if (input.target !== 'joint' && newCognition && sharedBody && ontology && !denySharedBody)
    throw new OntologyError('not_authorized', t('cognition.create.joint_required'), { requiredTarget: 'joint' });
}
/** Formation intentionally stores blocked plans and legacy parsing can infer a
 * discriminator. Explicit creation instead reports strict canonical structure
 * errors before any confirmation, without repairing the model's arguments. */
function validateCreationActions(doc: OntologyDocument, input: NonNullable<CognitionCreateInput['ontologyChanges']>, judgment: string): OntologyAction[] {
  const issues: Array<{ path: string; message: string }> = [];
  const collect = (error: unknown, prefix: string) => {
    if (!(error instanceof OntologyError)) throw error;
    const details = Array.isArray(error.details.issues) ? error.details.issues : [];
    if (!details.length) { issues.push({ path: prefix, message: error.message.slice(0, 400) }); return; }
    for (const issue of details) {
      if (!issue || typeof issue !== 'object') continue;
      const row = issue as { path?: unknown; message?: unknown; keys?: unknown };
      const field = Array.isArray(row.path) ? row.path.join('.') : typeof row.path === 'string' ? row.path : '';
      const at = field ? `${prefix}.${field}` : prefix;
      if (Array.isArray(row.keys)) for (const key of row.keys)
        issues.push({ path: `${at}.${String(key)}`.slice(0, 300), message: 'Unexpected field' });
      else issues.push({ path: at.slice(0, 300), message: String(row.message || 'invalid field').slice(0, 400) });
    }
  };
  let actions: OntologyAction[] = [];
  try { actions = validateOntologyCommand({ commandId: 'creation-preview', expectedRevision: doc.revision, actions: input.actions }).actions; }
  catch (error) { collect(error, 'ontologyChanges'); }
  const refs: CanonicalAbilityAssetOntologyRef[] = normalizeAbilityAssetOntologyRefs(input.refs || []).map((ref, index) => {
    if (!ref.moduleId || !ref.recordId || !ref.versionPolicy)
      throw new OntologyError('invalid_input', t('cognition.create.invalid_ontology_structure'), { issues:
        (['moduleId', 'recordId', 'versionPolicy'] as const).filter(field => !ref[field])
          .map(field => ({ path: `ontologyChanges.refs.${index}.${field}`, message: 'A canonical reference field is required' })) });
    return { ...ref, moduleId: ref.moduleId, recordId: ref.recordId, versionPolicy: ref.versionPolicy };
  });
  input.actions.forEach((raw, index) => {
    if (!raw || raw.intent !== 'create' || !raw.record || typeof raw.record !== 'object' || Array.isArray(raw.record)) return;
    const prefix = `ontologyChanges.actions.${index}.record`;
    for (const field of ['id', 'version', 'status', 'createdAt', 'updatedAt', 'source']) if (Object.hasOwn(raw.record, field))
      issues.push({ path: `${prefix}.${field}`, message: 'record metadata is assigned by the service' });
    try {
      // This is the existing explicit shared-body reference, not a guessed
      // discriminator or a cleanup of invalid fields. Only the copy resolves.
      const action = Object.hasOwn(raw.record, 'requirementSource') && raw.record.kind !== undefined
        ? resolveSharedRuleBodyEnvelope(doc, raw, refs, judgment) as Extract<OntologyAction, { intent: 'create' }> : raw;
      validateOntologyRecord({ ...action.record, id: 'creation-preview', version: 1, status: 'active',
        access: action.record.access ?? 'task', source: { kind: 'user', label: 'creation validation' }, createdAt: null, updatedAt: null });
    } catch (error) { collect(error, prefix); }
  });
  if (issues.length) throw new OntologyError('invalid_input', t('cognition.create.invalid_ontology_structure'), { issues: issues.slice(0, 32) });
  if (actions.some(action => action.intent !== 'create')) fail('invalid_intent', 'cognition.create.create_only');
  return actions;
}
function preview(input: Pick<SaveRecallCandidateInput, 'ontologyFormation' | 'summary' | 'proposalTarget' | 'judgment' | 'value'
  | 'applicableWhen' | 'forbiddenWhen' | 'suggestedScope' | 'scopePolicy'>): string {
  const plan = input.ontologyFormation;
  return [t('cognition.create.preview_intro'),
    `${t('cognition.edit.title')}\n${input.summary}`,
    ...(input.proposalTarget !== 'ontology' ? [`${t('cognition.edit.body')}\n${input.judgment}`,
      `${t('cognition.edit.applicable')}\n${list(input.applicableWhen)}`, `${t('cognition.edit.forbidden')}\n${list(input.forbiddenWhen)}`]
      : [`${t('cognition.create.description')}\n${input.judgment}`]),
    `${t('cognition.create.value')}\n${input.value}`,
    `${t('cognition.edit.scope')}\n${input.suggestedScope}${input.scopePolicy ? '\n' + JSON.stringify(input.scopePolicy, null, 2) : ''}`,
    ...(plan ? [`${t('cognition.edit.related')}\n${plan.previewChanges.map(row => describeCognitionOntology(row.after)).join('\n\n')}`,
      ...(plan.refs.length ? [`${t('cognition.create.references')}\n${plan.refs.map(ref => `${ref.moduleId}/${ref.recordId}${ref.sharedBody ? ' · ' + t('cognition.create.shared_body') : ''}`).join('\n')}`] : [])] : []),
    t('cognition.create.save_boundary')].join('\n\n');
}
async function checkOntologySources(userId: string, raw: unknown): Promise<void> {
  const doc = readOntologyDocument(userId), seen = new Set<string>();
  const walk = async (value: unknown): Promise<void> => {
    if (typeof value === 'string' && doc.records[value] && !seen.has(value)) {
      seen.add(value); await assertOntologyManagementSources(userId, doc.records[value]);
    } else if (Array.isArray(value)) for (const item of value) await walk(item);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) await walk(item);
  };
  await walk(raw);
}
async function finish(userId: string, candidate: RecallCandidateRecord, duplicate = false): Promise<CognitionCreateResult> {
  if (candidate.proposalTarget === 'ontology') {
    const saved = await confirmRecallOntologyCandidate(userId, candidate.id, { actor: 'user' });
    return { status: 'applied', candidateId: candidate.id, decisionId: saved.candidate.reviewDecisionId,
      receiptId: saved.ontologyHandoff.commandId, ontologyRevision: saved.ontologyHandoff.ontologyRevision,
      changedIds: saved.ontologyHandoff.recordIds, recordIds: saved.ontologyHandoff.recordIds, ...(duplicate ? { duplicate } : {}) };
  }
  let saved;
  try { saved = await promoteRecallCandidate(userId, candidate.id, { actor: 'user' }); }
  catch (error) {
    // The actual master may already be committed while its journal lags.
    saved = await recoverRecallCandidatePromotion(userId, candidate.id);
    if (!saved) throw error;
  }
  const doc = readOntologyDocument(userId), plan = saved.candidate.ontologyFormation;
  const receipt = plan ? doc.receipts[plan.commandId] : undefined;
  return { status: 'applied', assetId: saved.asset.id, candidateId: saved.candidate.id, decisionId: saved.decision.decision_id,
    receiptId: receipt?.commandId || saved.receipt.reviewDecisionId, version: saved.receipt.version,
    activeVersion: String(saved.asset.activeVersion || saved.asset.version), ontologyRevision: doc.revision,
    changedIds: [saved.asset.id, ...(receipt?.changedIds || [])], recordIds: receipt?.changedIds || [], ...(duplicate ? { duplicate } : {}) };
}
/** The host reads the persisted current human message before preparation. A
 * preview response or a caller's actor/source/permission claim is never a save. */
export async function createCognition(userId: string, context: Omit<CognitionEditHost, 'userId'>,
  raw: CognitionCreateInput): Promise<CognitionCreateResult> {
  const host = { ...context, userId };
  assertCognitionManagementActive(host);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) fail('invalid_input', 'cognition.create.invalid_input');
  const input = parsed.data as CognitionCreateInput;
  requireCreateIntent(host, input.mode === 'propose');
  if (input.target === 'ontology' ? !input.explanation || !!input.cognition || !input.ontologyChanges
    : !input.cognition || !!input.explanation || (input.target === 'joint' ? !input.ontologyChanges : !!input.ontologyChanges))
    fail('invalid_input', 'cognition.create.invalid_input');
  const source = await readHumanInstructionSource(userId, host.cid!, host.sourceMessageId!);
  if (source.text.trim() !== host.taskText!.trim()) fail('not_authorized', 'cognition.create.user_instruction_required');
  requireRequestedCreationTarget(host, input);
  const sourceHash = humanInstructionDigest(source.text);
  const requestId = 'create-' + humanInstructionDigest({ cid: host.cid, messageId: host.sourceMessageId, sourceHash,
    input: { ...input, mode: undefined } }).slice(0, 32);
  const captureKey = 'human-' + requestId, candidateId = candidateIdForCaptureKey(captureKey);
  const decisionId = 'rd_' + humanInstructionDigest(['creation', requestId]).slice(0, 24);
  if (await readRecallJsonRecord(userId, 'candidates', candidateId)) {
    const existing = await readRecallCandidate(userId, candidateId);
    if (existing.humanInstructionProvenance?.requestId !== requestId) fail('baseline_changed', 'cognition.create.baseline_changed');
    if (input.mode === 'propose') return { status: 'pending_confirmation', reason: preview(existing), preview: preview(existing) };
    // Existing terminal commits use their real recovery receipt, never a fresh
    // creation grant. Unfinished writes still reverify the reviewed contract.
    return withCognitionCommitLifetime(userId, host.signal, () => finish(userId, existing, true), host.onCommitStarted);
  }
  const doc = readOntologyDocument(userId);
  if (input.expectedOntologyRevision !== undefined && input.expectedOntologyRevision !== doc.revision)
    fail('baseline_changed', 'cognition.create.baseline_changed');
  const conversation = await getConversation(userId, host.cid!);
  if (!conversation) fail('source_unavailable', 'cognition.create.source_unavailable');
  const body = input.cognition ?? input.explanation!;
  const policy = normalizeAbilityAssetScopePolicy(body.scopePolicy) || {};
  for (const [key, actual] of [['projectIds', conversation!.project_id], ['workspaceIds', conversation!.space_id]] as const) if (actual) {
    if (policy[key] && policy[key]!.some(id => id !== actual)) fail('not_authorized', 'cognition.create.scope_exceeded');
    policy[key] ??= [actual];
  }
  const normalizedPolicy = normalizeAbilityAssetScopePolicy(policy);
  const refs = normalizeCognitionSourceRefsForWrite([{ kind: 'conversation', subtype: 'session', id: host.cid!, scope: 'conversation', title: conversation!.title },
    { ...cognitionMessageSourceRef(host.cid!, source), excerpt: source.text.slice(0, 240) }]);
  let plan;
  if (input.ontologyChanges) {
    validateCreationActions(doc, input.ontologyChanges, 'statement' in body ? body.statement : body.description);
    await checkOntologySources(userId, input.ontologyChanges);
    const actions = input.ontologyChanges.actions;
    const identityEvidence = actions.flatMap(action => action.intent === 'create' && action.record.kind === 'entity'
      ? [{ recordId: action.recordId, reason: t('cognition.create.identity_review'), evidence: ['instruction'] }] : []);
    plan = parseOntologyFormationProposal(doc, candidateId, { ...input.ontologyChanges, evidence: ['instruction'], identityEvidence,
      refs: normalizeAbilityAssetOntologyRefs(input.ontologyChanges.refs || []) }, 'statement' in body ? body.statement : body.description,
      new Date().toISOString(), input.target === 'ontology' ? 'ontology' : 'cognition');
    plan = validateOntologyFormationScope(userId, doc, plan, normalizedPolicy);
    if (!plan || plan.blockedReasons.length) fail('formation_blocked', 'cognition.create.invalid_ontology');
    plan = bindOntologyFormationPlan(candidateId, plan);
  }
  const prepared: SaveRecallCandidateInput = { proposalTarget: input.target, rawStatement: true,
    judgment: 'statement' in body ? body.statement : body.description, value: body.value, summary: body.title,
    suggestedType: 'cognition', ...(input.cognition ? { contentCategory: requireContentCategory(input.cognition.contentCategory || 'unclassified') } : {}),
    suggestedScope: resolveScopeForAsset(body.scope), suggestedAction: 'create', risk: 'low', captureKey,
    sourceRefs: refs, evidenceRefs: refs, ...(plan ? { ontologyFormation: plan } : {}),
    ...(normalizedPolicy ? { scopePolicy: normalizedPolicy } : {}), ...(conversation!.space_id ? { spaceId: conversation!.space_id } : {}),
    ...(input.cognition?.applicableWhen?.length ? { applicableWhen: input.cognition.applicableWhen } : {}),
    ...(input.cognition?.forbiddenWhen?.length ? { forbiddenWhen: input.cognition.forbiddenWhen } : {}),
  };
  assertNotForbiddenToPersist([JSON.stringify(prepared)]);
  const detail = preview(prepared);
  if (input.mode === 'propose') return { status: 'pending_confirmation', reason: detail, preview: detail };
  const prior = await readReviewDecision(userId, `cognition_creation:${requestId}`, decisionId);
  let proof: HumanInstructionProvenance, actual = prepared;
  if (prior) {
    // A prior complete approval retains its original prepared draft, including
    // canonical preview timestamps; an interrupted save cannot regenerate it.
    const saved = JSON.parse(prior.modified_content || 'null') as { provenance: HumanInstructionProvenance; input: SaveRecallCandidateInput };
    proof = humanInstructionProvenanceSchema.parse(saved?.provenance); actual = saved.input;
    if (proof.requestId !== requestId || proof.sourceHash !== sourceHash || !actual) fail('baseline_changed', 'cognition.create.baseline_changed');
  } else {
    const interactionId = await confirmCognitionManagement(host, detail, 'cognition.create.confirm_title');
    if (!interactionId) return { status: 'blocked', reason: t('cognition.edit.not_saved') };
    proof = { schemaVersion: 1, pipeline: 'human_instruction', ownerId: userId, requestId, candidateId, cid: host.cid!,
      sourceMessageId: host.sourceMessageId!, sourceHash, contractHash: humanInstructionContractHash(actual), interactionId,
      decisionId, confirmedAt: new Date().toISOString() };
    actual = { ...actual, humanInstructionProvenance: proof };
  }
  assertCognitionManagementActive(host);
  return withCognitionCommitLifetime(userId, host.signal, async () => {
    const candidate = await withCognitionTransition(userId, async () => {
      assertCognitionManagementActive(host);
      if (plan && readOntologyDocument(userId).revision !== actual.ontologyFormation!.baselineRevision)
        fail('baseline_changed', 'cognition.create.baseline_changed');
      const currentSource = await readHumanInstructionSource(userId, proof.cid, proof.sourceMessageId);
      if (humanInstructionDigest(currentSource.text) !== proof.sourceHash) fail('baseline_changed', 'cognition.create.source_changed');
      await checkOntologySources(userId, actual.ontologyFormation);
      assertCognitionManagementActive(host);
      if (!prior) await writeReviewDecision(userId, { targetRef: `cognition_creation:${requestId}`, decisionId,
        decisionType: 'accept', decision: 'confirm_complete_human_creation', actor: 'user', antecedentRef: proof.sourceMessageId,
        sourceSignalRef: cognitionMessageSourceId(proof.cid, proof.sourceMessageId), scope: actual.suggestedScope,
        modifiedContent: JSON.stringify({ provenance: proof, input: actual }), idempotencyKey: requestId });
      return withHumanInstructionCreation(userId, proof, async () => {
        await verifyHumanInstructionCandidate(userId, actual, { newWrite: true });
        assertCognitionManagementActive(host);
        return submitCognitionCandidate(userId, actual);
      });
    });
    return finish(userId, candidate);
  }, host.onCommitStarted);
}
