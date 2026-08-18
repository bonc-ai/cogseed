/**
 * P3394 node → AI 团队 projection.
 *
 * A local agent that self-registers into the bridge (gateway hello or a
 * first inbound message with an alias) automatically gets an AI 团队 entry
 * — a visible card with the external badge, dispatchable through @ in any
 * conversation. No manual 外接 flow needed: talk once, it joins the team.
 *
 * Scope (local-first): only same-host nodes are projected. A cloud agent
 * that merely posts messages (no endpoint) stays a registry peer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { p3394StateFile } from './runtime-paths';

const log = createLogger('p3394-bridge:team-projection');

/** Known local CLI nodes with bilingual card descriptions. */
const KNOWN_CLIS: Record<string, { name: string; description_zh: string; description_en: string }> = {
  hermes: {
    name: 'Hermes',
    description_zh: '本地通用任务智能体——通过 P3394 协议接入，多步任务、工具调用、按会话续接，在对话里 @ 它即可协作。',
    description_en: 'Local general-purpose agent connected over the P3394 protocol — multi-step tasks, tool use and session resume; @ it in any conversation to collaborate.',
  },
  claude: {
    name: 'ClaudeCode',
    description_zh: '本地代码研发智能体——通过 P3394 协议接入，实现功能、修 bug、重构、写测试，在对话里 @ 它即可协作。',
    description_en: 'Local coding agent connected over the P3394 protocol — features, fixes, refactors and tests; @ it in any conversation to collaborate.',
  },
  codex: {
    name: 'Codex',
    description_zh: '本地代码研发智能体——通过 P3394 协议接入，按需求/issue 打补丁、实现功能、修 bug，在对话里 @ 它即可协作。',
    description_en: 'Local coding agent connected over the P3394 protocol — patches against requirements or issues; @ it in any conversation to collaborate.',
  },
  opencode: {
    name: 'OpenCode',
    description_zh: '本地代码研发智能体——通过 P3394 协议接入，自选模型（含本地模型）实现功能、修 bug、跑终端命令，在对话里 @ 它即可协作。',
    description_en: 'Local coding agent connected over the P3394 protocol — bring-your-own-model development; @ it in any conversation to collaborate.',
  },
  openclaw: {
    name: 'OpenClaw',
    description_zh: '本地通用任务智能体——通过 P3394 协议接入，多模型/工具编排与自动化，在对话里 @ 它即可协作。',
    description_en: 'Local general-purpose agent connected over the P3394 protocol — multi-model/tool orchestration; @ it in any conversation to collaborate.',
  },
  workbuddy: {
    name: 'WorkBuddy',
    description_zh: '本地代码研发智能体——通过 P3394 协议接入（WorkBuddy 内置 CodeBuddy CLI），实现功能、修 bug、重构、写测试，在对话里 @ 它即可协作。',
    description_en: 'Local coding agent connected over the P3394 protocol (WorkBuddy CodeBuddy CLI) — features, fixes, refactors and tests; @ it in any conversation to collaborate.',
  },
};

interface ProjectionFile { schema_version: number; projections: Record<string, { agent_id: string; at: string }> }

const PROJECTION_SCHEMA_VERSION = 1;

function projectionFile(): string {
  return p3394StateFile('p3394-team-projection.json');
}

/** Always reads the file — projection is a low-frequency operation (fires on
 *  node registration only), and a live read keeps tests isolated and makes
 *  the file the single source of truth. */
function readProjections(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(projectionFile(), 'utf8')) as Partial<ProjectionFile>;
    if (parsed.schema_version === PROJECTION_SCHEMA_VERSION && parsed.projections) {
      for (const [nodeId, record] of Object.entries(parsed.projections)) {
        if (record && typeof record.agent_id === 'string') out.set(nodeId, record.agent_id);
      }
    }
  } catch { /* first run */ }
  return out;
}

export function projectedTeamAgentId(nodeId: string): string | undefined {
  return readProjections().get(String(nodeId || '').trim());
}

