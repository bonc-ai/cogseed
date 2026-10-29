/**
 * ToolCatalog — registry of injected built-in tools.
 *
 * Source of truth: a hand-written central constant table `TOOL_CATALOG`.
 * Historically it also rendered an "available tools" markdown block into the
 * setup-LLM prompts, but the runner no longer injects that block; the catalog
 * now backs the anti-drift test below (and any future tool-listing surface).
 * NOT derived from `AgentTool` instances — the runtime `description` on
 * each tool is a long English doc aimed at the runtime LLM, while the
 * catalog `summary` is a short blurb aimed at the setup LLM; the two
 * audiences are different. `group` / `permission` are human-judged
 * metadata and cannot be inferred from code.
 *
 * Anti-drift: `tool-catalog.test.ts` asserts that the set of tool names
 * runner.ts actually injects is a subset of `TOOL_CATALOG`. Forgetting
 * a catalog entry → test red.
 *
 * Connectors (Notion / Slack / GitHub / Gmail / …) are surfaced through two umbrella meta-
 * tools (`list_connector_tools` / `call_connector_tool`) PLUS a `## Connectors` system-prompt
 * block enumerating connector ids + descriptions. Both are injected only when ≥1 connector is
 * visible to the current actor; otherwise zero connector slots in `tools[]`. The two meta-
 * tools are static and ARE in this catalog; the per-connector MCP actions discovered at
 * runtime are NOT enumerated here (they vary per-user / per-install). See
 * `connector-meta-tools.ts` for the rationale (tool-selection accuracy cliff at 20–50 tools +
 * prompt-cache stability).
 */

import { createLogger } from '../../logger';

const log = createLogger('tool-catalog');

export type ToolGroup =
  | 'fs'         // files / workspace
  | 'shell'      // command line
  | 'pdf'        // PDF rendering
  | 'office'     // Word / Excel / PowerPoint documents
  | 'kb'         // Library
  | 'transcript' // meeting transcript correction glossary (会议转写纠错词表)
  | 'recall'     // ability assets (沉淀的认知资产)
  | 'chat'       // conversation history
  | 'image'      // image generation
  | 'web'        // web access
  | 'connector'  // third-party services via MCP umbrella tools
  | 'expense'    // reimbursement flow, scoped to the canonical expense agent
  | 'messaging'  // proactive Feishu/Lark sends (Commander-only)
  | 'p3394'      // P3394 agent-interop outbound (Commander-only)
  | 'meta';      // cross-session state

export interface ToolCatalogEntry {
  /** Tool name. Must match `AgentTool.name` exactly. */
  name: string;
  /** One-line English description aimed at the setup LLM. */
  summary: string;
  /** Render group; decides which section the entry lands in. */
  group: ToolGroup;
  /** Filled when the tool is gated by a runtime permission. Currently
   *  the only value is `localExec`. */
  permission?: 'localExec';
  /** When set, the tool is OWNED by one agent (a single id) or a fixed set of
   *  agents (a list of ids): it is injected only when the current actor's
   *  agentId is the owner / among the owners, and is invisible to every other
   *  actor (commander included). Default-deny — used for agent-specific tools
   *  that would only clutter the commander's `tools[]`. Enforced in runner.ts
   *  via `isToolVisibleToAgent`; the binding lives here so the catalog stays
   *  the single source of truth. */
  ownerAgent?: string | string[];
}

/**
 * The central constant table. **Always** append a row when adding a new
 * tool; the anti-drift test catches omissions.
 *
 * Within each group the order is "most frequently used first", kept stable
 * to keep the rendered KV-cache prefix stable.
 */
/**
 * Agent ids that share the deep-research engine, so its `research_rerank` tool
 * is visible to the platform DeepResearcher and hosted data/research agents
 * that can hand work into the research flow:
 * DeepResearcher / KnowledgeManager / SocialResearcher / BrandResearcher.
 * Referenced by opaque marketplace id (as skill_list does), not by name.
 */
