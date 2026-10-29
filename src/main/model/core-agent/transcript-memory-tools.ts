/** Read existing scoped correction pairs and canonical ontology names. */
import type { AgentTool } from '#core-agent';
import { loadGlossary } from '../../features/transcript_glossary';
import { readOntologyDocument } from '../../features/cognition/ontology/service';
import { ontologyModuleVisibleToTask } from '../../features/cognition/ontology/query';
import type { ResolvePersonalFieldsRequest } from '../../features/cognition_kernel/types';
import { OntologyError } from '../../features/cognition/ontology/model';
import { cognitionQueryFailure, queryModuleId } from './cognition-query-error';

export function createTranscriptMemoryTools(options: { userId: string; cid?: string; context?: ResolvePersonalFieldsRequest['context'] }): AgentTool[] {
  if (!options.cid) return [];
  const tools: AgentTool[] = [{ name: 'transcript_corrections_query', executionMode: 'parallel',
    description: '修正会议转写前读取已确认的纠错对和本体规范名称。只有本体名称时，先用 cognition_ontology_query(query=名称) 取得正式 moduleId，不猜ID或把名称填入moduleId。省略moduleId仍可读当前会话纠错。仅返回已确认的适用资料，未知/推断实体不作规范名称。结果只提供依据，不代表已改写文件；失败按错误指引处理，不能当作不存在而转去创建。',
    inputSchema: { type: 'object', properties: { moduleId: { type: 'string', maxLength: 160,
      description: '可选。此前 cognition_ontology_query 返回的正式模块 ID，不是显示名称；只有名称时先按 query 查询。' } }, additionalProperties: false },
    async execute(input) {
      try {
        const moduleId = queryModuleId(input.moduleId);
        const ontology = readOntologyDocument(options.userId), module = moduleId ? ontology.records[moduleId] : null;
        if (moduleId && (!module || module.kind !== 'module' || module.status !== 'active' || !ontologyModuleVisibleToTask(module, options.context)))
          throw new OntologyError('not_authorized', 'module outside task scope');
        const entries = loadGlossary(options.userId).entries.filter(entry => {
          if (entry.ontologyRef) { const linked = ontology.records[entry.ontologyRef.fieldId]; if (!linked || linked.kind !== 'entity' || linked.access !== 'task' || linked.status !== 'active' || linked.identityStatus !== 'confirmed' || linked.certainty && linked.certainty !== 'confirmed' || linked.name !== entry.correct && !linked.aliases.includes(entry.correct)) return false; }
          return entry.status === 'active' && (entry.scope.global || entry.scope.docIds.includes(`chat:${options.cid}`) || module && entry.scope.scenarioTags.includes(`ontology:${module.id}`)); });
        const canonicalNames = Object.values(ontology.records).filter(record => record.kind === 'entity' && record.moduleId === module?.id && record.access === 'task' && record.status === 'active' && record.identityStatus === 'confirmed' && (!record.certainty || record.certainty === 'confirmed')).map(record => ({ id: record.id, name: record.kind === 'entity' ? record.name : '', aliases: record.kind === 'entity' ? record.aliases : [], version: record.version }));
        return { content: JSON.stringify({ entries, canonicalNames, policy: 'Confirmed evidence only; do not infer speaker identities or extend correction scope.' }) };
      } catch (error) { return cognitionQueryFailure('transcript_corrections_query', error, options.userId); }
    },
  }];
  return tools;
}
