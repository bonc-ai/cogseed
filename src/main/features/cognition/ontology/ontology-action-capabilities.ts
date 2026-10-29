/** Explicit effect coverage. Unknown tools never acquire a read-only exemption. */
import path from 'node:path';
import { TOOL_CATALOG } from '../../../model/core-agent/tool-catalog';

const readOnly = new Set([
  'read_file', 'stat_file', 'ocr_file', 'list_files', 'search_files', 'grep_files', 'tool_result_search', 'tool_result_read_chunk',
  'web_search', 'web_fetch', 'kb_list', 'kb_search', 'kb_read', 'material_search', 'material_list', 'ask_materials', 'research_rerank',
  'personal_ontology_fields', 'search_ability_assets', 'ontology_query', 'personal_fields_check', 'transcript_corrections_query',
  'cognition_ontology_query', 'list_task_experiences', 'read_task_experience', 'list_ability_assets', 'read_ability_asset',
  'list_asset_change_proposals', 'chat_search', 'chat_read', 'list_connector_tools', 'expense_configuration_status', 'expense_case_status',
  'messaging_list_targets', 'p3394_peers', 'p3394_sessions', 'touchpoint_list', 'briefing_get', 'office_read', 'interactive_cli_read',
  'interactive_cli_close', 'cross_session_memory', 'load_skill', 'skill_read', 'cogseed_tasks', 'browser_snapshot', 'browser_open',
]);
const fileWrites = new Set(['write_file', 'edit_file', 'markdown_to_pdf', 'html_to_pdf', 'create_docx', 'create_xlsx', 'create_pptx',
  'edit_office', 'office_render', 'create_artifact', 'generate_image']);
const delegated = new Set(['bash', 'interactive_cli_start', 'interactive_cli_send', 'run_skill', 'skill_run', 'p3394_send']);
const unknownEffects = ['write_file', 'edit_file', 'delete_file', 'send_message', 'send_file', 'connector_write', 'execute_shell', 'run_skill'];
export interface OntologyActionCapability {
  toolName: string; coverage: 'read_only' | 'final_markdown_adapter' | 'unverified_effect'; operationKinds: string[];
}

export function ontologyActionCapability(toolName: string, input: Record<string, unknown>, options: { finalMarkdownAdapter?: boolean; trustedImplementation?: boolean } = {}): OntologyActionCapability {
  if (options.trustedImplementation === false) return { toolName, coverage: 'unverified_effect', operationKinds: [...unknownEffects, toolName] };
  if (readOnly.has(toolName)) return { toolName, coverage: 'read_only', operationKinds: [] };
  if (['write_file', 'edit_file'].includes(toolName)) {
    const target = typeof input.path === 'string' ? input.path : typeof input.file_path === 'string' ? input.file_path : '';
    if (options.finalMarkdownAdapter && ['.md', '.markdown'].includes(path.extname(target).toLowerCase()))
      return { toolName, coverage: 'final_markdown_adapter', operationKinds: [toolName] };
  }
  let operationKinds: string[];
  if (fileWrites.has(toolName)) operationKinds = ['write_file', 'edit_file', toolName];
  else if (delegated.has(toolName)) operationKinds = [...unknownEffects, toolName];
  else if (toolName === 'delete_file') operationKinds = ['delete_file'];
  else if (['messaging_send', 'messaging_send_file'].includes(toolName)) operationKinds = [toolName, toolName === 'messaging_send' ? 'send_message' : 'send_file'];
  else if (['call_connector_tool', 'add_custom_connector'].includes(toolName)) operationKinds = [...unknownEffects, toolName];
  else if (toolName === 'publish_outputs') operationKinds = ['publish_outputs', 'publish_file'];
  else if (toolName === 'project_instructions') operationKinds = ['write_file', 'edit_file', 'project_instructions'];
  else {
    const entry = TOOL_CATALOG.find(tool => tool.name === toolName);
    // A newly registered filesystem/document/delegated tool is not exempt just
    // because the catalog knows its name. Unadapted writers still encounter
    // the same bound file/send conditions as the established dispatch routes.
    operationKinds = entry && !['fs', 'shell', 'pdf', 'office', 'web', 'connector', 'image', 'p3394', 'expense', 'messaging'].includes(entry.group)
      ? [toolName] : [...unknownEffects, toolName];
  }
  return { toolName, coverage: 'unverified_effect', operationKinds: [...new Set(operationKinds)] };
}

export const ontologyActionCoverage = () => TOOL_CATALOG.map(tool => ontologyActionCapability(tool.name, {}));
