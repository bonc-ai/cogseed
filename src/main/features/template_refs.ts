/**
 * S5 模板引用解析：把模板声明的能力（角色模板、Agent、Skill、内置能力）解析为本机状态。
 *
 * 规则（spec FR-010~015）：
 * - 来源只看 `ref.source`，不按 id 形态推断；找不到就是找不到，不按名称纠正、不静默忽略。
 * - 内置依赖本机复用；Hub 依赖已装且兼容则复用，未装 → `needs_fetch`（交给 S4 安装流程，由用户确认）。
 * - 角色模板展开为附带的随包 Agent / Skill；已装 Agent 展开为它依赖的 Skill（复用 S4 的依赖规划）；按 (kind, id) 去重。
 * - 用户自己关掉的 → `user_disabled`，不自动恢复。
 * - 只认内置与已安装内容；空间项目目录里的 Skill 不算满足（不在探测范围内）。
 * - 连接器不在这里判断，见 `connectors/readiness.ts`。
 *
 * 判定是纯函数（`resolveTemplateRefsWith` + 探测接口），读盘在 `localTemplateRefProbe`，与
 * `agent_dependency_state.ts` 同样的拆法，判定可直接表驱动测试。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { userMarketplaceAgentDir } from '../paths';
import { satisfiesMinAppVersion } from '../util/app-version-compat';
import { builtinCapabilityAvailable, localSkillState, privateSkillIds } from './agent_dependency_state';
import { parseBuiltinRef } from './agent_builtin_capabilities';
import { isBundledAgentId, isBundledSkillId } from './builtin_bundled';
import { isAgentEnabled, isSkillEnabled } from './component_enabled';
import { planAgentDependencies } from './marketplace_agent_deps';
import { installedVersionOf, readContentStatus } from './marketplace/installed-version';
import { connectorReadyForType } from './connectors/readiness';
import { getRoleTemplate } from './role_templates';
import type { ConnectorReadiness, RefResolution, RefState, TemplateRef, TemplateRefKind } from './template_types';

/** 本机已有内容（Agent / Skill，任意来源）的状态。 */
export interface LocalContentProbe {
  present: boolean;
  /** 被 Hub 内容级停用。 */
  hubDisabled: boolean;
  /** 用户自己关掉。 */
  userDisabled: boolean;
  version?: string;
}

export interface TemplateRefProbe {
  roleTemplateBundle(id: string): { agent_ids: string[]; skill_ids: string[] } | null;
  bundledAgent(id: string): boolean;
  bundledSkill(id: string): boolean;
  builtinCapability(name: string): boolean;
  agent(id: string): LocalContentProbe;
  skill(id: string): LocalContentProbe;
  /** 已装 Agent 的下层依赖（S4 依赖规划的结果，转成引用）；未装或无依赖返回空。 */
  agentDependencies(id: string): TemplateRef[];
}

const KINDS: ReadonlySet<TemplateRefKind> = new Set(['role_template', 'agent', 'skill', 'builtin_capability', 'connector_type']);

function _content(ref: TemplateRef, local: LocalContentProbe, absent: RefState): RefState {
  if (!local.present) return absent;
  if (local.userDisabled) return 'user_disabled';
  if (local.hubDisabled) return 'disabled';
  const min = ref.compat?.min_version;
  if (min && !(local.version && satisfiesMinAppVersion(local.version, min))) return 'incompatible';
  return 'ready';
}

function _resolveOne(ref: TemplateRef, probe: TemplateRefProbe): RefState {
  if (!KINDS.has(ref.kind) || (ref.source !== 'builtin' && ref.source !== 'hub') || ref.hub_availability === 'unknown') {
    return 'unknown';
  }
  if (ref.source === 'builtin') {
    switch (ref.kind) {
      case 'role_template': return probe.roleTemplateBundle(ref.id) ? 'ready' : 'missing';
      case 'builtin_capability': return probe.builtinCapability(parseBuiltinRef(ref.id) ?? ref.id) ? 'ready' : 'missing';
      case 'agent': return probe.bundledAgent(ref.id) ? _content(ref, probe.agent(ref.id), 'missing') : 'missing';
      case 'skill': return probe.bundledSkill(ref.id) ? _content(ref, probe.skill(ref.id), 'missing') : 'missing';
      default: return 'unknown';
    }
  }
  // Hub 只分发 Agent / Skill；角色模板、内置能力标成 hub 属于引用写错，不猜。
  if (ref.kind !== 'agent' && ref.kind !== 'skill') return 'unknown';
  // Hub availability is the current server-side conclusion. It wins even if an
  // older local copy still exists; otherwise withdrawn/incompatible content can
  // silently pass the create and execution gates.
  if (ref.hub_availability === 'missing') return 'missing';
  if (ref.hub_availability === 'disabled') return 'disabled';
  if (ref.hub_availability === 'incompatible') return 'incompatible';
  const local = ref.kind === 'agent' ? probe.agent(ref.id) : probe.skill(ref.id);
  return _content(ref, local, 'needs_fetch');
}

