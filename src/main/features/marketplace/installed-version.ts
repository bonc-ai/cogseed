/**
 * 「已装实际版本」的**单一判定入口**（FR-019 / FR-020）。
 *
 * ## 权威定义（2026-09-20 收口）
 *
 * Hub 官方副本的 **actual installed version = 已经成功原子落盘的本地内容事实**。
 * 依据三项，全部在本机、全部不联网：
 *
 * 1. **本地内容树存在** —— `<uid>/local/marketplace/skills/<content_id>/`；
 * 2. **安装标记 `_install.json` 的 `version`** —— 它是既有安装链路的 **success marker**，
 *    在内容原子落盘**之后**才写（`marketplace.ts` 安装路径注释原文：
 *    「scanned here, **before the success marker** (`_install.json`)」）；
 * 3. **不可变发布物的完整性** —— `artifact_sha256` / `artifact_size_bytes`，
 *    在取字节时由 `source-fetch.ts` 以 `artifact.sha256` + `size_bytes` 校验（FR-011），
 *    落盘后记录在标记里。
 *
 * > ⚠️ **不要与既有的 `content_sha` 混淆**：`_install.json` 里的 `content_sha` 是
 * > **`SKILL.md` 单文件的摘要**（`sha256OfFile(skillMdFile)`，既有语义，本轮不动），
 * > **不是**发布物字节的 `artifact.sha256`。两者用途不同，故用不同字段名并存。
 *
 * 依据冻结 PRD `doc-v0.5`：§7.8「客户端读取**本机内容树**（不从网络实时读取）……检查内容完整性」、
 * §7.4 第 4 步「全部通过后**原子落盘**……此处写入的 `version` 是**目标版本**」、
 * §7.5「更新写入中断或崩溃，**重启后仍是旧版可用**」。
 *
 * ## 明确禁止
 *
 * - ❌ **用 `installs.json` 的 `version` 冒充实际版本** —— 那是**目标 / 服务端版本**。
 *   更新分两阶段（检查阶段先推进 `version`，对账阶段才替换内容），失败时它会**领先于内容**
 *   （G-A Spike 发现 12）。这正是 FR-019 要防的那件事。
 * - ❌ **用 `bundle_url` 作为下载 authority** —— 字节一律经 `source-fetch.ts` 按
 *   `{content_id, version}` 从 Hub 源站取得（FR-008 / FR-009）。
 * - ❌ **用 `bundle_url` 作为版本身份** —— 版本身份是 `{content_id, version}`，
 *   完整性依据是 `artifact.sha256`。
 * - ❌ **为兼容旧字段伪造 `hub://...` 之类的假地址**。
 * - ❌ **恢复对象存储（COS）直连**。
 *
 * > 📌 `CC-HUB-OPEN1-US3-US6-BUNDLE-URL-001`（`under_review`）：冻结 PRD §7.1 第 190 行
 * > 仍写着「读内容**或 `bundle_url`**」。该句的**实质不变量是「目标版本不得冒充实际已安装版本」**，
 * > `bundle_url` 只是当时可用的机制；A-02 按 F4 收口为只回字节后该机制不复存在。
 * > 改写那句冻结文本需 Owner 批准；**本模块的实现不依赖该批准**——它只需不把目标版本当实际版本。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { userMarketplaceSkillDir } from '../../paths';

const log = createLogger('marketplace/installed-version');

/** 安装成功标记。内容原子落盘之后才写——它的存在即「这一版已经在盘上了」。 */
const INSTALL_MARKER = '_install.json';

/** 判不出实际版本的原因。 */
export type InstalledVersionState =
  /** 内容树不存在——该内容未安装。 */
  | 'absent'
  /** 内容树在，但没有成功标记：落盘未完成或被中断。**不得当作已安装**。 */
  | 'unmarked'
  /** 标记存在但不可解析 / 缺 `version`。 */
  | 'unreadable'
  /** 判定成立。 */
  | 'installed';

export interface InstalledVersionFact {
  contentId: string;
  /** 实际已安装版本；**判不出时为 `null`**，绝不猜。 */
  version: string | null;
  state: InstalledVersionState;
  /** 发布物字节的 `artifact.sha256`，取字节时已校验、落盘时记录。 */
  artifactSha256?: string;
  artifactSizeBytes?: number;
  /** `SKILL.md` 单文件摘要（既有字段，语义与 `artifactSha256` 不同）。 */
  contentSha?: string;
  installedAt?: number;
  /** 本机这一版的发布/更新时间，供 §7.5 的新鲜度比较使用（epoch 毫秒）。 */
  publishedAt?: number;
  updatedAt?: number;
}

function installDirOf(userId: string, contentId: string): string {
  return userMarketplaceSkillDir(userId, contentId);
}

/**
 * 读取一个 Hub 内容的**实际已安装版本事实**。
 *
 * 纯本地、不联网、不读安装清单、不读停用状态。任何异常都归为「判不出」，
 * 不抛错也不回退到目标版本。
 */
