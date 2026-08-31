// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import type { AgentRuntime, AgentSummary } from '../agents';
import { assertCogSeedUserId } from './paths';
import { listCogSeedTasks } from './task-store';
import type { CogSeedTaskRecord } from './types';
import { isCogSeedAgentRuntimeSupported } from './agent-execution-context';

const ACTIVE_STATUSES = new Set(['created', 'queued', 'running', 'waiting_user']);

export type CogSeedRendererAgentSourceKind = 'cogseed' | 'local-cli' | 'p3394';
export type CogSeedRendererAgentHealth = 'ready' | 'busy' | 'offline' | 'disabled' | 'unsupported' | 'unknown';

export interface CogSeedRendererAgentSummary {
  agentId: string;
  displayName: string;
  sourceKind: CogSeedRendererAgentSourceKind;
  definitionSource?: string;
  runtimeKind: string;
  installed: boolean;
  online: boolean;
  enabled: boolean;
  dispatchable: boolean;
  health: CogSeedRendererAgentHealth;
  currentTaskId?: string;
  currentConversationId?: string;
  lastActiveAt?: string;
  capabilities: string[];
  stats: { active: number; completed: number; failed: number };
}

export interface CogSeedRendererRuntimeSummary {
  runtimeId: string;
  agentId?: string;
  displayName: string;
  sourceKind: 'local-cli' | 'p3394';
  runtimeKind: string;
  installed: boolean;
  online: boolean;
  enabled: boolean;
  dispatchable: boolean;
  health: CogSeedRendererAgentHealth;
  lastActiveAt?: string;
  gatewayRunning?: boolean;
  gatewayControllable?: boolean;
}

export interface CogSeedRendererChannelSummary {
  channelId: string;
  displayName: string;
  platform: string;
  enabled: boolean;
  online: boolean;
  health: 'ready' | 'offline' | 'disabled' | 'error';
  lastActiveAt?: string;
}

export interface CogSeedRendererAgentRegistryProjection {
  schemaVersion: 1;
  updatedAt: string;
  agents: CogSeedRendererAgentSummary[];
  runtimes: CogSeedRendererRuntimeSummary[];
  channels: CogSeedRendererChannelSummary[];
}

interface CogSeedHostCliEntry {
  type: string;
  available: boolean;
}

interface CogSeedHostChannel {
  id: string;
  displayName: string;
  platform: string;
  enabled: boolean;
  status: { kind: string; checkedAt?: string };
}

interface CogSeedHostPeer {
  agent_id: string;
  display_name?: string;
  node_kind?: string;
  online: boolean;
  disabled?: boolean;
  last_seen_at?: string;
  capabilities?: unknown;
}

interface CogSeedHostGateway {
  cli: string;
  started_at?: string;
  running?: boolean;
}

interface CogSeedHostRemoteNode {
  id: string;
  label: string;
  expected_identity?: string;
  enabled?: boolean;
}

type MaybePromise<T> = T | Promise<T>;

export interface CogSeedAgentRegistryProjectionDeps {
  listAgentSummaries?: () => Promise<AgentSummary[]>;
  detectAll?: () => Promise<CogSeedHostCliEntry[]>;
  listTasks?: typeof listCogSeedTasks;
  listChannels?: (userId: string) => Promise<CogSeedHostChannel[]>;
  listPeers?: () => MaybePromise<CogSeedHostPeer[]>;
  listGateways?: () => MaybePromise<CogSeedHostGateway[]>;
  listRemoteNodes?: () => MaybePromise<{ nodes: CogSeedHostRemoteNode[] }>;
  now?: () => Date;
}

async function hostAdapter() {
  return import('../cogseed-agent-registry-host');
}

async function defaultListAgentSummaries(): Promise<AgentSummary[]> {
  return (await hostAdapter()).listCogSeedHostAgentSummaries();
}

async function defaultDetectAll(): Promise<CogSeedHostCliEntry[]> {
  return (await hostAdapter()).listCogSeedHostCliEntries();
}

async function defaultListChannels(userId: string): Promise<CogSeedHostChannel[]> {
  return (await hostAdapter()).listCogSeedHostChannels(userId);
}

async function defaultListPeers(): Promise<CogSeedHostPeer[]> {
  return (await hostAdapter()).listCogSeedHostPeers();
}

async function defaultListGateways(): Promise<CogSeedHostGateway[]> {
  return (await hostAdapter()).listCogSeedHostGateways();
}

async function defaultListRemoteNodes(): Promise<{ nodes: CogSeedHostRemoteNode[] }> {
  return (await hostAdapter()).listCogSeedHostRemoteNodes();
}

function safeIdentifier(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 160 && /^[A-Za-z0-9_.:-]+$/.test(text) ? text : fallback;
}

function safeDisplayName(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '') : '';
  if (!text) return fallback.slice(0, 120);
  const sensitive = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|https?:\/\/|\bBearer\s+|\b(?:api[_-]?key|token|password|secret)\s*[:=]|\bsk-[A-Za-z0-9_-]{12,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b)/i;
  return (sensitive.test(text) ? fallback : text).slice(0, 120);
}

