/** 按任务时间、对象和显式模块引用读取本体；查询不会保存任务临时安排。 */
import type { AgentTool } from '#core-agent';
import type { CognitionEditHost } from '../../features/cognition/edit-service';
import { OntologyError, validateOntologyId } from '../../features/cognition/ontology/model';
import { localCalendarDay } from '../../features/cognition/ontology/calendar-day';
import { recordOntologyQueryReadReceipt } from '../../features/cognition/ontology/query-receipt';
import {
  ONTOLOGY_TASK_USAGE_RECEIPT_POLICY,
  runOntologyTaskQuery,
} from '../../features/cognition/ontology/task-query';
import type { ResolvePersonalFieldsRequest } from '../../features/cognition_kernel/types';
import { createLogger } from '../../logger';
import { t } from '../../i18n';
import { MANAGEMENT_PAGE_TOKENS, managementContentChunk, managementReadVersion } from '../../features/cognition/management-read';
import { readOntologyInventory, readOntologyManagementRecord } from '../../features/cognition/ontology/inventory';
import { esticogseedToolResultTokens } from '../../util/tool-result-cap';
import { logErrorRef, maskId } from '../../util/log-redact';
import { cognitionQueryFailure, queryModuleId } from './cognition-query-error';

const log = createLogger('ontology-query');

export interface OntologyToolsOptions extends Partial<CognitionEditHost> {
  userId: string;
  turnId?: string;
  context?: ResolvePersonalFieldsRequest['context'];
}
type ToolInput = Record<string, unknown>;
export function createOntologyTools(options: OntologyToolsOptions): AgentTool[] {
  const tool: AgentTool = {
    name: 'cognition_ontology_query',
    executionMode: 'parallel',
    description:
      '查询用户的本体认知：按人物、项目或关系查当前与历史事实，并查看适用于本任务的规则。'
      + 'moduleId只能填查询结果中的正式ID；只有名称时先填query，不猜ID。'
      + '只读；临时任务安排不会保存。每条结果带来源和版本，unknown 表示开始时间或规则条件未确认。'
      + 'rule 的 matched 只表示条件匹配，不表示规则已经检查、采用或执行；default、required、suggestion 要按原等级说明。若 truncated 计数非零，结果不完整，不能据此断言所有要求均已覆盖。'
      + '带query按主题查；带recordId读该条完整内容（大条目用contentCursor分批）；都不带则分页列出全部本体内容（默认25、最多50，含仅自己可见、暂停与归档，来源不可读给占位）。'
      + '主题查询不返回仅自己可见和其他项目/工作区内容；scopeExcluded只报排除数量，modules为空但scopeExcluded非零=内容存在但未提供给任务，不能断言本体为空。失败按错误指引处理，不等于不存在。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: '要查询的人物、项目、关系或主题；例如 CogSeed、负责人、周报接收人。' },
        recordId: { type: 'string', maxLength: 160, description: '读取该条完整内容的管理合同；正式本体记录 ID，先用主题查询或全量分页拿到。' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '全量分页每页条数，默认25。' },
        cursor: { type: 'string', description: '全量分页上页 nextCursor；仅分页一致性，不是授权。' },
        expectedRevision: { type: 'integer', minimum: 0, description: '延续分页或单条读取时要求的主档 revision；变化拒绝，不能拼接新旧版本。' },
        contentCursor: { anyOf: [{ type: 'integer', const: 0 }, { type: 'string' }], description: '超大完整JSON分块：0开始，再用nextContentCursor。recordId读取与主题查询超大结果都适用；每批回源核来源与版本，全部拼接才是全文。' },
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
        if (input.recordId !== undefined) {
          const recordId = validateOntologyId(String(input.recordId));
          const result = await readOntologyManagementRecord(options.userId, recordId, input.contentCursor, input.expectedRevision);
          if (input.contentCursor === undefined && esticogseedToolResultTokens(JSON.stringify(result.content)) > MANAGEMENT_PAGE_TOKENS)
            return { content: JSON.stringify({ mode: 'manage', id: recordId, contentState: 'requires_chunk_read', managementRead: { mode: 'manage', recordId, contentCursor: 0, expectedRevision: result.doc.revision }, useBoundary: t('cognition.read.use_boundary') }) };
          return { content: JSON.stringify(result.content) };
        }
        const query = typeof input.query === 'string' ? input.query.trim() : '';
        if (input.query !== undefined && typeof input.query !== 'string') throw new OntologyError('invalid_input', '请输入不超过200字的查询主题');
        if (input.query !== undefined && !query) throw new OntologyError('invalid_input', 'query 不能为空；要列全量请省略 query 和 recordId');
        if (!query) {
          const filters = ['moduleId', 'at', 'purpose', 'taskKind', 'entityId']
            .filter(field => input[field] !== undefined && input[field] !== '');
          if (filters.length) throw new OntologyError('invalid_input', `全量分页不接受 ${filters.join('/')} 过滤参数；请提供 query 或 recordId`);
          if (input.contentCursor !== undefined) throw new OntologyError('invalid_input', 'contentCursor 需要配合 query 或 recordId');
          return { content: JSON.stringify(await readOntologyInventory(options.userId, { limit: input.limit, cursor: input.cursor, expectedRevision: input.expectedRevision })) };
        }
        if (query.length > 200) throw new OntologyError('invalid_input', '请输入不超过200字的查询主题');
        const moduleId = queryModuleId(input.moduleId);
        for (const field of ['purpose', 'taskKind'] as const) if (typeof input[field] === 'string' && input[field]!.length > 200) throw new OntologyError('invalid_input', `${field} is too long`);
        const at = typeof input.at === 'string' && input.at ? input.at : localCalendarDay();
        const result = await runOntologyTaskQuery({
          userId: options.userId,
          context: options.context,
          query,
          moduleId,
          at,
          ...(typeof input.purpose === 'string' && input.purpose ? { purpose: input.purpose } : {}),
          ...(typeof input.taskKind === 'string' && input.taskKind ? { taskKind: input.taskKind } : {}),
          ...(typeof input.entityId === 'string' && input.entityId ? { entityId: input.entityId } : {}),
        });
        let readReceiptId: string | undefined, readReceiptStatus: 'recorded' | 'unavailable' | 'no_turn_id' | 'no_result_refs' = 'no_turn_id';
        if (options.turnId) {
          try {
            const receipt = await recordOntologyQueryReadReceipt(options.userId, options.turnId, result.readRefs);
            readReceiptId = receipt?.id;
            readReceiptStatus = receipt ? 'recorded' : 'no_result_refs';
          } catch (error) {
            readReceiptStatus = 'unavailable';
            log.warn('ontology query read receipt failed', { userId: maskId(options.userId), turnId: maskId(options.turnId), error: logErrorRef(error as Error) });
          }
        }
        const { readRefs: _readRefs, ...semantic } = result;
        const payload = { ...semantic,
          readReceipt: { status: readReceiptStatus, ...(readReceiptId ? { id: readReceiptId } : {}) },
          usageReceiptPolicy: ONTOLOGY_TASK_USAGE_RECEIPT_POLICY };
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
