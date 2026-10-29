/**
 * Agent 提交副本暂存区 —— 与 `staging.ts`（Skill）同一纪律，针对 Agent 的布局。
 *
 * 只做文件系统层：把本机自建 Agent 的**作者原文**与其引用的**本机自建 Skill**复制到暂存目录，
 * 产出 `agent-package-v1` 的提交形态（`agent.json` + 可选 `README.md` + 可选 `skills/<name>/`）。
 * 所有路径由调用方显式传入（不 import `paths.ts` / Electron），所以可以对真实临时目录直接测试；
 * 按 uid 解析目录的薄封装放在调用方（`agent-contribution`）。
 *
 * ## 不变量（与 C-FR-004b 同口径）
 * - 只作用于**副本**，不修改本机原 Agent 与原 Skill；
 * - 本机处理（剥离 `version` 等）只给本机预览看，**不上传**，Hub 不需要知道处理了什么；
 * - 不跟随符号链接，不复制本机安装态文件（`_install.json` 等）；
 * - 提交包里**不得**出现 `_meta.json`（由 Hub 发布时写入）。
 *
 * ## 私有 Skill 的 `ownerAgent`
 * 现有机制里 `ownerAgent` 是**宿主 Agent 的 id**，只有该 Agent 解析得到这个 Skill。提交时 Hub
 * 尚未分配 `content_id`，所以副本里 `ownerAgent` 写**本机 `agent_id`**，并要求 `agent.json` 同样带
 * 这个 `agent_id`；安装时由客户端改写为安装后的 Agent id（见 `marketplace_agent_deps`）。
 * 此约定需与 Hub 确认（`agent-api-proposal.md` §8.3）。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  splitSkillRefs, toDistributableAgent, type AgentBlocker, type AgentPackageIssue, type HandledItem,
} from './agent-package-rules';

/**
 * 暂存目录前缀，必须与 `staging.ts` 的 `CONTRIB_STAGING_PREFIX` 相同，孤儿清理才能覆盖 Agent 副本。
 * 这里不 import 它以保持本模块是无 Electron 依赖的叶模块；测试钉住两者相等。
 */
export const AGENT_STAGING_PREFIX = '.contrib-';

/** 本机安装态文件不进副本（与 `staging.ts` / `preview.ts` 同一集合）。 */
const INSTALL_STATE_FILES = new Set(['_install.json', '_cache.json', '_resource_manifest.json']);
const SAFE_NAME_RE = /^[A-Za-z0-9\p{L}_-]{1,64}$/u;

export interface AgentStagingSources {
  /** 本机自建 Agent 目录（含 `agent.json`），如 `<uid>/cloud/agents/<id>`。 */
  agentDir: string;
  /** 本机自建 Skill 根目录，如 `<uid>/cloud/skills`。 */
  userSkillsDir: string;
  /** 暂存根目录（不在 Skill 注册表扫描范围内，如 `marketplaceCacheSkillsDir(uid)`）。 */
  stagingRoot: string;
}

export interface AgentStaging {
  /** 副本根目录绝对路径；沿用 `.contrib-<hex>` 前缀，孤儿清理自动覆盖。 */
  dir: string;
  /** 本机 Agent id（用于日志与替换键，不上传）。 */
  sourceAgentId: string;
  token: string;
  /** 剥离项，仅本机预览用。 */
  handled: HandledItem[];
  /** 不得贡献的原因；非空时流程必须终止。 */
  blockers: AgentBlocker[];
  /** `skill_list` 里的 Hub Skill（本机无需随包）。 */
  hubRefs: string[];
  /** `skill_list` 里的客户端内置能力（`builtin:<name>`，不随包提交，只写在 `agent.json` 里）。 */
  builtinRefs: string[];
  /** 已随包复制的私有 Skill 名字。 */
  bundledSkills: string[];
  /** 暂存阶段发现的问题（本机缺少被引用的私有 Skill 等）。 */
  issues: AgentPackageIssue[];
}

export class AgentStagingError extends Error {
  constructor(readonly code: 'agent_missing' | 'agent_invalid_json' | 'invalid_agent_id') {
    super(code);
    this.name = 'AgentStagingError';
  }
}

const isSymlink = (p: string): boolean => {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
};

function copyFilter(src: string): boolean {
  if (INSTALL_STATE_FILES.has(path.basename(src))) return false;
  return !isSymlink(src);
}

/**
 * 在 SKILL.md 的 frontmatter 里写入 `ownerAgent: <agentId>`；已有则替换。
 * 没有 frontmatter 的文件返回 `null`（由调用方记为问题，不静默放行）。
 */
