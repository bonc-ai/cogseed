/**
 * Hub 不可变版本存储 —— 按 `{content_id, version}` 写入 / 解析 / 校验版本副本。
 *
 * 依据**路线 C**（已拍板的客户端 architecture baseline）。让「仍被旧使用钉固的历史版本」
 * 与「用户当前看到的版本」在磁盘上分离，把版本稳定性从 current install 解耦。
 *
 * 契约：specs/010 `contracts/immutable-version-store.md`｜字段表：`data-model.md` §3
 * 需求：FR-023 / FR-024 / FR-025 / FR-027 / FR-028
 *
 * ⚠️ **命名冲突**：`src/main/features/skills/version-store.ts` 是**创作流**的版本信封，
 * 与本模块同名但不同路径，本轮**完全不动、契约不变**（FR-026）。本模块**不与它发生任何交互**。
 *
 * 明确不做：不存 `forked_from`、不维护引用计数（引用靠扫描，crash 安全）、
 * 不做内容树哈希、解析路径不联网也不读停用状态。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { createLogger } from '../../logger';
import { installedVersionOf } from './installed-version';
import {
  userMarketplaceContentVersionsDir,
  userMarketplaceVersionDir,
  userMarketplaceVersionMetaFile,
  userMarketplaceVersionsDir,
  userMarketplaceVersionTreeDir,
} from '../../paths';

const log = createLogger('marketplace/version-store');

/** `meta.json` 的字段集合（FR-028）。**不含 `forked_from`，不含引用计数**（FR-027）。 */
export interface VersionCopyMeta {
  content_id: string;
  version: string;
  /** 取自 A-01 的 `artifact.sha256`。**完整性校验的唯一依据**，不是树哈希。 */
  sha256: string;
  size_bytes: number;
  /** epoch 毫秒。**回收宽限期的计时起点**。 */
  installed_at: number;
  source: 'hub';
}

