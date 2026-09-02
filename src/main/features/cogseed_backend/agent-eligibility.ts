// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

/**
 * The single answer to "can this Agent take a run right now", shared by the
 * Run Center registry projection and the execution admission gate.
 *
 * This is deliberately a leaf module: the projection imports `task-store` and
 * the host discovery facade, and the admission gate runs on every dispatch, so
 * neither may import the other. Both import this instead. It holds no I/O — the
 * caller supplies the facts it has already read.
 */

import type { AgentRuntime } from '../agents';

const COGSEED_EXECUTABLE_CLI_RUNTIMES = new Set([
  'claude',
  'codex',
  'openclaw',
  'opencode',
  'hermes',
  'workbuddy',
]);

export function isCogSeedAgentRuntimeSupported(runtime: AgentRuntime | null | undefined): boolean {
  return !runtime || runtime.kind === 'in_process' || COGSEED_EXECUTABLE_CLI_RUNTIMES.has(runtime.cli);
}

/** Machine reason an Agent cannot take a run right now. Consumers pick copy and
 *  filter groups from this; they must never re-derive eligibility themselves. */
export type CogSeedAgentEligibilityReason =
  | 'disabled'
  | 'management_only'
  | 'peer_disabled'
  | 'unsupported_runtime'
  | 'not_installed'
  | 'offline';

export interface CogSeedAgentEligibilityFacts {
  /** The user has not switched this Agent off. */
  enabled: boolean;
  /** Host-owned management identity; never an ordinary chat/run target. */
  managementOnly: boolean;
  peerDisabled: boolean;
  installed: boolean;
  online: boolean;
  runtimeSupported: boolean;
}

export interface CogSeedAgentEligibility {
  dispatchable: boolean;
  reasonCode?: CogSeedAgentEligibilityReason;
}

/** Minimal shapes this module reads. Callers pass their richer host records. */
export interface CogSeedAgentCliEntryFacts {
  type: string;
  available: boolean;
}

export interface CogSeedAgentPeerFacts {
  agent_id: string;
  online: boolean;
  disabled?: boolean;
}

/**
 * `dispatchable` is one conjunction. The branch order only decides which
 * `reasonCode` is reported: policy first (the user can act on it in settings),
 * then capability, then reachability — matching the order the Run Center health
 * badge already used.
 */
export function resolveAgentEligibility(facts: CogSeedAgentEligibilityFacts): CogSeedAgentEligibility {
  if (!facts.enabled) return { dispatchable: false, reasonCode: 'disabled' };
  if (facts.managementOnly) return { dispatchable: false, reasonCode: 'management_only' };
  if (facts.peerDisabled) return { dispatchable: false, reasonCode: 'peer_disabled' };
  if (!facts.runtimeSupported) return { dispatchable: false, reasonCode: 'unsupported_runtime' };
  if (!facts.installed) return { dispatchable: false, reasonCode: 'not_installed' };
  if (!facts.online) return { dispatchable: false, reasonCode: 'offline' };
  return { dispatchable: true };
}

export function findAgentCliEntry<T extends CogSeedAgentCliEntryFacts>(
  entries: readonly T[],
  runtime: AgentRuntime | null | undefined,
): T | undefined {
  return runtime && runtime.kind !== 'in_process'
    ? entries.find((entry) => entry.type === runtime.cli)
    : undefined;
}

export function findAgentPeer<T extends CogSeedAgentPeerFacts>(
  peers: readonly T[],
  agentId: string,
  runtime: AgentRuntime | null | undefined,
): T | undefined {
  return peers.find((item) => item.agent_id === agentId)
    ?? (runtime?.kind === 'p3394-gateway'
      ? peers.find((item) => item.agent_id === runtime.cli)
      : undefined);
}

export interface CogSeedAgentEligibilityInputs {
  enabled: boolean;
  interactionMode?: string | null;
  runtime: AgentRuntime | null | undefined;
  cli: CogSeedAgentCliEntryFacts | undefined;
  peer: CogSeedAgentPeerFacts | undefined;
}

/**
 * `installed` and `online` are not universal conditions — what they mean, and
 * whether they are variables at all, depends on where the Agent comes from.
 * For an in-process Agent both are constants; for a local CLI `installed` is
 * whether the binary was detected; for a gateway-backed Agent `online` is the
 * peer's reachability. Keeping this derivation in one place is the point: the
 * admission gate used to reimplement eligibility around the in-process shape
 * and therefore accepted uninstalled CLIs and offline peers.
 */
export function deriveAgentEligibilityFacts(
  input: CogSeedAgentEligibilityInputs,
): CogSeedAgentEligibilityFacts {
  const { runtime, cli, peer } = input;
  const installed = runtime?.kind === 'cli'
    ? cli?.available === true
    : runtime?.kind === 'p3394-gateway'
      ? !!peer || !!cli?.available
      : true;
  const online = runtime?.kind === 'p3394-gateway'
    ? peer?.online === true
    : installed;
  return {
    enabled: input.enabled,
    managementOnly: input.interactionMode === 'management_only',
    peerDisabled: peer?.disabled === true,
    installed,
    online,
    runtimeSupported: isCogSeedAgentRuntimeSupported(runtime),
  };
}
