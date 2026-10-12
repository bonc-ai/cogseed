/**
 * Personal Ontology 只读工具。
 *
 *   - `personal_ontology_fields` — 列出已安装角色模板的可写入字段落点。
 *   - `list_ontology_graph` — 只读检索保存的本体分类、实体、字段和关系。
 *
 * 为什么需要它：`personal-ontology-candidate-builder` 技能原本用 bash 直接
 * cat `groups.md`、自己 parse `- 模板: <id>@<ver>` 行、再读 `<template_id>.md`
 * 才能拿到「有哪些坑可填」。那条路让一个 LLM 技能依赖 PO 的目录布局、文件名
 * 约定和值行格式，PO 改存储就会静默失效。这个工具把同一份信息经 contract 给出。
 * 本体图谱也通过自己的 feature API 读取，不要求模型了解文件位置或 JSON 格式。
 *
 * 只读，无需 localExec（与 kb / recall 工具一致）。返回的 fieldRef 是 opaque
 * 句柄：技能把它填进候选的「建议字段」，确认时由 PO 解析——技能不解析、不拼接。
 */

import type { AgentTool } from '#core-agent';
import { createLogger } from '../../logger';
import {
  describeRoleTemplateFieldRef,
  listRoleTemplateFieldTargets,
} from '../../features/personal_ontology_contract';
import { readOntologyGraph, type OntologyDomain } from '../../features/ontology_graph';
import { logErrorRef, maskId } from '../../util/log-redact';

const log = createLogger('personal-ontology-tools');
const ONTOLOGY_DOMAINS = new Set<OntologyDomain>(['affairs', 'resources', 'concepts']);
const GRAPH_PAGE_SIZE = 20;

function boundedQueryText(value: unknown): string | null {
  if (value === undefined) return '';
  if (typeof value !== 'string') return null;
  const query = value.trim();
  return query.length <= 200 ? query : null;
}

function excerpt(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function createOntologyGraphListTool(opts: PersonalOntologyToolsOpts): AgentTool {
  const userId = opts.userId;
  return {
    name: 'list_ontology_graph',
    executionMode: 'parallel',
    description: '只读查询用户的本体图谱：浏览分类、实体、字段值和明确关系。可按领域或关键词筛选，返回来源引用 ID 供核对。此工具不会创建、编辑或删除本体内容。',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: ['affairs', 'resources', 'concepts'], description: '可选领域：事项、对象与资源、概念。' },
        query: { type: 'string', maxLength: 200, description: '可选关键词，匹配分类、实体、属性值、关系名称和备注。' },
        offset: { type: 'integer', minimum: 0, maximum: 10_000, description: '分页偏移；每页最多 20 个实体和 20 条关系。' },
      },
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>) {
      const domainValue = input.domain;
      if (domainValue !== undefined && (typeof domainValue !== 'string' || !ONTOLOGY_DOMAINS.has(domainValue as OntologyDomain))) {
        return { content: 'domain 只能是 affairs、resources 或 concepts。', isError: true };
      }
      const queryValue = boundedQueryText(input.query);
      if (queryValue === null) return { content: 'query 必须是 200 字以内的文本。', isError: true };
      const offset = input.offset === undefined ? 0 : Number(input.offset);
      if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
        return { content: 'offset 必须是 0 到 10000 之间的整数。', isError: true };
      }
      const domain = domainValue as OntologyDomain | undefined;
      const query = queryValue.toLocaleLowerCase();
      try {
        const graph = await readOntologyGraph(userId);
        const categoriesById = new Map(graph.categories.map((category) => [category.id, category]));
        const entities = graph.entities.filter((entity) => {
          if (domain && entity.domain !== domain) return false;
          if (!query) return true;
          const category = categoriesById.get(entity.categoryId);
          const text = [entity.name, entity.description, category?.name, ...Object.values(entity.properties)]
            .join('\n').toLocaleLowerCase();
          return text.includes(query);
        });
        const matchedEntityIds = new Set(entities.map((entity) => entity.id));
        const relations = graph.relations.filter((relation) => {
          const subjectId = relation.subject.kind === 'entity' ? relation.subject.id : undefined;
          const objectId = relation.object.kind === 'entity' ? relation.object.id : undefined;
          const endpointIds = [subjectId, objectId].filter((id): id is string => Boolean(id));
          if (domain && !endpointIds.some((id) => graph.entities.some((entity) => entity.id === id && entity.domain === domain))) return false;
          if (!query) return true;
          const subject = subjectId
            ? graph.entities.find((entity) => entity.id === subjectId)?.name || ''
            : '我';
          const object = objectId
            ? graph.entities.find((entity) => entity.id === objectId)?.name || ''
            : '我';
          return endpointIds.some((id) => matchedEntityIds.has(id))
            || [subject, relation.predicate, object, relation.note].join('\n').toLocaleLowerCase().includes(query);
        });
        const categories = graph.categories.filter((category) => {
          if (domain && category.domain !== domain) return false;
          if (!query) return true;
          return entities.some((entity) => entity.categoryId === category.id)
            || [category.name, category.description, ...category.fields.map((field) => field.name)]
              .join('\n').toLocaleLowerCase().includes(query);
        });
        const result = {
          readOnly: true,
          domain: domain || 'all',
          query,
          totals: { categories: categories.length, entities: entities.length, relations: relations.length },
          offset,
          limit: GRAPH_PAGE_SIZE,
          hasMore: {
            categories: offset + GRAPH_PAGE_SIZE < categories.length,
            entities: offset + GRAPH_PAGE_SIZE < entities.length,
            relations: offset + GRAPH_PAGE_SIZE < relations.length,
          },
          categories: categories.slice(offset, offset + GRAPH_PAGE_SIZE).map((category) => ({
            id: category.id,
            domain: category.domain,
            name: category.name,
            parentId: category.parentId || null,
            builtIn: category.builtIn,
            fields: category.fields.slice(0, 24).map((field) => ({ id: field.id, name: field.name, kind: field.kind })),
          })),
          entities: entities.slice(offset, offset + GRAPH_PAGE_SIZE).map((entity) => ({
            id: entity.id,
            domain: entity.domain,
            category: categoriesById.get(entity.categoryId)?.name || entity.categoryId,
            name: entity.name,
            description: excerpt(entity.description, 300),
            properties: Object.fromEntries(Object.entries(entity.properties).slice(0, 12).map(([key, value]) => [key, excerpt(value, 240)])),
            sourceRefs: entity.sourceRefs,
            status: entity.status,
          })),
          relations: relations.slice(offset, offset + GRAPH_PAGE_SIZE).map((relation) => {
            const subjectId = relation.subject.kind === 'entity' ? relation.subject.id : undefined;
            const objectId = relation.object.kind === 'entity' ? relation.object.id : undefined;
            return {
              id: relation.id,
              subject: subjectId
                ? { kind: 'entity', id: subjectId, name: graph.entities.find((entity) => entity.id === subjectId)?.name || '' }
                : { kind: 'self', name: '我' },
              predicate: relation.predicate,
              object: objectId
                ? { kind: 'entity', id: objectId, name: graph.entities.find((entity) => entity.id === objectId)?.name || '' }
                : { kind: 'self', name: '我' },
              note: excerpt(relation.note, 300),
              sourceRefs: relation.sourceRefs,
            };
          }),
        };
        return { content: JSON.stringify(result, null, 2) };
      } catch (error) {
        log.warn('ontology graph list failed', { userId: maskId(userId), error: logErrorRef(error as Error) });
        return { content: 'list_ontology_graph: 读取本体图谱失败', isError: true };
      }
    },
  };
}