export const DEEP_RESEARCH_AGENT_IDS = [
  '78900d8758bc', // DeepResearcher
  '5dd962efb425', // KnowledgeManager
  '17c0a2e95df3', // SocialResearcher
  '7083ff63b398', // BrandResearcher
];

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  // Files / workspace
  { name: 'background_list',   group: 'meta', summary: 'List CLI runs moved to the background because they hit their wall-clock or idle deadline; shows liveness and where the output goes.' },
  { name: 'background_output', group: 'meta', summary: 'Read the bounded tail of a background run output.' },
  { name: 'background_stop',   group: 'meta', summary: 'Stop a still-running background run and its child processes; output stays readable.' },
  { name: 'read_file',     group: 'fs', summary: 'Read a slice of text from a workspace or attachment file (PDF/modern Office text or image as multimodal).' },
  { name: 'write_file',    group: 'fs', permission: 'localExec', summary: 'Write text/code/markdown into the workspace; resolves under $working_dir.' },
  { name: 'edit_file',     group: 'fs', permission: 'localExec', summary: 'In-place `old_string → new_string` replacement on an existing text file (instead of rewriting the whole file).' },
  { name: 'delete_file',   group: 'fs', permission: 'localExec', summary: 'Delete a single file. Files inside the current workspace/attachment/editor scope are deleted immediately; files outside that scope use an inline confirmation card with a token, and multiple out-of-scope deletes from the same turn are grouped when possible. Use instead of `bash rm` for removals.' },
  { name: 'list_files',    group: 'fs', summary: 'List the workspace directory tree.' },
  { name: 'stat_file',     group: 'fs', summary: 'Trigger PDF/modern Office extraction and return total_chars; call before read_file.' },
  { name: 'ocr_file',      group: 'fs', summary: 'Run local OCR on PDF pages or image files when visual text is not available through read_file/stat_file.' },
  { name: 'search_files',  group: 'fs', summary: 'Find files by name / glob across the workspace + attachment scope.' },
  { name: 'grep_files',    group: 'fs', summary: 'Grep text across the workspace + attachment scope (PDF/modern Office auto-extracted, then searched); optional `glob` scope + `output_mode` files/count.' },
  { name: 'tool_result_search', group: 'fs', summary: 'Search a persisted oversized tool result by opaque ref and return bounded matching excerpts.' },
  { name: 'tool_result_read_chunk', group: 'fs', summary: 'Read one bounded cursor chunk from a persisted oversized tool result by opaque ref.' },
  { name: 'publish_outputs', group: 'fs', summary: 'Declare the complete set of current-turn files that should appear as final deliverables in the message footer.' },
  { name: 'create_artifact', group: 'fs', permission: 'localExec', summary: 'Build an interactive multi-file app (HTML/CSS/JS) rendered live & clickable inside the chat bubble; for interactive dashboards / calculators / visualizations / mini-tools. Static/read-only dashboards should use :::dashboard; not documents (html_to_pdf) or images (generate_image).' },

  // Shell
  { name: 'bash',          group: 'shell', permission: 'localExec', summary: 'Execute a shell command on the user\'s machine (cwd = $working_dir).' },
  { name: 'interactive_cli_start', group: 'shell', permission: 'localExec', summary: 'Start a live stdin/stdout session for any local CLI command expected to wait for user input.' },
  { name: 'interactive_cli_read',  group: 'shell', permission: 'localExec', summary: 'Read status and recent output from an interactive CLI session.' },
  { name: 'interactive_cli_send',  group: 'shell', permission: 'localExec', summary: 'Send non-secret stdin to an interactive CLI session; user secrets must go through the UI panel.' },
  { name: 'interactive_cli_close', group: 'shell', permission: 'localExec', summary: 'Terminate an interactive CLI session and its process tree.' },

  // PDF
  { name: 'markdown_to_pdf', group: 'pdf', permission: 'localExec', summary: 'Markdown → PDF (CJK-friendly, zero external dependency).' },
  { name: 'html_to_pdf',     group: 'pdf', permission: 'localExec', summary: 'HTML → PDF (same renderer).' },

  // Office documents (bundled OfficeCLI engine — no MS Office needed)
  { name: 'create_docx',   group: 'office', permission: 'localExec', summary: 'Create a Word (.docx) document from paragraphs (styles + inline bold/font/size/color), plus tables and images; CJK-ready, first-page PNG preview; built-in engine, no MS Office required.' },
  { name: 'create_xlsx',   group: 'office', permission: 'localExec', summary: 'Create an Excel (.xlsx) workbook from rows (values + formulas + number formats + cell fill/font/align/border), with multiple sheets and column widths; CJK-ready, PNG preview.' },
  { name: 'create_pptx',   group: 'office', permission: 'localExec', summary: 'Create a PowerPoint (.pptx) deck (title/body/layout, slide background/transition, free-positioned styled shapes, plus images and tables for designed slides); CJK-ready, first-slide PNG preview.' },
  { name: 'office_read',   group: 'office', permission: 'localExec', summary: 'Read an existing .docx/.xlsx/.pptx with element paths (text/outline/get/query) so edits can target them; pairs with edit_office.' },
  { name: 'edit_office',   group: 'office', permission: 'localExec', summary: 'Edit an existing .docx/.xlsx/.pptx in place (set/add/remove on element paths), preserving formatting; returns a PNG preview.' },
  { name: 'office_render', group: 'office', permission: 'localExec', summary: 'Render a page of an existing .docx/.xlsx/.pptx to a PNG image to inspect layout / fonts / CJK glyphs.' },

  // Library
  { name: 'kb_list',       group: 'kb', summary: 'List Library files and indexing status before choosing what to search or read.' },
  { name: 'kb_search',     group: 'kb', summary: 'Semantic search over the user\'s Library.' },
  { name: 'kb_read',       group: 'kb', summary: 'Read source-text chunks from a Library file that kb_search has hit.' },
  { name: 'material_search', group: 'kb', summary: 'Hybrid (vector + BM25) search over the user Library; returns fused hits with citation anchors (scope/path/chunk).' },
  { name: 'material_list', group: 'kb', summary: 'List the full material boundary for the conversation (Library + attachments + space artifacts), each marked in-scope or out-of-scope.' },
  { name: 'ask_materials', group: 'kb', summary: 'Grounded Q&A evidence service over the material set (Library + attachments): returns evidence to answer from with citations, or an explicit no-material/low-confidence marker.' },
  { name: 'research_rerank', group: 'kb', ownerAgent: DEEP_RESEARCH_AGENT_IDS, summary: 'Semantically rerank candidate research passages against a sub-question by local embedding similarity — the second stage after the deep-research compress skill\'s lexical filter, surfacing on-topic passages that share no keywords. Read-only, local, no Tool Execution Access. Owned by the deep-research + data-research agents (hidden from the commander).' },
  // ── 会议转写纠错词表（会议工作流：取转写 → 纠错 → 核对新词 → 生成纪要）──────
  { name: 'transcript_glossary_scan', group: 'transcript', summary: 'Scan a meeting transcript against the user\'s correction glossary and report matches WITHOUT changing the text. Run this right after fetching a Tencent Meeting transcript and before writing minutes. Reports auto-applicable (risk=low|medium) and needs-confirmation (risk=high) matches separately.' },
  { name: 'transcript_glossary_apply', group: 'transcript', summary: 'Apply glossary corrections and return the corrected transcript text. `high` risk candidates are never auto-applied; when the result is `status: draft` you must confirm the listed items with the user (an inline card is offered) before generating minutes. Does not write files.' },
  { name: 'transcript_glossary_upsert', group: 'transcript', summary: 'Add or update one glossary entry (mangled form → authoritative spelling) so future transcripts are corrected automatically. Use after the user confirms a correction or names a person/proper noun the transcript mangled. The engine derives risk level and can only raise it, never lower it.' },
  { name: 'transcript_glossary_list', group: 'transcript', summary: 'List correction-glossary entries (people, products, domain terms and the mangled forms they replace) with kind, risk, scope and boundary. Use to answer what is corrected or to check a term before adding it.' },

  // Recall ability assets
  { name: 'personal_ontology_fields', group: 'recall', summary: 'List the fillable fields of the user\'s installed role templates (个人本体挖空表单), so a candidate can be routed to a concrete field by opaque field_ref.' },
  { name: 'ontology_graph_read', group: 'recall', summary: 'Read the ontology graph by keyword, domain or category (descendants included), or one entity with its one-hop neighbours; returns entity ids for linking meeting records.' },
  { name: 'ontology_projection_apply', group: 'recall', summary: 'Project one confirmed meeting_record.v1 JSON file from the visible workspace into the ontology graph; idempotent, archives instead of deleting, links people/projects/series only by given entity ids.' },
  { name: 'list_ontology_graph', group: 'recall', summary: 'Read saved ontology categories, entities, properties, source references, and explicit relations; supports domain and keyword filters.' },
  { name: 'search_ability_assets', group: 'recall', summary: 'Semantic search over the user\'s ability asset pool (沉淀的可复用经验/规则/模板/方法；全量只读，含所有空间与全局资产).' },
  { name: 'ontology_query', group: 'recall', summary: 'Navigate governed ability-asset relations with bounded hops and return auditable evidence paths.' },
  // 个人字段读取与缺口检查；缺失字段在当前对话中补充。
  { name: 'personal_fields_check', group: 'recall', summary: 'Read which cognition slots a task type needs across three axes (personal fields / ontology facts and rules / method assets), which are bound, and which are missing (pack: weekly_report). Ask the user in the conversation for the missing ones.' },
  { name: 'transcript_corrections_query', group: 'recall', summary: 'Read confirmed conversation/ontology-scene transcript corrections and canonical names before revising a transcript; exclude uncertain identities.' },
  { name: 'cognition_ontology_query', group: 'recall', summary: 'Read time-aware ontology facts and applicable rules through explicit module references, with source/version citations and private-scope filtering.' },

  // 任务经验：与资产**完全隔离**的第二套集合（exp- 前缀）。
  // 2 读 + 0 写、无 localExec（读写都在 <uid> 数据域内，不碰 shell/文件系统），
  // 不按 agent 收窄（与 search_ability_assets 同一面）；同样**不进只读会话白名单**
  // ——读正文会写 agent_read 回执与流水，不是无副作用（runner.ts:417-434 口径）。
  { name: 'list_task_experiences', group: 'recall', summary: 'List the user\'s task experiences (lessons/workflows/gaps precipitated from finished tasks — a collection separate from ability assets) as one-line entries filtered by task type; no body text.' },
  { name: 'read_task_experience', group: 'recall', summary: 'Read one task experience body by id in ≤2000-character chunks (use `chunk` to continue); enforces the same runtime gate and reports blocked state honestly instead of pretending it is missing.' },

  // 资产管家：把既有的资产读写能力暴露给模型。
  // **没有 localExec**（读写都经
  // asset-service 的写函数与 <uid> 数据域，不碰 shell/文件系统），也不受
  // ownerAgent 限：主会话与 group_chat 各 actor 都能用（与 search_ability_assets 同）。
  // 顺序按"最常用优先"：先看全貌、再取正文，然后才是改动类动作。
  { name: 'list_ability_assets', group: 'recall', summary: 'Page through EVERY ability asset the user owns (title/type/status/tags + total), with optional type/status/space filters — deliberately not capped by the UI catalog page size.' },
  { name: 'read_ability_asset', group: 'recall', summary: 'Read one ability asset by id in ≤2000-character chunks (use `chunk` to continue); reports deleted/paused/blocked state honestly instead of pretending it is missing.' },
  { name: 'report_ability_asset_usage', group: 'recall', summary: 'Report adoption of one supplied asset version with an exact final-output excerpt; the host verifies the persisted message before recording adoption, never effectiveness.' },
  { name: 'list_asset_change_proposals', group: 'recall', summary: 'List AI-proposed asset changes still awaiting the user (approval cards): proposed values, current values, reason, state — read-only, because only the user may confirm/reject.' },
  { name: 'create_cognition', group: 'recall', summary: 'Create user-requested durable cognition, ontology records or a joint shared rule through one complete host confirmation and the governed storage pipeline; returns actual saved IDs and receipt.' },
  { name: 'edit_cognition', group: 'recall', summary: 'Edit an existing user-named cognition or ontology record, or merge/split named cognitions with complete outputs and archive the originals, preserving source/access boundaries, reviewed user intent and shared rule bodies in one commit; AI rewrites require one complete preview confirmation.' },
  { name: 'edit_ability_asset', group: 'recall', summary: 'Submit a pending asset improvement with mode=propose (writes a real approval proposal, keeps the current version); or edit on verified user instruction. Only a returned proposal receipt establishes submission; listing proposals is read-only.' },
  { name: 'merge_ability_assets', group: 'recall', summary: 'Merge a duplicate ability asset into a target asset: both share one version group, the source is archived with a pointer, history stays traceable.' },
  { name: 'archive_ability_asset', group: 'recall', summary: 'Archive an ability asset: removed from daily lists and recommendations, content + evidence + history kept, restorable.' },
  { name: 'delete_ability_asset', group: 'recall', summary: 'Delete an ability asset into the 30-day recovery window; restorable within it, then permanently purged (content and records erased).' },
  { name: 'restore_ability_asset', group: 'recall', summary: 'Restore an archived asset, or a deleted asset still within its retention window, back to active.' },
  { name: 'rollback_ability_asset', group: 'recall', summary: 'Roll an ability asset back to a historical version by publishing that snapshot as a new version (history never rewinds); the rollback itself is audited.' },

  // Conversation history
  { name: 'chat_search',   group: 'chat', summary: 'Search prior messages for missing continuity context; project conversations default to same-project history.' },
  { name: 'chat_read',     group: 'chat', summary: 'Read nearby messages from a chat_search hit, or the latest messages from a known conversation.' },

  // Image
  { name: 'generate_image', group: 'image', permission: 'localExec', summary: 'Call the configured image-generation API and save the result into the workspace.' },

  // Web (when a vendor-native search is available the framework picks it automatically; the two below are the fallback channel)
  { name: 'web_search',    group: 'web', summary: 'Built-in fallback web search (vendor-native search is preferred automatically when available).' },
  { name: 'web_fetch',     group: 'web', summary: 'Fetch the body of a URL; pairs with web_search.' },

  // Connectors (umbrella meta-tools — actual MCP actions are discovered + invoked via these;
  // injected only when at least one connector is visible to the actor, alongside a
  // `## Connectors` system-prompt block listing the connector ids + descriptions)
  { name: 'list_connector_tools', group: 'connector', summary: 'Discover the actions a specific connector exposes (returns name + JSON input schema for each).' },
  { name: 'call_connector_tool',  group: 'connector', summary: 'Invoke an action on a connector; call list_connector_tools first to learn the action name and schema.' },
  { name: 'add_custom_connector', group: 'connector', summary: 'Commander-only: add a user-described custom MCP server (requires a user confirmation dialog before install).' },

  // Reimbursement (owner-scoped: configuration is private and submission is human-gated)
  { name: 'expense_configuration_status', group: 'expense', summary: 'Read redacted reimbursement/Feishu setup readiness for the current user.' },
  { name: 'expense_precheck_case', group: 'expense', summary: 'Bind current-chat materials to a reimbursement case and run deterministic precheck.' },
  { name: 'expense_case_status', group: 'expense', summary: 'Read a current-conversation reimbursement case before presenting the host submit confirmation.' },

  // Proactive messaging (Commander-only — injected by runner.ts for gconv
  // sessions with a resolved uid + cid; the model can never reach arbitrary
  // recipients, credentials, chat ids, or open ids)
  { name: 'messaging_list_targets', group: 'messaging', summary: 'List configured Feishu/Lark bots and which can proactively message the configured owner (self); read-only diagnostics.' },
  { name: 'messaging_send', group: 'messaging', summary: 'Send a text message to the configured owner (self) through one Feishu/Lark bot, after the user approves a confirmation dialog.' },
  { name: 'p3394_send', group: 'p3394', summary: 'Send a P3394 task to a registered peer Agent (e.g. hermes) and wait for its reply — agent-to-agent collaboration.' },
  { name: 'p3394_peers', group: 'p3394', summary: 'List registered P3394 peer Agents: id, name, capabilities, locality, endpoints.' },
  { name: 'p3394_sessions', group: 'p3394', summary: 'List the P3394 sessions opened from this conversation: session id, peer, goal, last used.' },

  // Feishu companion surface (Commander-only — injected by runner.ts for
  // gconv sessions with a resolved uid; read-only status + briefing write)
  { name: 'feishu_dashboard', group: 'messaging', summary: 'Read the Feishu companion status: bot connection, authorization/sync state, and briefing configuration (sanitized).' },
  { name: 'briefing_get', group: 'messaging', summary: 'Read the daily-briefing configuration: scheduled time, enabled state, recent delivery.' },
  { name: 'briefing_schedule', group: 'messaging', summary: 'Set or change the daily briefing time (hour/minute); mutates user configuration.' },
  { name: 'touchpoint_list', group: 'messaging', summary: 'List recent touchpoint notifications (intents) and the card actions the owner recorded.' },
  { name: 'messaging_send_file', group: 'messaging', summary: 'Send a local file (md/doc/pdf/…) to the configured owner (self) through one Feishu/Lark bot, after confirmation; workspace/attachment-scoped paths only.' },

  // Task-local and cross-session state
  { name: 'manage_execution_plan', group: 'meta', summary: 'Manage the durable current-task objective and milestone statuses for long/tool-heavy work; session-local and independent of context summaries.' },
  { name: 'cross_session_memory', group: 'meta', summary: 'Read existing user profile, shared facts, and caller-scoped agent memory.' },
  { name: 'project_instructions', group: 'meta', summary: "Replace the project's standing goal + rules (COGSEED.md, the Project instructions block); commander-only, project sessions." },
  { name: 'metacognition',        group: 'meta', summary: 'Read/write metacognition (COMPETENCE / LEARNING_STRATEGIES); env-flag gated.' },

  // NB: the commander's group-dispatch tools (dispatch_to / run_worker) and other
  // group_chat extras (auto_tasks_list / marketplace_* / skill_search) are
  // caller-supplied `extraTools`, NOT runner-injected, so they are intentionally
  // absent here — the anti-drift test only covers runner-injected builtins.
];

