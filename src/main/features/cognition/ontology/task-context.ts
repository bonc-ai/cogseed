/** Build the independent task-ontology block used by chat and native Runtime.
 * The query kernel owns admission; this module only selects deterministic
 * mentions, drops duplicate/incompatible rows, renders within budget and
 * reports what was omitted. */
import { createLogger } from '../../../logger';
import { readOntologyView } from './service';
import { OntologyError, type OntologyDocument } from './model';
import { localCalendarDay } from './calendar-day';
import { inferOntologyTaskKind } from './task-kind';
import {
  runOntologyTaskQuery,
  summarizeOntologyScopeExclusion,
  type OntologyQueryFactRow,
  type OntologyQueryRuleRow,
  type OntologyTaskQueryLimits,
  type OntologyTaskQueryResult,
  type OntologyTaskScopeExcluded,
} from './task-query';
import { ontologyModuleVisibleToTask } from './query';
import type { OntologySourceContext } from './source-admission';
import type { OntologyQueryReadRef } from './query-receipt';

const log = createLogger('task-ontology-context');

export interface TaskOntologyBudget {
  maxChars: number;
  maxFacts: number;
  maxUncertainFacts: number;
  maxRules: number;
  maxModules: number;
  maxConflicts: number;
}

export interface TaskOntologyContextInput {
  userId: string;
  taskText: string;
  at?: string;
  context?: OntologySourceContext;
  topicQuery?: string;
  moduleId?: string;
  entityId?: string;
  purpose?: string;
  taskKind?: string;
  injectedAssetIds?: readonly string[];
  limits?: Partial<OntologyTaskQueryLimits>;
  budget?: Partial<TaskOntologyBudget>;
}

export interface TaskOntologyOmitted {
  reason: 'ambiguous_mention' | 'budget_mentions' | 'budget_facts' | 'budget_uncertain_facts'
    | 'budget_rules' | 'budget_conflicts' | 'budget_modules'
    | 'budget_total_chars' | 'context_unavailable';
  count: number;
}

export interface TaskOntologyContextResult {
  promptBlock: string;
  readRefs: OntologyQueryReadRef[];
  revision?: number;
  at?: string;
  mentions: string[];
  ambiguousMentions: string[];
  omitted: TaskOntologyOmitted[];
  truncated: OntologyTaskQueryResult['truncated'];
  scopeExcluded?: OntologyTaskScopeExcluded;
  complete: boolean;
  errorCode?: string;
}

export interface RenderedTaskOntologyBlock {
  promptBlock: string;
  readRefs: OntologyQueryReadRef[];
  omitted: TaskOntologyOmitted[];
  truncated: OntologyTaskQueryResult['truncated'];
  complete: boolean;
}

const DEFAULT_BUDGET: TaskOntologyBudget = {
  maxChars: 6_000,
  maxFacts: 12,
  maxUncertainFacts: 6,
  maxRules: 8,
  maxModules: 6,
  maxConflicts: 3,
};
export const TASK_ONTOLOGY_MAX_CHARS = 8_000;
const MAX_MENTIONS = 8;
const MIN_MENTION_LENGTH = 2;
const OLD_GRAPH_MODULE = 'legacy-ontology-graph';

