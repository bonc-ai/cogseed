/**
 * Agent 更新检查：只依据 Hub 的 B-01 目录判断"有没有新版本"（Hub 契约 B-01 `list[]` 规则第 5 条，2026-10-13）。
 *
 * 三条硬约束，对应三个容易写错的地方：
 * 1. **必须翻完整个目录**（按 `total` 翻页，`size ≤ 100`）。某一页里没有该 `content_id` 不等于它不在目录里；
 *    没翻完时一律不下结论（`catalog_incomplete`），保持现状。
 * 2. **目录里查不到该 `content_id`**（跨通道不可见、从未发布、已从目录移除）**不得**解释成"有新版本"，
 *    只能解释成"当前不可见"——保持既有版本不变。
 * 3. **停用不等于有新版本。**已停用内容仍是目录里的一条记录（`disabled` 与 `status` 同时下发且一致），版本没变就
 *    不触发更新。
 *
 * 比较的是 `version` 与 `artifact.sha256`：版本更高 → 更新；版本相同但摘要不同 → 同版本重新发布，也更新；
 * 目录版本低于本机版本 → 保持（**永不降级**）；版本解析不了 → 保持。
 *
 * 纯函数：目录分页读取以注入的 `fetchPage` 完成，所以不依赖网络，可以直接对各种分页与异常形态做测试。
 * 真正接到 Hub 的 B-01 接口要等联调（接口在 Hub 侧落地后），这里先把判定写对。
 */
import { compareSemVer } from './contribution/version';

/** B-01 目录里与更新判断有关的字段。 */
export interface CatalogAgentRow {
  content_id: string;
  version: string;
  /** `artifact.sha256`；目录项没带则缺省。 */
  artifactSha256?: string;
  /** `published` 或 `disabled`，与 `disabled` 布尔一致；客户端只读这个字符串。 */
  status?: string;
}

export interface InstalledAgentRef {
  id: string;
  version: string;
  /** 本机安装时记下的发布物摘要；旧安装可能没有。 */
  artifactSha256?: string;
}

export type AgentUpdateDecision =
  | { action: 'update'; reason: 'newer_version' | 'republished'; disabled: boolean }
  | {
    action: 'keep';
    reason: 'up_to_date' | 'not_visible' | 'catalog_incomplete' | 'older_than_installed' | 'unparsable_version';
    /** 目录里这条记录是否已被停用；用来更新本机的状态展示，**不**触发内容更新。 */
    disabled: boolean;
  };

export interface CatalogSnapshot {
  /** 是否确认翻完了整个目录。 */
  complete: boolean;
  rows: ReadonlyMap<string, CatalogAgentRow>;
}

const isDisabled = (row: CatalogAgentRow | undefined): boolean => row?.status === 'disabled';

/**
 * 判断一个已装 Agent 要不要更新。
 *
 * @param opts.allowUpdateWhenDisabled 已停用的 Agent 在目录里有更高版本时是否更新。Hub 允许下载已停用内容的发布物，
 *   要不要更是本机策略；缺省 `true`（更新，更新后仍保持停用，不替用户启用）。
 */
export function decideAgentUpdate(
  installed: InstalledAgentRef,
  catalog: CatalogSnapshot,
  opts: { allowUpdateWhenDisabled?: boolean } = {},
): AgentUpdateDecision {
  if (!catalog.complete) return { action: 'keep', reason: 'catalog_incomplete', disabled: false };
  const row = catalog.rows.get(installed.id);
  if (!row) return { action: 'keep', reason: 'not_visible', disabled: false };
  const disabled = isDisabled(row);

  const cmp = compareSemVer(row.version, installed.version);
  if (cmp === null) return { action: 'keep', reason: 'unparsable_version', disabled };
  if (cmp < 0) return { action: 'keep', reason: 'older_than_installed', disabled };

  let decision: AgentUpdateDecision;
  if (cmp > 0) decision = { action: 'update', reason: 'newer_version', disabled };
  else if (installed.artifactSha256 && row.artifactSha256 && installed.artifactSha256 !== row.artifactSha256) {
    decision = { action: 'update', reason: 'republished', disabled };
  } else return { action: 'keep', reason: 'up_to_date', disabled };

  if (disabled && opts.allowUpdateWhenDisabled === false) return { action: 'keep', reason: 'up_to_date', disabled };
  return decision;
}

/** 把 B-01 的一条原始记录整理成判断用的形态；形态不对返回 `null`。 */
export function normalizeCatalogAgentRow(raw: unknown): CatalogAgentRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.content_id === 'string' ? r.content_id : '';
  const version = typeof r.version === 'string' ? r.version : '';
  if (!id || !version) return null;
  const artifact = r.artifact && typeof r.artifact === 'object' ? r.artifact as Record<string, unknown> : null;
  const sha = artifact && typeof artifact.sha256 === 'string' && artifact.sha256 ? artifact.sha256 : undefined;
  // 只读 status 字符串，不读布尔 disabled（与 Skill 一致：Hub 同时下发且一致，客户端只认字符串）
  const status = typeof r.status === 'string' ? r.status : undefined;
  return { content_id: id, version, ...(sha ? { artifactSha256: sha } : {}), ...(status ? { status } : {}) };
}

export interface CatalogPage {
  list: unknown[];
  total: number;
}

/**
 * 翻完整个目录。以下任一情形都返回 `complete: false`，调用方不得据此判断"没有更新"或"有更新"：
 * - 某一页取失败；
 * - 翻到页数上限还没凑够 `total`；
 * - 响应形态不对（`total` 不是非负整数，或 `list` 不是数组）。
 * 空页且已凑够 `total`（含 `total = 0` 的空目录）才算翻完。
 */
export async function fetchCompleteAgentCatalog(
  fetchPage: (page: number, size: number) => Promise<CatalogPage>,
  opts: { size?: number; maxPages?: number } = {},
): Promise<CatalogSnapshot> {
  const size = Math.min(100, Math.max(1, opts.size ?? 100));
  const maxPages = opts.maxPages ?? 200;
  const rows = new Map<string, CatalogAgentRow>();
  let seen = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    let res: CatalogPage;
    try {
      res = await fetchPage(page, size);
    } catch {
      return { complete: false, rows };
    }
    if (!res || !Array.isArray(res.list) || !Number.isInteger(res.total) || res.total < 0) return { complete: false, rows };
    for (const raw of res.list) {
      const row = normalizeCatalogAgentRow(raw);
      if (row) rows.set(row.content_id, row);
    }
    seen += res.list.length;
    if (seen >= res.total) return { complete: true, rows };
    if (res.list.length === 0) return { complete: false, rows }; // 还没凑够 total 却翻到了空页：目录在变，或接口有问题
  }
  return { complete: false, rows };
}