/** Fixed render order + section heading per group. */
const GROUP_ORDER: ReadonlyArray<{ group: ToolGroup; title: string }> = [
  { group: 'fs',    title: 'Files / workspace' },
  { group: 'shell', title: 'Shell' },
  { group: 'pdf',   title: 'PDF' },
  { group: 'office', title: 'Office documents' },
  { group: 'kb',    title: 'Library' },
  { group: 'transcript', title: 'Meeting transcript correction (glossary)' },
  { group: 'chat',  title: 'Conversation history' },
  { group: 'recall', title: 'Ability assets / cognition' },
  { group: 'image', title: 'Image' },
  { group: 'web',       title: 'Web' },
  { group: 'connector', title: 'Connectors (third-party services)' },
  { group: 'expense', title: 'Reimbursement' },
  { group: 'p3394', title: 'P3394 peer agents' },
  { group: 'messaging', title: 'Messaging' },
  { group: 'meta',      title: 'Task / cross-session state' },
];

const CATALOG_BY_NAME: ReadonlyMap<string, ToolCatalogEntry> = new Map(
  TOOL_CATALOG.map((e) => [e.name, e]),
);

/**
 * Owner-scoped visibility gate. A tool is visible to an actor when its catalog
 * entry declares no `ownerAgent`, or lists `agentId` among its owner(s) (a
 * single id or an array of ids). Tools not in the catalog (caller-supplied
 * `extraTools` such as the commander's dispatch tools) are never owner-gated →
 * always visible. This is the authoritative check runner.ts applies before
 * handing `tools[]` to the model.
 */
