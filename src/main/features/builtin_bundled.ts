/**
 * 随包内容的身份判定：这个 ID 是不是安装包自带的平台智能体 / 技能。
 *
 * 2026-10-21 定：随包内容继续随安装包分发，不走 Hub 分发；Hub 上同 ID 上架（用于统计与
 * 统一查看），技术上能停用，但约定不停用——停用会同步到客户端，波及报销工作台等写死的
 * 引用。用户侧：「已安装」页不列出、不提供停用 / 卸载 / 更新。判据是**安装包里有没有这个 ID**，而不是
 * 安装记录的 `seed_source`：「随包」本来就由安装包定义，而较早的随包记录不一定带这个
 * 标记（`builtin_marketplace.ts` 另用 `create_uid` / `published_at` 推断）。
 *
 * 只依赖 `paths`：`builtin_marketplace.ts` 依赖 `marketplace.ts`，`agents.ts` / `skills.ts`
 * 引它会成环。安装包内容在进程内不变，读一次即可。
 */
import * as fs from 'node:fs';

import { packagedBuiltinMarketplaceAgentsDir, packagedBuiltinMarketplaceSkillsDir } from '../paths';

let _agents: Set<string> | null = null;
let _skills: Set<string> | null = null;

function _readIds(root: string): Set<string> {
  try {
    return new Set(fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[0-9a-f]{12}$/.test(e.name))
      .map((e) => e.name));
  } catch {
    return new Set();
  }
}

export function isBundledAgentId(id: string): boolean {
  if (!_agents) _agents = _readIds(packagedBuiltinMarketplaceAgentsDir());
  return _agents.has(id);
}

export function isBundledSkillId(id: string): boolean {
  if (!_skills) _skills = _readIds(packagedBuiltinMarketplaceSkillsDir());
  return _skills.has(id);
}