export interface TaskMentionExtraction {
  mentions: string[];
  ambiguous: string[];
  overflow: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ASCII names need word boundaries; CJK names are matched as substrings
 * because Chinese text has no whitespace-delimited words. */
function containsMention(text: string, key: string): boolean {
  const asciiStart = /^[a-z0-9_]/i.test(key);
  const asciiEnd = /[a-z0-9_]$/i.test(key);
  if (!asciiStart && !asciiEnd) return text.includes(key);
  const pattern = `${asciiStart ? '(^|[^a-z0-9_])' : ''}${escapeRegExp(key)}${asciiEnd ? '([^a-z0-9_]|$)' : ''}`;
  return new RegExp(pattern, 'i').test(text);
}

/** Match visible canonical module/entity names (and entity aliases) in the
 * task text. Legacy projections do not seed automatic mentions; they can still
 * be queried explicitly through topicQuery or the Agent tool. */
export function extractTaskMentions(
  doc: OntologyDocument,
  taskText: string,
  context?: OntologySourceContext,
): TaskMentionExtraction {
  const text = String(taskText || '').toLowerCase();
  if (!text.trim()) return { mentions: [], ambiguous: [], overflow: 0 };
  const visibleModules = new Set(Object.values(doc.records)
    .filter(record => record.kind === 'module' && record.status === 'active'
      && record.source.kind !== 'legacy' && ontologyModuleVisibleToTask(record, context))
    .map(record => record.id));
  const names = new Map<string, { display: string; ids: Set<string> }>();
  const register = (raw: string, recordId: string) => {
    const name = String(raw || '').trim();
    const key = name.toLowerCase();
    if (key.length < MIN_MENTION_LENGTH) return;
    const entry = names.get(key) ?? { display: name, ids: new Set<string>() };
    entry.ids.add(recordId);
    names.set(key, entry);
  };
  for (const record of Object.values(doc.records)) {
    if (record.status !== 'active' || record.access !== 'task' || record.source.kind === 'legacy') continue;
    if (record.kind === 'module') {
      if (visibleModules.has(record.id)) register(record.name, record.id);
    } else if (record.kind === 'entity' && visibleModules.has(record.moduleId)) {
      register(record.name, record.id);
      for (const alias of record.aliases) register(alias, record.id);
    } else if (record.kind === 'definition' && record.definitionKind === 'relation'
      && visibleModules.has(record.moduleId)) {
      register(record.name, record.id);
    }
  }
  const mentions: string[] = [];
  const ambiguous: string[] = [];
  for (const [key, entry] of names) {
    if (!containsMention(text, key)) continue;
    if (entry.ids.size > 1) ambiguous.push(entry.display);
    else mentions.push(entry.display);
  }
  const uniqueMentions = [...new Set(mentions)].sort(compareText);
  return {
    mentions: uniqueMentions.slice(0, MAX_MENTIONS),
    ambiguous: [...new Set(ambiguous)].sort(compareText),
    overflow: Math.max(0, uniqueMentions.length - MAX_MENTIONS),
  };
}

function positiveLimit(value: unknown, fallback: number, max: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;
}

function resolveBudget(input: Partial<TaskOntologyBudget> = {}): TaskOntologyBudget {
  return {
    maxChars: positiveLimit(input.maxChars, DEFAULT_BUDGET.maxChars, TASK_ONTOLOGY_MAX_CHARS),
    maxFacts: positiveLimit(input.maxFacts, DEFAULT_BUDGET.maxFacts, 100),
    maxUncertainFacts: positiveLimit(input.maxUncertainFacts, DEFAULT_BUDGET.maxUncertainFacts, 100),
    maxRules: positiveLimit(input.maxRules, DEFAULT_BUDGET.maxRules, 100),
    maxModules: positiveLimit(input.maxModules, DEFAULT_BUDGET.maxModules, 50),
    maxConflicts: positiveLimit(input.maxConflicts, DEFAULT_BUDGET.maxConflicts, 50),
  };
}

function emptyTruncated(): OntologyTaskQueryResult['truncated'] {
  return { facts: 0, uncertainFacts: 0, rules: 0, modules: 0, records: 0 };
}

function renderedComplete(
  truncated: OntologyTaskQueryResult['truncated'],
  searchTruncated: boolean,
  sourceComplete: boolean,
  omittedEmpty: boolean,
): boolean {
  return omittedEmpty && !searchTruncated && sourceComplete
    && truncated.facts === 0 && truncated.uncertainFacts === 0
    && truncated.rules === 0 && truncated.modules === 0;
}

function emptyResult(
  omitted: TaskOntologyOmitted[] = [],
  extraction: TaskMentionExtraction = { mentions: [], ambiguous: [], overflow: 0 },
  complete = true,
  errorCode?: string,
): TaskOntologyContextResult {
  return {
    promptBlock: '',
    readRefs: [],
    mentions: extraction.mentions,
    ambiguousMentions: extraction.ambiguous,
    omitted,
    truncated: emptyTruncated(),
    complete,
    ...(errorCode ? { errorCode } : {}),
  };
}

function recordModuleId(doc: OntologyDocument, recordId: string): string | undefined {
  const record = doc.records[recordId];
  return record ? record.kind === 'module' ? record.id : record.moduleId : undefined;
}

function excludedFromAutoBlock(
  doc: OntologyDocument,
  recordId: string,
  injectedAssetIds: ReadonlySet<string>,
): boolean {
  if (recordModuleId(doc, recordId) === OLD_GRAPH_MODULE) return true;
  const record = doc.records[recordId];
  return Boolean(record?.source.refs?.some(ref => ref.kind === 'asset' && injectedAssetIds.has(ref.id)));
}

function dedupByCitation<T extends { citation: string; source: { recordId: string } }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = `${row.source.recordId}\0${row.citation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function addOmitted(rows: TaskOntologyOmitted[], reason: TaskOntologyOmitted['reason'], count: number): void {
  if (count <= 0) return;
  const existing = rows.find(row => row.reason === reason);
  if (existing) existing.count += count;
  else rows.push({ reason, count });
}

interface RenderedSection {
  key: 'facts' | 'uncertainFacts' | 'rules' | 'conflicts' | 'modules';
  text: string;
  rows: Array<{ citation: string; moduleId: string; recordId: string; version: number; kind: 'assertion' | 'rule'; sourceKind: 'user' | 'candidate' | 'legacy' }>;
}

function factRows(rows: OntologyQueryFactRow[], tag: 'facts' | 'uncertain-facts'): RenderedSection {
  return {
    key: tag === 'facts' ? 'facts' : 'uncertainFacts',
    text: `<${tag}>\n${rows.map(row => `  <fact match="${row.match}" citation="${escapeXml(row.citation)}">${escapeXml(row.statement)}</fact>`).join('\n')}\n</${tag}>`,
    rows: rows.map(row => ({
      citation: row.citation, moduleId: row.module.id, recordId: row.source.recordId,
      version: row.source.version, kind: 'assertion', sourceKind: row.source.kind,
    })),
  };
}

/** Pure renderer. Whole sections are dropped from lowest priority to highest so
 * a citation or XML tag is never cut in half. */
export function renderTaskOntologyBlock(
  result: OntologyTaskQueryResult,
  budgetInput: Partial<TaskOntologyBudget> = {},
  mentions: string[] = [],
  extraOmitted: TaskOntologyOmitted[] = [],
): RenderedTaskOntologyBlock {
  const budget = resolveBudget(budgetInput);
  const omitted = [...extraOmitted];
  const truncated = { ...result.truncated };

  const facts = result.facts.slice(0, budget.maxFacts);
  addOmitted(omitted, 'budget_facts', result.facts.length - facts.length);
  truncated.facts += result.facts.length - facts.length;

  const uncertainFacts = result.uncertainFacts.slice(0, budget.maxUncertainFacts);
  addOmitted(omitted, 'budget_uncertain_facts', result.uncertainFacts.length - uncertainFacts.length);
  truncated.uncertainFacts += result.uncertainFacts.length - uncertainFacts.length;

  const rules = result.rules.slice(0, budget.maxRules);
  addOmitted(omitted, 'budget_rules', result.rules.length - rules.length);
  truncated.rules += result.rules.length - rules.length;

  const conflicts = result.conflicts.slice(0, budget.maxConflicts);
  addOmitted(omitted, 'budget_conflicts', result.conflicts.length - conflicts.length);

  const modules = result.modules.slice(0, budget.maxModules);
  addOmitted(omitted, 'budget_modules', result.modules.length - modules.length);
  truncated.modules += result.modules.length - modules.length;

  const sections: RenderedSection[] = [];
  if (facts.length) sections.push(factRows(facts, 'facts'));
  if (uncertainFacts.length) sections.push(factRows(uncertainFacts, 'uncertain-facts'));
  if (rules.length) {
    sections.push({
      key: 'rules',
      text: `<rules>\n${rules.map(row => `  <rule name="${escapeXml(row.name)}" match="${row.match}" strength="${row.strength}" citation="${escapeXml(row.citation)}">${escapeXml(row.requirement)}</rule>`).join('\n')}\n</rules>`,
      rows: rules.map(row => ({
        citation: row.citation, moduleId: row.module.id, recordId: row.source.recordId,
        version: row.source.version, kind: 'rule', sourceKind: row.source.kind,
      })),
    });
  }
  if (conflicts.length) {
    sections.push({
      key: 'conflicts',
      text: `<conflicts>\n${conflicts.map(row => `  <conflict key="${escapeXml(row.key)}" state="${row.state}" values="${escapeXml(row.values.join(', '))}" />`).join('\n')}\n</conflicts>`,
      rows: [],
    });
  }
  if (modules.length) {
    sections.push({
      key: 'modules',
      text: `<modules>\n${modules.map(row => `  <module id="${escapeXml(row.id)}" name="${escapeXml(row.name)}" />`).join('\n')}\n</modules>`,
      rows: [],
    });
  }
  if (!sections.length) {
    return {
      promptBlock: '', readRefs: [], omitted, truncated,
      complete: renderedComplete(truncated, result.searchTruncated, result.sourceCoverage.complete, omitted.length === 0),
    };
  }

  const openTag = `<task-ontology${mentions.length ? ` mentions="${escapeXml(mentions.join(', '))}"` : ''}${result.revision >= 0 ? ` revision="${result.revision}"` : ''}>`;
  const closeTag = '</task-ontology>';
  const renderNotes = (blockTruncated: boolean) => {
    const notes = ['Stored ontology facts and rules. Rules marked matched only indicate condition match, not execution.'];
    if (uncertainFacts.length) notes.push('Facts under uncertain-facts have unresolved time or certainty.');
    if (!result.sourceCoverage.complete) notes.push('Source coverage is incomplete.');
    if (result.searchTruncated) notes.push('Candidate search results were truncated and may be incomplete.');
    notes.push('If a stored fact or rule materially informs the final answer, copy its citation marker exactly into that answer; do not cite background that was not used.');
    if (blockTruncated || omitted.length) notes.push('Context is truncated and may be incomplete.');
    return `<notes>${notes.join(' ')}</notes>`;
  };

  const kept = [...sections];
  const droppedCounts: Record<RenderedSection['key'], number> = {
    facts: 0, uncertainFacts: 0, rules: 0, conflicts: 0, modules: 0,
  };
  let block = '';
  while (true) {
    const notes = renderNotes(Object.values(droppedCounts).some(count => count > 0));
    const candidate = `${openTag}\n${[...kept.map(section => section.text), notes].join('\n')}\n${closeTag}`;
    if (candidate.length <= budget.maxChars) { block = candidate; break; }
    if (!kept.length) break;
    const dropped = kept.pop()!;
    droppedCounts[dropped.key] += dropped.rows.length || 1;
    if (dropped.key === 'facts') truncated.facts += dropped.rows.length;
    if (dropped.key === 'uncertainFacts') truncated.uncertainFacts += dropped.rows.length;
    if (dropped.key === 'rules') truncated.rules += dropped.rows.length;
    if (dropped.key === 'modules') truncated.modules += dropped.rows.length;
  }
  if (!block) {
    addOmitted(omitted, 'budget_total_chars', 1);
    return { promptBlock: '', readRefs: [], omitted, truncated, complete: false };
  }
  const droppedTotal = Object.values(droppedCounts).reduce((sum, count) => sum + count, 0);
  addOmitted(omitted, 'budget_total_chars', droppedTotal);

  const refs = new Map<string, OntologyQueryReadRef>();
  for (const section of kept) {
    for (const row of section.rows) {
      refs.set(`${row.moduleId}:${row.recordId}:${row.version}`, {
        moduleId: row.moduleId, recordId: row.recordId, recordVersion: row.version,
        kind: row.kind, sourceKind: row.sourceKind,
      });
    }
  }
  const complete = renderedComplete(truncated, result.searchTruncated, result.sourceCoverage.complete, omitted.length === 0);
  return { promptBlock: block, readRefs: [...refs.values()], omitted, truncated, complete };
}

export async function buildTaskOntologyContext(input: TaskOntologyContextInput): Promise<TaskOntologyContextResult> {
  let extraction: TaskMentionExtraction = { mentions: [], ambiguous: [], overflow: 0 };
  try {
    const doc = await readOntologyView(input.userId);
    extraction = extractTaskMentions(doc, input.taskText, input.context);
    const queries = [...extraction.mentions];
    const topic = String(input.topicQuery || '').trim();
    if (topic && !queries.includes(topic)) queries.push(topic);
    const extractionOmitted: TaskOntologyOmitted[] = [
      ...(extraction.ambiguous.length ? [{ reason: 'ambiguous_mention' as const, count: extraction.ambiguous.length }] : []),
      ...(extraction.overflow ? [{ reason: 'budget_mentions' as const, count: extraction.overflow }] : []),
    ];
    if (!queries.length) {
      return {
        ...emptyResult(extractionOmitted, extraction, extractionOmitted.length === 0),
        scopeExcluded: summarizeOntologyScopeExclusion(doc, input.context),
      };
    }

    const effectiveTaskKind = input.taskKind
      || inferOntologyTaskKind(input.purpose || input.context?.purpose)
      || inferOntologyTaskKind(input.taskText);
    const result = await runOntologyTaskQuery({
      userId: input.userId,
      context: input.context,
      query: queries[0],
      queries: queries.slice(1),
      at: input.at || localCalendarDay(),
      ...(input.moduleId ? { moduleId: input.moduleId } : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
      ...(input.purpose || input.context?.purpose ? { purpose: input.purpose || input.context?.purpose } : {}),
      ...(effectiveTaskKind ? { taskKind: effectiveTaskKind } : {}),
      ...(input.limits ? { limits: input.limits } : {}),
    }, doc);

    const injected = new Set(input.injectedAssetIds || []);
    const keep = (recordId: string) => !excludedFromAutoBlock(doc, recordId, injected);
    const filtered: OntologyTaskQueryResult = {
      ...result,
      modules: result.modules.filter(module => keep(module.id)),
      records: result.records.filter(record => keep(record.id)),
      facts: dedupByCitation(result.facts.filter(row => keep(row.source.recordId))),
      uncertainFacts: dedupByCitation(result.uncertainFacts.filter(row => keep(row.source.recordId))),
      rules: dedupByCitation(result.rules.filter(row => keep(row.source.recordId))),
    };
    const rendered = renderTaskOntologyBlock(filtered, input.budget, extraction.mentions, extractionOmitted);
    return {
      promptBlock: rendered.promptBlock,
      readRefs: rendered.readRefs,
      revision: result.revision,
      at: result.at,
      mentions: extraction.mentions,
      ambiguousMentions: extraction.ambiguous,
      omitted: rendered.omitted,
      truncated: rendered.truncated,
      scopeExcluded: result.scopeExcluded,
      complete: rendered.complete,
    };
  } catch (error) {
    const errorCode = error instanceof OntologyError ? error.code : 'unexpected';
    if (error instanceof OntologyError) {
      log.warn('task ontology context soft failure', { code: error.code, message: error.message });
    } else {
      log.warn('task ontology context unexpected failure', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return emptyResult([{ reason: 'context_unavailable', count: 1 }], extraction, false, errorCode);
  }
}