export interface VersionCopyIdentity {
  contentId: string;
  version: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * `content_id` / `version` 直接进路径，必须是安全的单段名。
 * 拒绝分隔符、`.`/`..`、NUL 与空值——这是路径注入的入口。
 */
function assertSafeSegment(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  if (value.includes('\0') || value.includes('/') || value.includes('\\')
      || value === '.' || value === '..' || value.startsWith('.')) {
    throw new Error(`${label} must be a safe single path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

/** 临时区目录名前缀。解析与枚举一律跳过，半写状态永远不会被当成一个版本。 */
const STAGING_PREFIX = '.staging-';

function isVersionDirName(name: string): boolean {
  return !name.startsWith('.');
}

// ── 写入（FR-023） ────────────────────────────────────────────────────────

/**
 * 写入一份不可变副本。
 *
 * **原子性**：内容先落到同一父目录下的 `.staging-<rand>/`，全部就位后**一次 `rename`** 提交。
 * 因此任何中断留下的都只是 `.staging-*`，**不会出现半写的版本目录**——`rename` 是唯一的提交点。
 *
 * **幂等**：目标已存在即视为已写入（副本不可变，重复写没有意义），直接返回其路径。
 *
 * @param sourceTreeDir 已校验内容的来源目录（安装成功后的内容树）。
 */
export async function writeVersionCopy(
  uid: string,
  identity: VersionCopyIdentity,
  sourceTreeDir: string,
): Promise<string> {
  const contentId = assertSafeSegment(identity.contentId, 'content_id');
  const version = assertSafeSegment(identity.version, 'version');
  if (!identity.sha256) throw new Error('sha256 is required; it is the only integrity basis');

  const target = userMarketplaceVersionDir(uid, contentId, version);
  if (fs.existsSync(target)) {
    log.info('version copy already present', { content_id: contentId, version });
    return target;
  }
  if (!fs.existsSync(sourceTreeDir)) {
    throw new Error(`source tree does not exist: ${sourceTreeDir}`);
  }

  const parent = userMarketplaceContentVersionsDir(uid, contentId);
  await fs.promises.mkdir(parent, { recursive: true });
  const staging = path.join(parent, `${STAGING_PREFIX}${randomBytes(8).toString('hex')}`);

  try {
    await fs.promises.mkdir(staging, { recursive: true });
    // 内容树整体复制。不读、不解析、不哈希内容——二进制与 NUL 字节都必须原样通过（FR-025）。
    await fs.promises.cp(sourceTreeDir, path.join(staging, 'tree'), { recursive: true });

    const meta: VersionCopyMeta = {
      content_id: contentId,
      version,
      sha256: identity.sha256,
      size_bytes: identity.sizeBytes,
      installed_at: Date.now(),
      source: 'hub',
    };
    await fs.promises.writeFile(path.join(staging, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    // 唯一的提交点。此前崩溃只留 `.staging-*`，此后目录必然完整。
    await fs.promises.rename(staging, target);
    log.info('version copy written', { content_id: contentId, version, size_bytes: identity.sizeBytes });
    return target;
  } catch (err) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ── 解析（FR-024） ────────────────────────────────────────────────────────

/**
 * 按 `{content_id, version}` 解析出内容目录。
 *
 * ⚠️ **硬约束**：本函数**不联网、不读停用状态、不看 current install**。
 * 它是 TaskRun pin 解析的稳定内容来源——一次使用开始时钉住的版本，
 * 在停用、更新、卸载之后仍然解析得到。
 *
 * @returns 内容树目录；副本不存在或结构不完整时返回 `null`。
 */
export function resolveVersionCopy(uid: string, contentId: string, version: string): string | null {
  if (!contentId || !version) return null;
  if (contentId.includes('\0') || version.includes('\0')) return null;
  if (!isVersionDirName(version)) return null;

  const tree = userMarketplaceVersionTreeDir(uid, contentId, version);
  const meta = userMarketplaceVersionMetaFile(uid, contentId, version);
  if (!fs.existsSync(tree) || !fs.existsSync(meta)) return null;
  return tree;
}

/** 读取副本的 `meta.json`；不存在或不可解析时返回 `null`。 */
export function readVersionCopyMeta(uid: string, contentId: string, version: string): VersionCopyMeta | null {
  if (!contentId || !version || !isVersionDirName(version)) return null;
  try {
    const raw = fs.readFileSync(userMarketplaceVersionMetaFile(uid, contentId, version), 'utf8');
    const parsed = JSON.parse(raw) as VersionCopyMeta;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// ── 校验（FR-025） ────────────────────────────────────────────────────────

/**
 * 校验一份副本的完整性。
 *
 * ⚠️ **本函数刻意不重算内容摘要。** `artifact.sha256` 是**压缩包字节**的摘要，
 * 从解包后的内容树**无法反推**；而重算一个「内容树哈希」正是 FR-025 明令禁止的做法——
 * `captureSkillTree` 拒绝 NUL 字节、限单文件 2 MiB / 整树 8 MiB，对契约允许的内容
 * （PRD §6.3：解包后 ≤10 MiB、未禁二进制）**即便只是读取也会失败**。
 *
 * 因此完整性的建立分两处，各司其职：
 *   1. **取字节时**由 `source-fetch.ts` 以 `artifact.sha256` + `size_bytes` 校验（FR-011）；
 *   2. **副本落盘后**由本函数做结构自检——目录名与 `meta.json` 自洽、摘要已记录、内容树存在。
 *
 * 任何异常一律判为不通过，绝不放行。
 */
export function verifyVersionCopy(uid: string, contentId: string, version: string): boolean {
  try {
    const meta = readVersionCopyMeta(uid, contentId, version);
    if (!meta) return false;
    // 目录名即事实来源；meta 与之不符说明副本被移动或篡改过。
    if (meta.content_id !== contentId || meta.version !== version) return false;
    if (typeof meta.sha256 !== 'string' || meta.sha256 === '') return false;
    if (typeof meta.size_bytes !== 'number' || !Number.isFinite(meta.size_bytes)) return false;
    if (meta.source !== 'hub') return false;

    const tree = userMarketplaceVersionTreeDir(uid, contentId, version);
    if (!fs.statSync(tree).isDirectory()) return false;
    return fs.readdirSync(tree).length > 0;
  } catch {
    return false;
  }
}

// ── 枚举（供后续回收使用；本模块不实现回收） ──────────────────────────────

export interface VersionCopyRef {
  contentId: string;
  version: string;
  meta: VersionCopyMeta | null;
}

/**
 * 枚举已落盘的版本副本。`.staging-*` 等以点开头的目录一律跳过。
 *
 * ⚠️ 本模块**不实现回收**。回收规则（非终态 pin / current 版本 / 宽限期三条全满足才删）
 * 属 `version-gc.ts`，其 pin 扫描复用 `pin-scan.ts` 的唯一实现，不在此重建。
 */
export function listVersionCopies(uid: string, contentId?: string): VersionCopyRef[] {
  const out: VersionCopyRef[] = [];
  const root = userMarketplaceVersionsDir(uid);
  let contentIds: string[];
  try {
    contentIds = contentId ? [contentId] : fs.readdirSync(root).filter(isVersionDirName);
  } catch {
    return out;
  }
  for (const id of contentIds) {
    let versions: string[];
    try {
      versions = fs.readdirSync(userMarketplaceContentVersionsDir(uid, id)).filter(isVersionDirName);
    } catch {
      continue;
    }
    for (const version of versions) {
      out.push({ contentId: id, version, meta: readVersionCopyMeta(uid, id, version) });
    }
  }
  return out;
}

// ── TaskRun pin 的来源分派支撑（FR-029～FR-033） ──────────────────────────

/**
 * 该 `content_id` 是否由 Hub 不可变版本存储管理。
 *
 * 判据是**本地事实**：Hub 版本存储下有该内容的副本，或安装目录里有成功标记。
 * **不联网、不读停用状态、不读安装清单的目标版本。**
 *
 * 用途：让 pin 的产生与解析按来源分派，而**不改 pin 的形状**——
 * 创作流 Skill 在这两处都不会命中，原路径逐字不变。
 */
export function isHubManagedContent(uid: string, contentId: string): boolean {
  if (!contentId) return false;
  if (installedVersionOf(uid, contentId) !== null) return true;
  return listVersionCopies(uid, contentId).length > 0;
}

/**
 * 取 Hub 内容的 pin 身份：**实际已安装版本** + 该版本副本记录的 `artifact.sha256`。
 *
 * 版本取自 `installed-version.ts`（FR-019 的单一入口），**不是**安装清单的目标版本；
 * 摘要取自版本副本的 `meta.json`。两者缺一即返回 `null`——宁可不产生 pin，
 * 也不产生一个指不到内容的 pin。
 *
 * > 📌 `manifestHash` 字段对 Hub pin 承载的是 `artifact.sha256`。pin 的形状是不变量
 * > （`contracts/pin-dispatch.md`），不得新增字段，故该字段按来源承载对应的内容身份摘要：
 * > 创作流是内容树 manifest 哈希，Hub 是发布物字节摘要。
 */
export function hubPinIdentity(
  uid: string,
  contentId: string,
): { version: string; manifestHash: string } | null {
  const version = installedVersionOf(uid, contentId);
  if (!version) return null;
  const meta = readVersionCopyMeta(uid, contentId, version);
  if (!meta?.sha256) return null;
  return { version, manifestHash: meta.sha256 };
}

/**
 * 按 pin 解析 Hub 版本副本的内容目录。
 *
 * ⚠️ **硬约束**：不联网、不读停用状态、不看 current install。停用、更新、卸载之后，
 * 一次已开始的使用仍然解析到它开始时那一版（FR-031 / FR-042）。
 *
 * 摘要不符即返回 `null`——**不静默降级到 current install**（FR-032）。
 */
export function resolveHubPinnedTree(
  uid: string,
  contentId: string,
  version: string,
  manifestHash: string,
): string | null {
  const tree = resolveVersionCopy(uid, contentId, version);
  if (!tree) return null;
  const meta = readVersionCopyMeta(uid, contentId, version);
  if (!meta?.sha256) return null;
  // pin 记录的身份摘要必须与副本记录一致，否则这不是被钉住的那一份内容。
  if (manifestHash && meta.sha256 !== manifestHash) return null;
  return tree;
}
