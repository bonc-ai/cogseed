import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import AdmZip from 'adm-zip';

import { safeId } from '../storage';
import { stampOwnerAgent } from './contribution/agent-staging';
import { inspectMarketplaceBundle } from './marketplace_bundle';

/**
 * Return the skill ids materialized by an agent-private skills bundle.
 *
 * Agent bundles are authored as `<skill-id>/SKILL.md` trees. `agent.json.skill_list`
 * is also the runtime allowlist, so it may legitimately contain both these private
 * ids and standalone marketplace skill ids. Installers must only cascade-install
 * the latter.
 */
export function agentPrivateSkillIdsFromBundle(bundle: AdmZip | null): Set<string> {
  const ids = new Set<string>();
  if (!bundle) return ids;

  for (const { entry, relPath } of inspectMarketplaceBundle(bundle)) {
    if (entry.isDirectory) continue;
    if (!relPath) continue;
    const parts = relPath.split('/');
    if (parts.length !== 2 || parts[1] !== 'SKILL.md') continue;
    if (safeId(parts[0])) ids.add(parts[0]);
  }
  return ids;
}

/**
 * 把 Agent 私有 Skill 的 `ownerAgent` 改写成**安装后的 Agent id**。
 *
 * 贡献时 Hub 尚未分配 `content_id`，包里的 `ownerAgent` 写的是贡献者本机的 `agent_id`；安装后
 * Agent 目录名是 Hub 内容 ID，只有两者一致，这些 Skill 才只对该 Agent 可见（别的 Agent 解析为未知，
 * 见 `skills.ts` 的 `ownerAgent` 过滤）。已一致的包（存量官方 Agent）改写是空操作。
 *
 * 只作用于本 Agent 自己的私有 Skill 目录；没有 frontmatter 的 SKILL.md 保持原样（返回里不含它）。
 * 返回实际被写入的 Skill 目录名。
 */
export async function stampPrivateSkillOwners(privateSkillsDir: string, agentId: string): Promise<string[]> {
  const stamped: string[] = [];
  let entries: import('node:fs').Dirent[];
  try { entries = await fsp.readdir(privateSkillsDir, { withFileTypes: true }); } catch { return stamped; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeId(entry.name)) continue;
    const file = path.join(privateSkillsDir, entry.name, 'SKILL.md');
    let text: string;
    try { text = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const next = stampOwnerAgent(text, agentId);
    if (next === null || next === text) continue;
    await fsp.writeFile(file, next, 'utf8');
    stamped.push(entry.name);
  }
  return stamped;
}
