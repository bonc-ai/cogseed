/**
 * 个人上下文资源注册表 + 游标存储（设计稿 §5.4）。
 *
 * - registry.json：`<uid>/cloud/context/registry.json`（云同步）——ExternalResource 索引
 *   （幂等键 → 资源 + 选择/失效元数据），幂等 upsert：同键同版本重复写入不产生变化。
 * - cursors/<provider>.json：同步水位（watermarks + 事件幂等窗口），只允许显式
 *   advance（CAS，失败不落盘）/ regress（服务端回滚场景）。
 *
 * 候选实体池不在此存储：复用 personal_ontology_candidates 既有数据文件。
 */
import * as path from 'node:path';
import { Mutex } from 'async-mutex';

import { nowIso, readJson, writeJson } from '../../storage';
import { userCloudRoot } from '../../paths';
import { createLogger } from '../../logger';
import type { ExternalResource, ResourceType, SyncCursor } from './contract';
import { EVENT_IDEMPOTENCY_WINDOW, parseResourceKey } from './contract';

const log = createLogger('personal-context:registry');

const REGISTRY_VERSION = 1;
const CURSOR_VERSION = 1;

function contextDir(uid: string): string {
  return path.join(userCloudRoot(uid), 'context');
}

function registryFile(uid: string): string {
  return path.join(contextDir(uid), 'registry.json');
}

function cursorFile(uid: string, providerId: string): string {
  return path.join(contextDir(uid), 'cursors', `${providerId}.json`);
}

// ── 注册表 ────────────────────────────────────────────────────────────────
export interface RegistryEntry {
  resource: ExternalResource;
  /** 用户是否选择接入该资源（可审计的选择状态） */
  selected: boolean;
  selectedAt?: string;
  firstSeenAt: string;
  /** 撤销授权/按范围遗忘时标记失效（资源保留，场景不可见） */
  invalidatedAt?: string;
  invalidateReason?: string;
}

export interface RegistryFile {
  version: number;
  resources: Record<string, RegistryEntry>;
}

export type UpsertChange = 'new' | 'updated' | 'unchanged';

export interface UpsertResult {
  change: UpsertChange;
  resource: ExternalResource;
}

export interface ListOptions {
  providerId?: string;
  types?: ResourceType[];
  /** 默认只返回未失效资源；true 时全部返回 */
  includeInvalid?: boolean;
  selectedOnly?: boolean;
}

const emptyRegistry = (): RegistryFile => ({ version: REGISTRY_VERSION, resources: {} });

const locks = new Map<string, Mutex>();

function lockFor(filePath: string): Mutex {
  let lock = locks.get(filePath);
  if (!lock) {
    lock = new Mutex();
    locks.set(filePath, lock);
  }
  return lock;
}

async function readRegistry(uid: string): Promise<RegistryFile> {
  try {
    const raw = await readJson<Partial<RegistryFile>>(registryFile(uid));
    if (!raw.resources || typeof raw.resources !== 'object') return emptyRegistry();
    return { version: REGISTRY_VERSION, resources: raw.resources as Record<string, RegistryEntry> };
  } catch {
    return emptyRegistry();
  }
}

export class PersonalContextRegistry {
  /**
   * 幂等 upsert（单条）：委托批量 upsertMany（一次锁 + 一次读写）。
   */
  async upsert(uid: string, resource: ExternalResource): Promise<UpsertResult> {
    const [result] = await this.upsertMany(uid, [resource]);
    return result;
  }

