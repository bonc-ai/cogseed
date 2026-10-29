/** Conversation edits of existing cognition. Host intent and optional complete
 * preview precede the existing asset/ontology commit rails; no candidate is made. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { t } from '../../i18n';
import { withCognitionCommitLifetime } from '../cognition_kernel/store';
import { assertCognitionManagementActive, confirmCognitionManagement } from './management-confirmation';
import { withCognitionSourceDependency, withCognitionTransition } from '../cognition_bridge';
import { updateAbilityAsset, readAbilityAsset, listAbilityAssets, abilityAssetActiveVersion, diffAbilityAssetsForAudit, summarizeAuditChange, type UpdateAbilityAssetInput } from '../recall/asset-service';
import { createAssetChangeProposal } from '../recall/asset-approval-service';
import type { RecallAbilityAssetRecord } from '../recall/candidate-service';
import { readRecallCandidate } from '../recall/candidate-service';
import { isCognitionSourceEnabled } from '../recall/source-control';
import { hasReviewedStandingContract, withHumanInstructionEdit } from '../recall/standing-preference-authority';
import { classifyMemoryReplaceIntent } from '../recall/memory-save-intent';
import { normalizeAbilityTagList } from '../recall/ability-tag-service';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { applyOntologyCommand, type OntologyAction, type OntologyCommand } from './ontology/commands';
import { readOntologyDocument, commitOntologyCommand } from './ontology/service';
import { OntologyError, validateOntologyId, type OntologyRecord, type OntologyDocument } from './ontology/model';
import { ontologyScopeViolations } from './ontology/cognition-scope';
import type { RecallAbilityAssetScopePolicy } from '../recall/scope-policy';
import type { CognitionEditDecision } from './edit-decision';

export interface CognitionEditHost {
  userId: string; cid?: string; turnId?: string; sourceMessageId?: string;
  sourceMessageFromUser?: boolean; taskText?: string;
  /** Host-only execution lifetime; never persisted or accepted as tool input. */
  signal?: AbortSignal;
  /** Notify the tool runner only when the first irreversible write starts. */
  onCommitStarted?: () => void;
  /** Compatibility with the pre-existing singular "this asset" editor. */
  allowDeicticTarget?: boolean;
}
export interface CognitionEditInput {
  target: { assetId: string } | { ontologyRecordId: string };
  fields?: Record<string, unknown>;
  replaceText?: { before: string; after: string };
  ontologyChanges?: OntologyAction[];
  expectedVersion?: string | number; expectedActiveVersion?: string; expectedOntologyRevision?: number;
  factIntent?: 'correct' | 'change'; effectiveFrom?: string;
  mode?: 'apply_if_authorized' | 'propose'; reason: string;
}
export interface CognitionEditResult {
  status: 'applied' | 'pending_confirmation' | 'blocked';
  reason?: string; decisionId?: string; version?: string; activeVersion?: string;
  ontologyRevision?: number; changedIds?: string[]; duplicate?: boolean;
}
const normalize = (value: unknown) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
function realUser(host: CognitionEditHost): void {
  if (host.sourceMessageFromUser !== true || !host.taskText?.trim()) throw new OntologyError('not_authorized', '需要当前用户的明确管理指令');
}
function targetNamed(host: CognitionEditHost, record: { id: string; title?: string; name?: string }, doc?: OntologyDocument): boolean {
  const text = normalize(host.taskText);
  if ([record.id, record.title, record.name].some(value => value && text.includes(normalize(value)))) return true;
  const row = record as OntologyRecord;
  if (row.kind === 'assertion' && doc) {
    const subject = doc.records[row.subjectId] as { name?: string } | undefined;
    const definition = doc.records[row.definitionId] as { name?: string } | undefined;
    if (subject?.name && definition?.name && text.includes(subject.name) && text.includes(definition.name)) return true;
  }
  return host.allowDeicticTarget === true && /这条|这个|该条|this (?:asset|rule|preference)/i.test(text);
}
export function assertCognitionManagementTarget(host: CognitionEditHost, record: { id: string; title?: string; name?: string }, doc?: OntologyDocument): void {
  realUser(host);
  if (!targetNamed(host, record, doc)) throw new OntologyError('not_authorized', '管理目标必须由当前用户明确点名；同名时请用户指定条目');
  if (doc && 'name' in record && record.name && !normalize(host.taskText).includes(record.id)) {
    const matches = Object.values(doc.records).filter(row => 'name' in row && row.name === record.name);
    if (matches.length > 1) throw new OntologyError('ambiguous_identity', '存在同名本体条目，请用户指定条目 ID');
  }
}
export async function cognitionManagementAssetMatches(userId: string, host: CognitionEditHost, asset: RecallAbilityAssetRecord) {
  if (normalize(host.taskText).includes(asset.id)) return [];
  const matches = (await listAbilityAssets(userId)).filter(row => row.title === asset.title);
  return matches.length > 1 ? matches.map(row => ({ id: row.id, title: row.title, status: row.status })) : [];
}
async function assertAssetManagementTarget(host: CognitionEditHost, asset: RecallAbilityAssetRecord): Promise<void> {
  assertCognitionManagementTarget(host, asset);
  if ((await cognitionManagementAssetMatches(host.userId, host, asset)).length) throw new OntologyError('ambiguous_identity', '存在同名资产，请用户指定条目 ID');
}
/** Only a target inside the imperative's own target phrase can authorize a
 * silent write. A mentioned background asset is not the command's object. */
