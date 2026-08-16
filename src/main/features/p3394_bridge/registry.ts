import * as fs from 'node:fs';
import { createLogger } from '../../logger';
import { writeJsonSync } from '../../storage';
import type { P3394AgentIdentity } from './identity';
import { validateP3394AgentIdentity } from './identity';
import type { P3394BridgeManifest } from './manifest';
import { validateP3394BridgeManifest } from './manifest';

const log = createLogger('p3394-bridge:registry');

/** Unified node and capability registry kinds (guide §7.2): independent
 *  agents, sub-agents, task agents, reduced capability nodes (MCP-like),
 *  and model runtimes. Non-agent kinds never masquerade as autonomous. */
export type P3394NodeKind = 'agent' | 'sub_agent' | 'task_agent' | 'capability' | 'model_runtime';

export const P3394_NODE_KINDS: readonly P3394NodeKind[] = ['agent', 'sub_agent', 'task_agent', 'capability', 'model_runtime'] as const;

export type P3394Locality = 'in_process' | 'same_host' | 'enterprise' | 'external';

export const P3394_LOCALITY_RANK: Record<P3394Locality, number> = {
  in_process: 0,
  same_host: 1,
  enterprise: 2,
  external: 3,
};

export interface P3394PeerRecord {
  identity: P3394AgentIdentity;
  aliases: string[];
  manifest: P3394BridgeManifest;
  /** Dial endpoints for outbound calls to this peer (e.g. http://127.0.0.1:9000). */
  endpoints?: string[];
  /** Declared capabilities (capability discovery, guide §7.2). */
  capabilities?: string[];
  /** Node kind in the unified registry (guide §7.2 RegisteredNode). */
  node_kind?: P3394NodeKind;
  /** Profiles this node supports (e.g. p3394-session/1.0). */
  supported_profiles?: string[];
  /** Preferred channel schemes (e.g. p3394+https). */
  preferred_channels?: string[];
  /** Declared data handling policy label (guide §7.2 data_policy). */
  data_policy?: string;
  /** Declared cost policy label (guide §7.2 cost_policy). */
  cost_policy?: string;
  /** Deployment locality — used to rank capability resolution (local-first). */
  locality?: P3394Locality;
  /** Trust policy label applied to this peer (registry metadata). */
  trust_policy?: string;
  /** When set, dialing must verify the remote manifest identity matches this. */
  expected_identity?: string;
  /** Outbound dial Bearer token for this peer (per-peer credential, optional).
   *  Stored in the local registry only; never exported to manifests or audit. */
  dial_token?: string;
  /** 最近一次观察到该节点活动的时间（hello/心跳/任意入站信封刷新）——ECS 在线状态。 */
  last_seen_at?: string;
  disabled?: boolean;
  updated_at: string;
}

export interface P3394AliasResolutionContext {
  sessionAliases?: Record<string, string>;
}

export type P3394RegistryReason =
  | 'invalid_peer'
  | 'invalid_alias'
  | 'alias_equals_identity'
  | 'alias_conflict'
  | 'identity_conflict'
  | 'identity_mismatch'
  | 'capability_profile_mismatch'
  | 'peer_disabled'
  | 'peer_not_found';

export interface P3394RegistryError {
  reason: P3394RegistryReason;
  field: string;
  message: string;
}

export type P3394RegistryResult<T> = { ok: true; value: T } | { ok: false; error: P3394RegistryError };

function fail(reason: P3394RegistryReason, field: string, message: string): { ok: false; error: P3394RegistryError } {
  return { ok: false, error: { reason, field, message } };
}

function normalizeAlias(alias: unknown): string | null {
  if (typeof alias !== 'string') return null;
  const v = alias.trim();
  if (!v || v.length > 256) return null;
  return v;
}

function uniqueAliases(aliases: unknown[], agentId: string): P3394RegistryResult<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < aliases.length; i += 1) {
    const alias = normalizeAlias(aliases[i]);
    if (!alias) return fail('invalid_alias', `aliases[${i}]`, 'Alias must be a non-empty bounded string.');
    if (alias === agentId) return fail('alias_equals_identity', `aliases[${i}]`, 'Alias must not equal agent_id.');
    if (!seen.has(alias)) {
      seen.add(alias);
      out.push(alias);
    }
  }
  return { ok: true, value: out };
}

export interface P3394PeerRegistryOptions {
  /** Optional persistence target (e.g. Agent Home peersRegistryFile). */
  filePath?: string;
  now?: () => string;
}

export const P3394_PEER_REGISTRY_SCHEMA_VERSION = 1 as const;

export class P3394PeerRegistry {
  private peers = new Map<string, P3394PeerRecord>();
  private aliasToAgent = new Map<string, string>();
  private readonly filePath: string | null;
  private readonly now: () => string;

  constructor(options: P3394PeerRegistryOptions = {}) {
    this.filePath = options.filePath ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
    if (this.filePath) this.loadSync();
  }

