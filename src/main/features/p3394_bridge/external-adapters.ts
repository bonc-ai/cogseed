/**
 * P3394 external adapter profiles (Phase 4).
 *
 * Distinguishes external nodes by what they actually are:
 *
 * - 'agent': a full P3394 peer (handle_message capability, its own runtime);
 * - 'capability': an MCP-like tool/resource surface — reduced profile, may
 *   not claim autonomous behaviour;
 * - 'model-runtime': an OpenAI-compatible model API — a model endpoint is a
 *   model endpoint, never a full Agent; it cannot claim autonomous-agent
 *   capabilities and is addressed through reduced profiles.
 *
 * validateP3394ExternalAdapterDescriptor is the choke point: a non-agent node
 * declaring autonomous-agent capability is rejected (capability nodes and
 * model runtimes must not masquerade as autonomous Agents).
 */

import type { P3394BridgeManifest } from './manifest';

export type P3394ExternalNodeKind = 'agent' | 'capability' | 'model-runtime';

export interface P3394ExternalAdapterDescriptor {
  id: string;
  kind: P3394ExternalNodeKind;
  endpoint: string;
  authorized: boolean;
  capabilities: string[];
}

export function validateP3394ExternalAdapterDescriptor(
  descriptor: P3394ExternalAdapterDescriptor,
): { ok: true; descriptor: P3394ExternalAdapterDescriptor } | { ok: false; error: { reason: string } } {
  if (!descriptor.authorized) return { ok: false, error: { reason: 'unauthorized_endpoint' } };
  if (descriptor.kind !== 'agent' && descriptor.capabilities.includes('autonomous-agent')) {
    return { ok: false, error: { reason: 'capability_profile_mismatch' } };
  }
  return { ok: true, descriptor };
}

/**
 * Derives an external node descriptor from a peer manifest. A peer is an
 * 'agent' only when its capability profile carries handle_message; otherwise
 * it is classified as a reduced capability node (model endpoints and MCP-like
 * surfaces never become agents implicitly).
 */
export function p3394ExternalDescriptorFromManifest(
  manifest: P3394BridgeManifest,
  input: { endpoint: string; authorized: boolean },
): P3394ExternalAdapterDescriptor {
  const capabilities = [...manifest.capability_profile.capabilities];
  const hasHandleMessage = capabilities.includes('handle_message');
  const kind: P3394ExternalNodeKind = hasHandleMessage ? 'agent' : 'capability';
  const id = manifest.identity.agent_id;
  const descriptor: P3394ExternalAdapterDescriptor = {
    id,
    kind,
    endpoint: input.endpoint,
    authorized: input.authorized,
    capabilities,
  };
  const validated = validateP3394ExternalAdapterDescriptor(descriptor);
  if (validated.ok === false) {
    // A manifest that claims autonomous behaviour without handle_message is
    // treated as a model/capability surface and stripped of the claim.
    return { ...descriptor, capabilities: capabilities.filter((c) => c !== 'autonomous-agent') };
  }
  return descriptor;
}