export interface PersonalOntologyToolsOpts {
  userId: string;
}

function createPersonalOntologyFieldsTool(opts: PersonalOntologyToolsOpts): AgentTool {
  const userId = opts.userId;
  return {
    name: 'personal_ontology_fields',
    executionMode: 'parallel',
    description:
      '列出用户已安装角色模板的可填字段（个人本体的「挖空表单」）。用于把一条候选'
      + '「对号入座」到具体字段：先调用本工具拿到字段清单，再判断候选值语义与哪个'
      + '字段匹配。用户没装任何角色模板时返回空清单——此时不要猜字段名。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      let targets: Awaited<ReturnType<typeof listRoleTemplateFieldTargets>>;
      try {
        targets = await listRoleTemplateFieldTargets(userId);
      } catch (err) {
        log.warn('personal_ontology_fields list failed', {
          userId: maskId(userId),
          error: logErrorRef(err as Error),
        });
        return { content: 'personal_ontology_fields: 读取角色模板字段失败', isError: true };
      }

      if (!targets.length) {
        return { content: '用户尚未安装任何角色模板，没有可填字段。不要猜测字段名。' };
      }

      const byTemplate = new Map<string, typeof targets>();
      for (const target of targets) {
        const key = target.parentLabel || target.parentId || '';
        const bucket = byTemplate.get(key) || [];
        bucket.push(target);
        byTemplate.set(key, bucket);
      }

      const lines: string[] = [`已安装角色模板共 ${byTemplate.size} 个，可填字段 ${targets.length} 个：`, ''];
      for (const [templateLabel, rows] of byTemplate) {
        lines.push(`【${templateLabel}】`);
        for (const row of rows) {
          // 字段名/分节名在这里只作展示：候选池的「建议字段」按字段名记录
          // （candidates.md 的既有契约），定位与写入仍由 PO 在确认时完成。
          const placement = describeRoleTemplateFieldRef(row.fieldRef);
          lines.push(placement
            ? `- 字段名: ${placement.fieldName}   （分节: ${placement.section}）`
            : `- ${row.label}`);
        }
        lines.push('');
      }
      lines.push('候选与某个字段语义明确匹配时，把上面的**字段名**原样填进候选的「建议字段」；拿不准就留空。');
      return { content: lines.join('\n') };
    },
  };
}

/** Read-only Personal Ontology tools. No localExec needed. */
export function createPersonalOntologyTools(opts: PersonalOntologyToolsOpts): AgentTool[] {
  return [createPersonalOntologyFieldsTool(opts), createOntologyGraphListTool(opts)];
}