function persistProjections(map: Map<string, string>): void {
  try {
    const file = projectionFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload: ProjectionFile = {
      schema_version: PROJECTION_SCHEMA_VERSION,
      projections: Object.fromEntries([...map.entries()].map(([id, agentId]) => [id, { agent_id: agentId, at: new Date().toISOString() }])),
    };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, file);
  } catch (error) {
    log.warn('P3394 team projection persist failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

function writeProjection(nodeId: string, agentId: string): void {
  const map = readProjections();
  map.set(nodeId, agentId);
  persistProjections(map);
}

/** Removes a node's team-projection mapping (agent deletion cleanup).
 *  Idempotent: a missing mapping or file is a no-op. */
export function removeProjection(nodeId: string): void {
  const key = String(nodeId || '').trim();
  if (!key) return;
  const map = readProjections();
  if (!map.delete(key)) return;
  persistProjections(map);
  log.info('P3394 team projection removed', { nodeId: key });
}

/** Removes every projection mapping that points at the given agent id.
 *  Projection keys are node ids, which may differ from the CLI type the
 *  agent was created with (self-reported gateway ids like
 *  "workbuddy-final"), so `removeProjection(cli)` alone can leave stale
 *  mappings that re-project the deleted agent on the next hello. Returns
 *  the number of removed mappings. Idempotent. */
export function removeProjectionsForAgent(agentId: string): number {
  const key = String(agentId || '').trim();
  if (!key) return 0;
  const map = readProjections();
  let removed = 0;
  for (const [nodeId, mappedAgentId] of [...map.entries()]) {
    if (mappedAgentId === key) {
      map.delete(nodeId);
      removed += 1;
    }
  }
  if (removed > 0) {
    persistProjections(map);
    log.info('P3394 team projections removed for agent', { agent_id: key, removed });
  }
  return removed;
}

// ── 投影抑制（suppressed nodes）───────────────────────────────────────
// 用户显式删除某个外接智能体后，其网关进程可能仍在运行（孤儿进程 /
// 未停干净的托管网关），持续 hello 会触发投影**自动重建同名 agent**，
// 让「删除 → 重建同名」永远撞名。删除时把该节点的 nodeId 记入抑制表；
// 被抑制的节点 hello 只注册为 peer，不再自动投影进 AI 团队。用户显式
// 重新外接（p3394.external.start 创建 agent）时解除抑制。

interface SuppressedFile { schema_version: number; nodes: string[] }

const SUPPRESSED_SCHEMA_VERSION = 1;

function suppressedFile(): string {
  return p3394StateFile('p3394-suppressed-nodes.json');
}

function readSuppressed(): Set<string> {
  const out = new Set<string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(suppressedFile(), 'utf8')) as Partial<SuppressedFile>;
    if (parsed.schema_version === SUPPRESSED_SCHEMA_VERSION && Array.isArray(parsed.nodes)) {
      for (const nodeId of parsed.nodes) {
        if (typeof nodeId === 'string' && nodeId.trim()) out.add(nodeId.trim());
      }
    }
  } catch { /* first run */ }
  return out;
}

