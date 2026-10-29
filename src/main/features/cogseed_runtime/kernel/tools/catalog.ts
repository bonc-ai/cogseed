import { TRANSCRIPT_TOOL_DEFINITIONS, type TranscriptToolName } from '../../../transcript-tool-contract';
import { MEETING_RECORD_TEMPLATE } from '../../../meeting-record-contract';
import type { RuntimeModelToolDefinition } from '../model-adapter';
import type { RuntimeToolPolicy } from '../types';

export type RuntimeToolName = TranscriptToolName | 'stat_file' | 'read_file' | 'search_files' | 'grep_files' | 'write_file' | 'edit_file' | 'bash' | 'run_skill' | 'list_connector_tools' | 'call_connector_tool' | 'search_mate_kb' | 'read_mate_kb' | 'office_read' | 'office_create' | 'office_edit' | 'office_render' | 'browser_open' | 'browser_snapshot' | 'browser_click' | 'browser_type' | 'browser_screenshot' | 'cogseed_delegate' | 'cogseed_join' | 'cogseed_tasks' | 'publish_outputs' | 'cogseed_cancel' | 'cogseed_retry_step' | 'cogseed_skip_step' | 'cogseed_resume_workflow' | 'cogseed_workflow' | 'messaging_list_targets' | 'messaging_send' | 'p3394_send' | 'ontology_graph_read' | 'ontology_projection_apply';

export interface RuntimeToolCatalogEntry {
  name: RuntimeToolName;
  summary: string;
  kind: 'file' | 'shell' | 'skill' | 'host';
  parameters: RuntimeModelToolDefinition['parameters'];
}

