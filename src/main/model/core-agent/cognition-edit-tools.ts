/** One model adapter; authorization and atomic writes belong to the feature. */
import type { AgentTool, ToolContext } from '#core-agent';
import { editCognition, type CognitionEditHost, type CognitionEditInput } from '../../features/cognition/edit-service';
export function createCognitionEditTools(host: CognitionEditHost): AgentTool[] {
  return [{
    name: 'edit_cognition',
    description: '按当前用户明确指令修改已有认知资产或本体。先用 read_ability_asset(mode=manage) 或 cognition_ontology_query(mode=manage) 看正文和版本。精确字段/唯一片段补丁可直接保存；缺完整本人决定或 AI 改写时，主进程展示完整正文与条件并请用户确认一次。共享规则正文自动与拥有认知同次保存。单条编辑不创建新资产。operation=merge/split 时读取所有目标的在用全文与版本，用当前模型起草完整 outputs，附原文片段与本体去向；宿主展示整组结果，确认后新建结果并归档原条目。不恢复暂停，不扩大默认使用授权；明确本人确认的新版本在原范围内继续用于普通后续任务。mode=propose 只预览不保存。',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['merge', 'split'], description: '合并或拆分用户指定的认知：新建结果、原条目归档，整组预览确认。此时不用 target/fields，使用 sourceAssetIds/outputs/expectedVersions。' },
      sourceAssetIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 },
      expectedVersions: { type: 'array', items: { type: 'object', properties: { assetId: { type: 'string' }, version: { type: 'string' }, activeVersion: { type: 'string' } }, required: ['assetId', 'version', 'activeVersion'], additionalProperties: false } },
      outputs: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', properties: { title: { type: 'string' }, statement: { type: 'string' }, value: { type: 'string' }, applicableWhen: { type: 'array', items: { type: 'string' } }, forbiddenWhen: { type: 'array', items: { type: 'string' } }, sourceAssetIds: { type: 'array', items: { type: 'string' } }, ontologyRecordIds: { type: 'array', items: { type: 'string' } }, excerpts: { type: 'array', items: { type: 'object', properties: { assetId: { type: 'string' }, quote: { type: 'string' } }, required: ['assetId', 'quote'], additionalProperties: false } } }, required: ['title', 'statement', 'sourceAssetIds', 'excerpts', 'ontologyRecordIds'], additionalProperties: false }, description: '每份完整结果及对应原文。合并 2–6 条为一份，或拆分一条为 2–6 份。保留用途、条件、例外与全部本体去向。' },
      target: { type: 'object', properties: { assetId: { type: 'string' }, ontologyRecordId: { type: 'string' } }, additionalProperties: false, description: '唯一已有目标，二选一；ID 来自管理读取。' },
      fields: { type: 'object', additionalProperties: true, description: '只传实际要改的新值，不要把读取到的旧正文放进fields作基线（版本基线用expectedVersion）。资产：title/statement/value（用途）/scope/scopePolicy/applicableWhen/forbiddenWhen/tags。本体按记录类型修改 name/description/requirement/condition/effect/strength/exception/aliases 等；事实用 object/subjectId/certainty。没给的字段保留。正文整体改写用fields.statement；若用replaceText改片段，则不要再传fields.statement：正文这两种表示必须二选一。' },
      replaceText: { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' } }, required: ['before', 'after'], additionalProperties: false, description: '只修改正文一个精确且唯一的原片段。使用它就不要再传fields.statement（包括旧正文）；整体正文新值与片段补丁必须二选一。其他没要求改的正文保持不变。' },
      ontologyChanges: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '可选，同次保存的已有关联本体命令；必须给记录版本，不允许 create。额外影响会完整确认。' },
      expectedVersion: { type: 'string', description: '管理读取返回的最新版；本体记录也以字符串传数字。' },
      expectedActiveVersion: { type: 'string' }, expectedOntologyRevision: { type: 'number' },
      factIntent: { type: 'string', enum: ['correct', 'change'], description: 'correct 更正原记录（缺省）；change 表示现实从某日改变，保留历史有效期。' },
      effectiveFrom: { type: 'string', description: 'change 时必填，按原事实日/月精度。' },
      mode: { type: 'string', enum: ['apply_if_authorized', 'propose'], description: '普通用户编辑（包括需要你起草或润色的AI改写）使用 apply_if_authorized（缺省）：宿主核对后，必要时会展示完整修改并等待用户一次确认，再保存。不要仅因AI起草而选propose，也不要在对话中另问一遍确认。只有用户明确要求“先看方案/只预览/暂不保存”时才用propose；它只返回预览文字，不发起审批也不保存。' }, reason: { type: 'string' },
    }, required: ['reason'], additionalProperties: false },
    async execute(input: Record<string, unknown>, context?: ToolContext) {
      try {
        const result = await editCognition(host.userId, { ...host, signal: context?.signal ?? host.signal,
          onCommitStarted: context?.beginAtomicCommit ?? host.onCommitStarted }, input as unknown as CognitionEditInput);
        return { content: JSON.stringify(result), ...(result.status === 'blocked' ? { isError: true } : {}) };
      } catch (error) { return { content: `edit_cognition: ${error instanceof Error ? error.message : '修改失败'}`, isError: true }; }
    },
  }];
}
