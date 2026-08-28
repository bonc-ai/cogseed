/**
 * Personal Ontology 只读工具。
 *
 *   - `personal_ontology_fields` — 列出已安装角色模板的可写入字段落点。
 *
 * 为什么需要它：`personal-ontology-candidate-builder` 技能原本用 bash 直接
 * cat `groups.md`、自己 parse `- 模板: <id>@<ver>` 行、再读 `<template_id>.md`
 * 才能拿到「有哪些坑可填」。那条路让一个 LLM 技能依赖 PO 的目录布局、文件名
 * 约定和值行格式，PO 改存储就会静默失效。这个工具把同一份信息经 contract 给出。
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
import { logErrorRef, maskId } from '../../util/log-redact';

const log = createLogger('personal-ontology-tools');

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

/** Read-only Personal Ontology tools (currently one). No localExec needed. */
export function createPersonalOntologyTools(opts: PersonalOntologyToolsOpts): AgentTool[] {
  return [createPersonalOntologyFieldsTool(opts)];
}
