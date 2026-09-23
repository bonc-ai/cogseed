/**
 * Metadata Adapter —— 按 `content_id` 取单个 Skill 元信息的唯一入口。
 *
 * 存在理由：让「按 ID 取 metadata」的**承载方式**成为可替换项，使 Q1 的答案
 * 不阻塞任何调用方。Q1 的答案只影响本模块【内部】，调用方 0 行改动（SC-011）。
 *
 * 契约：specs/010 `contracts/metadata-adapter.md`｜字段表：`data-model.md` §1
 * 需求：FR-001 / FR-002 / FR-003 / FR-005 / FR-007
 *
 * ⚠️ 取代的既有行为：基线 `marketplace.ts` 的 :818 / :947 / :1114 / :1423 四处
 * 以 `POST /marketplace/skills/bundle`（A-02）兼任 metadata 接口。A-02 按 F4
 * 收口后只回不可变字节，这四处必然迁到本模块——与 Q1 的答案无关。
 */

import { createLogger } from '../../logger';
import { normalizeMarketplaceError } from './errors';

const log = createLogger('marketplace/metadata-adapter');

/** 目录页分页上限：服务端把 `size` 超限收敛到 ≤100。 */
const CATALOG_PAGE_SIZE = 100;
/** 分页遍历的硬上限，防目录异常时无限翻页。 */
const CATALOG_MAX_PAGES = 200;
/** 索引有效期：与既有检查节奏（每 6 小时）对齐，**不引入第二套节奏**。 */
const INDEX_TTL_MS = 6 * 60 * 60 * 1000;

/** 发布物元信息（`data-model.md` §1）。完整性校验依据是 `sha256`，不是树哈希。 */
export interface ArtifactMeta {
  sha256: string;
  size_bytes: number;
  format: string;
}

/**
 * 适配层对调用方的统一返回形状。
 *
 * 无论内部走 A-01 全量目录（Q1=a）还是 Hub 按 ID 的详情接口（Q1=b），
 * 字段集合与类型**完全一致**。
 */
export interface SkillMetadata {
  content_id: string;
  version: string;
  /** 官方恒 `"0"`。决定安全扫描档位，不只是展示。 */
  create_uid: string;
  /** 客户端判定停用的唯一判据。 */
  status: string;
  /** **缺席 = 无下限**，以空串表示，**不是 `null`**（FR-005）。 */
  min_app_version: string;
  /** 缺省即未分类，以空串表示。 */
  category: string;
  /** epoch 毫秒。上层**不见时间字符串**（FR-007）。 */
  published_at: number;
  /** epoch 毫秒；源缺席时为 undefined。 */
  updated_at?: number;
  artifact: ArtifactMeta;
  /** 展示用，非冻结契约字段。 */
  name: string;
  /** A-01 目录行既有字段。服务端可能下发 boolean 或 0/1，这里统一归一为 boolean。 */
  default_install: boolean;
  is_open_source: boolean;
}

/** 内部数据源接缝 —— Q1 的答案只换这里。 */
export interface MetadataSource {
  /** 返回原始记录；无此内容返回 null（**不抛错**）。 */
  lookup(contentId: string): Promise<Record<string, unknown> | null>;
  /** 使缓存失效；无缓存的实现可为空操作。 */
  invalidate(): void;
}

// ── 归一化 ────────────────────────────────────────────────────────────────

/**
 * RFC 3339 UTC → epoch 毫秒（FR-007）。
 * 已是数值的直接采用：既有客户端兼容形态下发的就是毫秒。
 */
