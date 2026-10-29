/** Recover tool calls a model wrote as text instead of native function calls.
 *
 * Some providers occasionally emit their tool-call markup into the content
 * stream (`<tool_calls><tool_call name="read_file"><parameter name="path">…`).
 * Treating that as the final answer shows raw markup to the user and ends the
 * task without doing the work. Only names in the live tool catalog are
 * accepted; anything else leaves the text untouched. */
import type { RuntimeModelToolCall } from './model-adapter';

const CALL_RE = /<tool_call(?:\s+name="([^"]+)")?\s*>([\s\S]*?)<\/tool_call>/g;
const PARAM_RE = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;

function paramValue(raw: string): unknown {
  const value = raw.replace(/^\n+|\n+$/g, '');
  const trimmed = value.trim();
  if (/^(?:\{[\s\S]*\}|\[[\s\S]*\]|-?\d+(?:\.\d+)?|true|false|null)$/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch { /* keep the string */ }
  }
  return value;
}

export function parseTextToolCalls(text: string, knownTools: ReadonlySet<string>, idPrefix: string): RuntimeModelToolCall[] | null {
  if (!text.includes('<tool_call')) return null;
  const calls: RuntimeModelToolCall[] = [];
  for (const match of text.matchAll(CALL_RE)) {
    let name = match[1];
    let args: Record<string, unknown> = {};
    if (name) {
      for (const param of match[2].matchAll(PARAM_RE)) args[param[1]] = paramValue(param[2]);
    } else {
      // JSON form: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
      try {
        const parsed = JSON.parse(match[2].trim()) as { name?: unknown; arguments?: unknown };
        if (typeof parsed.name !== 'string') return null;
        name = parsed.name;
        const rawArgs = typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : parsed.arguments;
        if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) args = rawArgs as Record<string, unknown>;
      } catch { return null; }
    }
    if (!knownTools.has(name)) return null;
    calls.push({ id: `${idPrefix}-${calls.length}`, name, arguments: args });
  }
  return calls.length ? calls : null;
}
