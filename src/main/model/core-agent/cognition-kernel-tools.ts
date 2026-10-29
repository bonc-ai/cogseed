/** Task field checks and governed ontology reads; conversation answers stay in the current task. */

import type { AgentTool } from '#core-agent';
import { createLogger } from '../../logger';
import {
  checkTaskFields,
  getTaskFieldPack,
  recordCognitionBoundReceipt,
  TASK_FIELD_PACKS,
} from '../../features/cognition_kernel';
import { logErrorRef, maskId } from '../../util/log-redact';

import { recordAssetAgentReads } from '../../features/recall/agent-read-accounting';
import type { ResolvePersonalFieldsRequest } from '../../features/cognition_kernel/types';
import { createTranscriptMemoryTools } from './transcript-memory-tools';
import { createOntologyTools } from './ontology-tools';
const log = createLogger('cognition-kernel-tools');

const PACK_IDS = Object.keys(TASK_FIELD_PACKS);

export interface CognitionKernelToolsOpts {
  userId: string;
  sourceMessageId?: string; sourceMessageFromUser?: boolean; taskText?: string;
  turnId?: string;
  /** 真实任务运行 ID（群聊 run）；缺省回退 turnId 记账。 */
  taskRunId?: string;
  cid?: string;
  /** Conversation-scoped transcript reads stay commander-only at runtime. */
  allowTranscriptRead?: boolean;
  spaceId?: string;
  context?: ResolvePersonalFieldsRequest['context'];
}

function packIdOf(input: Record<string, unknown>): string {
  return String(input.pack ?? '').trim();
}

function createFieldsCheckTool(opts: CognitionKernelToolsOpts): AgentTool {
  const userId = opts.userId;
  return {
    name: 'personal_fields_check',
    executionMode: 'parallel',
    description:
      '查一个任务类型开工前需要的认知槽位（三轴：个人字段／本体事实与规则／方法资产）：哪些已有、哪些还缺。'
      + '周报用 pack="weekly_report"。'
      + '本体 fact 槽位需要主体时，用 subjects 告诉它这次任务针对哪个对象（如 {"周报-固定接收人":"项目甲"}）。'
      + '对缺的槽位，在对话里直接问用户（一条一条问，不要一次抛整张表），'
      + '用户回答仅用于当前任务；长期资料由夜间提取和用户确认形成。'
      + '已有槽位直接用，不要重复问。缺方法资产不是缺口，如实告知用户即可。',
    inputSchema: {
      type: 'object',
      properties: {
        pack: { type: 'string', enum: PACK_IDS, description: 'Task slot pack id (weekly_report).' },
        subjects: {
          type: 'object',
          description: 'Optional. fact 槽位的主体绑定：槽位名 → 对象名（来自任务上下文）。',
          additionalProperties: { type: 'string', maxLength: 200 },
        },
      },
      required: ['pack'],
      additionalProperties: false,
    },
    async execute(input) {
      const packId = packIdOf(input);
      const pack = getTaskFieldPack(packId);
      if (!pack) return { content: 'personal_fields_check: 未知的任务槽位包，可选：' + PACK_IDS.join(' / '), isError: true };
      const subjects = input.subjects && typeof input.subjects === 'object'
        && !Array.isArray(input.subjects)
        ? Object.fromEntries(Object.entries(input.subjects as Record<string, unknown>)
          .map(([key, value]) => [key, String(value ?? '').trim().slice(0, 200)]))
        : undefined;
      try {
        const check = await checkTaskFields(userId, pack, opts.context, subjects);
        await recordAssetAgentReads(opts, check.resolution.bound.flatMap(field => field.source === 'personal_asset' && field.version
          ? [{ assetId: field.sourceId, assetVersion: field.version }] : []));
        try {
          await recordCognitionBoundReceipt(userId, opts.turnId, pack.id, check, opts.taskRunId);
        } catch (error) {
          log.warn('personal fields bound receipt failed', { userId: maskId(userId), turnId: maskId(opts.turnId), pack: packId, error: logErrorRef(error as Error) });
        }
        const result = {
          pack: pack.id,
          title: pack.title,
          total: check.totalCount,
          boundCount: check.boundCount,
          bound: check.resolution.bound.map((field) => ({ field: field.fieldName, value: field.value, source: field.source, sourceId: field.sourceId, ...(field.version ? { version: field.version, revision: field.revision ?? field.version } : {}) })),
          ontology: (check.ontology?.bound ?? []).map((hit) => ({ slot: hit.slot, kind: hit.kind, statement: hit.statement, moduleId: hit.moduleId, recordId: hit.recordId, version: hit.version, truth: hit.truth, ...(hit.match ? { match: hit.match } : {}) })),
          assets: (check.assets?.bound ?? []).map((hit) => ({ slot: hit.slot, assetId: hit.assetId, title: hit.title, version: hit.version })),
          assetMissing: (check.assets?.missing ?? []).map((miss) => ({ slot: miss.slot, reason: miss.reason, required: miss.required })),
          missing: check.gaps.map((gap) => ({ slot: gap.fieldName, axis: gap.axis, ask: gap.question, action: gap.action, reason: gap.reason, ...(gap.note ? { note: gap.note } : {}) })),
        };
        return { content: JSON.stringify(result, null, 2) };
      } catch (error) {
        log.warn('personal fields check failed', { userId: maskId(userId), pack: packId, error: logErrorRef(error as Error) });
        return { content: 'personal_fields_check: 读取认知槽位失败', isError: true };
      }
    },
  };
}

/** Assemble read-only field checks and ontology tools. */
export function createCognitionKernelTools(opts: CognitionKernelToolsOpts): AgentTool[] {
  return [
    createFieldsCheckTool(opts),
    ...(opts.allowTranscriptRead === false ? [] : createTranscriptMemoryTools(opts)),
    ...createOntologyTools({ userId: opts.userId, turnId: opts.turnId, cid: opts.cid, context: opts.context,
      sourceMessageId: opts.sourceMessageId, sourceMessageFromUser: opts.sourceMessageFromUser, taskText: opts.taskText }),
  ];
}
