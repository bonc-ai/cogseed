/** Deny-only deterministic preflight for a bound production operation.
 * Rule text never becomes code or an authorization grant.
 * Markdown section requirements are checked against the final content. Other
 * bound required effects are denied until an operation adapter can check them.
 * Unmatched/unbound actions stay outside this guard's scope.
 */
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { safeId } from '../../../storage';
import { readOntologyDocument } from './service';
import { ontologyModuleVisibleToTask, queryOntologyRules, type OntologyTaskScopeContext } from './query';
import { OntologyError, type OntologyCondition, type OntologyDocument, type OntologyRule } from './model';
import { assessOntologySources } from './source-admission';
import type { AssetRuntimeContext } from '../../recall/formal-assets/runtime';

export interface OntologyMarkdownWriteInput {
  operation: 'write_file' | 'edit_file'; path: string; content: string;
  /** Host-provided scope only. A model-supplied task label does not bind an action. */
  context?: OntologyTaskScopeContext & AssetRuntimeContext;
}
export interface OntologyOperationCheck {
  moduleId: string; recordId: string; version: number;
  status: 'satisfied' | 'blocked' | 'not_machine_checkable';
  reasonCode: 'required_section_present' | 'required_section_missing' | 'rule_condition_unknown'
    | 'rule_exception_requires_review' | 'operation_target_unbound' | 'effect_not_bound' | 'advisory_rule' | 'operation_adapter_missing';
  /** Only the typed requirement needed to repair this action, never full private rule text. */
  sectionName?: string;
}
export interface OntologyOperationDecision {
  allowed: boolean; revision: number; checks: OntologyOperationCheck[];
  code?: 'E_ONTOLOGY_OPERATION_PRECONDITION';
}
function positiveOperationTarget(condition: OntologyCondition | null, operation: string, positive = true): boolean {
  if (!condition) return false;
  if (condition.kind === 'task') return positive && condition.field === 'taskKind' && (condition.equals === operation || operation === 'edit_file' && condition.equals === 'write_file');
  if (condition.kind === 'not') return positiveOperationTarget(condition.condition, operation, !positive);
  if (condition.kind === 'all' || condition.kind === 'any') return condition.conditions.some(child => positiveOperationTarget(child, operation, positive));
  return false;
}
function hasOperationCondition(condition: OntologyCondition | null): boolean {
  if (!condition) return false;
  if (condition.kind === 'task') return condition.field === 'taskKind';
  if (condition.kind === 'not') return hasOperationCondition(condition.condition);
  return (condition.kind === 'all' || condition.kind === 'any') && condition.conditions.some(hasOperationCondition);
}
function boundToOperation(rule: OntologyRule, operation: string): boolean {
  if (positiveOperationTarget(rule.condition, operation)) return true;
  // A typed required section is already a file-content constraint. An
  // unconditional/purpose/fact-conditioned rule must not silently disappear
  // merely because it omitted a redundant taskKind=write_file clause. Explicit
  // (including negated) operation conditions keep their ordinary semantics.
  return rule.effect.kind === 'required_section' && ['write_file', 'edit_file'].includes(operation)
    && !hasOperationCondition(rule.condition);
}
const headingName = (value: string) => value.trim().normalize('NFC');

/** A conservative Markdown heading recognizer. Quoted/code/comment/frontmatter
 * examples cannot satisfy a section. No natural-language synonym inference.
 */