function directCommand(host: CognitionEditHost): { target: string; replacement: string } | undefined {
  const text = normalize(host.taskText);
  const commands = [...text.matchAll(/(?:把|将)([^。；;\n]{1,180}?)(?:改成|改为|替换为|更正为|更新为|调整为)/g),
    ...text.matchAll(/\b(?:change|update|replace|correct|edit|revise)\s+([^.!?\n]{1,180}?)\s+(?:to|with)\b/gi),
    ...text.matchAll(/\b(?:altere|mude|atualize|substitua|corrija|edite|modifique)\s+([^.!?\n]{1,180}?)\s+(?:para|por)\b/gi)];
  if (commands.length !== 1) return undefined;
  const command = commands[0];
  const rest = text.slice(command.index! + command[0].length).replace(/^\s*[:：]?\s*/, '');
  const quote: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"', "'": "'" };
  const closing = quote[rest[0]];
  const end = closing ? rest.indexOf(closing, 1) : -1;
  return { target: command[1], replacement: closing && end >= 0 ? rest.slice(1, end) : rest.replace(/[。.!?！？]+$/g, '').trim() };
}
function directTargetBound(host: CognitionEditHost, target: { id: string; title?: string; name?: string }, doc?: OntologyDocument): boolean {
  const command = directCommand(host);
  return Boolean(command && targetNamed({ ...host, taskText: command.target }, target, doc));
}
/** Bind the field as well as the target and value. With no field qualifier,
 * replacing an asset/rule means its body; renaming it is a different command. */
function directFieldBound(host: CognitionEditHost, target: { id: string; title?: string; name?: string; kind?: OntologyRecord['kind'] }, key: string): boolean {
  const command = directCommand(host);
  if (!command) return false;
  let phrase = command.target;
  for (const identity of [target.id, target.title, target.name].filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length))
    phrase = phrase.split(normalize(identity)).join(' ');
  phrase = phrase.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/g, ' ');
  const bodyKey = target.kind === 'rule' ? 'requirement' : target.kind ? 'description' : 'statement';
  const qualifiers: Array<[string, RegExp]> = [
    [target.kind ? 'name' : 'title', /标题|名称|名字|\b(?:title|name|nome|t[ií]tulo)\b|名前/i],
    [bodyKey, /正文|内容|\b(?:body|statement|content|requirement|texto|conte[uú]do)\b|本文/i],
    ['description', /描述|说明文字|\b(?:description|descri[cç][aã]o)\b|説明文/i],
    ['value', /用途|\b(?:purpose|future use|intended use|finalidade)\b|用途説明|uso futuro/i],
    ['tags', /标签|\b(?:tags?|etiquetas?)\b|タグ/i],
    ['applicableWhen', /适用(?:条件|场景)|\b(?:applicable|applicability)\b|適用条件/i],
    ['forbiddenWhen', /禁用(?:条件|场景)|\b(?:forbidden|exclusions?)\b|除外条件/i],
    ['condition', /触发条件|规则条件|\bcondition\b|発動条件/i],
    ['effect', /效果|\beffect\b|効果/i], ['strength', /强度|\bstrength\b|強度/i],
    ['exception', /例外|\bexception\b/i], ['aliases', /别名|\baliases?\b|別名/i],
  ];
  const requested = [...new Set(qualifiers.filter(([, pattern]) => pattern.test(phrase)).map(([field]) => field))];
  const actualKey = key === 'statement' && target.kind === 'rule' ? 'requirement' : key;
  return requested.length ? requested.length === 1 && requested[0] === actualKey
    : (!target.kind || target.kind === 'rule') && actualKey === bodyKey;
}
export async function assertAssetManagementSources(userId: string, asset: RecallAbilityAssetRecord): Promise<void> {
  if (asset.ownerId !== userId) throw new OntologyError('not_authorized', '该条目正文当前不可管理读取');
  // Keep the canonical asset-service invariant messages: callers, audit
  // classification and the model-facing receipt key on these exact reasons.
  if (asset.status === 'revoked') throw new Error('revoked ability asset cannot be changed');
  if (asset.status === 'deleted') throw new Error('deleted ability asset cannot be changed');
  if (asset.status === 'purged') throw new Error('ability asset has been purged');
  for (const source of asset.evidenceRefs) if (!await isCognitionSourceEnabled(userId, source))
    throw new OntologyError('source_unavailable', '来源已停用或撤权，正文不可读取或编辑');
}
/** Shared preparation/commit rails for the conversation editor and the legacy
 * steward. These are host APIs, never exposed as model-callable tool stages. */
