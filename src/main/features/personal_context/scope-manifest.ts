/**
 * 接入范围清单（scope-manifest，设计稿 §5.4）。
 *
 * `<uid>/cloud/context/scope-manifest.json`（云同步、可审计）：记录用户勾选接入
 * 的资源（资源类型 + 资源 id + 选择时间）。与注册表联动：
 * - manifest 是"用户意图"的持久记录（谁、何时、勾了什么）；
 * - registry 的 selected 标记是运行时事实（同步/选择过滤用，provider.sync
 *   只同步 selectedOnly 资源）；
 * - save() 保证两者一致：先写 manifest，再逐项 setSelection，未勾选的已登记
 *   资源同步取消选择。
 */
import * as path from 'node:path';

import { nowIso, readJson, writeJson } from '../../storage';
import { userCloudRoot } from '../../paths';
import { createLogger } from '../../logger';
import type { ExternalResource, ResourceType } from './contract';
import { parseResourceKey } from './contract';
import { PersonalContextRegistry } from './registry';

const log = createLogger('personal-context:scope');

const MANIFEST_VERSION = 1;

export interface ScopeManifestEntry {
  resourceId: string;
  resourceType: ResourceType;
  selectedAt: string;
}

export interface ScopeManifestFile {
  version: number;
  updatedAt: string;
  entries: ScopeManifestEntry[];
}

export interface SaveScopeResult {
  changed: boolean;
  manifest: ScopeManifestFile;
}

function manifestFile(uid: string): string {
  return path.join(userCloudRoot(uid), 'context', 'scope-manifest.json');
}

function emptyManifest(): ScopeManifestFile {
  return { version: MANIFEST_VERSION, updatedAt: nowIso(), entries: [] };
}

export class ScopeManifestStore {
  private readonly registry: PersonalContextRegistry;

  constructor(registry: PersonalContextRegistry) {
    this.registry = registry;
  }

  async get(uid: string): Promise<ScopeManifestFile> {
    try {
      const raw = await readJson<Partial<ScopeManifestFile>>(manifestFile(uid));
      if (!Array.isArray(raw.entries)) return emptyManifest();
      return {
        version: MANIFEST_VERSION,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
        entries: raw.entries.filter(isValidEntry),
      };
    } catch {
      return emptyManifest();
    }
  }

  async has(uid: string, resourceId: string): Promise<boolean> {
    const manifest = await this.get(uid);
    return manifest.entries.some((entry) => entry.resourceId === resourceId);
  }

  /**
   * 整体替换接入范围（勾选保存 = 用户显式提交，全量语义，不做增量合并）。
   * - 内容与现有一致 → 不写盘（幂等：重复保存不产生变化）；
   * - 否则写 manifest + 联动注册表选择状态（勾选 true、未勾选的已登记资源 false）。
   * 返回 changed 便于 UI 提示。
   */
  async save(uid: string, resources: ExternalResource[]): Promise<SaveScopeResult> {
    const current = await this.get(uid);
    const entries: ScopeManifestEntry[] = resources.map((resource) => ({
      resourceId: resource.resourceId,
      resourceType: resource.resourceType,
      selectedAt: nowIso(),
    }));

    const sameContent = current.entries.length === entries.length
      && current.entries.every((entry, index) => {
        const next = entries[index];
        return entry.resourceId === next.resourceId && entry.resourceType === next.resourceType;
      });
    if (sameContent) {
      return { changed: false, manifest: current };
    }

    const next: ScopeManifestFile = { version: MANIFEST_VERSION, updatedAt: nowIso(), entries };
    await writeJson(manifestFile(uid), next);

    // 联动注册表：勾选集合内的资源标记 selected；已登记但未勾选的取消选择。
    // 资源未在注册表时先登记（发现即登记由 discover 完成，这里兜底）。
    const selectedIds = new Set(entries.map((entry) => entry.resourceId));
    for (const resource of resources) {
      await this.registry.upsert(uid, resource);
      await this.registry.setSelection(uid, resource.resourceId, true);
    }
    const registered = await this.registry.list(uid, { includeInvalid: false });
    for (const entry of registered) {
      if (!selectedIds.has(entry.resource.resourceId)) {
        await this.registry.setSelection(uid, entry.resource.resourceId, false);
      }
    }
    log.info('scope manifest saved', { uid, count: entries.length });
    return { changed: true, manifest: next };
  }

  /** 撤销授权时清空接入范围（资源保留在注册表，仅失效标记） */
  async clear(uid: string): Promise<void> {
    const next = emptyManifest();
    await writeJson(manifestFile(uid), next);
  }
}

function isValidEntry(value: unknown): value is ScopeManifestEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.resourceId !== 'string' || typeof entry.resourceType !== 'string') return false;
  return parseResourceKey(entry.resourceId) !== null;
}