export function readInstalledVersion(userId: string, contentId: string): InstalledVersionFact {
  const base: InstalledVersionFact = { contentId, version: null, state: 'absent' };
  if (!userId || !contentId || contentId.includes('\0')) return base;

  let dir: string;
  try {
    dir = installDirOf(userId, contentId);
  } catch {
    return base;
  }

  try {
    if (!fs.statSync(dir).isDirectory()) return base;
  } catch {
    return base;
  }

  const marker = path.join(dir, INSTALL_MARKER);
  if (!fs.existsSync(marker)) {
    // 内容目录在但没有成功标记：落盘未完成。**不得当作已安装的那一版**。
    return { ...base, state: 'unmarked' };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
    const version = typeof parsed.version === 'string' ? parsed.version : '';
    if (!version) return { ...base, state: 'unreadable' };
    return {
      contentId,
      version,
      state: 'installed',
      ...(typeof parsed.artifact_sha256 === 'string' && parsed.artifact_sha256
        ? { artifactSha256: parsed.artifact_sha256 } : {}),
      ...(typeof parsed.artifact_size_bytes === 'number'
        ? { artifactSizeBytes: parsed.artifact_size_bytes } : {}),
      ...(typeof parsed.content_sha === 'string' && parsed.content_sha
        ? { contentSha: parsed.content_sha } : {}),
      ...(typeof parsed.installed_at === 'number' ? { installedAt: parsed.installed_at } : {}),
      ...(typeof parsed.published_at === 'number' ? { publishedAt: parsed.published_at } : {}),
      ...(typeof parsed.updated_at === 'number' ? { updatedAt: parsed.updated_at } : {}),
    };
  } catch (err) {
    log.warn('install marker unreadable', { content_id: contentId, error: (err as Error).message });
    return { ...base, state: 'unreadable' };
  }
}

/**
 * 实际已安装版本的便捷取值。**判不出返回 `null`。**
 *
 * 这是界面展示、`min_app_version` 兼容判定与更新决策**三处共用的唯一入口**（FR-020）。
 */
export function installedVersionOf(userId: string, contentId: string): string | null {
  return readInstalledVersion(userId, contentId).version;
}

/**
 * 目标版本是否**领先于**实际内容——即处于「更新未完成」状态。
 *
 * 供更新决策使用：`true` 表示清单已推进但内容还没换，此时展示与兼容判定
 * 都必须用实际版本，不能用目标版本。
 */
export function isTargetAheadOfContent(
  userId: string,
  contentId: string,
  targetVersion: string | undefined | null,
): boolean {
  if (!targetVersion) return false;
  const actual = installedVersionOf(userId, contentId);
  if (actual === null) return false;
  return actual !== targetVersion;
}

// ── 内容级停用状态（FR-004 / FR-042 / FR-045） ────────────────────────────

/**
 * 内容当前是否可开始新的使用。
 *
 * - `available`：可用；
 * - `disabled`：Hub 侧内容级停用，**阻断新的使用**；
 * - `unknown`：没有本机安装事实，无从判断。
 */
export type ContentAvailability = 'available' | 'disabled' | 'unknown';

/**
 * ⚠️ **只读 `status` / `state` 字符串，绝不读布尔 `disabled`**（FR-004）。
 *
 * 依据冻结 PRD `doc-v0.5` §7.6 的 v0.5 收口（发现 11）：「**客户端判定停用读取的是
 * `status` / `state` 字符串，不读布尔 `disabled`**；故附录 A.2 必须同时下发且二者一致，
 * 只下发 `disabled` 会让本条静默失效。」
 *
 * 只认 `disabled` 这一个取值为停用；其余（`approved` / `published` / 空）一律视为可用——
 * 判错方向应当是「不阻断」，把用户已装的内容误判成停用比漏拦更糟。
 */
const DISABLED_STATUS = 'disabled';

/**
 * 读取本机记录的内容状态。
 *
 * **不联网**：读的是安装标记里**最近一次检查**写下的结果，因此 Hub 不可达时
 * 天然「沿用最近一次检查结果」，既不擅自解除也不擅自施加阻断（FR-045）。
 */
export function readContentStatus(
  userId: string,
  contentId: string,
): { raw: string; availability: ContentAvailability } {
  const fact = readInstalledVersion(userId, contentId);
  if (fact.state === 'absent') return { raw: '', availability: 'unknown' };
  const raw = readRawStatus(userId, contentId);
  return {
    raw,
    availability: raw.trim().toLowerCase() === DISABLED_STATUS ? 'disabled' : 'available',
  };
}

function readRawStatus(userId: string, contentId: string): string {
  try {
    const marker = path.join(userMarketplaceSkillDir(userId, contentId), INSTALL_MARKER);
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
    // 只看字符串字段；布尔 `disabled` 即便存在也**刻意不读**。
    const status = typeof parsed.status === 'string' ? parsed.status : '';
    const state = typeof parsed.state === 'string' ? parsed.state : '';
    return status || state;
  } catch {
    return '';
  }
}

/** 该内容是否被内容级停用，因而**不得开始新的使用**（FR-043）。 */
export function isContentDisabled(userId: string, contentId: string): boolean {
  return readContentStatus(userId, contentId).availability === 'disabled';
}
