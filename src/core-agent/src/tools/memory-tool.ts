/** Read existing cross-session memory through host-owned, caller-scoped IO.
 * Cognition formation belongs to the host's independent nightly pipeline. */
import type { AgentTool, ToolContext, ToolResult } from './base.js';
export type MemoryTier = 'agent' | 'space' | 'shared' | 'user';
export interface MemoryToolHandler {
  list(tier: MemoryTier): MemoryToolOperationResult | Promise<MemoryToolOperationResult>;
}
export interface MemoryToolOperationResult {
  ok: boolean; error?: string; entries: string[];
  usage: { current: number; limit: number };
  legacySource?: 'project';
  legacyEntryCount?: number;
}
export interface CrossSessionMemoryToolOptions { includeProjectTier?: boolean }
export function createCrossSessionMemoryTool(handler: MemoryToolHandler, opts: CrossSessionMemoryToolOptions = {}): AgentTool {
  const tiers: MemoryTier[] = opts.includeProjectTier ? ['agent', 'space', 'shared', 'user'] : ['agent', 'shared', 'user'];
  return {
    name: 'cross_session_memory',
    description: `Read-only existing cross-session memory. Targets: agent (default, caller's notes), shared (shared facts), user (profile/preferences)${opts.includeProjectTier ? ', space (this conversation\'s space memory)' : ''}. Use list for user-requested inventories or exact existing text; do not reload memory already in context. Reply in the current response language; preserve proper nouns, commands, file paths, URLs and quoted wording.`,
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['list'], description: 'Read the existing inventory.' },
      target: { type: 'string', enum: tiers, description: 'Caller-scoped existing memory; defaults to agent.' },
    }, required: ['action'], additionalProperties: false },
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const target = (input.target as MemoryTier) || 'agent';
      if (!tiers.includes(target)) return { content: JSON.stringify({ ok: false, error: `target must be one of: ${tiers.join(', ')}` }), isError: true };
      if (input.action !== 'list') return { content: JSON.stringify({ ok: false, error: 'cross-session memory is read-only; only list is available' }), isError: true };
      const result = await handler.list(target);
      return { content: JSON.stringify(result), isError: !result.ok };
    },
  };
}