export async function prepareCognitionAssetEdit(userId: string, assetId: string): Promise<RecallAbilityAssetRecord> {
  const asset = await readAbilityAsset(userId, assetId);
  await assertAssetManagementSources(userId, asset);
  return structuredClone(asset);
}
export async function withPreparedCognitionAssetEdit<T>(userId: string, baseline: RecallAbilityAssetRecord,
  work: (current: RecallAbilityAssetRecord) => Promise<T>): Promise<T> {
  return withCognitionTransition(userId, async () => {
    const current = await prepareCognitionAssetEdit(userId, baseline.id);
    if (!isDeepStrictEqual(current, baseline)) throw new OntologyError('baseline_changed', '资产在准备后已变化，请重新核对');
    return work(current);
  });
}
export async function commitPreparedCognitionAssetEdit(userId: string, baseline: RecallAbilityAssetRecord,
  input: UpdateAbilityAssetInput, decision?: CognitionEditDecision,
  aroundCommit?: (commit: () => Promise<RecallAbilityAssetRecord>, current: RecallAbilityAssetRecord) => Promise<RecallAbilityAssetRecord>): Promise<RecallAbilityAssetRecord> {
  return withPreparedCognitionAssetEdit(userId, baseline, current => {
    const write = () => updateAbilityAsset(userId, current.id, { ...input,
      expectedVersion: input.expectedVersion ?? current.version,
      expectedActiveVersion: input.expectedActiveVersion ?? abilityAssetActiveVersion(current) });
    const commit = () => decision ? withHumanInstructionEdit(userId, current, decision, write) : write();
    return aroundCommit ? aroundCommit(commit, current) : commit();
  });
}
export async function proposePreparedCognitionAssetEdit(userId: string, baseline: RecallAbilityAssetRecord,
  input: { payload: Record<string, unknown>; fields: readonly string[]; reason: string }) {
  return withPreparedCognitionAssetEdit(userId, baseline, current => {
    const summary = summarizeAuditChange(diffAbilityAssetsForAudit(current, { ...current, ...input.payload }));
    const beforeValues = Object.fromEntries(input.fields.map(key => {
      const value = (current as unknown as Record<string, unknown>)[key];
      // 标签缺省与空数组同义：落成 [] 才能让审批的标签 CAS 和补偿回滚
      // 区分"原本无标签"与"字段未记录"（JSON.stringify 会丢掉 undefined 键）。
      return [key, key === 'tags' ? (Array.isArray(value) ? value : []) : value];
    }));
    return createAssetChangeProposal(userId, { assetId: current.id, baselineVersion: current.version, baselineActiveVersion: abilityAssetActiveVersion(current),
      fields: [...input.fields], payload: input.payload, beforeValues, before: summary?.before || '', after: summary?.after || '', reason: input.reason });
  });
}
/** An ontology record can only cite an asset, never own its lifecycle. The
 * asset editor's status-specific messages ("revoked/deleted/purged ...") would
 * disclose a linked source's state through an ontology-only preview, so collapse
 * them into the same authorization failure used for any unmanageable source. */
