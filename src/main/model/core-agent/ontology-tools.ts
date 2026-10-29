/** 按任务时间、对象和显式模块引用读取本体；查询不会保存任务临时安排。 */
import type { AgentTool } from '#core-agent';
import type { CognitionEditHost } from '../../features/cognition/edit-service';
import { OntologyError, validateOntologyId } from '../../features/cognition/ontology/model';
import { readOntologyView } from '../../features/cognition/ontology/service';
import { assessOntologySources, ontologyWithAdmittedSources } from '../../features/cognition/ontology/source-admission';
import { ontologyModuleVisibleToTask, queryOntologyFacts, queryOntologyRules, searchOntologyRecords } from '../../features/cognition/ontology/query';
import { resolveOntologyRecordForModule } from '../../features/cognition/ontology/commands';
import { recordOntologyQueryReadReceipt, type OntologyQueryReadRef } from '../../features/cognition/ontology/query-receipt';
import type { ResolvePersonalFieldsRequest } from '../../features/cognition_kernel/types';
import { createLogger } from '../../logger';
import { t } from '../../i18n';
import { assertCognitionManagementReadTarget, MANAGEMENT_PAGE_TOKENS, managementContentChunk, managementReadVersion } from '../../features/cognition/management-read';
import { readOntologyInventory, readOntologyManagementRecord } from '../../features/cognition/ontology/inventory';
import { esticogseedToolResultTokens } from '../../util/tool-result-cap';
import { logErrorRef, maskId } from '../../util/log-redact';
import { cognitionQueryFailure, queryModuleId } from './cognition-query-error';

const log = createLogger('ontology-query');
function queryReadRef(row: Record<string, unknown>, kind: OntologyQueryReadRef['kind']): OntologyQueryReadRef | undefined {
  const module = row.module && typeof row.module === 'object' ? row.module as Record<string, unknown> : {};
  const source = row.source && typeof row.source === 'object' ? row.source as Record<string, unknown> : {};
  const sourceKind = source.kind;
  const recordVersion = Number(source.version);
  if (typeof module.id !== 'string' || typeof source.recordId !== 'string'
    || !['user', 'candidate', 'legacy'].includes(String(sourceKind)) || !Number.isSafeInteger(recordVersion)) return undefined;
  return { moduleId: module.id, recordId: source.recordId, recordVersion, kind, sourceKind: sourceKind as OntologyQueryReadRef['sourceKind'] };
}

