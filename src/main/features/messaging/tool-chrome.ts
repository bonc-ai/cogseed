/**
 * Pure rendering helpers for tool-call chrome lines (the one-line "🔍
 * web_search: "…"" previews shown in streaming cards and merged into plain-text
 * replies). Mirrors Hermes' `build_tool_preview` / `format_tool_event`.
 */

import type { GroupEvent } from '../group_chat/bus';

export const MAX_TOOL_LINES = 20;
/** Tool chrome preview length (mirrors Hermes `_tool_preview_max_len`). */
export const TOOL_PREVIEW_MAX_LEN = 40;

/** Display emoji per tool (mirrors Hermes' tool registry `emoji` fields). */
const TOOL_EMOJI: Record<string, string> = {
  web_search: '🔍',
  web_extract: '📄',
  read_file: '📖',
  write_file: '✍️',
  search_files: '🔎',
  terminal: '🖥️',
  run_command: '🖥️',
  process: '⚙️',
  vision_analyze: '👁️',
  analyze_image: '👁️',
  browser_navigate: '🌐',
  browser_click: '👆',
  browser_type: '⌨️',
  image_generate: '🎨',
  execute_code: '💻',
  delegate_task: '🎯',
};
const DEFAULT_TOOL_EMOJI = '⚙️';

/** Primary argument used for the one-line preview per tool (mirrors Hermes
 * `build_tool_preview`'s `primary_args` table). */
const TOOL_PREVIEW_PRIMARY_ARG: Record<string, string> = {
  web_search: 'query',
  web_extract: 'urls',
  read_file: 'path',
  write_file: 'path',
  patch: 'path',
  search_files: 'pattern',
  terminal: 'command',
  run_command: 'command',
  vision_analyze: 'question',
  analyze_image: 'question',
  browser_navigate: 'url',
  browser_click: 'ref',
  browser_type: 'text',
  image_generate: 'prompt',
  execute_code: 'code',
  delegate_task: 'goal',
  process: 'action',
};

function toolPreviewText(name: string, args: Record<string, unknown>): string {
  const key = TOOL_PREVIEW_PRIMARY_ARG[name];
  const raw = key ? args[key] : undefined;
  let text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? args);
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > TOOL_PREVIEW_MAX_LEN) return `${text.slice(0, TOOL_PREVIEW_MAX_LEN)}…`;
  return text;
}

/** Render one tool-call chrome line, e.g. `🔍 web_search: "site:openai.com …"`
 * (mirrors Hermes `format_tool_event`). */
export function renderToolLine(name: string, args: Record<string, unknown>): string {
  const emoji = TOOL_EMOJI[name] || DEFAULT_TOOL_EMOJI;
  return `${emoji} ${name}: "${toolPreviewText(name, args)}"`;
}

/** Extract tool-call lines from a process event. Returns [] for non-tool
 * events. The bus tool shape is `{ type: 'event', event: { stream: 'tool',
 * data: { phase, name, arguments } } }`. */
export function toolLinesFromProcessEvent(event: Extract<GroupEvent, { type: 'process' }>): string[] {
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
  if (data.type !== 'event') return [];
  const inner = data.event && typeof data.event === 'object' ? data.event as Record<string, unknown> : {};
  if (inner.stream !== 'tool') return [];
  const toolData = inner.data && typeof inner.data === 'object' ? inner.data as Record<string, unknown> : {};
  if (toolData.phase !== 'start') return [];
  const name = typeof toolData.name === 'string' && toolData.name ? toolData.name : '';
  if (!name) return [];
  const args = toolData.arguments && typeof toolData.arguments === 'object'
    ? toolData.arguments as Record<string, unknown>
    : {};
  return [renderToolLine(name, args)];
}