export function toEpochMillis(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A-01 对这两个字段实测既可能是 boolean 也可能是 0/1，统一收敛为 boolean。 */
function bool(value: unknown): boolean {
  return value === true || value === 1;
}

function readArtifact(raw: Record<string, unknown>): ArtifactMeta {
  const a = (raw.artifact && typeof raw.artifact === 'object' ? raw.artifact : {}) as Record<string, unknown>;
  return { sha256: str(a.sha256), size_bytes: num(a.size_bytes), format: str(a.format) };
}

/**
 * 把一条原始目录记录归一为 `SkillMetadata`。
 *
 * ⚠️ `min_app_version` 与 `category` 的**字段缺席即语义**：缺席不是错误，
 * 分别表示「无下限」与「未分类」，统一以空串承载，上层不再判 null/undefined。
 */
export function normalizeCatalogEntry(raw: Record<string, unknown>): SkillMetadata {
  return {
    content_id: str(raw.content_id) || str(raw.id),
    version: str(raw.version),
    create_uid: str(raw.create_uid),
    status: str(raw.status) || str(raw.state),
    min_app_version: str(raw.min_app_version) || str(raw.minAppVersion),
    category: str(raw.category),
    published_at: toEpochMillis(raw.published_at) ?? 0,
    updated_at: toEpochMillis(raw.updated_at),
    artifact: readArtifact(raw),
    name: str(raw.name),
    default_install: bool(raw.default_install),
    is_open_source: bool(raw.is_open_source),
  };
}

/** 目录列表行的归一形状：`marketplace.ts` 的 `MarketplaceSkill` 所需主键、时间与发布物字段。 */
export type CatalogListRow = Record<string, unknown> & {
  id: string;
  content_id: string;
  published_at: number;
  updated_at: number;
  status?: string;
  min_app_version?: string;
  artifact?: ArtifactMeta;
};

/**
 * 把 A-01 目录列表的一行归一为客户端列表形状（`MarketplaceSkill`）。
 *
 * 目录列表（`listMarketplaceSkills`）与按 ID 取元信息共用同一份字段归一
 * （`normalizeCatalogEntry`），上层不见 `content_id` 与 RFC 3339 字符串（FR-007）：
 * - `id = content_id`，同时保留 `content_id`；旧形态只带 `id` 的行照常可用；
 * - `published_at` / `updated_at` 转为 epoch 毫秒；`updated_at` 缺席时回退到 `published_at`；
 * - `status` 兼容 `state`，`min_app_version` 兼容 `minAppVersion`；
 * - 下发了 `artifact` 时保留归一后的形状。
 * 未识别的原始字段原样保留。取不到 ID 的行无法识别、详情、安装，返回 `null` 由调用方丢弃。
 */
export function normalizeCatalogListRow(raw: unknown): CatalogListRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const meta = normalizeCatalogEntry(row);
  if (!meta.content_id) return null;
  const out: Record<string, unknown> = {
    ...row,
    id: meta.content_id,
    content_id: meta.content_id,
    published_at: meta.published_at,
    updated_at: meta.updated_at ?? meta.published_at,
  };
  if (meta.status) out.status = meta.status;
  if (meta.min_app_version) out.min_app_version = meta.min_app_version;
  if (row.artifact && typeof row.artifact === 'object') out.artifact = meta.artifact;
  else delete out.artifact;
  return out as CatalogListRow;
}

// ── 内部默认数据源：A-01 全量目录 + 本地索引（Q1 = 选项 a） ──────────────

/**
 * **实现假设，不是 Hub 的答复**（Spec 假设 A-06）。
 *
 * 索引由三处调用方**共用一份**，不各建一份（FR-002）。
 */
class CatalogIndexSource implements MetadataSource {
  private index: Map<string, Record<string, unknown>> | null = null;

  private builtAt = 0;

  private inflight: Promise<Map<string, Record<string, unknown>>> | null = null;

  invalidate(): void {
    this.index = null;
    this.builtAt = 0;
  }

  async lookup(contentId: string): Promise<Record<string, unknown> | null> {
    const index = await this.ensureIndex();
    return index.get(contentId) ?? null;
  }

  private async ensureIndex(): Promise<Map<string, Record<string, unknown>>> {
    const fresh = this.index && Date.now() - this.builtAt < INDEX_TTL_MS;
    if (fresh && this.index) return this.index;
    // 并发调用共用同一次构建，避免三处调用方各翻一遍目录。
    this.inflight = this.inflight ?? this.build().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async build(): Promise<Map<string, Record<string, unknown>>> {
    // 延迟取 postJson：`marketplace.ts` 会反过来依赖本模块，函数内取值避免装载期循环。
    const { postJson } = await import('../marketplace');
    const index = new Map<string, Record<string, unknown>>();

    try {
      for (let page = 1; page <= CATALOG_MAX_PAGES; page += 1) {
        const res = await postJson<{ list?: unknown; total?: number }>('/marketplace/skills/list', {
          category: null, status: null, q: null, page, size: CATALOG_PAGE_SIZE,
        });
        const list = Array.isArray(res.list) ? res.list : [];
        for (const row of list) {
          if (!row || typeof row !== 'object') continue;
          const record = row as Record<string, unknown>;
          const id = str(record.content_id) || str(record.id);
          if (id) index.set(id, record);
        }
        // 空结果 `code:0, list:[], total:0` 是**成功**不是错误（FR-003）。
        if (list.length < CATALOG_PAGE_SIZE) break;
      }
    } catch (err) {
      throw normalizeMarketplaceError(err, 'CATALOG_UNAVAILABLE');
    }

    this.index = index;
    this.builtAt = Date.now();
    log.info('catalog index built', { entries: index.size });
    return index;
  }
}

let source: MetadataSource = new CatalogIndexSource();

/**
 * 替换内部数据源。
 *
 * 生产路径不调用；供 Q1 翻转（选项 b）与测试替身使用。
 * 调用方**不感知**本函数的存在（SC-011）。
 */
export function setMetadataSource(next: MetadataSource | null): void {
  source = next ?? new CatalogIndexSource();
}

/** 使共享索引失效。与既有检查节奏对齐，不引入第二套节奏。 */
export function invalidateMetadataIndex(): void {
  source.invalidate();
}

// ── 对调用方的唯一入口 ────────────────────────────────────────────────────

/**
 * 按 `content_id` 取元信息。
 *
 * @returns 无此内容时返回 `null`——**空结果不是错误**（FR-003）。
 *          目录不可用等失败归一为 `MarketplaceError`（FR-014）。
 */
export async function getSkillMetadata(contentId: string): Promise<SkillMetadata | null> {
  if (!contentId) return null;
  const raw = await source.lookup(contentId);
  return raw ? normalizeCatalogEntry(raw) : null;
}