export const TOOL_CATALOG = Object.freeze<readonly RuntimeToolCatalogEntry[]>([
  ...TRANSCRIPT_TOOL_DEFINITIONS.map((tool) => ({ name: tool.name, summary: tool.description, kind: 'host' as const, parameters: tool.inputSchema })),
  {
    name: 'stat_file',
    summary: 'Inspect a visible file and return metadata plus total character count without reading a slice.',
    kind: 'file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'read_file',
    summary: 'Read a visible file or character slice from an explicit runtime root.',
    kind: 'file',
    parameters: { type: 'object', properties: { path: { type: 'string' }, charStart: { type: 'integer', minimum: 0 }, charEnd: { type: 'integer', minimum: 0 } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'search_files',
    summary: 'Find visible files by substring or glob without reading their contents.',
    kind: 'file',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'grep_files',
    summary: 'Search visible file contents for a substring or regex and return bounded matches.',
    kind: 'file',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        regex: { type: 'boolean' },
        glob: { type: 'string' },
        output_mode: { type: 'string', enum: ['content', 'files', 'count'] },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    summary: 'Write UTF-8 text under an explicit writable Runtime root.',
    kind: 'file',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
  },
  {
    name: 'edit_file',
    summary: 'Replace exact UTF-8 text in a file under an explicit writable Runtime root.',
    kind: 'file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'bash',
    summary: 'Execute a low-risk host shell command under an explicit Runtime root.',
    kind: 'shell',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1 }, working_dir: { type: 'string' } }, required: ['command'], additionalProperties: false },
  },
  {
    name: 'run_skill',
    summary: 'Run an allowlisted skill script through bin/run-skill.cjs.',
    kind: 'skill',
    parameters: { type: 'object', properties: { skill_id: { type: 'string' }, script: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, agent_id: { type: 'string' } }, required: ['skill_id', 'script'], additionalProperties: false },
  },
  {
    name: 'list_connector_tools',
    summary: 'List tools exposed by the user-enabled CogSeed connectors.',
    kind: 'skill',
    parameters: { type: 'object', properties: { connector_id: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'call_connector_tool',
    summary: 'Call one user-enabled CogSeed connector tool by connector id and tool name.',
    kind: 'skill',
    parameters: { type: 'object', properties: { connector_id: { type: 'string' }, tool_name: { type: 'string' }, arguments: { type: 'object' } }, required: ['connector_id', 'tool_name', 'arguments'], additionalProperties: false },
  },
  {
    name: 'search_mate_kb',
    summary: 'Search the user-owned CogSeed knowledge base.',
    kind: 'file',
    parameters: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'read_mate_kb',
    summary: 'Read one user-owned CogSeed knowledge base source.',
    kind: 'file',
    parameters: { type: 'object', properties: { source_id: { type: 'string' } }, required: ['source_id'], additionalProperties: false },
  },
  {
    name: 'office_read', summary: 'Read the structure of a scoped Word, Excel, or PowerPoint file.', kind: 'host',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'office_create', summary: 'Create a scoped Word, Excel, or PowerPoint file with validated Office batch operations.', kind: 'host',
    parameters: { type: 'object', properties: { path: { type: 'string' }, operations: { type: 'array', items: { type: 'object' } }, preview: { type: 'boolean' } }, required: ['path', 'operations'], additionalProperties: false },
  },
  {
    name: 'office_edit', summary: 'Edit a scoped Word, Excel, or PowerPoint file after inspecting it with office_read.', kind: 'host',
    parameters: { type: 'object', properties: { path: { type: 'string' }, operations: { type: 'array', items: { type: 'object' } }, preview: { type: 'boolean' } }, required: ['path', 'operations'], additionalProperties: false },
  },
  {
    name: 'office_render', summary: 'Render one page or slide of a scoped Office file.', kind: 'host',
    parameters: { type: 'object', properties: { path: { type: 'string' }, page: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false },
  },
  { name: 'browser_open', summary: 'Open a public HTTP or HTTPS page in the isolated CogSeed browser.', kind: 'host', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
  { name: 'browser_snapshot', summary: 'Read bounded visible page text and numeric interactive element references.', kind: 'host', parameters: { type: 'object', properties: { maxChars: { type: 'integer', minimum: 1, maximum: 50000 } }, additionalProperties: false } },
  { name: 'browser_click', summary: 'Click one numeric element reference from the latest browser snapshot.', kind: 'host', parameters: { type: 'object', properties: { ref: { type: 'integer', minimum: 1 } }, required: ['ref'], additionalProperties: false } },
  { name: 'browser_type', summary: 'Type bounded text into one numeric input reference from the latest browser snapshot.', kind: 'host', parameters: { type: 'object', properties: { ref: { type: 'integer', minimum: 1 }, text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['ref', 'text'], additionalProperties: false } },
  { name: 'browser_screenshot', summary: 'Capture the current isolated browser page to a scoped writable path.', kind: 'host', parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'cogseed_delegate', summary: 'Start ONE bounded child task from a self-contained brief and return its handle immediately. The child sees only that brief, never this conversation: include the goal, the exact inputs and paths, and the expected deliverable. Follow with cogseed_join to await results; never poll.', kind: 'host', parameters: { type: 'object', properties: { task: { type: 'string' }, role: { type: 'string' }, context: { type: 'array' } }, required: ['task'], additionalProperties: false } },
  { name: 'publish_outputs', summary: 'Declare the complete set of final deliverables written in this Agent session. The host verifies every path against this session’s write records, registers the files for knowledge-base precipitation, and returns per-file added/skipped/failed/not_written status. Call it once after all files are written; a later call replaces the earlier declaration.', kind: 'host', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Absolute paths, or paths relative to the working directory, of every user-facing deliverable. Empty means no file deliverable.' } }, required: ['paths'], additionalProperties: false } },
  { name: 'cogseed_join', summary: 'Wait inside the host until delegated child tasks settle (default 120s, max 600s) and return each child status, error code, final result summary and written files, plus a validated structured result (status/summary/files/open_questions) when the child followed the contract, or structuredError when it omitted or malformed it. Prefer this over repeated cogseed_tasks polling.', kind: 'host', parameters: { type: 'object', properties: { task_ids: { type: 'array', items: { type: 'string' }, description: 'Child task ids to join. Omit to join every child in this coordination.' }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 } }, additionalProperties: false } },
  { name: 'cogseed_tasks', summary: 'Read a point-in-time status and latest result summary for child tasks without waiting. Use cogseed_join when you need the finished result.', kind: 'host', parameters: { type: 'object', properties: { task_ids: { type: 'array', items: { type: 'string' } } }, required: ['task_ids'], additionalProperties: false } },
  { name: 'cogseed_cancel', summary: 'Cancel one child task in the current CogSeed coordination.', kind: 'host', parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false } },
  { name: 'cogseed_retry_step', summary: 'Retry and dispatch one failed or blocked CogSeed workflow step.', kind: 'host', parameters: { type: 'object', properties: { step_id: { type: 'string' } }, required: ['step_id'], additionalProperties: false } },
  { name: 'cogseed_skip_step', summary: 'Skip one unfinished CogSeed workflow step with an auditable reason.', kind: 'host', parameters: { type: 'object', properties: { step_id: { type: 'string' }, reason: { type: 'string' } }, required: ['step_id'], additionalProperties: false } },
  { name: 'cogseed_resume_workflow', summary: 'Resume a blocked or failed CogSeed workflow and reconcile blockers.', kind: 'host', parameters: { type: 'object', properties: { reason: { type: 'string' } }, additionalProperties: false } },
  { name: 'cogseed_workflow', summary: 'Read the current CogSeed workflow run and step statuses.', kind: 'host', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'messaging_list_targets', summary: 'List configured Feishu/Lark bots and which can proactively message the configured owner (self); read-only sanitized diagnostics.', kind: 'host', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'messaging_send', summary: 'Send a text message to the configured owner (self) through an explicit or default-routed Feishu/Lark bot, after the user approves a confirmation dialog.', kind: 'host', parameters: { type: 'object', properties: { instance_id: { type: 'string', description: 'Optional bot instance id. Omit it to use the configured default delivery bot.' }, target: { type: 'string', const: 'self' }, text: { type: 'string', minLength: 1, maxLength: 12000 } }, required: ['target', 'text'], additionalProperties: false } },
  { name: 'p3394_send', summary: 'Send a P3394 task to a registered peer Agent (e.g. hermes) and wait for its reply — agent-to-agent collaboration.', kind: 'host', parameters: { type: 'object', properties: { peer: { type: 'string', description: 'Registered peer agent id (e.g. hermes).' }, message: { type: 'string', minLength: 1, maxLength: 20000 } }, required: ['peer', 'message'], additionalProperties: false } },
  {
    name: 'ontology_graph_read',
    summary: "Read the user's ontology graph: a page of entities filtered by keyword, domain or category name (matches any ancestor category, e.g. 人物), or one entity with its one-hop neighbours and relations. Read-only; returns entity ids for linking.",
    kind: 'host',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200 },
        category: { type: 'string', maxLength: 80, description: 'Exact category name; entities in its descendant categories match too.' },
        domain: { type: 'string', enum: ['affairs', 'resources', 'concepts'] },
        entity_id: { type: 'string', maxLength: 64, description: 'Return this entity with its one-hop neighbours instead of a page.' },
        include_archived: { type: 'boolean' },
        offset: { type: 'integer', minimum: 0, maximum: 10000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ontology_projection_apply',
    summary: `Project one confirmed meeting record (meeting_record.v1 JSON file in the task workspace) into the ontology graph: creates or updates the meeting, decision, open-question and action-item entities and their fixed relations. Idempotent; never deletes; links people, projects and series only by entity ids named in the record. Write the record with write_file in exactly this shape (keys N1/D1/Q1/A1, enums as listed, omit unknown optionals): ${MEETING_RECORD_TEMPLATE}`,
    kind: 'host',
    parameters: { type: 'object', properties: { record_path: { type: 'string' } }, required: ['record_path'], additionalProperties: false },
  },
]);

export function getRuntimeToolCatalog(): readonly RuntimeToolCatalogEntry[] {
  return TOOL_CATALOG;
}

/** Capability that unlocks the Commander-only proactive messaging tools. */
export const MESSAGING_PROACTIVE_CAPABILITY = 'messaging.proactive';

/** Capability that unlocks the P3394 agent-interop outbound tool. */
export const P3394_INTEROP_CAPABILITY = 'p3394.interop';

/** 只有真正挂在一个协作 workflow 上的任务才拿得到：没有 workflow 时
 *  cogseed_workflow / retry_step / skip_step / resume_workflow 必然报
 *  “CogSeed workflow not found”，暴露出去只会让模型撞墙（真机复现）。 */
export const COGSEED_WORKFLOW_CAPABILITY = 'cogseed.workflow';

/** 委派是父任务的权力：子 Agent 拿到这组工具会形成无界 fan-out，而且它没有
 *  结果回传通道（子任务的交付物只能经父任务 join 取回）。 */
export const COGSEED_COORDINATION_CAPABILITY = 'cogseed.coordination';

const CAPABILITY_GATED_TOOLS: ReadonlyMap<RuntimeToolName, string> = new Map([
  ['messaging_list_targets', MESSAGING_PROACTIVE_CAPABILITY],
  ['messaging_send', MESSAGING_PROACTIVE_CAPABILITY],
  ['p3394_send', P3394_INTEROP_CAPABILITY],
  ['cogseed_workflow', COGSEED_WORKFLOW_CAPABILITY],
  ['cogseed_retry_step', COGSEED_WORKFLOW_CAPABILITY],
  ['cogseed_skip_step', COGSEED_WORKFLOW_CAPABILITY],
  ['cogseed_resume_workflow', COGSEED_WORKFLOW_CAPABILITY],
  ['cogseed_delegate', COGSEED_COORDINATION_CAPABILITY],
  ['cogseed_join', COGSEED_COORDINATION_CAPABILITY],
  ['cogseed_tasks', COGSEED_COORDINATION_CAPABILITY],
  ['cogseed_cancel', COGSEED_COORDINATION_CAPABILITY],
]);

/**
 * Per-run catalog slice. Tools gated by a capability are visible only when the
 * main-process-derived capability list grants them; everything else stays
 * unconditional. The model never sees gated tools without the grant, and the
 * runner rejects direct calls to them by the same filter.
 */
export function filterRuntimeToolCatalogByCapabilities(
  catalog: readonly RuntimeToolCatalogEntry[],
  capabilities: readonly string[] | undefined,
): readonly RuntimeToolCatalogEntry[] {
  const granted = new Set(capabilities ?? []);
  return catalog.filter((entry) => {
    const required = CAPABILITY_GATED_TOOLS.get(entry.name);
    return !required || granted.has(required);
  });
}

/**
 * Per-run catalog slice, second half: the目录必须与本次运行的有效策略一致。
 * 策略为 `none` 的能力，其工具一律不进目录 —— 模型看不到就不会去调用一个必然
 * 被 `E_RUNTIME_PERMISSION_DENIED` 拒绝的工具。真机复现：进程内 Task Agent 在
 * 目录里看到 `bash` 就去调用，整轮以 `runtime_tool_error` 收场，UI 只给一句
 * 「智能体未能完成本次回复，请重试」，而重试只会再次撞同一面墙。
 *
 * 注意：这里只收紧可见性，不放宽任何权限——要真正放开某项能力，得先在
 * Runtime 请求里由主进程推导出对应策略（见 kernel/config.ts 的 policy）。
 */
export function filterRuntimeToolCatalogByPolicy(
  catalog: readonly RuntimeToolCatalogEntry[],
  policy: RuntimeToolPolicy,
): readonly RuntimeToolCatalogEntry[] {
  return catalog.filter((entry) => {
    switch (entry.name) {
      case 'bash':
        return policy.shell !== 'none';
      case 'write_file':
      case 'edit_file':
      case 'publish_outputs':
        return policy.fileWrite !== 'none';
      case 'run_skill':
        return policy.skillRun !== 'none';
      case 'stat_file':
      case 'read_file':
      case 'search_files':
      case 'grep_files':
        return policy.fileRead !== 'none';
      default:
        return true;
    }
  });
}

export function isRuntimeToolName(name: string): name is RuntimeToolName {
  return TOOL_CATALOG.some((entry) => entry.name === name);
}


export function getRuntimeOpenAIToolCatalog(
  catalog: readonly RuntimeToolCatalogEntry[] = TOOL_CATALOG,
): RuntimeModelToolDefinition[] {
  return catalog.map((entry) => ({
    name: entry.name,
    description: entry.summary,
    parameters: entry.parameters,
  }));
}
