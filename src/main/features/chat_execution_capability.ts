import { hasConfiguredModel } from './auth';
import { detectAll } from './local_agents/registry';
import { readCliModelEndpoint, probeModelEndpointReachable } from './local_agents/active_config';

const CHAT_FALLBACK_CLIS = new Set(['claude', 'codex', 'opencode', 'workbuddy']);

/**
 * Effective capability for the main conversation composer. API model
 * configuration remains a separate fact because model-only surfaces still
 * need it, while normal chat can execute through a local CLI Agent.
 */
export async function getChatExecutionCapability() {
  const apiConfigured = hasConfiguredModel().configured;
  if (apiConfigured) {
    return { apiConfigured: true, localAgentAvailable: false, chatAvailable: true };
  }

  const entries = await detectAll();
  const candidates = entries.filter((entry) => entry.available && CHAT_FALLBACK_CLIS.has(entry.type));
  let localAgentAvailable = false;
  await Promise.all(candidates.map(async (entry) => {
    try {
      const endpoint = readCliModelEndpoint(entry.type);
      if (endpoint?.isLocalProxy && await probeModelEndpointReachable(entry.type) === false) return;
      localAgentAvailable = true;
    } catch {
      // An unreadable endpoint is not proof that the CLI cannot execute. The
      // runner will surface its own diagnostic if the process later fails.
      localAgentAvailable = true;
    }
  }));

  return {
    apiConfigured: false,
    localAgentAvailable,
    chatAvailable: localAgentAvailable,
  };
}