function safeCapabilities(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter((value) => value.length > 0 && value.length <= 80 && /^[A-Za-z0-9_.:-]+$/.test(value))))
    .slice(0, 24);
}

function latestTask(tasks: CogSeedTaskRecord[]): CogSeedTaskRecord | undefined {
  return [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function taskStats(tasks: CogSeedTaskRecord[]) {
  return {
    active: tasks.filter((task) => ACTIVE_STATUSES.has(task.status)).length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    failed: tasks.filter((task) => task.status === 'failed' || task.status === 'recoverable').length,
  };
}

function localEntry(entries: CogSeedHostCliEntry[], runtime: AgentRuntime | undefined): CogSeedHostCliEntry | undefined {
  return runtime && runtime.kind !== 'in_process'
    ? entries.find((entry) => entry.type === runtime.cli)
    : undefined;
}

function runtimePeer(
  peers: CogSeedHostPeer[],
  agentId: string,
  runtime: AgentRuntime | undefined,
): CogSeedHostPeer | undefined {
  return peers.find((item) => item.agent_id === agentId)
    ?? (runtime?.kind === 'p3394-gateway'
      ? peers.find((item) => item.agent_id === runtime.cli)
      : undefined);
}

export async function buildCogSeedAgentRegistryProjection(
  userId: string,
  deps: CogSeedAgentRegistryProjectionDeps = {},
): Promise<CogSeedRendererAgentRegistryProjection> {
  assertCogSeedUserId(userId);
  const readAgentSummaries = deps.listAgentSummaries ?? defaultListAgentSummaries;
  const readCliEntries = deps.detectAll ?? defaultDetectAll;
  const readTasks = deps.listTasks ?? listCogSeedTasks;
  const readChannels = deps.listChannels ?? defaultListChannels;
  const readPeers = deps.listPeers ?? defaultListPeers;
  const readGateways = deps.listGateways ?? defaultListGateways;
  const readRemoteNodes = deps.listRemoteNodes ?? defaultListRemoteNodes;
  const [definitions, cliEntries, tasks, channels, peers, gateways, remoteNodes] = await Promise.all([
    readAgentSummaries(),
    readCliEntries(),
    readTasks(userId),
    Promise.resolve().then(() => readChannels(userId)).catch(() => []),
    readPeers(),
    readGateways(),
    readRemoteNodes(),
  ]);

  const tasksByAgent = new Map<string, CogSeedTaskRecord[]>();
  for (const task of tasks) {
    if (!task.agentId) continue;
    const rows = tasksByAgent.get(task.agentId) ?? [];
    rows.push(task);
    tasksByAgent.set(task.agentId, rows);
  }

  const projectedAgentIds = new Set<string>();
  const boundPeerIds = new Set<string>();
  const agents: CogSeedRendererAgentSummary[] = definitions.map((definition) => {
    const agentId = safeIdentifier(definition.agent_id, 'unknown-agent');
    projectedAgentIds.add(agentId);
    const runtime = definition.runtime;
    const relatedTasks = tasksByAgent.get(agentId) ?? [];
    const active = latestTask(relatedTasks.filter((task) => ACTIVE_STATUSES.has(task.status)));
    const last = latestTask(relatedTasks);
    const cli = localEntry(cliEntries, runtime);
    const peer = runtimePeer(peers, agentId, runtime);
    if (peer) boundPeerIds.add(peer.agent_id);
    const sourceKind: CogSeedRendererAgentSourceKind = runtime?.kind === 'p3394-gateway'
      ? 'p3394'
      : runtime?.kind === 'cli'
        ? 'local-cli'
        : 'cogseed';
    const installed = runtime?.kind === 'cli'
      ? cli?.available === true
      : runtime?.kind === 'p3394-gateway'
        ? !!peer || !!cli?.available
        : true;
    const online = runtime?.kind === 'p3394-gateway'
      ? peer?.online === true
      : installed;
    const runtimeSupported = isCogSeedAgentRuntimeSupported(runtime);
    const dispatchable = definition.enabled !== false && installed && online && runtimeSupported && peer?.disabled !== true;
    const health: CogSeedRendererAgentHealth = definition.enabled === false || peer?.disabled === true
      ? 'disabled'
      : active
        ? 'busy'
        : !runtimeSupported
          ? 'unsupported'
          : !installed || !online
            ? 'offline'
            : 'ready';
    return {
      agentId,
      displayName: safeDisplayName(definition.name, agentId),
      sourceKind,
      definitionSource: safeIdentifier(definition.source, 'unknown'),
      runtimeKind: runtime?.kind === 'cli' || runtime?.kind === 'p3394-gateway'
        ? `${runtime.kind}:${safeIdentifier(runtime.cli, 'unknown')}`
        : 'in_process',
      installed,
      online,
      enabled: definition.enabled !== false && peer?.disabled !== true,
      dispatchable,
      health,
      ...(active?.taskId ? { currentTaskId: active.taskId } : {}),
      ...(active?.conversationId ? { currentConversationId: active.conversationId } : {}),
      ...(last?.updatedAt || peer?.last_seen_at ? { lastActiveAt: [last?.updatedAt, peer?.last_seen_at].filter(Boolean).sort().at(-1) } : {}),
      capabilities: peer ? safeCapabilities(peer.capabilities) : [sourceKind === 'cogseed' ? 'in-process' : 'task-execution'],
      stats: taskStats(relatedTasks),
    };
  });

  for (const peer of peers) {
    // The local bridge registers CogSeed itself as a peer. It is infrastructure,
    // not an external executor that users can configure from the Run Center.
    if (peer.node_kind === 'channel_bridge' || peer.agent_id === 'cogseed'
      || projectedAgentIds.has(peer.agent_id) || boundPeerIds.has(peer.agent_id)) continue;
    const agentId = safeIdentifier(peer.agent_id, 'unknown-peer');
    const relatedTasks = tasksByAgent.get(agentId) ?? [];
    const active = latestTask(relatedTasks.filter((task) => ACTIVE_STATUSES.has(task.status)));
    const last = latestTask(relatedTasks);
    const enabled = peer.disabled !== true;
    const executableNode = peer.node_kind === 'agent' || peer.node_kind === 'sub_agent' || peer.node_kind === 'task_agent';
    agents.push({
      agentId,
      displayName: safeDisplayName(peer.display_name, agentId),
      sourceKind: 'p3394',
      runtimeKind: `p3394:${safeIdentifier(peer.node_kind, 'agent')}`,
      installed: true,
      online: peer.online,
      enabled,
      dispatchable: enabled && peer.online && executableNode,
      health: !enabled ? 'disabled' : active ? 'busy' : !executableNode ? 'unsupported' : peer.online ? 'ready' : 'offline',
      ...(active?.taskId ? { currentTaskId: active.taskId } : {}),
      ...(active?.conversationId ? { currentConversationId: active.conversationId } : {}),
      ...(last?.updatedAt || peer.last_seen_at ? { lastActiveAt: [last?.updatedAt, peer.last_seen_at].filter(Boolean).sort().at(-1) } : {}),
      capabilities: safeCapabilities(peer.capabilities),
      stats: taskStats(relatedTasks),
    });
  }

  const runtimes: CogSeedRendererRuntimeSummary[] = cliEntries.map((entry) => {
    const gateway = gateways.find((item) => item.cli === entry.type);
    const supported = isCogSeedAgentRuntimeSupported({ kind: 'cli', cli: entry.type });
    const installed = entry.available === true;
    return {
      runtimeId: `local-cli:${entry.type}`,
      displayName: safeDisplayName(entry.type, entry.type),
      sourceKind: 'local-cli',
      runtimeKind: entry.type,
      installed,
      online: installed,
      enabled: true,
      dispatchable: installed && supported,
      health: !supported ? 'unsupported' : installed ? 'ready' : 'offline',
      gatewayRunning: gateway?.running === true,
      gatewayControllable: installed && supported,
      ...(gateway?.started_at ? { lastActiveAt: gateway.started_at } : {}),
    };
  });
  for (const node of remoteNodes.nodes) {
    const peer = peers.find((item) => item.agent_id === node.expected_identity);
    const enabled = node.enabled !== false && peer?.disabled !== true;
    runtimes.push({
      runtimeId: safeIdentifier(node.id, 'remote-node'),
      ...(node.expected_identity ? { agentId: safeIdentifier(node.expected_identity, 'remote-agent') } : {}),
      displayName: safeDisplayName(node.label, 'Remote P3394 node'),
      sourceKind: 'p3394',
      runtimeKind: 'p3394-remote',
      installed: true,
      online: peer?.online === true,
      enabled,
      dispatchable: enabled && peer?.online === true,
      health: !enabled ? 'disabled' : peer?.online ? 'ready' : 'offline',
      ...(peer?.last_seen_at ? { lastActiveAt: peer.last_seen_at } : {}),
    });
  }

  const channelViews: CogSeedRendererChannelSummary[] = channels.map((channel) => {
    const health: CogSeedRendererChannelSummary['health'] = !channel.enabled
      ? 'disabled'
      : channel.status.kind === 'connected'
        ? 'ready'
        : channel.status.kind === 'error'
          ? 'error'
          : 'offline';
    return {
      channelId: safeIdentifier(channel.id, 'unknown-channel'),
      displayName: safeDisplayName(channel.displayName, channel.platform),
      platform: safeIdentifier(channel.platform, 'unknown'),
      enabled: channel.enabled,
      online: channel.status.kind === 'connected',
      health,
      ...(channel.status.checkedAt ? { lastActiveAt: channel.status.checkedAt } : {}),
    };
  });

  return {
    schemaVersion: 1,
    updatedAt: (deps.now?.() ?? new Date()).toISOString(),
    agents: agents.sort((left, right) => Number(right.health === 'busy') - Number(left.health === 'busy') || left.displayName.localeCompare(right.displayName)),
    runtimes: runtimes.sort((left, right) => left.displayName.localeCompare(right.displayName)),
    channels: channelViews.sort((left, right) => left.displayName.localeCompare(right.displayName)),
  };
}