function persistSuppressed(nodes: Set<string>): void {
  try {
    const file = suppressedFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload: SuppressedFile = {
      schema_version: SUPPRESSED_SCHEMA_VERSION,
      nodes: [...nodes].sort(),
    };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, file);
  } catch (error) {
    log.warn('P3394 suppressed nodes persist failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** True when the node must not auto-project into the AI team (deleted by
 *  the user; gateway may still be alive). Idempotent lookup. */
export function isNodeProjectionSuppressed(nodeId: string): boolean {
  return readSuppressed().has(String(nodeId || '').trim());
}

/** Suppresses auto-projection for a node id (agent deletion cleanup). */
export function suppressNodeProjection(nodeId: string): void {
  const key = String(nodeId || '').trim();
  if (!key) return;
  const nodes = readSuppressed();
  if (nodes.has(key)) return;
  nodes.add(key);
  persistSuppressed(nodes);
  log.info('P3394 node projection suppressed', { nodeId: key });
}

/** Removes the suppression for a node id (user explicitly re-connects the
 *  CLI — auto-projection is allowed again). Idempotent. */
export function unsuppressNodeProjection(nodeId: string): void {
  const key = String(nodeId || '').trim();
  if (!key) return;
  const nodes = readSuppressed();
  if (!nodes.delete(key)) return;
  persistSuppressed(nodes);
  log.info('P3394 node projection unsuppressed', { nodeId: key });
}

/**
 * Projects a self-registered LOCAL node into the AI 团队 (idempotent).
 * Returns the agent id when projected (or already projected).
 */
export async function projectP3394NodeToTeam(input: {
  nodeId: string;
  alias?: string;
  endpoints?: string[];
}): Promise<{ projected: boolean; agent_id?: string; reason?: string }> {
  const nodeId = String(input.nodeId || '').trim();
  if (!nodeId || nodeId === 'cogseed') return { projected: false, reason: 'skip_local' };

  // 聚焦本地：只有同机节点（回环端点）自动投影；无端点的纯客户端不投影。
  const endpoints = (input.endpoints ?? []).filter((v) => typeof v === 'string' && v.startsWith('http'));
  const allLoopback = endpoints.length > 0 && endpoints.every((endpoint) => {
    try {
      const host = new URL(endpoint).hostname.toLowerCase();
      return host === '127.0.0.1' || host === 'localhost' || host === '::1';
    } catch { return false; }
  });
  if (!allLoopback) return { projected: false, reason: 'skip_non_local' };

  // 已投影过 → 只有目标 Agent 仍存在时才幂等返回。Agent 被删除后，
  // 必须允许当前在线 P3394 节点重新进入 AI 团队目录，不能被陈旧映射卡死。
  const agents = await import('../agents');
  const already = readProjections().get(nodeId);
  if (already) {
    const existingProjected = await agents.getAgent(already);
    if (existingProjected && existingProjected.runtime?.kind === 'p3394-gateway') {
      return { projected: false, agent_id: already, reason: 'already_projected' };
    }
  }

  // 已存在同 cli 的 p3394-gateway agent（用户外接流程创建的）→ 记录映射，不重复创建。
  const existingAgents = await agents.listAgents();
  const cli = Object.prototype.hasOwnProperty.call(KNOWN_CLIS, nodeId) ? nodeId : null;
  const match = existingAgents.find((agent) => {
    const rt = agent.runtime as { kind?: string; cli?: string } | undefined;
    return rt && rt.kind === 'p3394-gateway' && (!cli || rt.cli === cli);
  });
  if (match) {
    writeProjection(nodeId, match.agent_id);
    return { projected: false, agent_id: match.agent_id, reason: 'existing_agent' };
  }

  // 用户显式删除过该节点（网关进程可能仍在 hello）→ 不自动重建，等用户
  // 显式重新外接（p3394.external.start 会 unsuppress）。否则「删除后立即
  // 被同名投影重建、再次创建同名撞名」。
  if (isNodeProjectionSuppressed(nodeId)) {
    return { projected: false, reason: 'suppressed' };
  }

  const known = cli ? KNOWN_CLIS[cli] : null;
  // CogSeed 的 agent 名称不允许空格与符号（ASCII 字母/数字/_/-/CJK）。
  // 自报 alias 清洗后用作卡片名；清洗后为空则回退到节点 id。
  const rawBase = (input.alias || (known ? known.name : nodeId)).trim();
  const sanitizedBase = rawBase.replace(/[^A-Za-z0-9_\-\u4e00-\u9fff]+/g, '').slice(0, 60);
  const baseName = sanitizedBase || String(nodeId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'p3394-agent';
  const descriptionZh = known ? known.description_zh : '本地智能体——通过 P3394 协议自动接入的协作节点，在对话里 @ 它即可协作。';
  const descriptionEn = known ? known.description_en : 'Local agent auto-connected over the P3394 protocol as a collaboration node; @ it in any conversation to collaborate.';

  // 名称冲突：优先原名，占用则加「P3394」后缀，仍冲突则跳过。
  const nameTaken = (name: string) => existingAgents.some((agent) => (agent.name || '').trim() === name);
  let name = baseName;
  if (nameTaken(name)) name = baseName + ' · P3394';
  if (nameTaken(name)) return { projected: false, reason: 'name_conflict' };

  try {
    const created = await agents.createCustomAgent({
      name,
      description_zh: descriptionZh,
      description_en: descriptionEn,
      icon: 'code',
      color: 'sage',
      runtime: { kind: 'p3394-gateway', cli: cli || nodeId },
      category: 'general',
    });
    if (!created) return { projected: false, reason: 'create_failed' };
    writeProjection(nodeId, created.agent_id);
    log.info('P3394 node projected into AI team', { nodeId, agent_id: created.agent_id, name });
    return { projected: true, agent_id: created.agent_id };
  } catch (error) {
    log.warn('P3394 team projection failed', { nodeId, error: error instanceof Error ? error.message : String(error) });
    return { projected: false, reason: 'create_failed' };
  }
}