  /**
   * 幂等 upsert（批量）：同 resourceId 已存在且 sourceVersion 相同 → unchanged；
   * sourceVersion 不同 → updated（保留 firstSeenAt 与选择状态）；不存在 → new。
   * 幂等键非空且可解析才写入（防御服务端脏数据）。
   *
   * 性能关键：首次回填（30 天/90 天）一次同步几十上百条资源，逐条 upsert 意味着
   * 每条都读+写整个 registry.json；批量提交把 N 次全量读写收敛为 1 次。
   * 语义：整批原子（任一 resourceId 不可解析 → 抛错，整批不落盘），
   * 与 provider.sync「失败不落水位」的契约一致。
   */
  async upsertMany(uid: string, resources: ExternalResource[]): Promise<UpsertResult[]> {
    if (resources.length === 0) return [];
    const file = registryFile(uid);
    const release = await lockFor(file).acquire();
    try {
      const registry = await readRegistry(uid);
      const results: UpsertResult[] = [];
      let dirty = false;
      for (const resource of resources) {
        const parsed = parseResourceKey(resource.resourceId);
        if (!parsed) {
          log.warn('registry upsert rejected: unparsable resourceId', { resourceId: resource.resourceId });
          throw new Error(`registry: unparsable resourceId '${resource.resourceId}'`);
        }
        const existing = registry.resources[resource.resourceId];
        if (existing) {
          // 幂等比较只看 sourceVersion（版本/事件 ID）；observedAt 是观察时间戳，
          // 每次同步都会变化，参与比较会让同版本资源每轮 sync 都变成 updated
          const sameVersion = existing.resource.sourceVersion === resource.sourceVersion;
          if (sameVersion) {
            results.push({ change: 'unchanged', resource: existing.resource });
            continue;
          }
          const next: RegistryEntry = {
            ...existing,
            resource: { ...resource, observedAt: resource.observedAt },
          };
          registry.resources[resource.resourceId] = next;
          results.push({ change: 'updated', resource: next.resource });
        } else {
          registry.resources[resource.resourceId] = {
            resource,
            selected: false,
            firstSeenAt: nowIso(),
          };
          results.push({ change: 'new', resource });
        }
        dirty = true;
      }
      if (dirty) await writeJson(file, registry);
      return results;
    } finally {
      release();
    }
  }

  async get(uid: string, resourceId: string): Promise<RegistryEntry | null> {
    const registry = await readRegistry(uid);
    return registry.resources[resourceId] ?? null;
  }

  async list(uid: string, opts: ListOptions = {}): Promise<RegistryEntry[]> {
    const registry = await readRegistry(uid);
    const entries = Object.values(registry.resources);
    return entries.filter((entry) => {
      if (opts.includeInvalid !== true && entry.invalidatedAt) return false;
      if (opts.selectedOnly === true && !entry.selected) return false;
      if (opts.types && !opts.types.includes(entry.resource.resourceType)) return false;
      if (opts.providerId) {
        const parsed = parseResourceKey(entry.resource.resourceId);
        if (!parsed || parsed.provider !== opts.providerId) return false;
      }
      return true;
    });
  }

  /** 用户选择/取消接入资源；幂等（状态不变时直接返回） */
  async setSelection(uid: string, resourceId: string, selected: boolean): Promise<boolean> {
    const file = registryFile(uid);
    const release = await lockFor(file).acquire();
    try {
      const registry = await readRegistry(uid);
      const entry = registry.resources[resourceId];
      if (!entry) return false;
      if (entry.selected === selected) return true;
      entry.selected = selected;
      entry.selectedAt = nowIso();
      await writeJson(file, registry);
      return true;
    } finally {
      release();
    }
  }

  /** 标记资源失效（撤销授权/遗忘）；再次 markInvalid 幂等 */
  async markInvalid(uid: string, resourceId: string, reason?: string): Promise<boolean> {
    const file = registryFile(uid);
    const release = await lockFor(file).acquire();
    try {
      const registry = await readRegistry(uid);
      const entry = registry.resources[resourceId];
      if (!entry) return false;
      if (entry.invalidatedAt) return true;
      entry.invalidatedAt = nowIso();
      entry.invalidateReason = reason;
      await writeJson(file, registry);
      return true;
    } finally {
      release();
    }
  }

  /** 撤销授权时的整 provider 级联失效（资源保留、标记来源失效） */
  async invalidateProvider(uid: string, providerId: string, reason?: string): Promise<number> {
    const entries = await this.list(uid, { providerId, includeInvalid: true });
    let count = 0;
    for (const entry of entries) {
      if (await this.markInvalid(uid, entry.resource.resourceId, reason)) count += 1;
    }
    return count;
  }

  /** 物理删除（按范围遗忘的可选强删除；默认遗忘走 markInvalid） */
  async remove(uid: string, resourceId: string): Promise<boolean> {
    const file = registryFile(uid);
    const release = await lockFor(file).acquire();
    try {
      const registry = await readRegistry(uid);
      if (!registry.resources[resourceId]) return false;
      delete registry.resources[resourceId];
      await writeJson(file, registry);
      return true;
    } finally {
      release();
    }
  }

  async count(uid: string, opts: ListOptions = {}): Promise<number> {
    return (await this.list(uid, opts)).length;
  }
}

// ── 游标存储 ──────────────────────────────────────────────────────────────
export interface CursorFile {
  version: number;
  providerId: string;
  cursor: SyncCursor;
}