export function stampOwnerAgent(skillMd: string, agentId: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(skillMd);
  if (!m) return null;
  const eol = skillMd.includes('\r\n') ? '\r\n' : '\n';
  const lines = m[1].split(/\r?\n/);
  const idx = lines.findIndex((l) => /^ownerAgent\s*:/.test(l));
  const line = `ownerAgent: ${agentId}`;
  if (idx >= 0) lines[idx] = line; else lines.push(line);
  return `---${eol}${lines.join(eol)}${eol}---${m[2]}${skillMd.slice(m[0].length)}`;
}

/**
 * 建立 Agent 提交副本。
 *
 * 阻断项（宿主专有、外接运行时、`crown`）**不**抛错，登记在 `blockers` 里交给检查阶段统一展示；
 * 只有无法继续的情形（Agent 不存在、`agent.json` 不是 JSON）才抛 {@link AgentStagingError}。
 */
export async function stageAgent(agentId: string, src: AgentStagingSources): Promise<AgentStaging> {
  if (!SAFE_NAME_RE.test(agentId)) throw new AgentStagingError('invalid_agent_id');
  const agentJsonPath = path.join(src.agentDir, 'agent.json');
  if (!fs.existsSync(agentJsonPath)) throw new AgentStagingError('agent_missing');

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(agentJsonPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    raw = parsed as Record<string, unknown>;
  } catch {
    throw new AgentStagingError('agent_invalid_json');
  }

  const { agent, handled, blockers } = toDistributableAgent(raw);
  const skillList = Array.isArray(agent.skill_list) ? agent.skill_list.filter((x): x is string => typeof x === 'string') : [];
  const { hub, bundled, builtin } = splitSkillRefs(skillList);

  await fsp.mkdir(src.stagingRoot, { recursive: true });
  const token = randomBytes(6).toString('hex');
  const dir = path.join(src.stagingRoot, `${AGENT_STAGING_PREFIX}${token}`);
  await fsp.mkdir(dir, { recursive: true });

  const issues: AgentPackageIssue[] = [];
  const bundledCopied: string[] = [];
  try {
    await fsp.writeFile(path.join(dir, 'agent.json'), `${JSON.stringify(agent, null, 2)}\n`, 'utf8');

    const readme = path.join(src.agentDir, 'README.md');
    if (fs.existsSync(readme) && !isSymlink(readme)) await fsp.copyFile(readme, path.join(dir, 'README.md'));

    // 私有 Skill 的 ownerAgent 必须能指向本 Agent：要求 agent.json 带 agent_id
    const ownerId = typeof agent.agent_id === 'string' ? agent.agent_id : '';
    if (bundled.length > 0 && !ownerId) {
      issues.push({
        code: 'PRIVATE_SKILL_INVALID', rule: 'private_skill.owner', path: 'agent_id',
        message: 'agent.json needs an agent_id so bundled skills can name their owner',
      });
    }

    for (const name of bundled) {
      const skillSrc = path.join(src.userSkillsDir, name);
      const skillMdSrc = path.join(skillSrc, 'SKILL.md');
      if (!fs.existsSync(skillMdSrc) || isSymlink(skillSrc)) {
        issues.push({
          code: 'SKILL_REF_NOT_FOUND', rule: 'skill_ref.local_missing', path: `skill_list.${skillList.indexOf(name)}`,
          message: `bundled skill not found on this machine: ${name}`,
        });
        continue;
      }
      const skillDst = path.join(dir, 'skills', name);
      await fsp.cp(skillSrc, skillDst, { recursive: true, filter: copyFilter });
      if (ownerId) {
        const stamped = stampOwnerAgent(fs.readFileSync(path.join(skillDst, 'SKILL.md'), 'utf8'), ownerId);
        if (stamped === null) {
          issues.push({
            code: 'PRIVATE_SKILL_INVALID', rule: 'private_skill.frontmatter', path: `skills/${name}/SKILL.md`,
            message: 'SKILL.md has no frontmatter to carry ownerAgent',
          });
        } else {
          await fsp.writeFile(path.join(skillDst, 'SKILL.md'), stamped, 'utf8');
        }
      }
      bundledCopied.push(name);
    }
  } catch (err) {
    // 失败不留半成品副本
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return { dir, sourceAgentId: agentId, token, handled, blockers, hubRefs: hub, builtinRefs: builtin, bundledSkills: bundledCopied, issues };
}

/** 销毁副本；不抛错。 */
export async function destroyAgentStaging(staging: Pick<AgentStaging, 'dir'>): Promise<void> {
  await fsp.rm(staging.dir, { recursive: true, force: true }).catch(() => undefined);
}