  /** Restores peers from the persistence file (atomic-read; tolerant of absence). */
  private loadSync(): void {
    try {
      const text = fs.readFileSync(this.filePath!, 'utf8');
      const parsed = JSON.parse(text) as { schemaVersion?: number; peers?: P3394PeerRecord[] };
      if (parsed.schemaVersion !== P3394_PEER_REGISTRY_SCHEMA_VERSION) return;
      for (const peer of parsed.peers ?? []) {
        this.peers.set(peer.identity.agent_id, peer);
        for (const alias of peer.aliases) this.aliasToAgent.set(alias, peer.identity.agent_id);
      }
    } catch {
      // Missing or malformed persistence file: start empty (fail-open to an
      // empty registry; the registry is not a trust boundary by itself).
    }
  }

  /** Persists the registry atomically (tmp + rename). Best-effort. */
  private persist(): void {
    if (!this.filePath) return;
    try {
      const payload = {
        schemaVersion: P3394_PEER_REGISTRY_SCHEMA_VERSION,
        peers: [...this.peers.values()].map((peer) => ({
          ...peer,
          aliases: [...peer.aliases],
        })),
        saved_at: this.now(),
      };
      writeJsonSync(this.filePath, payload);
    } catch (error) {
      log.warn('P3394 peer registry persistence failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  list(): P3394PeerRecord[] {
    return [...this.peers.values()].map((peer) => ({ ...peer, aliases: [...peer.aliases] }));
  }

  register(input: {
    identity: P3394AgentIdentity;
    aliases?: string[];
    manifest: P3394BridgeManifest;
    endpoints?: string[];
    capabilities?: string[];
    node_kind?: P3394NodeKind;
    supported_profiles?: string[];
    preferred_channels?: string[];
    data_policy?: string;
    cost_policy?: string;
    locality?: P3394Locality;
    trust_policy?: string;
    expected_identity?: string;
    dial_token?: string;
    disabled?: boolean;
    now?: string;
  }): P3394RegistryResult<P3394PeerRecord> {
    const identityResult = validateP3394AgentIdentity(input.identity);
    if (identityResult.ok === false) return { ok: false, error: { reason: 'invalid_peer', field: identityResult.error.field, message: identityResult.error.message } };
    const manifestResult = validateP3394BridgeManifest(input.manifest);
    if (manifestResult.ok === false) return { ok: false, error: { reason: 'invalid_peer', field: manifestResult.error.field, message: manifestResult.error.message } };
    if (manifestResult.manifest.identity.agent_id !== identityResult.identity.agent_id) {
      return fail('identity_mismatch', 'manifest.identity.agent_id', 'Manifest identity must match peer identity.');
    }
    const aliasesResult = uniqueAliases(input.aliases ?? [], identityResult.identity.agent_id);
    if (aliasesResult.ok === false) return aliasesResult;

    for (const alias of aliasesResult.value) {
      const existing = this.aliasToAgent.get(alias);
      if (existing && existing !== identityResult.identity.agent_id) {
        return fail('alias_conflict', 'aliases', `Alias ${alias} is already registered to another peer.`);
      }
    }

    const previous = this.peers.get(identityResult.identity.agent_id);
    if (previous) {
      for (const alias of previous.aliases) this.aliasToAgent.delete(alias);
    }
    const endpoints = (input.endpoints ?? []).filter((value) => typeof value === 'string' && value.startsWith('http')).slice(0, 8);
    const capabilities = Array.from(new Set((input.capabilities ?? []).filter((value) => typeof value === 'string' && value.trim()))).slice(0, 64);
    const nodeKind: P3394NodeKind | undefined = input.node_kind && (P3394_NODE_KINDS as readonly string[]).includes(input.node_kind)
      ? input.node_kind
      : undefined;
    // Reduced nodes must not claim autonomous behaviour (guide §2.7/§7.2).
    if (nodeKind && (nodeKind === 'capability' || nodeKind === 'model_runtime') && capabilities.includes('autonomous-agent')) {
      return fail('capability_profile_mismatch', 'capabilities', 'capability/model_runtime nodes must not declare autonomous-agent.');
    }
    const supportedProfiles = Array.from(new Set((input.supported_profiles ?? []).filter((value) => typeof value === 'string' && value.trim() && value.trim().length <= 120))).slice(0, 32);
    const preferredChannels = Array.from(new Set((input.preferred_channels ?? []).filter((value) => typeof value === 'string' && value.trim() && value.trim().length <= 120))).slice(0, 16);
    const dataPolicy = typeof input.data_policy === 'string' && input.data_policy.trim() ? input.data_policy.trim().slice(0, 120) : undefined;
    const costPolicy = typeof input.cost_policy === 'string' && input.cost_policy.trim() ? input.cost_policy.trim().slice(0, 120) : undefined;
    const locality: P3394Locality | undefined = input.locality && P3394_LOCALITY_RANK[input.locality] !== undefined
      ? input.locality
      : undefined;
    const trustPolicy = typeof input.trust_policy === 'string' && input.trust_policy.trim() ? input.trust_policy.trim().slice(0, 120) : undefined;
    const expectedIdentity = typeof input.expected_identity === 'string' && input.expected_identity.trim() ? input.expected_identity.trim().slice(0, 256) : undefined;
    const dialToken = typeof input.dial_token === 'string' && input.dial_token.trim() ? input.dial_token.trim() : undefined;
    const record: P3394PeerRecord = {
      identity: identityResult.identity,
      aliases: aliasesResult.value,
      manifest: manifestResult.manifest,
      ...(endpoints.length ? { endpoints } : {}),
      ...(capabilities.length ? { capabilities } : {}),
      ...(nodeKind ? { node_kind: nodeKind } : {}),
      ...(supportedProfiles.length ? { supported_profiles: supportedProfiles } : {}),
      ...(preferredChannels.length ? { preferred_channels: preferredChannels } : {}),
      ...(dataPolicy ? { data_policy: dataPolicy } : {}),
      ...(costPolicy ? { cost_policy: costPolicy } : {}),
      ...(locality ? { locality } : {}),
      ...(trustPolicy ? { trust_policy: trustPolicy } : {}),
      ...(expectedIdentity ? { expected_identity: expectedIdentity } : {}),
      ...(dialToken ? { dial_token: dialToken } : {}),
      ...(input.disabled ? { disabled: true } : {}),
      last_seen_at: input.now ?? new Date().toISOString(),
      updated_at: input.now ?? new Date().toISOString(),
    };
    this.peers.set(record.identity.agent_id, record);
    for (const alias of record.aliases) this.aliasToAgent.set(alias, record.identity.agent_id);
    this.persist();
    return { ok: true, value: { ...record, aliases: [...record.aliases] } };
  }

  disable(agentId: string): P3394RegistryResult<P3394PeerRecord> {
    const peer = this.peers.get(agentId);
    if (!peer) return fail('peer_not_found', 'agent_id', 'Peer is not registered.');
    peer.disabled = true;
    peer.updated_at = this.now();
    this.persist();
    return { ok: true, value: { ...peer, aliases: [...peer.aliases] } };
  }

  revoke(agentId: string): P3394RegistryResult<P3394PeerRecord> {
    const peer = this.peers.get(agentId);
    if (!peer) return fail('peer_not_found', 'agent_id', 'Peer is not registered.');
    this.peers.delete(agentId);
    for (const alias of peer.aliases) this.aliasToAgent.delete(alias);
    this.persist();
    return { ok: true, value: { ...peer, aliases: [...peer.aliases] } };
  }

  resolve(aliasOrId: string, context: P3394AliasResolutionContext = {}): P3394RegistryResult<P3394PeerRecord> {
    const requested = normalizeAlias(aliasOrId);
    if (!requested) return fail('invalid_alias', 'aliasOrId', 'Alias or agent id must be a non-empty string.');
    const sessionTarget = context.sessionAliases?.[requested];
    const agentId = sessionTarget || this.aliasToAgent.get(requested) || requested;
    const peer = this.peers.get(agentId);
    if (!peer) return fail('peer_not_found', 'aliasOrId', 'Peer is not registered.');
    if (peer.disabled) return fail('peer_disabled', 'agent_id', 'Peer is disabled.');
    return { ok: true, value: { ...peer, aliases: [...peer.aliases] } };
  }

  /** 刷新节点在线时间（hello/心跳/任意入站信封）。返回是否命中。 */
  touch(agentId: string, now?: string): boolean {
    const peer = this.peers.get(agentId);
    if (!peer) return false;
    peer.last_seen_at = now ?? new Date().toISOString();
    this.persist();
    return true;
  }

  /** Capability-based resolution (guide §7.2): the best enabled peer declaring
   *  the capability, ranked local-first (in_process > same_host > enterprise
   *  > external), ties broken by registration order. */
  findByCapability(
    capability: string,
    opts: { preferLocal?: boolean; requiredProfile?: string; dataClassification?: string } = {},
  ): P3394RegistryResult<P3394PeerRecord> {
    const requested = normalizeAlias(capability);
    if (!requested) return fail('invalid_alias', 'capability', 'Capability must be a non-empty string.');
    const requiredProfile = typeof opts.requiredProfile === 'string' && opts.requiredProfile.trim() ? opts.requiredProfile.trim() : '';
    const dataClassification = typeof opts.dataClassification === 'string' && opts.dataClassification.trim() ? opts.dataClassification.trim() : '';
    let best: P3394PeerRecord | null = null;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const peer of this.peers.values()) {
      if (peer.disabled) continue;
      if (!peer.capabilities || !peer.capabilities.includes(requested)) continue;
      if (requiredProfile && (!peer.supported_profiles || !peer.supported_profiles.includes(requiredProfile))) continue;
      if (dataClassification && peer.data_policy !== dataClassification) continue;
      const rank = opts.preferLocal === false ? 0 : (peer.locality ? P3394_LOCALITY_RANK[peer.locality] : 3);
      if (rank < bestRank) {
        best = peer;
        bestRank = rank;
      }
    }
    if (!best) return fail('peer_not_found', 'capability', 'No enabled peer satisfies capability ' + requested + ' with the requested profile/data policy.');
    return { ok: true, value: { ...best, aliases: [...best.aliases] } };
  }
}