export interface OntologyToolsOptions extends Partial<CognitionEditHost> {
  userId: string;
  turnId?: string;
  context?: ResolvePersonalFieldsRequest['context'];
}
type ToolInput = Record<string, unknown>;
function todayLocal(): string {
  const now = new Date(), pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function ontologyCitation(moduleId: string, recordId: string, version: number): string {
  return `[[ontology:${moduleId}/${recordId}@${version}]]`;
}
const contains = (value: unknown, needle: string) => String(value ?? '').toLocaleLowerCase().includes(needle.toLocaleLowerCase());

export function createOntologyTools(options: OntologyToolsOptions): AgentTool[] {
  const tool: AgentTool = {
    name: 'cognition_ontology_query',
    executionMode: 'parallel',
    description:
      '查询用户的本体认知：按人物、项目或关系查当前与历史事实，并查看适用于本任务的规则。'
      + 'moduleId只能填查询结果中的正式ID；只有名称时先填query，不猜ID。'
      + '只读；临时任务安排不会保存。每条结果带来源和版本，unknown 表示开始时间或规则条件未确认。'
      + 'rule 的 matched 只表示条件匹配，不表示规则已经检查、采用或执行；default、required、suggestion 要按原等级说明。若 truncated 计数非零，结果不完整，不能据此断言所有要求均已覆盖。'
      + 'task模式不返回仅自己可见的内容和其他项目/工作区内容；本人明确要求全部内容盘点时使用inventory，按管理读取资格返回全文或来源占位，不授任务使用权。失败按错误指引处理，不等于不存在，不能据此转去创建。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['task', 'manage', 'inventory'], description: 'inventory：仅本人当前明确要求全部本体内容盘点时，分页返回完整管理记录，包括owner_only/暂停/归档/已纠正与旧只读投影，不授任务使用权。默认25条，最多50，按输出预算减条但不截断。来源不可读给占位。manage：点名或同一全量指令下按ID读完整管理合同；超大条目用contentCursor。缺省task仍按主题与任务权限查询；sourceCoverage.complete不是全库覆盖。' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'inventory本页最大条数，默认25。' },
        cursor: { type: 'string', description: 'inventory上页nextCursor；仅分页一致性，不是授权。' },
        expectedRevision: { type: 'integer', minimum: 0, description: '延续盘点或读取时要求的主档revision；变化拒绝，不能拼接新旧版本。' },
        contentCursor: { anyOf: [{ type: 'integer', const: 0 }, { type: 'string' }], description: '超大完整JSON分块：0开始，再用nextContentCursor。manage每批核本人意图/来源/版本；task保留原query/moduleId/at/purpose/taskKind/entityId并每批重新执行原任务范围与来源准入，不获得manage权限。全部拼接才是全文。' },
        recordId: { type: 'string', description: '管理读取的已有本体记录 ID。' },
        query: { type: 'string', maxLength: 200, description: '要查询的人物、项目、关系或主题；例如 CogSeed、负责人、周报接收人。' },
        moduleId: { type: 'string', maxLength: 160, description: '可选。此前查询结果中的正式本体 ID，不是显示名称；只有名称时先填 query。' },
        at: { type: 'string', maxLength: 10, description: '可选。查询哪一天的现实事实，格式 YYYY-MM-DD；缺省为今天。' },
        purpose: { type: 'string', maxLength: 200, description: '可选。任务目的的简短标记，用于判断规则条件。' },
        taskKind: { type: 'string', maxLength: 200, description: '可选。任务类型，用于判断规则条件。' },
        entityId: { type: 'string', maxLength: 160, description: '可选。此任务涉及的对象 ID。' },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(input: ToolInput) {
      try {
        if (input.mode !== undefined && (typeof input.mode !== 'string' || !['task', 'manage', 'inventory'].includes(input.mode))) throw new OntologyError('invalid_input', '无效读取模式');
        if (input.mode === 'inventory') {
          if (Object.keys(input).some(k => !['mode', 'limit', 'cursor', 'expectedRevision'].includes(k))) throw new OntologyError('invalid_input', t('cognition.read.inventory_no_filter'));
          return { content: JSON.stringify(await readOntologyInventory(options.userId, { ...options, userId: options.userId }, input)) };
        }
        if (input.mode === 'manage') {
          const doc = await readOntologyView(options.userId);
          const host = { ...options, userId: options.userId };
          const matches = input.recordId ? [doc.records[validateOntologyId(input.recordId)]].filter(Boolean)
            : Object.values(doc.records).filter(row => ('name' in row && row.name === input.query) || row.id === input.query);
          if (!matches.length) throw new OntologyError('not_found', '请用已有记录 ID 或用户点名的准确名称读取');
          if (matches.length !== 1) return { content: JSON.stringify({ status: 'ambiguous', matches: matches.map(row => ({ id: row.id, kind: row.kind, name: 'name' in row ? row.name : '', status: row.status })) }) };
          const record = matches[0];
          await assertCognitionManagementReadTarget(options.userId, host, 'ontology', record, doc);
          const result = await readOntologyManagementRecord(options.userId, record.id, input.contentCursor, input.expectedRevision);
          if (input.contentCursor === undefined && esticogseedToolResultTokens(JSON.stringify(result.content)) > MANAGEMENT_PAGE_TOKENS)
            return { content: JSON.stringify({ mode: 'manage', id: record.id, contentState: 'requires_chunk_read', managementRead: { mode: 'manage', recordId: record.id, contentCursor: 0, expectedRevision: result.doc.revision }, useBoundary: t('cognition.read.use_boundary') }) };
          return { content: JSON.stringify(result.content) };
        }
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        if (!query || query.length > 200) throw new OntologyError('invalid_input', '请输入不超过200字的查询主题');
        const moduleId = queryModuleId(input.moduleId);
        for (const field of ['purpose', 'taskKind'] as const) if (typeof input[field] === 'string' && input[field]!.length > 200) throw new OntologyError('invalid_input', `${field} is too long`);
        const at = typeof input.at === 'string' && input.at ? input.at : todayLocal();
        let doc = await readOntologyView(options.userId);
        const sourceStatuses = await assessOntologySources(options.userId, doc, options.context);
        doc = ontologyWithAdmittedSources(doc, sourceStatuses);
        const candidateRows = searchOntologyRecords(doc, query);
        const modules = Object.values(doc.records).filter((r): r is Extract<typeof r, { kind: 'module' }> => r.kind === 'module'
          && r.status === 'active' && ontologyModuleVisibleToTask(r, options.context));
        let targetModules = modules;
        if (moduleId) {
          const selected = doc.records[moduleId];
          if (!selected || selected.kind !== 'module' || !ontologyModuleVisibleToTask(selected, options.context))
            throw new OntologyError('not_authorized', '所选本体不存在或不属于当前任务范围');
          targetModules = [selected];
        } else {
          const moduleIds = new Set(candidateRows.flatMap(row => [row.kind === 'module' ? row.id : row.moduleId].filter((v): v is string => Boolean(v))));
          targetModules = modules.filter(module => moduleIds.has(module.id));
        }
        const entityIds = new Set(candidateRows.filter(row => row.kind === 'entity').map(row => row.id));
        const definitionIds = new Set(candidateRows.filter(row => row.kind === 'definition').map(row => row.id));
        const facts: Array<Record<string, unknown>> = [], uncertain: Array<Record<string, unknown>> = [], rules: Array<Record<string, unknown>> = [];
        for (const module of targetModules.slice(0, 50)) {
          const queried = queryOntologyFacts(doc, { moduleId: module.id, at });
          const relevant = (assertion: typeof queried.matched[number]) => {
            const definition = resolveOntologyRecordForModule(doc, module.id, assertion.definitionId);
            const subject = resolveOntologyRecordForModule(doc, module.id, assertion.subjectId);
            const object = assertion.object.kind === 'entity' ? resolveOntologyRecordForModule(doc, module.id, assertion.object.id) : null;
            const sourceModule = doc.records[assertion.moduleId];
            if (!sourceModule || sourceModule.kind !== 'module' || !ontologyModuleVisibleToTask(sourceModule, options.context)) return false;
            if (typeof input.moduleId === 'string' && input.moduleId) return true;
            return candidateRows.some(row => row.kind === 'module' && row.id === module.id) || entityIds.has(assertion.subjectId)
              || (assertion.object.kind === 'entity' && entityIds.has(assertion.object.id))
              || definitionIds.has(assertion.definitionId)
              || contains(definition?.kind === 'definition' ? definition.name : '', query)
              || contains(subject?.kind === 'entity' ? subject.name : '', query)
              || contains(object?.kind === 'entity' ? object.name : assertion.object.kind === 'literal' ? assertion.object.value : '', query);
          };
          const toFact = (assertion: typeof queried.matched[number], match: 'matched' | 'unknown') => {
            const subject = resolveOntologyRecordForModule(doc, module.id, assertion.subjectId), definition = resolveOntologyRecordForModule(doc, module.id, assertion.definitionId);
            const object = assertion.object.kind === 'entity' ? resolveOntologyRecordForModule(doc, module.id, assertion.object.id) : null;
            return { match, statement: `${subject?.kind === 'entity' ? subject.name : assertion.subjectId} · ${definition?.kind === 'definition' ? definition.name : assertion.definitionId} · ${object?.kind === 'entity' ? object.name : assertion.object.kind === 'literal' ? assertion.object.value : assertion.object.id}`,
              validity: assertion.validity, module: { id: assertion.moduleId, name: (doc.records[assertion.moduleId] as { name?: string })?.name },
              citation: ontologyCitation(assertion.moduleId, assertion.id, assertion.version),
              source: { recordId: assertion.id, version: assertion.version, label: assertion.source.label, kind: assertion.source.kind } };
          };
          for (const assertion of queried.matched.filter(relevant)) facts.push(toFact(assertion, 'matched'));
          for (const assertion of queried.uncertain.filter(relevant)) uncertain.push(toFact(assertion, 'unknown'));
          for (const result of queryOntologyRules(doc, { moduleId: module.id, task: {
            at,
            ...(typeof input.purpose === 'string' && input.purpose ? { purpose: input.purpose } : {}),
            ...(typeof input.taskKind === 'string' && input.taskKind ? { taskKind: input.taskKind } : {}),
            ...(typeof input.entityId === 'string' && input.entityId ? { entityId: validateOntologyId(input.entityId) } : {}),
          } })) {
            const sourceModule = doc.records[result.rule.moduleId];
            if (!sourceModule || sourceModule.kind !== 'module' || !ontologyModuleVisibleToTask(sourceModule, options.context)) continue;
            if (typeof input.moduleId !== 'string' && result.match === 'not_matched'
              && !contains(result.rule.name, query) && !contains(result.rule.requirement, query)) continue;
            const effect = result.rule.effect.kind === 'include_recipient'
              ? { ...result.rule.effect, entityName: (() => { const entity = resolveOntologyRecordForModule(doc, module.id, result.rule.effect.entityId); return entity?.kind === 'entity' ? entity.name : ''; })() }
              : result.rule.effect;
            rules.push({ name: result.rule.name, requirement: result.rule.requirement, strength: result.rule.strength,
              match: result.match, exception: result.rule.exception, effect,
              module: { id: result.rule.moduleId, name: sourceModule.name }, citation: ontologyCitation(result.rule.moduleId, result.rule.id, result.rule.version),
              source: { recordId: result.rule.id, version: result.rule.version, label: result.rule.source.label, kind: result.rule.source.kind } });
          }
        }
        const factLimit = 60, ruleLimit = 30;
        const visibleFacts = facts.slice(0, factLimit), visibleUncertainFacts = uncertain.slice(0, factLimit), visibleRules = rules.slice(0, ruleLimit);
        const choiceGroups = new Map<string, Array<{ value: string; match: string; recordId: string; moduleId: string; version: number; sourceKind: string }>>();
        for (const rule of visibleRules) {
          const effect = rule.effect as { kind?: string; key?: string; value?: string };
          if (effect.kind !== 'choice' || !effect.key || typeof effect.value !== 'string' || rule.match === 'not_matched') continue;
          choiceGroups.set(effect.key, [...(choiceGroups.get(effect.key) || []), { value: effect.value, match: String(rule.match),
            recordId: String((rule.source as { recordId?: string }).recordId || ''), moduleId: String((rule.module as { id?: string }).id || ''),
            version: Number((rule.source as { version?: number }).version || 0), sourceKind: String((rule.source as { kind?: string }).kind || '') }]);
        }
        const conflicts = [...choiceGroups].filter(([, entries]) => new Set(entries.map(item => item.value)).size > 1)
          .map(([key, entries]) => ({ key, values: [...new Set(entries.map(item => item.value))].slice(0, 10),
            state: entries.some(item => item.match === 'unknown') ? 'potential' : 'confirmed', sources: entries.slice(0, 10),
            omittedSourceCount: Math.max(0, entries.length - 10) }));
        let readReceiptId: string | undefined, readReceiptStatus: 'recorded' | 'unavailable' | 'no_turn_id' | 'no_result_refs' = 'no_turn_id';
        if (options.turnId) {
          try {
            const readRefs: OntologyQueryReadRef[] = [
              ...[...visibleFacts, ...visibleUncertainFacts].map(row => queryReadRef(row, 'assertion')),
              ...visibleRules.map(row => queryReadRef(row, 'rule')),
            ].filter((ref): ref is OntologyQueryReadRef => Boolean(ref));
            const receipt = await recordOntologyQueryReadReceipt(options.userId, options.turnId, readRefs);
            readReceiptId = receipt?.id;
            readReceiptStatus = receipt ? 'recorded' : 'no_result_refs';
          } catch (error) {
            readReceiptStatus = 'unavailable';
            log.warn('ontology query read receipt failed', { userId: maskId(options.userId), turnId: maskId(options.turnId), error: logErrorRef(error as Error) });
          }
        }
        const payload = { query, at, modules: targetModules.slice(0, 50).map(m => ({ id: m.id, name: m.name, scope: m.scope })),
          revision: doc.revision, records: Object.values(doc.records).filter(record => targetModules.some(module => (record.kind === 'module' ? record.id : record.moduleId) === module.id) && record.access === 'task' && record.status === 'active' && (record.kind !== 'assertion' || [...visibleFacts, ...visibleUncertainFacts].some(fact => (fact.source as { recordId?: string }).recordId === record.id))).slice(0, 100),
          facts: visibleFacts, uncertainFacts: visibleUncertainFacts, rules: visibleRules, conflicts, conflictsComplete: rules.length <= ruleLimit && targetModules.length <= 50,
          readReceipt: { status: readReceiptStatus, ...(readReceiptId ? { id: readReceiptId } : {}) },
          usageReceiptPolicy: 'If a fact or rule materially informs the final answer, copy its citation marker exactly into that answer. The host records use only when the same-turn query returned that exact version and the marker appears in the persisted reply. This does not prove external action execution or effectiveness.',
          truncated: { facts: Math.max(0, facts.length - factLimit), uncertainFacts: Math.max(0, uncertain.length - factLimit), rules: Math.max(0, rules.length - ruleLimit), modules: Math.max(0, targetModules.length - 50),
            records: Math.max(0, Object.values(doc.records).filter(record => targetModules.some(module => (record.kind === 'module' ? record.id : record.moduleId) === module.id) && record.access === 'task' && record.status === 'active' && (record.kind !== 'assertion' || [...visibleFacts, ...visibleUncertainFacts].some(fact => (fact.source as { recordId?: string }).recordId === record.id))).length - 100) },
          queryScope: 'task_topic_search_not_owner_inventory',
          sourceCoverage: { complete: ![...sourceStatuses.values()].includes('unavailable') },
          useBoundary: 'The read receipt means this tool produced a result containing the cited record versions; it does not prove adoption or execution. A rule match does not mean rule execution. If any truncated count is nonzero or sourceCoverage.complete is false, this result is incomplete and cannot certify that all requirements were checked.' };
        if (input.contentCursor !== undefined) {
          // Keep the original task path and re-run all admission checks above
          // on EVERY chunk. A receipt is operational read bookkeeping, not
          // stable semantic content or authority to read a stored result ref.
          const { readReceipt, ...semantic } = payload;
          const taskKey = 'task-' + managementReadVersion({ query, at, moduleId: input.moduleId, purpose: input.purpose,
            taskKind: input.taskKind, entityId: input.entityId, context: options.context });
          const part = managementContentChunk(options.userId, 'ontology', taskKey, { mode: 'task', ...semantic }, input.contentCursor);
          return { content: JSON.stringify({ ...part, readReceipt }) };
        }
        return { content: JSON.stringify(payload, null, 2) };
      } catch (error) {
        return cognitionQueryFailure('cognition_ontology_query', error, options.userId);
      }
    },
  };
  return [tool];
}