async function assertOntologyAssetSource(userId: string, assetId: string): Promise<void> {
  try {
    await assertAssetManagementSources(userId, await readAbilityAsset(userId, assetId));
  } catch (error) {
    if (error instanceof OntologyError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (message === 'revoked ability asset cannot be changed'
      || message === 'deleted ability asset cannot be changed'
      || message === 'ability asset has been purged') {
      throw new OntologyError('not_authorized', '该本体来源当前不可管理读取');
    }
    throw error;
  }
}
export async function assertOntologyManagementSources(userId: string, record: OntologyRecord, visited = new Set<string>()): Promise<void> {
  if (!record) throw new OntologyError('not_found', '本体目标已变化');
  if (record.kind !== 'module' && !visited.has(`module:${record.moduleId}`)) {
    visited.add(`module:${record.moduleId}`);
    const module = readOntologyDocument(userId).records[record.moduleId];
    if (module) await assertOntologyManagementSources(userId, module, visited);
  }
  const sources = [...(record.source.refs || [])];
  if (record.source.kind === 'candidate' && record.source.recordId) sources.push({ kind: 'candidate', id: record.source.recordId });
  for (const ref of sources) {
    const key = `${ref.kind}:${ref.id}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (ref.kind === 'asset') await assertOntologyAssetSource(userId, ref.id);
    if (ref.kind === 'candidate') {
      const candidate = await readRecallCandidate(userId, ref.id);
      if (candidate.status === 'confirmed' && candidate.promotedAssetId) {
        await assertOntologyAssetSource(userId, candidate.promotedAssetId);
      } else {
        if (candidate.status !== 'integrated' || candidate.proposalTarget !== 'ontology') throw new OntologyError('source_unavailable', '本体来源不可用');
        for (const source of [...candidate.sourceRefs, ...candidate.evidenceRefs]) if (!await isCognitionSourceEnabled(userId, source))
          throw new OntologyError('source_unavailable', '本体来源已停用或撤权');
      }
    }
  }
}
const assetFields = new Set(['title', 'statement', 'value', 'scope', 'scopePolicy', 'applicableWhen', 'forbiddenWhen', 'tags']);
const ontologyFields: Record<OntologyRecord['kind'], string[]> = {
  module: ['name', 'description', 'scope', 'access', 'scopeNote', 'summaryPoints'],
  definition: ['name', 'description', 'subjectTypes', 'objectTypes', 'valueType', 'cardinality', 'cardinalityAnchor'],
  entity: ['name', 'description', 'aliases'], assertion: ['object', 'subjectId', 'certainty'],
  rule: ['name', 'requirement', 'condition', 'effect', 'strength', 'exception'],
  reference: ['versionPolicy', 'targetVersion'],
};
function checkedFields(raw: unknown, allowed: Set<string>): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OntologyError('invalid_input', 'fields 必须是对象');
  const fields = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, value]) => value !== undefined));
  if (!Object.keys(fields).length || Object.keys(fields).some(key => !allowed.has(key))) throw new OntologyError('invalid_input', '包含不可编辑字段或没有改动');
  assertNotForbiddenToPersist([JSON.stringify(fields)]);
  return fields;
}
function patchText(current: string, patch: CognitionEditInput['replaceText']): string {
  if (!patch || typeof patch.before !== 'string' || !patch.before || typeof patch.after !== 'string'
    || current.indexOf(patch.before) < 0 || current.indexOf(patch.before) !== current.lastIndexOf(patch.before))
    throw new OntologyError('invalid_input', '原片段必须在当前正文中精确且唯一匹配；没有改动');
  return current.replace(patch.before, () => patch.after);
}
function explicitEdit(host: CognitionEditHost): boolean {
  // A scoped preservation clause is not a veto of the preceding body edit.
  // Strip only named condition/scope preservation, never "do not edit A".
  const text = normalize(host.taskText).replace(/(?:不要|不许|禁止|请勿)\s*(?:改变|改动|修改|更新|调整)(?:当前|现有|原有|其他)?的?(?:适用(?:和|与|及|、)禁用条件|适用条件|禁用条件|适用场景|禁用场景|作用范围|条件)(?=[，,。；;！？!?]|$)/g, '');
  return !/(?:不要|不许|禁止|请勿|别|暂不|do not|don't|n[aã]o|nunca)\s*[^。；;]{0,15}(?:改|更新|编辑|edit|change|altere|mude|atualize|substitua|corrija|edite|modifique)|(?:変更|修正|更新|編集|書き換え|置き換え)(?:しないで|ないで)/i.test(text)
    && /改成|改为|修改|更新|更正|纠正|替换|编辑|优化|调整|润色|change|update|correct|replace|edit|revise|変更|修正|書き換|置き換|訂正|編集|altere|mude|atualize|substitua|corrija|edite|modifique/i.test(text);
}
function exactValues(host: CognitionEditHost, fields: Record<string, unknown>, patch: CognitionEditInput['replaceText'], target: { id: string; title?: string; name?: string; kind?: OntologyRecord['kind'] }): boolean {
  if (!explicitEdit(host)) return false;
  const command = directCommand(host);
  if (patch) return Object.keys(fields).length === 1 && ['statement', 'requirement', 'description'].includes(Object.keys(fields)[0])
    && directFieldBound(host, target, Object.keys(fields)[0]) && Boolean(command && command.target.includes(normalize(patch.before))
    && normalize(command.replacement) === normalize(patch.after));
  const entries = Object.entries(fields);
  if (entries.length !== 1 || !directFieldBound(host, target, entries[0][0])) return false;
  const value = entries[0][1];
  const expected = Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join('、')
    : ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : undefined;
  return expected !== undefined && Boolean(command && normalize(command.replacement) === normalize(expected).replace(/[。.!?！？]+$/g, '').trim())
    && classifyMemoryReplaceIntent(host.taskText?.replace(/[“”]/g, '"'), expected.replace(/[“”]/g, '"'), host.sourceMessageFromUser === true) === 'direct';
}
function actionFor(record: OntologyRecord, fields: Record<string, unknown>, input: CognitionEditInput): OntologyAction {
  const sourceLabel = input.reason.slice(0, 200);
  if (record.kind !== 'assertion') return { intent: 'update', recordId: record.id, expectedVersion: record.version, patch: fields, sourceLabel };
  const common = { recordId: record.id, expectedVersion: record.version, sourceLabel,
    object: (fields.object ?? record.object) as import('./ontology/model').OntologyValue,
    ...(fields.subjectId ? { subjectId: String(fields.subjectId) } : {}),
    ...(fields.certainty ? { certainty: fields.certainty as 'confirmed' | 'inferred' | 'unknown' } : {}) };
  if (input.factIntent === 'change') {
    if (!input.effectiveFrom) throw new OntologyError('invalid_time', '现实变化需要明确生效日期');
    return { intent: 'change', ...common, effectiveFrom: input.effectiveFrom };
  }
  return { intent: 'correct', ...common };
}
async function confirm(host: CognitionEditHost, detail: string): Promise<string | undefined> {
  return confirmCognitionManagement(host, detail);
}
function decisionFor(host: CognitionEditHost, targetId: string, previousVersion: string, active: string,
  fields: Record<string, unknown>, interactionId?: string, requestId?: string): CognitionEditDecision {
  if (!host.cid || !host.sourceMessageId) throw new OntologyError('not_authorized', '保存决定需要真实会话和用户消息引用');
  const id = requestId || 'edit-' + createHash('sha256').update(JSON.stringify([host.cid, host.sourceMessageId, targetId, previousVersion, fields])).digest('hex').slice(0, 32);
  return { id, ownerId: host.userId, cid: host.cid, sourceMessageId: host.sourceMessageId, targetId,
    method: interactionId ? 'full_preview' : 'exact_patch', ...(interactionId ? { interactionId } : {}),
    previousVersion, previousActiveVersion: active, committedVersion: String(Number(previousVersion) + 1),
    changedFields: Object.keys(fields), patch: fields, createdAt: new Date().toISOString() };
}
const textValue = (value: unknown): string => {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return t('cognition.edit.none');
  if (Array.isArray(value)) return value.map(item => `• ${textValue(item)}`).join('\n');
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${textValue(item)}`).join('\n');
  return String(value);
};
export function describeCognitionOntology(record: OntologyRecord): string {
  return [`${'name' in record ? record.name : record.id} (${record.kind}, ${record.id}, v${record.version})`,
    record.kind === 'rule' ? record.requirement : record.kind === 'assertion' ? `${record.subjectId} → ${record.definitionId} → ${textValue(record.object)}` : 'description' in record ? record.description : '',
    ...Object.entries(record).filter(([key]) => !['id', 'kind', 'version', 'name', 'requirement', 'description', 'source', 'createdAt', 'updatedAt'].includes(key)).map(([key, value]) => `${key === 'status' ? t('cognition.edit.status') : key}: ${key === 'status' ? t(`cognition.edit.status_${value}`) : textValue(value)}`)].filter(Boolean).join('\n');
}
const describeOntology = describeCognitionOntology;
function ontologyPreview(before: OntologyRecord | undefined, after: OntologyRecord[]): string {
  return [`${t('cognition.edit.before')}\n${before ? describeOntology(before) : t('cognition.edit.none')}`,
    `${t('cognition.edit.after')}\n${after.map(describeOntology).join('\n\n')}`].join('\n\n');
}
function previewText(asset: RecallAbilityAssetRecord, fields: Record<string, unknown>, ontology?: OntologyRecord[]): string {
  const section = (statement: unknown, value: unknown, applicable: unknown, forbidden: unknown, scope: unknown, policy: unknown) => [
    `${t('cognition.edit.body')}\n${statement}`,
    `${t('cognition.edit.value')}\n${textValue(value)}`,
    `${t('cognition.edit.applicable')}\n${textValue(applicable)}`,
    `${t('cognition.edit.forbidden')}\n${textValue(forbidden)}`,
    `${t('cognition.edit.scope')}\n${textValue(scope)}\n${textValue(policy)}`,
  ].join('\n\n');
  return [`${t('cognition.edit.target')}: ${asset.title} (${asset.id})`,
    `${t('cognition.edit.status')}: ${t(`cognition.edit.status_${asset.status}`)}`,
    `${t('cognition.edit.before')}\n${section(asset.statement, asset.value, asset.applicableWhen, asset.forbiddenWhen, asset.scope, asset.scopePolicy)}`,
    `${t('cognition.edit.after')}\n${section(fields.statement ?? asset.statement, fields.value ?? asset.value, fields.applicableWhen ?? asset.applicableWhen, fields.forbiddenWhen ?? asset.forbiddenWhen, fields.scope ?? asset.scope, fields.scopePolicy ?? asset.scopePolicy)}`,
    ...(['title', 'tags'].filter(key => Object.hasOwn(fields, key)).map(key => `${t(`cognition.edit.${key}`)}: ${textValue(fields[key])}`)),
    ...(ontology?.length ? [`${t('cognition.edit.related')}\n${ontology.map(describeOntology).join('\n\n')}`] : []),
  ].join('\n\n');
}
/** Existing targets are edited or organized through their host-owned workflow.
 * prepare/commit stay internal so a model-provided
 * preview or authorization flag can never mint a host permit. */
export async function editCognition(userId: string, context: Omit<CognitionEditHost, 'userId'>, input: CognitionEditInput | (import('../recall/content-organization-contract').OrganizationDraft & { mode?: 'propose' | 'apply_if_authorized'; expectedVersions: Array<{ assetId: string; version: string; activeVersion: string }> })): Promise<CognitionEditResult> {
  if ('operation' in input) return (await import('../recall/content-organization')).organizeCognitionFromConversation(userId, context, input) as Promise<CognitionEditResult>;
  const host: CognitionEditHost = { ...context, userId };
  assertCognitionManagementActive(host);
  realUser(host);
  if (!explicitEdit(host)) throw new OntologyError('not_authorized', '当前用户没有要求修改已有认知');
  if (!input.reason?.trim() || input.reason.length > 1000 || !input.target || ('assetId' in input.target) === ('ontologyRecordId' in input.target))
    throw new OntologyError('invalid_input', '需要唯一已有目标及修改依据');
  if (input.mode !== undefined && !['propose', 'apply_if_authorized'].includes(input.mode)) throw new OntologyError('invalid_input', '无效修改模式');
  const requestId = 'edit-' + createHash('sha256').update(JSON.stringify(stable([host.cid, host.sourceMessageId, { ...input, mode: input.mode ?? 'apply_if_authorized' }]))).digest('hex').slice(0, 32);
  let doc = readOntologyDocument(host.userId);
  const existingReceipt = doc.receipts[requestId] || Object.values(doc.receipts).find(receipt => receipt.userEditDecision?.id === requestId);
  if (existingReceipt?.userEditDecision?.sourceMessageId === host.sourceMessageId) return { status: 'applied', duplicate: true,
    decisionId: requestId, ontologyRevision: existingReceipt.revision, changedIds: existingReceipt.changedIds };
  let asset: RecallAbilityAssetRecord | undefined;
  let record: OntologyRecord | undefined;
  let fields = { ...(input.fields || {}) };
  const actions = structuredClone(input.ontologyChanges || []);
  if ('assetId' in input.target) {
    asset = await prepareCognitionAssetEdit(host.userId, input.target.assetId);
    await assertAssetManagementTarget(host, asset);
    await assertAssetManagementSources(host.userId, asset);
    if (asset.userEditDecision?.id === requestId) return { status: 'applied', duplicate: true, decisionId: requestId,
      version: asset.userEditDecision.committedVersion, activeVersion: asset.userEditDecision.committedVersion, changedIds: [asset.id] };
  } else {
    record = doc.records[validateOntologyId(input.target.ontologyRecordId)];
    if (!record) throw new OntologyError('not_found', '已有本体条目不存在或属于只读旧投影');
    assertCognitionManagementTarget(host, record, doc);
    await assertOntologyManagementSources(host.userId, record);
    if (record.source.kind === 'legacy' || (record.kind !== 'module' && doc.records[record.moduleId]?.source.kind === 'legacy')) throw new OntologyError('legacy_read_only', '旧本体投影只读');
    if (input.expectedVersion !== undefined && Number(input.expectedVersion) !== record.version) throw new OntologyError('baseline_changed', '本体版本已变化');
    if (input.replaceText) fields[record.kind === 'rule' ? 'requirement' : 'description'] = patchText(record.kind === 'rule' ? record.requirement : 'description' in record ? record.description : '', input.replaceText);
    if (Object.keys(fields).length) fields = checkedFields(fields, new Set(ontologyFields[record.kind]));
    else if (!actions.some(action => action.intent !== 'create' && action.recordId === record!.id)) throw new OntologyError('invalid_input', '需要目标的字段变化或已有本体命令');
    const owner = record.kind === 'rule' && record.source.refs?.find(ref => ref.kind === 'asset');
    if (owner) {
      asset = await prepareCognitionAssetEdit(host.userId, owner.id);
      const requirement = fields.requirement;
      delete fields.requirement;
      if (Object.keys(fields).length) actions.unshift(actionFor(record, fields, input));
      fields = { statement: requirement ?? asset.statement };
    } else if (Object.keys(fields).length) actions.unshift(actionFor(record, fields, input));
  }
  if (input.expectedOntologyRevision !== undefined && input.expectedOntologyRevision !== doc.revision) throw new OntologyError('baseline_changed', '本体已变化');
  // Model-supplied ancillary actions cannot name unrelated unseen content.
  for (const action of actions) {
    if (action.intent === 'create') throw new OntologyError('invalid_intent', '主动编辑只修改已有条目，新增仍走形成流程');
    const target = doc.records[validateOntologyId(action.recordId)];
    if (!target) throw new OntologyError('not_found', '关联本体条目不存在');
    await assertOntologyManagementSources(host.userId, target);
    if (target.source.kind === 'legacy') throw new OntologyError('legacy_read_only', '旧本体只读');
    const linked = asset?.ontologyRefs?.some(ref => ref.recordId === target.id);
    if (target.id !== record?.id && !linked && !targetNamed(host, target, doc)) throw new OntologyError('not_authorized', '关联改动超出用户点名目标');
    if (target.kind === 'rule' && target.source.refs?.some(ref => ref.kind === 'asset') && (action.intent !== 'update' || target.source.refs.some(ref => ref.kind === 'asset' && ref.id !== asset?.id)))
      throw new OntologyError('shared_body_requires_cognition', '共享规则必须与其拥有认知一同保存');
  }
  if (!asset) {
    const commandId = requestId;
    const command: OntologyCommand = { commandId, expectedRevision: doc.revision, actions };
    const outcome = applyOntologyCommand(doc, command, new Date().toISOString());
    for (const id of outcome.receipt.changedIds) if (doc.records[id]) await assertOntologyManagementSources(host.userId, doc.records[id]);
    if (input.mode === 'propose') return { status: 'pending_confirmation', reason: ontologyPreview(record, outcome.receipt.changedIds.map(id => outcome.document.records[id])) };
    const structural = outcome.receipt.changedIds.some(id => ['module', 'definition', 'reference'].includes(outcome.document.records[id].kind));
    let interaction: string | undefined;
    if (structural || !directTargetBound(host, record!, doc) || !exactValues(host, fields, input.replaceText, record!) || actions.length > 1) {
      interaction = await confirm(host, ontologyPreview(record, outcome.receipt.changedIds.map(id => outcome.document.records[id])));
      if (!interaction) return { status: 'blocked', reason: t('cognition.edit.not_saved') };
    }
    assertCognitionManagementActive(host);
    const decision = decisionFor(host, record!.id, String(record!.version), String(record!.version), Object.keys(fields).length ? fields : { ontologyChanges: actions }, interaction, requestId);
    const saved = await withCognitionCommitLifetime(userId, host.signal, () => withCognitionTransition(host.userId, async () => {
      assertCognitionManagementActive(host);
      for (const action of actions) if (action.intent !== 'create') {
        const target = readOntologyDocument(host.userId).records[action.recordId];
        if (!target) throw new OntologyError('baseline_changed', '本体目标已变化');
        await assertOntologyManagementSources(host.userId, target);
      }
      assertCognitionManagementActive(host);
      return commitOntologyCommand(host.userId, command, undefined, decision);
    }), host.onCommitStarted);
    return { status: 'applied', decisionId: decision.id, ontologyRevision: saved.receipt.revision, changedIds: saved.receipt.changedIds, duplicate: saved.duplicate };
  }
  await assertAssetManagementSources(host.userId, asset);
  if (!record && input.expectedVersion !== undefined && String(input.expectedVersion) !== asset.version) throw new OntologyError('baseline_changed', '资产版本已变化');
  if (input.expectedActiveVersion !== undefined && input.expectedActiveVersion !== String(asset.activeVersion || asset.version)) throw new OntologyError('baseline_changed', '资产在用版本已变化');
  if (input.replaceText && !record) {
    if ('statement' in fields) throw new OntologyError('invalid_input', '正文整体替换和片段修改只能二选一');
    fields.statement = patchText(asset.statement, input.replaceText);
  }
  fields = checkedFields(fields, assetFields);
  if (fields.value !== undefined && (typeof fields.value !== 'string' || fields.value.length > 4000)) throw new OntologyError('invalid_input', '用途必须是 4000 字以内的文本');
  if (fields.tags !== undefined) fields.tags = normalizeAbilityTagList(fields.tags);
  for (const key of ['applicableWhen', 'forbiddenWhen'] as const) if (fields[key] !== undefined && (!Array.isArray(fields[key]) || (fields[key] as unknown[]).some(x => typeof x !== 'string')))
    throw new OntologyError('invalid_input', `${key} 必须是字符串数组`);
  // A body supplied twice must agree literally. The asset rail synchronizes it.
  const jointActions = actions.flatMap(action => {
    if (action.intent !== 'update' || doc.records[action.recordId]?.kind !== 'rule' || !asset!.ontologyRefs?.some(ref => ref.recordId === action.recordId && ref.sharedBody)) return [action];
    const patch = { ...action.patch };
    if ('requirement' in patch && patch.requirement !== (fields.statement ?? asset!.statement)) throw new OntologyError('shared_body_mismatch', '认知与共享规则正文不一致');
    delete patch.requirement;
    if ('status' in patch) throw new OntologyError('invalid_intent', '共享规则生命周期由资产管理');
    return Object.keys(patch).length ? [{ ...action, patch }] : [];
  });
  const preview = jointActions.length ? applyOntologyCommand(doc, { commandId: requestId, expectedRevision: doc.revision, actions: jointActions }, new Date().toISOString()) : undefined;
  if (preview) for (const id of preview.receipt.changedIds) if (doc.records[id]) await assertOntologyManagementSources(host.userId, doc.records[id]);
  const preference = asset.type === 'cognition' && asset.contentCategory === 'preference';
  const reviewed = preference && await hasReviewedStandingContract(host.userId, asset);
  const exact = exactValues(host, fields, input.replaceText, record ?? asset);
  const guidanceChanged = ['statement', 'applicableWhen', 'forbiddenWhen'].some(key => Object.hasOwn(fields, key));
  const mustConfirm = !directTargetBound(host, record ?? asset, doc) || !exact || (preference && guidanceChanged && !reviewed) || jointActions.length > 0 || fields.scopePolicy !== undefined || fields.scope !== undefined;
  if (input.mode === 'propose') return { status: 'pending_confirmation', reason: previewText(asset, fields, preview?.receipt.changedIds.map(id => preview.document.records[id])) };
  let interaction: string | undefined;
  if (mustConfirm) {
    interaction = await confirm(host, previewText(asset, fields, preview?.receipt.changedIds.map(id => preview.document.records[id])));
    if (!interaction) return { status: 'blocked', reason: t('cognition.edit.not_saved') };
  }
  assertCognitionManagementActive(host);
  const decision = decisionFor(host, asset.id, asset.version, String(asset.activeVersion || asset.version), fields, interaction, requestId);
  if (Object.keys(fields).length === 1 && Object.hasOwn(fields, 'tags')) decision.committedVersion = asset.version;
  const baseline = structuredClone(asset);
  const saved = await withCognitionCommitLifetime(userId, host.signal, () => commitPreparedCognitionAssetEdit(host.userId, baseline, { ...fields, actor: 'user',
    reason: `cognition_edit:${decision.id}` } as UpdateAbilityAssetInput, decision, async (commit, current) => {
    assertCognitionManagementActive(host);
    for (const action of jointActions) if (action.intent !== 'create') await assertOntologyManagementSources(host.userId, readOntologyDocument(host.userId).records[action.recordId]);
    if (readOntologyDocument(host.userId).revision !== doc.revision && (jointActions.length || current.ontologyRefs?.length)) throw new OntologyError('baseline_changed', '关联本体在确认期间已变化');
    assertCognitionManagementActive(host);
    let updated: RecallAbilityAssetRecord;
    try {
      updated = jointActions.length ? await withCognitionSourceDependency(host.userId, 'ability-assets', (store, next) => {
      const ontology = store.ontology!;
      const result = applyOntologyCommand(ontology, { commandId: decision.id, expectedRevision: doc.revision, actions: jointActions }, decision.createdAt);
      const violations = ontologyScopeViolations(result.document, result.receipt.changedIds.map(id => result.document.records[id]), (fields.scopePolicy ?? next.scopePolicy) as RecallAbilityAssetScopePolicy | undefined);
      if (violations.length) throw new OntologyError('not_authorized', '关联本体变化超出认知授权范围');
      result.receipt.userEditDecision = decision;
      result.document.receipts[decision.id] = result.receipt;
      store.ontology = result.document;
      const successors = result.document.history.filter(row => row.commandId === decision.id && row.after.kind === 'assertion' && row.after.supersedesId);
      if (Array.isArray(next.ontologyRefs)) next.ontologyRefs = next.ontologyRefs.map((ref: any) => {
        const successor = successors.find(row => row.after.kind === 'assertion' && row.after.supersedesId === ref.recordId);
        return successor && ref.versionPolicy === 'current' ? { ...ref, recordId: successor.after.id } : ref;
      });
      store.pendingJournal ??= [];
      store.pendingJournal.push({ key: `ontology-${decision.id}`, line: { at: decision.createdAt, kind: 'ontology', receipt: result.receipt } });
    }, commit) : await commit();
    } catch (error) {
      // The authoritative body, R and private decision may already be saved
      // while an append-only ledger projection is pending. Read the durable
      // same-command receipt rather than reporting that successful save failed.
      const durable = await readAbilityAsset(host.userId, current.id);
      if (durable.userEditDecision?.id !== decision.id || durable.userEditDecision.committedVersion !== durable.version
        || (jointActions.length && readOntologyDocument(host.userId).receipts[decision.id]?.userEditDecision?.id !== decision.id)) throw error;
      updated = durable;
    }
    const saved = await readAbilityAsset(host.userId, current.id);
    if (saved.version !== updated.version || saved.statement !== updated.statement) throw new OntologyError('commit_failed', '认知保存回读失败');
    return saved;
  }), host.onCommitStarted);
  doc = readOntologyDocument(host.userId);
  return { status: 'applied', decisionId: decision.id, version: saved.version, activeVersion: String(saved.activeVersion || saved.version),
    ontologyRevision: doc.revision, changedIds: [saved.id, ...Object.values(doc.receipts).filter(r => r.userEditDecision?.id === decision.id).flatMap(r => r.changedIds)] };
}
