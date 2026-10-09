/**
 * Explicit Core Agent → CogSeed Runtime tool contract.
 *
 * This is intentionally separate from both catalogs: Core owns the historical
 * public tool names, while CogSeed owns the executable Runtime catalog. The matrix
 * makes every compatibility decision reviewable and gives anti-drift tests one
 * place to prove that a Runtime tool is either mapped or explicitly CogSeed-native.
 */

export type CoreToCogSeedToolCategory =
  | 'parity'
  | 'cogseed-native-replacement'
  | 'deferred';

export interface CoreToCogSeedToolMapping {
  /** Exact Core Agent catalog name. */
  coreName: string;
  /** Compatibility decision for the Core name. */
  category: CoreToCogSeedToolCategory;
  /** Executable CogSeed Runtime names, empty for deferred tools. */
  cogseedNames: readonly string[];
  /** Short rationale, including the safety boundary for deferred tools. */
  reason: string;
}

const parity = (coreName: string, reason: string): CoreToCogSeedToolMapping => ({
  coreName,
  category: 'parity',
  cogseedNames: [coreName],
  reason,
});

const replacement = (coreName: string, cogseedNames: readonly string[], reason: string): CoreToCogSeedToolMapping => ({
  coreName,
  category: 'cogseed-native-replacement',
  cogseedNames,
  reason,
});

const deferred = (coreName: string, reason: string): CoreToCogSeedToolMapping => ({
  coreName,
  category: 'deferred',
  cogseedNames: [],
  reason,
});

export const CORE_TO_MATE_TOOL_MAPPINGS: readonly CoreToCogSeedToolMapping[] = Object.freeze([
  parity('read_file', 'Same explicit-root file read semantics, with transcript exclusion and capped Runtime results.'),
  parity('write_file', 'Same explicit writable-root write semantics, with path sandboxing and capped Runtime results.'),
  parity('edit_file', 'Same explicit writable-root exact replacement semantics, with stale/ambiguous replacement errors.'),
  deferred('delete_file', 'Deferred until a dedicated Runtime delete capability exists with confirmation and path-sandbox tests.'),
  deferred('list_files', 'Deferred because the Runtime currently exposes bounded search_files, not a directory-tree listing capability.'),
  parity('stat_file', 'Same explicit-root metadata inspection semantics; no file contents are exposed.'),
  deferred('ocr_file', 'Deferred because image OCR is not available through the current Runtime file-tool choke point.'),
  parity('search_files', 'Same explicit-root bounded filename/path search semantics.'),
  parity('grep_files', 'Same explicit-root bounded content search semantics with regex, glob, and output modes.'),
  deferred('tool_result_search', 'Deferred until Runtime exposes a bounded opaque-reference result reader; persisted outputs remain local-only.'),
  deferred('tool_result_read_chunk', 'Deferred until Runtime exposes bounded opaque-reference chunk reads without arbitrary path access.'),
  deferred('publish_outputs', 'Deferred until CogSeed output registration and renderer-safe publication semantics are available.'),
  deferred('create_artifact', 'Deferred until the validated chat-artifact resolver and artifact lifecycle are wired to Runtime.'),
  parity('bash', 'Same low-risk shell policy and explicit working-root boundary through Runtime shell-tools.ts.'),
  deferred('interactive_cli_start', 'Deferred because interactive CLI spawning is restricted to the local-agent runner choke point.'),
  deferred('interactive_cli_read', 'Deferred because interactive CLI session state cannot cross the Runtime worker boundary safely.'),
  deferred('interactive_cli_send', 'Deferred because interactive CLI stdin is restricted to the local-agent runner choke point.'),
  deferred('interactive_cli_close', 'Deferred because interactive CLI lifecycle is restricted to the local-agent runner choke point.'),
  deferred('markdown_to_pdf', 'Deferred until a Runtime-approved PDF adapter with bounded output and platform verification exists.'),
  deferred('html_to_pdf', 'Deferred until a Runtime-approved PDF adapter with bounded output and platform verification exists.'),
  replacement('create_docx', ['office_create'], 'CogSeed uses one validated Office create host capability; the adapter selects the document format from the target path.'),
  replacement('create_xlsx', ['office_create'], 'CogSeed uses one validated Office create host capability; the adapter selects the workbook format from the target path.'),
  replacement('create_pptx', ['office_create'], 'CogSeed uses one validated Office create host capability; the adapter selects the presentation format from the target path.'),
  parity('office_read', 'Same Office read capability through the Main-side adapter and reverse host-tool protocol.'),
  replacement('edit_office', ['office_edit'], 'CogSeed uses one validated Office edit host capability with the same path and batch safety boundary.'),
  parity('office_render', 'Same Office preview capability through the Main-side adapter and reverse host-tool protocol.'),
  deferred('kb_list', 'Deferred until the CogSeed KB adapter exposes a bounded source/status listing contract.'),
  replacement('kb_search', ['search_mate_kb'], 'CogSeed-owned KB search preserves user scoping and uses the Runtime KB manager boundary.'),
  replacement('kb_read', ['read_mate_kb'], 'CogSeed-owned KB source reads preserve user scoping and use the Runtime KB manager boundary.'),
  deferred('research_rerank', 'Deferred because the owner-scoped research reranker has no approved Runtime adapter yet.'),
  deferred('chat_search', 'Deferred because Runtime requests must not access conversation transcripts or chat history.'),
  deferred('chat_read', 'Deferred because Runtime requests must not access conversation transcripts or chat history.'),
  deferred('generate_image', 'Deferred until image API credentials, artifact registration, and output cleanup are Runtime-safe.'),
  deferred('web_search', 'Deferred because the current Runtime host boundary exposes controlled Browser actions, not a web-search provider.'),
  deferred('web_fetch', 'Deferred because arbitrary URL fetching is not an approved Runtime host capability.'),
  parity('list_connector_tools', 'Preserved as the fixed connector discovery umbrella; discovered MCP actions are never flattened into Runtime tools.'),
  parity('call_connector_tool', 'Preserved as the fixed connector invocation umbrella; discovered MCP actions are never flattened into Runtime tools.'),
  deferred('add_custom_connector', 'Deferred because connector authoring/install requires the hosted confirmation and secret lifecycle.'),
  replacement('manage_execution_plan', ['cogseed_workflow', 'cogseed_retry_step', 'cogseed_skip_step', 'cogseed_resume_workflow'], 'CogSeed workflow inspection and auditable step controls replace the Core plan tool without importing the legacy state machine.'),
  deferred('cross_session_memory', 'Deferred because Runtime has no approved user-memory adapter and must not read business data directly.'),
  deferred('project_instructions', 'Deferred because project instruction mutation belongs to the project/session owner boundary.'),
  deferred('metacognition', 'Deferred because the Runtime worker has no approved metacognition storage or visibility adapter.'),
]);

/** Runtime tools that are intentionally CogSeed-native additions, not Core aliases. */
export const COGSEED_NATIVE_RUNTIME_TOOL_NAMES = Object.freeze([
  'run_skill',
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'cogseed_delegate',
  'cogseed_tasks',
  'cogseed_cancel',
] as const);

export function getExecutableCogSeedToolNames(): readonly string[] {
  return Object.freeze([
    ...new Set(
      CORE_TO_MATE_TOOL_MAPPINGS.flatMap((entry) => entry.cogseedNames),
    ),
  ]);
}

export function getCoreToCogSeedToolMapping(coreName: string): CoreToCogSeedToolMapping | undefined {
  return CORE_TO_MATE_TOOL_MAPPINGS.find((entry) => entry.coreName === coreName);
}
