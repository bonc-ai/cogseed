import type { AgentBackend } from './types';
import type { AgentCapability } from './capability-catalog';

export const AGENT_BACKEND_CAPABILITIES = Object.freeze<Record<AgentBackend, readonly AgentCapability[]>>({
  native: Object.freeze([
    'file',
    'shell',
    'skill',
  ]),
  core: Object.freeze([
    'file',
    'shell',
    'kb',
    'search',
    'connector',
    'office',
    'history',
  ]),
});

export function getAgentBackendCapabilities(backend: AgentBackend): readonly AgentCapability[] {
  return AGENT_BACKEND_CAPABILITIES[backend];
}

export function hasAgentCapability(backend: AgentBackend, capability: AgentCapability): boolean {
  return getAgentBackendCapabilities(backend).includes(capability);
}

export function getMissingAgentCapabilities(
  backend: AgentBackend,
  requiredCapabilities: readonly AgentCapability[],
): AgentCapability[] {
  const available = new Set(getAgentBackendCapabilities(backend));
  return requiredCapabilities.filter((capability) => !available.has(capability));
}