export class CursorConflictError extends Error {
  constructor(providerId: string) {
    super(`cursor conflict: concurrent advance for provider '${providerId}'`);
    this.name = 'CursorConflictError';
  }
}

/** 水位比较：ISO 时间按时间戳、其余按字典序（要求同构零填充） */
function watermarkNewer(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta > tb;
  return a > b;
}

function mergeWatermarks(prev: Record<string, string>, patch: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...prev };
  for (const [type, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '') continue;
    // 水位只升不降；显式回退走 regress
    if (!merged[type] || watermarkNewer(value, merged[type])) {
      merged[type] = value;
    }
  }
  return merged;
}

const cursorLocks = new Map<string, Mutex>();

function cursorLockFor(uid: string, providerId: string): Mutex {
  const key = `${uid}\0${providerId}`;
  let lock = cursorLocks.get(key);
  if (!lock) {
    lock = new Mutex();
    cursorLocks.set(key, lock);
  }
  return lock;
}

async function readCursor(uid: string, providerId: string): Promise<SyncCursor | null> {
  try {
    const raw = await readJson<Partial<CursorFile>>(cursorFile(uid, providerId));
    if (!raw.cursor) return null;
    return {
      watermarks: raw.cursor.watermarks ?? {},
      eventIdempotency: Array.isArray(raw.cursor.eventIdempotency) ? raw.cursor.eventIdempotency : [],
      updatedAt: raw.cursor.updatedAt ?? nowIso(),
    };
  } catch {
    return null;
  }
}

export interface CursorAdvancePatch {
  /** 各资源类型的新水位；与旧水位合并（只升不降） */
  watermarks?: Record<string, string>;
  /** 本次新处理的事件 id；合并去重并按窗口截断 */
  newEventIds?: string[];
}

export class PersonalContextCursorStore {
  async get(uid: string, providerId: string): Promise<SyncCursor | null> {
    return readCursor(uid, providerId);
  }

  /**
   * 推进游标（CAS）：opts.expectedPrev 提供时，若磁盘当前游标与之不一致则抛
   * CursorConflictError（并发同步只有一方能 commit）。同步失败时调用方不应调用
   * advance——水位只落成功处理的数据。
   */
  async advance(
    uid: string,
    providerId: string,
    patch: CursorAdvancePatch,
    opts: { expectedPrev?: SyncCursor } = {},
  ): Promise<SyncCursor> {
    const file = cursorFile(uid, providerId);
    const release = await cursorLockFor(uid, providerId).acquire();
    try {
      const current = await readCursor(uid, providerId);
      if (opts.expectedPrev) {
        const prevMatch = current
          && current.updatedAt === opts.expectedPrev.updatedAt
          && JSON.stringify(current.watermarks) === JSON.stringify(opts.expectedPrev.watermarks)
          && JSON.stringify(current.eventIdempotency) === JSON.stringify(opts.expectedPrev.eventIdempotency);
        if (!prevMatch) throw new CursorConflictError(providerId);
      }
      const watermarks = mergeWatermarks(current?.watermarks ?? {}, patch.watermarks ?? {});
      const mergedEvents = [...(current?.eventIdempotency ?? []), ...(patch.newEventIds ?? [])];
      const deduped = [...new Set(mergedEvents)];
      const next: SyncCursor = {
        watermarks,
        eventIdempotency: deduped.slice(-EVENT_IDEMPOTENCY_WINDOW),
        updatedAt: nowIso(),
      };
      const fileData: CursorFile = { version: CURSOR_VERSION, providerId, cursor: next };
      await writeJson(file, fileData);
      return next;
    } finally {
      release();
    }
  }

  /**
   * 显式回退到旧 checkpoint（服务端数据回滚/清理场景）。
   * 与 advance 不同，regress 允许水位降低；返回回退前的游标便于审计。
   */
  async regress(uid: string, providerId: string, to: SyncCursor): Promise<{ previous: SyncCursor | null }> {
    const file = cursorFile(uid, providerId);
    const release = await cursorLockFor(uid, providerId).acquire();
    try {
      const previous = await readCursor(uid, providerId);
      const next: SyncCursor = {
        watermarks: to.watermarks ?? {},
        eventIdempotency: (to.eventIdempotency ?? []).slice(-EVENT_IDEMPOTENCY_WINDOW),
        updatedAt: nowIso(),
      };
      const fileData: CursorFile = { version: CURSOR_VERSION, providerId, cursor: next };
      await writeJson(file, fileData);
      return { previous };
    } finally {
      release();
    }
  }
}