/** 解析并展开引用；连接器引用被跳过（另行判断）。结果按 (kind, id) 去重，先出现者优先。 */
export function resolveTemplateRefsWith(refs: readonly TemplateRef[], probe: TemplateRefProbe): RefResolution[] {
  const out: RefResolution[] = [];
  const seen = new Set<string>();
  const push = (ref: TemplateRef, via?: TemplateRef): RefState | null => {
    if (ref.kind === 'connector_type') return null;
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const state = _resolveOne(ref, probe);
    out.push({ ref, state, ...(state === 'ready' || state === 'user_disabled' || state === 'disabled' || state === 'incompatible' ? { local_id: ref.id } : {}), ...(via ? { via } : {}) });
    return state;
  };
  for (const ref of refs) {
    const state = push(ref);
    if (state === null) continue;
    if (ref.kind === 'role_template' && state === 'ready') {
      const bundle = probe.roleTemplateBundle(ref.id)!;
      for (const id of bundle.agent_ids) {
        const agentRef: TemplateRef = { source: 'builtin', kind: 'agent', id };
        if (push(agentRef, ref) === 'ready') for (const dep of probe.agentDependencies(id)) push(dep, agentRef);
      }
      for (const id of bundle.skill_ids) push({ source: 'builtin', kind: 'skill', id }, ref);
    } else if (ref.kind === 'agent' && state === 'ready') {
      for (const dep of probe.agentDependencies(ref.id)) push(dep, ref);
    }
  }
  return out;
}

/** 读盘探测。`appVersion` 用于内置能力的引入版本判断。 */
export function localTemplateRefProbe(uid: string, appVersion: string): TemplateRefProbe {
  const skillState = localSkillState(uid);
  const agentJson = (id: string): { skill_list?: string[] } | null => {
    try { return JSON.parse(fs.readFileSync(path.join(userMarketplaceAgentDir(uid, id), 'agent.json'), 'utf8')); } catch { return null; }
  };
  const status = (id: string): boolean => {
    try { return readContentStatus(uid, id).availability === 'disabled'; } catch { return false; }
  };
  const version = (id: string): string | undefined => {
    try { return installedVersionOf(uid, id) ?? undefined; } catch { return undefined; }
  };
  return {
    roleTemplateBundle: (id) => {
      const t = getRoleTemplate(id);
      return t ? { agent_ids: t.bundle?.agent_ids ?? [], skill_ids: t.bundle?.skill_ids ?? [] } : null;
    },
    bundledAgent: isBundledAgentId,
    bundledSkill: isBundledSkillId,
    builtinCapability: (name) => builtinCapabilityAvailable(uid, name, appVersion),
    agent: (id) => {
      const present = agentJson(id) !== null;
      return present
        ? { present, hubDisabled: status(id), userDisabled: !isAgentEnabled(uid, id), version: version(id) }
        : { present, hubDisabled: false, userDisabled: false };
    },
    skill: (id) => {
      const local = skillState(id);
      return local.present
        ? { present: true, hubDisabled: local.disabled, userDisabled: !isSkillEnabled(uid, id), version: version(id) }
        : { present: false, hubDisabled: false, userDisabled: false };
    },
    agentDependencies: (id) => {
      const spec = agentJson(id);
      if (!spec?.skill_list?.length) return [];
      const plan = planAgentDependencies(spec.skill_list, privateSkillIds(uid, id), skillState,
        (name) => builtinCapabilityAvailable(uid, name, appVersion));
      // 随 Agent 提供的私有 Skill 随 Agent 走，不单列。
      return plan.items.flatMap((item): TemplateRef[] => {
        if (item.kind === 'hub') return [{ source: 'hub', kind: 'skill', id: item.id }];
        if (item.kind === 'builtin') return [{ source: 'builtin', kind: 'builtin_capability', id: item.id }];
        return [];
      });
    },
  };
}

export function resolveTemplateRefs(uid: string, refs: readonly TemplateRef[], appVersion: string): RefResolution[] {
  return resolveTemplateRefsWith(refs, localTemplateRefProbe(uid, appVersion));
}

/** 创建 / 启用 / 执行前的完整检查：能力引用 + 连接器类型（连接器只能由用户授权，不能代装）。 */
export function resolveTemplateRequirements(
  uid: string, refs: readonly TemplateRef[], connectorTypes: readonly string[], appVersion: string,
): { items: RefResolution[]; connectors: ConnectorReadiness[] } {
  const types = [...new Set(connectorTypes.filter((t) => typeof t === 'string' && t))];
  return {
    items: resolveTemplateRefs(uid, refs, appVersion),
    connectors: types.map((t) => connectorReadyForType(uid, t)),
  };
}
