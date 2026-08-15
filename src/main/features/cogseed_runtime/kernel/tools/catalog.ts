import type { RuntimeModelToolDefinition } from '../model-adapter';

export type RuntimeToolName = 'stat_file' | 'read_file' | 'search_files' | 'grep_files' | 'write_file' | 'edit_file' | 'bash' | 'run_skill' | 'list_connector_tools' | 'call_connector_tool' | 'search_mate_kb' | 'read_mate_kb' | 'office_read' | 'office_create' | 'office_edit' | 'office_render' | 'browser_open' | 'browser_snapshot' | 'browser_click' | 'browser_type' | 'browser_screenshot' | 'mate_delegate' | 'mate_tasks' | 'mate_cancel' | 'mate_retry_step' | 'mate_skip_step' | 'mate_resume_workflow' | 'mate_workflow' | 'messaging_list_targets' | 'messaging_send';

export interface RuntimeToolCatalogEntry {
  name: RuntimeToolName;
  summary: string;
  kind: 'file' | 'shell' | 'skill' | 'host';
  parameters: RuntimeModelToolDefinition['parameters'];
}

export const TOOL_CATALOG = Object.freeze<readonly RuntimeToolCatalogEntry[]>([
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
  { name: 'mate_delegate', summary: 'Delegate an explicit bounded subtask to one child CogSeed task.', kind: 'host', parameters: { type: 'object', properties: { task: { type: 'string' }, role: { type: 'string' }, context: { type: 'array' } }, required: ['task'], additionalProperties: false } },
  { name: 'mate_tasks', summary: 'Read status summaries for child tasks in the current CogSeed coordination.', kind: 'host', parameters: { type: 'object', properties: { task_ids: { type: 'array', items: { type: 'string' } } }, required: ['task_ids'], additionalProperties: false } },
  { name: 'mate_cancel', summary: 'Cancel one child task in the current CogSeed coordination.', kind: 'host', parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false } },
  { name: 'mate_retry_step', summary: 'Retry and dispatch one failed or blocked CogSeed workflow step.', kind: 'host', parameters: { type: 'object', properties: { step_id: { type: 'string' } }, required: ['step_id'], additionalProperties: false } },
  { name: 'mate_skip_step', summary: 'Skip one unfinished CogSeed workflow step with an auditable reason.', kind: 'host', parameters: { type: 'object', properties: { step_id: { type: 'string' }, reason: { type: 'string' } }, required: ['step_id'], additionalProperties: false } },
  { name: 'mate_resume_workflow', summary: 'Resume a blocked or failed CogSeed workflow and reconcile blockers.', kind: 'host', parameters: { type: 'object', properties: { reason: { type: 'string' } }, additionalProperties: false } },
  { name: 'mate_workflow', summary: 'Read the current CogSeed workflow run and step statuses.', kind: 'host', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'messaging_list_targets', summary: 'List configured Feishu/Lark bots and which can proactively message the configured owner (self); read-only sanitized diagnostics.', kind: 'host', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'messaging_send', summary: 'Send a text message to the configured owner (self) through an explicit or default-routed Feishu/Lark bot, after the user approves a confirmation dialog.', kind: 'host', parameters: { type: 'object', properties: { instance_id: { type: 'string', description: 'Optional bot instance id. Omit it to use the configured default delivery bot.' }, target: { type: 'string', const: 'self' }, text: { type: 'string', minLength: 1, maxLength: 12000 } }, required: ['target', 'text'], additionalProperties: false } },
]);

export function getRuntimeToolCatalog(): readonly RuntimeToolCatalogEntry[] {
  return TOOL_CATALOG;
}

/** Capability that unlocks the Commander-only proactive messaging tools. */
export const MESSAGING_PROACTIVE_CAPABILITY = 'messaging.proactive';

const CAPABILITY_GATED_TOOLS: ReadonlySet<RuntimeToolName> = new Set([
  'messaging_list_targets',
  'messaging_send',
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
  return catalog.filter((entry) => (
    !CAPABILITY_GATED_TOOLS.has(entry.name) || granted.has(MESSAGING_PROACTIVE_CAPABILITY)
  ));
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
