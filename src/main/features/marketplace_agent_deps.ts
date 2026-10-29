/**
 * Agent 依赖规划 —— 安装一个 Agent 前，把它的 `skill_list` 归成"要装 / 复用 / 随包 / 阻断"。
 *
 * 纯函数、无 IO：本机状态由调用方以函数注入，所以可以直接对各种组合做表驱动测试，
 * 安装流程（`marketplace.ts`）与"将同时安装"确认框共用同一份规划，不会各算一遍。
 *
 * ## 版本规则（产品 2026-10-10 第 3 条，待 D-13 书面确认）
 * "本机已有该 Skill 时怎么办"集中在 {@link resolveExistingDependency} 一个函数里：
 * 现行规则 = 可用则**复用、不升级**，被 Hub 停用则阻断。产品若改规则（例如 Agent 要求更高版本时升级），
 * **只改这个函数**，规划与安装流程不动。
 *
 * ## 为什么复用而不升级
 * 本机别的 Agent 可能也在用这个 Skill，在途任务可能正固定着它的版本。为装一个 Agent 而升级它，
 * 会影响不相干的使用。升级走 Skill 自己的更新通道（"在途任务固定版本"机制）。
 *
 * ## 与 skill_list 三类写法的关系
 * 12 位十六进制 = Hub Skill；名字形式且在包内 = 随包私有 Skill；`builtin:` = 客户端内置能力：
 * 本机具备（开放清单内、系统 Skill 已就位、客户端版本够）就直接用，不下载；不具备则阻断，也不尝试下载。
 * 存量 Agent 的 `skill_list` 可能出现不符合这三类的写法，保持旧行为：按 Hub Skill 处理，不在此拒绝。
 */
import { classifySkillRef } from './contribution/agent-package-rules';
import { parseBuiltinRef } from './agent_builtin_capabilities';

/** 本机对某个 Skill 的已知状态。 */
export interface LocalSkillState {
  /** 本机有该 Skill（自建或市场安装）。 */
  present: boolean;
  /** 被 Hub 内容级停用（只读 `status` 字符串得出，见 `installed-version.ts`）。 */
  disabled: boolean;
}

/** 本机已有时的处置。 */
export type ExistingDependencyAction = 'reuse' | 'blocked_disabled';

/**
 * **可替换的版本策略**：本机已有该 Skill 时如何处置。
 * 现行：可用 → 复用且不升级；已停用 → 阻断。
 */
export function resolveExistingDependency(local: LocalSkillState): ExistingDependencyAction {
  return local.disabled ? 'blocked_disabled' : 'reuse';
}

export type DependencyKind = 'hub' | 'bundled' | 'builtin';

export type DependencyAction =
  /** 本机已有且可用，直接复用，不升级。 */
  | 'reuse'
  /** 本机没有，需从 Hub 获取。 */
  | 'install'
  /** 随 Agent 一起安装（私有 Skill）。 */
  | 'bundled'
  /** 本机有但被 Hub 停用，Agent 不可用。 */
  | 'blocked_disabled'
  /** 客户端内置能力，本机具备，直接使用，不下载。 */
  | 'builtin'
  /** 客户端内置能力，但本机不具备（不在开放清单内、系统 Skill 未就位或客户端版本不够）。 */
  | 'blocked_builtin_unsupported';

export interface DependencyItem {
  id: string;
  kind: DependencyKind;
  action: DependencyAction;
}

export interface DependencyPlan {
  items: DependencyItem[];
  /** 需要从 Hub 下载的 Skill id，保持 `skill_list` 顺序。 */
  toInstall: string[];
  /** 本机复用的 Skill id。 */
  reused: string[];
  /** 随包安装的私有 Skill id。 */
  bundled: string[];
  /** 本机具备的客户端内置能力（`builtin:<name>` 原样）。 */
  builtin: string[];
  /** 阻断项；非空时 Agent 不可安装/不可用。 */
  blocked: DependencyItem[];
}

/**
 * 规划依赖。
 *
 * @param skillList  `agent.json` 的 `skill_list`（缺省视为空）
 * @param privateIds 随 Agent 提供的私有 Skill id（包内 `<id>/SKILL.md`）
 * @param local      查询本机状态
 */
export function planAgentDependencies(
  skillList: readonly string[] | undefined,
  privateIds: ReadonlySet<string>,
  local: (skillId: string) => LocalSkillState,
  /** 客户端内置能力在本机是否具备；缺省一律不具备（失败关闭）。 */
  builtinAvailable: (name: string) => boolean = () => false,
): DependencyPlan {
  const items: DependencyItem[] = [];
  const seen = new Set<string>();
  for (const raw of skillList ?? []) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);

    // 随包私有 Skill 先于本机判断：别人的私有 Skill 与本机同名 Skill 不是一回事，不得被"本机已有"吞掉
    if (privateIds.has(id)) {
      items.push({ id, kind: 'bundled', action: 'bundled' });
      continue;
    }
    if (classifySkillRef(id) === 'builtin') {
      const name = parseBuiltinRef(id);
      items.push({ id, kind: 'builtin', action: name !== null && builtinAvailable(name) ? 'builtin' : 'blocked_builtin_unsupported' });
      continue;
    }
    const state = local(id);
    if (state.present) {
      items.push({ id, kind: 'hub', action: resolveExistingDependency(state) });
    } else {
      items.push({ id, kind: 'hub', action: 'install' });
    }
  }
  return {
    items,
    toInstall: items.filter((i) => i.action === 'install').map((i) => i.id),
    reused: items.filter((i) => i.action === 'reuse').map((i) => i.id),
    bundled: items.filter((i) => i.action === 'bundled').map((i) => i.id),
    builtin: items.filter((i) => i.action === 'builtin').map((i) => i.id),
    blocked: items.filter((i) => i.action === 'blocked_disabled' || i.action === 'blocked_builtin_unsupported'),
  };
}

/** Agent 在本机是否可用：所有依赖都就绪（复用或随包或已装），且没有阻断项。 */
export type AgentReadiness = 'ready' | 'deps_blocked';

export function agentReadiness(plan: DependencyPlan): AgentReadiness {
  return plan.blocked.length === 0 && plan.toInstall.length === 0 ? 'ready' : 'deps_blocked';
}
