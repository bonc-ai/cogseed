export const AGENT_CAPABILITIES = [
  'file',
  'shell',
  'skill',
  'kb',
  'search',
  'connector',
  'browser',
  'office',
  'history',
] as const;

export type AgentCapability = typeof AGENT_CAPABILITIES[number];

export function isAgentCapability(value: unknown): value is AgentCapability {
  return typeof value === 'string'
    && (AGENT_CAPABILITIES as readonly string[]).includes(value);
}