export function isToolVisibleToAgent(name: string, agentId: string): boolean {
  const owner = CATALOG_BY_NAME.get(name)?.ownerAgent;
  if (!owner) return true;
  return Array.isArray(owner) ? owner.includes(agentId) : owner === agentId;
}

const PREAMBLE =
  'Built-in tools available in the current session, grouped by purpose. ' +
  '**Calling a tool does NOT require a skill wrapper** — if a tool can do the job in one call, just call it; ' +
  'do not design a skill for a single-step task. The real value of a skill is encapsulating multi-step logic, ' +
  'managing third-party API credentials, or reusing a high-frequency composite flow.';

/**
 * Render the `## Available tools` block.
 *
 * `names` should be sourced from runner.ts's actual assembled
 * `allTools.map(t => t.name)` — that way runtime-conditional tools
 * (memory / metacognition / plan_* / uid-gated fileTools, ...) follow
 * the actual injection state automatically; no "listed but not
 * actually injected" drift.
 *
 * Behaviour:
 * - empty `names` → return `""` (core-agent treats empty string as "skip
 *   this section")
 * - a name in `names` that is missing from `TOOL_CATALOG` → warn log +
 *   skip that name; never throws
 * - output is assembled in fixed `GROUP_ORDER`; within each group the
 *   order matches the catalog array — same input → same output, KV
 *   cache friendly
 */
export function getToolsSystemPromptBlock(names: string[]): string {
  if (!names.length) return '';

  const seen = new Set<string>();
  const present: ToolCatalogEntry[] = [];
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = CATALOG_BY_NAME.get(name);
    if (!entry) {
      log.warn('runtime tool missing from TOOL_CATALOG', { tool: name });
      continue;
    }
    present.push(entry);
  }
  if (!present.length) return '';

  const presentSet = new Set(present.map((e) => e.name));
  const lines: string[] = ['## Available tools', '', PREAMBLE, ''];

  for (const { group, title } of GROUP_ORDER) {
    const groupEntries = TOOL_CATALOG.filter(
      (e) => e.group === group && presentSet.has(e.name),
    );
    if (!groupEntries.length) continue;
    lines.push(`### ${title}`);
    for (const e of groupEntries) {
      const perm = e.permission === 'localExec' ? ' (gated by local-execution permission)' : '';
      lines.push(`- **${e.name}** — ${e.summary}${perm}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
