/**
 * S5 内置清单：Hub 模板可以引用的客户端内置内容（角色模板、随包 Agent / Skill、内置能力、连接器类型）。
 *
 * 交给 Hub 做模板发布校验——Brief 要求清单「从客户端事实维护，不能由运营随意填写」，
 * 所以这里只汇总现有注册表，不另写一份列表。形态见
 * `specs/010-hub-workspace-task-templates/contracts/builtin-template-refs.schema.json`。
 *
 * 随包 Agent / Skill 取自已过内置资源门禁的 `resources/builtin/_manifest.json` 的 `inventory`
 * （由调用方读入传进来）：Hub 现有同步脚本读的也是它，两边同源。
 * 纯函数、不读盘、不依赖 Electron，导出脚本和测试都直接调用。
 */

import { listRoleTemplates } from './role_templates';
import { builtinCapabilityManifest } from './agent_builtin_capabilities';
import { connectorCatalog } from './connectors/catalog';

export interface BuiltinInventoryEntry {
  id: string;
  version: string;
}

/** `_manifest.json` 里 `inventory` 中本清单用到的部分。 */
export interface BuiltinInventory {
  marketplace_agents: BuiltinInventoryEntry[];
  marketplace_skills: BuiltinInventoryEntry[];
}

export interface TemplateRefManifest {
  schema_version: 1;
  client_version: string;
  role_templates: Array<{ template_id: string; version: string; name: string }>;
  agents: BuiltinInventoryEntry[];
  skills: BuiltinInventoryEntry[];
  builtin_capabilities: Array<{ id: string; current_version: string; introduced_in: string }>;
  connector_types: Array<{ id: string; name: string }>;
}

function _byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 角色模板保持注册表顺序；其余按 id 排序，保证同一份输入得到同一份输出（`--check` 按字节比对）。 */
export function buildTemplateRefManifest(opts: { clientVersion: string; inventory: BuiltinInventory }): TemplateRefManifest {
  const pick = (list: BuiltinInventoryEntry[]) => list.map(({ id, version }) => ({ id, version })).sort(_byId);
  return {
    schema_version: 1,
    client_version: opts.clientVersion,
    role_templates: listRoleTemplates().map((t) => ({ template_id: t.template_id, version: t.version, name: t.name })),
    agents: pick(opts.inventory.marketplace_agents),
    skills: pick(opts.inventory.marketplace_skills),
    builtin_capabilities: builtinCapabilityManifest()
      .map((c) => ({ id: c.id, current_version: c.current_version, introduced_in: c.introduced_in }))
      .sort(_byId),
    connector_types: connectorCatalog().map((c) => ({ id: c.id, name: c.display_name })).sort(_byId),
  };
}
