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

function writeProjection(nodeId: string, agentId: string): void {
  const map = readProjections();
  map.set(nodeId, agentId);
  try {
    const file = projectionFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload: ProjectionFile = {
      schema_version: PROJECTION_SCHEMA_VERSION,
      projections: Object.fromEntries([...map.entries()].map(([id, agentId2]) => [id, { agent_id: agentId2, at: new Date().toISOString() }])),
    };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, file);
  } catch (error) {
    log.warn('P3394 team projection persist failed', { error: error instanceof Error ? error.message : String(error) });
  }
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

  // 已投影过 → 幂等返回。
  const already = readProjections().get(nodeId);
  if (already) return { projected: false, agent_id: already, reason: 'already_projected' };

  // 已存在同 cli 的 p3394-gateway agent（用户外接流程创建的）→ 记录映射，不重复创建。
  const agents = await import('../agents');
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
