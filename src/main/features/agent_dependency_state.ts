/**
 * 已安装 Agent 的依赖状态 —— 智能体页卡片据此显示「依赖已停用 / 缺少依赖」。
 *
 * 与安装时共用同一份依赖规划（`marketplace_agent_deps.planAgentDependencies`），所以卡片上看到的
 * 状态与安装时的判断一致，不会各算一遍。纯判定与读盘分开：判定可直接表驱动测试。
 *
 * ## 为什么只有「停用」会让「使用」按钮不可点
 * 产品要求"全部依赖准备好后才显示可用"。但存量 Agent 的 `skill_list` 里可能有早就失效的旧引用，
 * 运行时本来就把未知条目忽略（`resolveSkillAllowlistRefs`）。把「本机找不到」也当成不可用，会让原本能用的
 * Agent 突然点不动。所以：
 * - 依赖被 Hub 停用 → `blocked`，卡片提示并禁用「使用」（与安装时阻断一致）；
 * - 依赖本机缺失 → 只给提示，不禁用（用户可重装 Agent 补齐）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  userMarketplaceAgentSkillsDir, userMarketplaceSkillDir, userSkillsDir, userSystemSkillDir,
} from '../paths';
import { satisfiesMinAppVersion } from '../util/app-version-compat';
import { getBuiltinCapability } from './agent_builtin_capabilities';
import {
  planAgentDependencies, type DependencyPlan, type LocalSkillState,
} from './marketplace_agent_deps';
import { readContentStatus } from './marketplace/installed-version';

export type AgentDependencyReason = 'disabled' | 'unsupported' | 'missing' | 'user_disabled';

export interface AgentDependencyState {
  /** `deps_blocked`：有依赖被停用或不被支持，Agent 不可用；`deps_missing`：本机缺少依赖；`ready`：就绪。 */
  status: 'ready' | 'deps_blocked' | 'deps_missing';
  /** 有问题的依赖 id（按 `skill_list` 顺序）。 */
  ids: string[];
  /** 只在有用户停用的依赖时出现：`user_disabled` 与 Hub 停用（`disabled`）区分，便于界面给出「启用 X」。 */
  reasons?: Record<string, AgentDependencyReason>;
}

const READY: AgentDependencyState = Object.freeze({ status: 'ready', ids: [] }) as AgentDependencyState;

/** 纯判定：把依赖规划归成卡片要用的状态。停用与不支持优先于缺失。 */
export function dependencyStateFromPlan(plan: DependencyPlan): AgentDependencyState {
  const blocked = plan.blocked.map((item) => item.id);
  if (blocked.length) return { status: 'deps_blocked', ids: blocked };
  if (plan.toInstall.length) return { status: 'deps_missing', ids: [...plan.toInstall] };
  return READY;
}

/**
 * 纯判定：叠加用户自己停用的依赖（`component-enabled.json`）。用户停用让 Agent 在界面上不可手动使用
 * （S4 spec FR-027，与 S3 一致）；`builtin:` 引用与随包私有 Skill 不受用户停用名单影响。
 * `disabledIdOf(ref)`：`skill_list` 里的一项（id 或旧写法的技能名）若指向一个被用户停用的技能，返回该技能 id，
 * 否则返回 ''。返回 id 而不是布尔，是为了让 `ids` / `reasons` 始终是真实 id（界面据此一键「启用」）。
 * 运行时不看这个状态：主智能体照常派活，只是被停用的技能不会出现在该 Agent 的技能里（2026-10-20 定）。
 */
export function withUserDisabledDependencies(
  state: AgentDependencyState,
  skillList: readonly string[] | undefined,
  privateIds: ReadonlySet<string>,
  disabledIdOf: (ref: string) => string,
): AgentDependencyState {
  const userIds = (skillList ?? [])
    .map((ref) => String(ref || '').trim())
    .filter((ref) => ref && !ref.startsWith('builtin:') && !privateIds.has(ref))
    .map((ref) => disabledIdOf(ref))
    .filter((id, i, all) => id && all.indexOf(id) === i);
  if (!userIds.length) return state;
  const blocked = state.status === 'deps_blocked' ? state.ids : [];
  const ids = [...blocked, ...userIds.filter((id) => !blocked.includes(id))];
  const reasons: Record<string, AgentDependencyReason> = { ...(state.reasons ?? {}) };
  for (const id of userIds) reasons[id] = 'user_disabled';
  return { status: 'deps_blocked', ids, reasons };
}

/** 该 Agent 的随包私有 Skill id：安装时解到 `<agent>/skills/<id>/SKILL.md`。 */
function privateSkillIds(uid: string, agentId: string): Set<string> {
  const out = new Set<string>();
  const dir = userMarketplaceAgentSkillsDir(uid, agentId);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md'))) out.add(entry.name);
  }
  return out;
}

function localSkillState(uid: string): (skillId: string) => LocalSkillState {
  return (skillId) => {
    const present = fs.existsSync(path.join(userSkillsDir(uid), skillId, 'SKILL.md'))
      || fs.existsSync(path.join(userMarketplaceSkillDir(uid, skillId), 'SKILL.md'));
    if (!present) return { present: false, disabled: false };
    let disabled = false;
    try { disabled = readContentStatus(uid, skillId).availability === 'disabled'; } catch { /* 读不到按未停用 */ }
    return { present: true, disabled };
  };
}

/**
 * 客户端内置能力在本机是否具备：在开放清单内、对应系统 Skill 已就位、客户端版本不低于引入版本。
 * 任何一项不满足都算不具备（失败关闭）。
 */
export function builtinCapabilityAvailable(uid: string, name: string, appVersion: string): boolean {
  const capability = getBuiltinCapability(name);
  if (!capability) return false;
  if (!satisfiesMinAppVersion(appVersion, capability.introducedIn)) return false;
  try { return fs.existsSync(path.join(userSystemSkillDir(uid, name), 'SKILL.md')); } catch { return false; }
}

/** 读盘版本：只读本机，不联网。`skillList` 缺省或为空时直接返回就绪。
 *  `userDisabledSkills`（可选）：用户停用的技能 id 集合，或 ref → 被停用技能 id 的解析函数，传入时一并判定
 *  （见 `withUserDisabledDependencies`）。 */
export function readAgentDependencyState(
  uid: string, agentId: string, skillList: readonly string[] | undefined, appVersion = '',
  userDisabledSkills?: ReadonlySet<string> | ((ref: string) => string),
): AgentDependencyState {
  if (!skillList || skillList.length === 0) return READY;
  const privateIds = privateSkillIds(uid, agentId);
  const state = dependencyStateFromPlan(planAgentDependencies(
    skillList, privateIds, localSkillState(uid), (name) => builtinCapabilityAvailable(uid, name, appVersion),
  ));
  if (!userDisabledSkills) return state;
  if (typeof userDisabledSkills === 'function') return withUserDisabledDependencies(state, skillList, privateIds, userDisabledSkills);
  if (userDisabledSkills.size === 0) return state;
  return withUserDisabledDependencies(state, skillList, privateIds, (ref) => (userDisabledSkills.has(ref) ? ref : ''));
}
