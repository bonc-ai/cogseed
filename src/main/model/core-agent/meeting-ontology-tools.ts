/**
 * Meeting ontology tools for in-process core-agent turns.
 *
 * An Agent's first hand-off runs in the CogSeed Runtime worker, but its
 * follow-up replies (form submissions, confirmations) run in-process here.
 * Both surfaces expose the same `ontology_graph_read` / `ontology_projection_apply`
 * and delegate to `features/meeting_ontology_projection`, so a workflow step
 * behaves the same whichever path executes it.
 *
 * Scope: the record file must sit inside the conversation's visible roots
 * (workspace + attachment dir + extra / read-only extra roots), checked through
 * `util/path-sandbox` by the shared feature.
 */

import type { AgentTool, ToolContext } from '#core-agent';
import { getWorkspacePath } from '../../features/user_workspace';
import { runMeetingOntologyTool } from '../../features/meeting_ontology_projection';
import { createLogger } from '../../logger';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { logErrorRef, maskId } from '../../util/log-redact';

const log = createLogger('meeting-ontology-tools');

export interface MeetingOntologyToolsOpts {
  userId: string;
  projectId?: string;
  cid?: string;
  extraRoots?: readonly string[];
  readOnlyExtraRoots?: readonly string[];
}

function visibleRoots(opts: MeetingOntologyToolsOpts): string[] {
  const roots: string[] = [];
  try {
    const workspace = getWorkspacePath(opts.userId, opts.projectId);
    if (workspace) roots.push(workspace);
  } catch (error) {
    log.warn('resolve workspace failed', { user_id: maskId(opts.userId), error: logErrorRef(error) });
  }
  if (opts.cid) {
    try { roots.push(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
    catch (error) { log.warn('resolve attachment dir failed', { user_id: maskId(opts.userId), cid: maskId(opts.cid), error: logErrorRef(error) }); }
  }
  for (const root of [...(opts.extraRoots ?? []), ...(opts.readOnlyExtraRoots ?? [])]) if (root) roots.push(root);
  return roots;
}

export function createMeetingOntologyTools(opts: MeetingOntologyToolsOpts): AgentTool[] {
  const scopeFor = (ctx: ToolContext) => ({
    userId: opts.userId,
    roots: visibleRoots(opts),
    ...(ctx?.workingDir ? { workingDir: ctx.workingDir } : {}),
  });
  return [
    {
      name: 'ontology_graph_read',
      executionMode: 'parallel',
      description: '只读查询用户的本体图谱：按关键词、领域或分类名分页列出实体（分类名同时匹配其子分类，如“人物”含“团队成员”），或给 entity_id 返回该实体及其一跳邻居与关系。返回实体 id 供会议记录关联使用；不创建、修改或删除任何内容。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200 },
          category: { type: 'string', maxLength: 80, description: '准确的分类名；其子分类下的实体也会匹配。' },
          domain: { type: 'string', enum: ['affairs', 'resources', 'concepts'] },
          entity_id: { type: 'string', maxLength: 64, description: '给出时返回该实体及一跳邻居，而不是分页列表。' },
          include_archived: { type: 'boolean' },
          offset: { type: 'integer', minimum: 0, maximum: 10_000 },
        },
        additionalProperties: false,
      },
      async execute(input: Record<string, unknown>, ctx: ToolContext) {
        return runMeetingOntologyTool('ontology_graph_read', input || {}, scopeFor(ctx));
      },
    },
    {
      name: 'ontology_projection_apply',
      executionMode: 'sequential',
      description: '把工作区中一份已确认的会议记录（meeting_record.v1 JSON 文件）投影到本体图谱：创建或更新会议、决议、未决问题、行动项实体及固定关系。可重复执行；从不删除；只按记录中给出的实体 id 关联人物、项目和系列。',
      inputSchema: {
        type: 'object',
        properties: { record_path: { type: 'string', description: '会议记录 JSON 的绝对路径，或相对当前工作目录的路径。' } },
        required: ['record_path'],
        additionalProperties: false,
      },
      async execute(input: Record<string, unknown>, ctx: ToolContext) {
        return runMeetingOntologyTool('ontology_projection_apply', input || {}, scopeFor(ctx));
      },
    },
  ];
}