function markdownSections(content: string): Set<string> {
  const lines = content.replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/);
  const headings = new Set<string>();
  const active: Array<{ name: string; level: number; hasContent: boolean }> = [];
  const heading = (name: string, level: number) => {
    while (active.length && active.at(-1)!.level >= level) { const done = active.pop()!; if (done.hasContent) headings.add(done.name); }
    active.push({ name, level, hasContent: false });
  };
  const markContent = () => { for (const section of active) section.hasContent = true; };
  let fence: { character: string; size: number } | undefined;
  let htmlBlock: string | undefined;
  let frontmatter = lines[0]?.replace(/^\uFEFF/, '').trim() === '---';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (frontmatter) { if (i > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false; continue; }
    if (htmlBlock) { if (new RegExp(`</${htmlBlock}\\s*>`, 'i').test(line)) htmlBlock = undefined; continue; }
    const fenced = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenced && fenced[1][0] === fence.character && fenced[1].length >= fence.size && line.slice(fenced[0].length).trim() === '') fence = undefined;
      else if (line.trim()) markContent();
      continue;
    }
    if (fenced) { fence = { character: fenced[1][0], size: fenced[1].length }; continue; }
    const html = /^ {0,3}<(script|style|pre|textarea|div|table|section|article|details|summary|header|footer|nav|blockquote|ul|ol|li|p|h[1-6])\b/i.exec(line);
    if (html) { if (!new RegExp(`</${html[1]}\\s*>`, 'i').test(line)) htmlBlock = html[1]; continue; }
    const atx = /^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/.exec(line);
    if (atx) { const name = headingName(atx[1].replace(/[ \t]+#+[ \t]*$/, '')); if (name) heading(name, /^ {0,3}(#+)/.exec(line)![1].length); continue; }
    if (/^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1] || '') && line.trim() && !/^ {0,3}(?:>|[#`~<])/.test(line) && !/^\s{4}/.test(line)) {
      heading(headingName(line), lines[i + 1].trim().startsWith('=') ? 1 : 2); i++; continue;
    }
    if (line.trim() && !/^ {0,3}(?:[-*_]\s*){3,}$/.test(line) && !/^ {0,3}<[^>]*>\s*$/.test(line)) markContent();
  }
  for (const section of active) if (section.hasContent) headings.add(section.name);
  return headings;
}
function inheritWriteConstraint(condition: OntologyCondition | null, positive = true): OntologyCondition | null {
  if (!condition) return null;
  if (condition.kind === 'task') return positive && condition.field === 'taskKind' && condition.equals === 'write_file'
    ? { ...condition, equals: 'edit_file' } : condition;
  if (condition.kind === 'not') return { ...condition, condition: inheritWriteConstraint(condition.condition, !positive)! };
  if (condition.kind === 'all' || condition.kind === 'any') return { ...condition, conditions: condition.conditions.map(child => inheritWriteConstraint(child, positive)!) };
  return condition;
}
function localDay(): string {
  const now = new Date(), pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function evaluateOntologyMarkdownWrite(doc: OntologyDocument, input: OntologyMarkdownWriteInput, at: string): OntologyOperationDecision {
  // This guard does not certify other file formats, shell writes or read tools.
  if (!['write_file', 'edit_file'].includes(input.operation) || typeof input.path !== 'string' || typeof input.content !== 'string'
    || !['.md', '.markdown'].includes(path.extname(input.path).toLowerCase())) return { allowed: true, revision: doc.revision, checks: [] };
  const visibleModuleIds = new Set(Object.values(doc.records).filter(record => record.kind === 'module' && record.status === 'active'
    && ontologyModuleVisibleToTask(record, input.context)).map(record => record.id));
  // Prevent cross-module references from resolving hidden facts in conditions.
  const view: OntologyDocument = { ...doc, records: Object.fromEntries(Object.entries(doc.records).filter(([, record]) =>
    visibleModuleIds.has(record.kind === 'module' ? record.id : record.moduleId)).map(([id, record]) => [id,
      record.kind === 'rule' && input.operation === 'edit_file'
        ? { ...record, condition: inheritWriteConstraint(record.condition) } : record])) };
  const sections = markdownSections(input.content), checks = new Map<string, OntologyOperationCheck>();
  for (const moduleId of visibleModuleIds) for (const { rule, match } of queryOntologyRules(view, { moduleId, task: { at, taskKind: input.operation } })) {
    if (match === 'not_matched' || checks.has(rule.id)) continue;
    const checked: OntologyOperationCheck = { moduleId: rule.moduleId, recordId: rule.id, version: rule.version, status: 'not_machine_checkable', reasonCode: 'operation_target_unbound' };
    if (!boundToOperation(rule, input.operation)) { checks.set(rule.id, checked); continue; }
    if (rule.strength !== 'required') checked.reasonCode = 'advisory_rule';
    else if (match === 'unknown') { checked.status = 'blocked'; checked.reasonCode = 'rule_condition_unknown'; }
    else if (rule.exception.trim()) { checked.status = 'blocked'; checked.reasonCode = 'rule_exception_requires_review'; }
    else if (rule.effect.kind !== 'required_section') { checked.status = 'blocked'; checked.reasonCode = 'operation_adapter_missing'; }
    else {
      checked.sectionName = rule.effect.name;
      const present = sections.has(headingName(rule.effect.name));
      checked.status = present ? 'satisfied' : 'blocked';
      checked.reasonCode = present ? 'required_section_present' : 'required_section_missing';
    }
    checks.set(rule.id, checked);
  }
  const values = [...checks.values()], allowed = !values.some(check => check.status === 'blocked');
  return { allowed, revision: doc.revision, checks: values, ...(!allowed ? { code: 'E_ONTOLOGY_OPERATION_PRECONDITION' as const } : {}) };
}

/** Read the current authoritative rules at the operation's pre-write boundary. */
export async function checkOntologyMarkdownWrite(userId: string, input: OntologyMarkdownWriteInput): Promise<OntologyOperationDecision> {
  if (!safeId(userId)) throw new Error('invalid ontology operation owner');
  const doc = readOntologyDocument(userId), blockedSources = new Set<string>(), unavailableSources = new Set<string>();
  const sourceAccess = await assessOntologySources(userId, doc, input.context);
  for (const [id, status] of sourceAccess) {
    if (status === 'disabled') blockedSources.add(id);
    if (status === 'unavailable') unavailableSources.add(id);
  }
  // Source checks yield to storage. Never approve the old R snapshot if a rule,
  // condition fact, visibility or lifecycle changed while those reads awaited.
  const current = readOntologyDocument(userId);
  if (current.revision !== doc.revision || !isDeepStrictEqual(current.records, doc.records))
    throw new OntologyError('baseline_changed', 'ontology changed during operation preflight; retry against current rules');
  const filtered: OntologyDocument = { ...doc, records: Object.fromEntries(Object.entries(doc.records).filter(([id]) => !blockedSources.has(id) && !unavailableSources.has(id))) };
  const at = localDay();
  if (['write_file', 'edit_file'].includes(input.operation) && ['.md', '.markdown'].includes(path.extname(input.path).toLowerCase())) {
    const visible = new Set(Object.values(filtered.records).filter(row => row.kind === 'module' && row.status === 'active' && ontologyModuleVisibleToTask(row, input.context)).map(row => row.id));
    const scopedRecords = Object.fromEntries(Object.entries(filtered.records).filter(([, row]) => visible.has(row.kind === 'module' ? row.id : row.moduleId)));
    for (const record of Object.values(doc.records)) {
      if (record.kind !== 'rule' || record.status !== 'active' || record.access !== 'task'
        || record.strength !== 'required'
        || !boundToOperation(record, input.operation) || blockedSources.has(record.id)) continue;
      const module = doc.records[record.moduleId];
      if (!module || module.kind !== 'module' || module.status !== 'active' || blockedSources.has(module.id)
        || !ontologyModuleVisibleToTask(module, input.context)
        || (!unavailableSources.has(record.id) && !unavailableSources.has(module.id))) continue;
      // Evaluate applicability without unavailable facts. Do not expose names
      // from unreadable/private sources or block unrelated notes/modules.
      const probe: OntologyDocument = { ...filtered, records: { ...scopedRecords, [module.id]: module, [record.id]: input.operation === 'edit_file'
        ? { ...record, condition: inheritWriteConstraint(record.condition) } : record } };
      const matched = queryOntologyRules(probe, { moduleId: module.id, task: { at, taskKind: input.operation } }).find(row => row.rule.id === record.id);
      if (matched && matched.match !== 'not_matched') throw new OntologyError('source_unavailable', 'a bound required operation condition could not be checked');
    }
  }
  // Missing/unknown condition facts remain three-valued; a bound required R
  // then returns rule_condition_unknown rather than treating absence as false.
  return evaluateOntologyMarkdownWrite(filtered, input, at);
}


/** Bound required conditions cannot be bypassed by an opaque alternate tool.
 * This never certifies an unknown effect and never parses arbitrary scripts. */
export async function checkOntologyUnverifiedAction(userId: string, input: {
  operationKinds: readonly string[]; context?: OntologyMarkdownWriteInput['context'];
}): Promise<OntologyOperationDecision> {
  if (!safeId(userId)) throw new Error('invalid ontology operation owner');
  const doc = readOntologyDocument(userId);
  const visible = new Set(Object.values(doc.records).filter(row => row.kind === 'module' && row.status === 'active'
    && ontologyModuleVisibleToTask(row, input.context)).map(row => row.id));
  const bound = Object.values(doc.records).filter(row => row.kind === 'rule' && row.status === 'active'
    && row.access === 'task' && row.strength === 'required' && visible.has(row.moduleId)
    && input.operationKinds.some(kind => boundToOperation(row, kind)));
  if (!bound.length) return { allowed: true, revision: doc.revision, checks: [] };
  const access = await assessOntologySources(userId, doc, input.context);
  const records = Object.fromEntries(Object.entries(doc.records).filter(([id]) => access.get(id) === 'allowed'));
  const checks: OntologyOperationCheck[] = [];
  for (const record of bound) {
    if (record.kind !== 'rule' || access.get(record.id) === 'disabled' || access.get(record.moduleId) === 'disabled') continue;
    const module = doc.records[record.moduleId];
    // Only the rule and visible module are retained for applicability probes;
    // unavailable assertions remain unknown rather than invented as false.
    for (const kind of input.operationKinds) {
      if (!boundToOperation(record, kind)) continue;
      const probe = { ...doc, records: { ...records, [module.id]: module, [record.id]: kind === 'edit_file'
        ? { ...record, condition: inheritWriteConstraint(record.condition) } : record } };
      const result = queryOntologyRules(probe, { moduleId: record.moduleId, task: { at: localDay(), taskKind: kind } })
        .find(row => row.rule.id === record.id);
      if (!result || result.match === 'not_matched') continue;
      if (access.get(record.id) !== 'allowed' || access.get(record.moduleId) !== 'allowed')
        throw new OntologyError('source_unavailable', 'a bound required operation condition could not be checked');
      checks.push({ moduleId: record.moduleId, recordId: record.id, version: record.version, status: 'blocked',
        reasonCode: result.match === 'unknown' ? 'rule_condition_unknown' : record.exception.trim()
          ? 'rule_exception_requires_review' : 'operation_adapter_missing' });
      break;
    }
  }
  const current = readOntologyDocument(userId);
  if (current.revision !== doc.revision || !isDeepStrictEqual(current.records, doc.records))
    throw new OntologyError('baseline_changed', 'ontology changed during operation preflight; retry against current rules');
  return { allowed: checks.length === 0, revision: doc.revision, checks,
    ...(checks.length ? { code: 'E_ONTOLOGY_OPERATION_PRECONDITION' as const } : {}) };
}
