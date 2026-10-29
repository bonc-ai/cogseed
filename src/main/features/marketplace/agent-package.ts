/**
 * Agent 发布物（`agent-package-v1`，B-02）→ 安装流程所需的两样东西。
 *
 * 现有安装流程（`marketplace.ts::_installMarketplaceAgentLocked`）只需要：
 *   1. 一份 `agent.json` 内容；
 *   2. 一个"私有技能 zip"（`<name>/SKILL.md` 树）。
 * 本模块把 Hub 的新发布物拆成这两样，下游的扫描、回执、`ownerAgent` 改写、替换与回滚原样复用，
 * 旧格式（`agent_json_url` + 私有技能地址）的 Agent 不经过这里。
 *
 * 包结构（契约草案 B-02，待 Hub 与客户端联合冻结）：
 *   agent.json          必需，作者原文
 *   _meta.json          必需，Hub 发布时写入（`version`、`published_at`）
 *   README.md           可选，不安装
 *   skills/<name>/...   可选，随包私有技能；每个目录含 SKILL.md；<name> 不得是 12 位十六进制
 *
 * 安全：解包前先做 zip 预检（条目数、解压总量、非 ZIP64），逐条目路径必须在包内、不得是符号链接。
 * 下载校验（sha256 与大小）在 `source-fetch.ts`，不过则不返回字节。
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import AdmZip from 'adm-zip';

import { safeId } from '../../storage';
import { classifySkillRef } from '../contribution/agent-package-rules';
import { inspectMarketplaceBundle, parseMarketplaceBundle } from '../marketplace_bundle';
import { fetchImmutableAgentSource, type ImmutableArtifactRef } from './source-fetch';
import { toEpochMillis } from './metadata-adapter';

export const AGENT_PACKAGE_FORMAT = 'agent-package-v1';

export type AgentPackageErrorCode =
  | 'AGENT_PACKAGE_UNSAFE'
  | 'AGENT_PACKAGE_MISSING_FILE'
  | 'AGENT_PACKAGE_INVALID_JSON'
  | 'AGENT_PACKAGE_VERSION_MISMATCH'
  | 'AGENT_PACKAGE_PRIVATE_SKILL';

export class AgentPackageError extends Error {
  constructor(readonly code: AgentPackageErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AgentPackageError';
  }
}

export interface AgentPackage {
  /** `agent.json`，其中 `agent_id` 已改写成安装后的 id。 */
  agentJson: Record<string, unknown>;
  /** 来自 `_meta.json`。 */
  version: string;
  /** 毫秒；`_meta.json` 未给或无法解析时为 `null`。 */
  publishedAt: number | null;
  /** 包内私有技能，已去掉 `skills/` 前缀（`<name>/SKILL.md`…）；没有则为 `null`。 */
  privateSkills: AdmZip | null;
  hasReadme: boolean;
}

const HUB_ID_RE = /^[a-f0-9]{12}$/;

function isSymlink(entry: AdmZip.IZipEntry): boolean {
  // ZIP 的 unix 模式在外部属性高 16 位；S_IFLNK = 0o120000
  return ((entry.header.attr >>> 16) & 0o170000) === 0o120000;
}

function parseJsonObject(file: string, buf: Buffer): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(buf.toString('utf8')); } catch {
    throw new AgentPackageError('AGENT_PACKAGE_INVALID_JSON', `${file} is not valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentPackageError('AGENT_PACKAGE_INVALID_JSON', `${file} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * 读取并检查一个 `agent-package-v1` 的字节。
 *
 * @param opts.expectedVersion 请求的版本；`_meta.json` 的版本必须与之一致（同一 `content_id + version`
 *   永远同字节，不一致说明拿到的不是请求的版本，拒绝而不是将就）。
 * @param opts.installedAgentId 安装后的 Agent id（= Hub 内容 ID），用来改写 `agent.json` 的 `agent_id`。
 */
export function readAgentPackage(
  bytes: Buffer,
  opts: { expectedVersion?: string; installedAgentId: string },
): AgentPackage {
  const zip = parseMarketplaceBundle(bytes);
  const files = new Map<string, AdmZip.IZipEntry>();
  const skillFiles = new Map<string, Array<{ rel: string; entry: AdmZip.IZipEntry }>>();

  for (const { entry, relPath } of inspectMarketplaceBundle(zip)) {
    if (entry.isDirectory) continue;
    if (!relPath) throw new AgentPackageError('AGENT_PACKAGE_UNSAFE', `unsafe entry path: ${entry.entryName}`);
    if (isSymlink(entry)) throw new AgentPackageError('AGENT_PACKAGE_UNSAFE', `symbolic link not allowed: ${relPath}`);
    const parts = relPath.split('/');
    if (parts[0] === 'skills') {
      if (parts.length < 3) continue; // skills/ 下直接的文件不属于任何私有技能，忽略
      const name = parts[1];
      const list = skillFiles.get(name) ?? [];
      list.push({ rel: parts.slice(2).join('/'), entry });
      skillFiles.set(name, list);
    } else if (parts.length === 1) {
      files.set(relPath, entry);
    }
    // 其余顶层子目录：不属于本格式，忽略（不安装）
  }

  const agentEntry = files.get('agent.json');
  if (!agentEntry) throw new AgentPackageError('AGENT_PACKAGE_MISSING_FILE', 'agent.json is missing');
  const metaEntry = files.get('_meta.json');
  if (!metaEntry) throw new AgentPackageError('AGENT_PACKAGE_MISSING_FILE', '_meta.json is missing');

  const agentJson = parseJsonObject('agent.json', agentEntry.getData());
  const meta = parseJsonObject('_meta.json', metaEntry.getData());
  const version = typeof meta.version === 'string' ? meta.version : '';
  if (!version) throw new AgentPackageError('AGENT_PACKAGE_INVALID_JSON', '_meta.json has no version');
  if (opts.expectedVersion && version !== opts.expectedVersion) {
    throw new AgentPackageError('AGENT_PACKAGE_VERSION_MISMATCH', `requested ${opts.expectedVersion}, package is ${version}`);
  }

  // 随包私有技能：名字合法、不是 12 位十六进制、每个都有 SKILL.md
  let privateSkills: AdmZip | null = null;
  for (const [name, list] of skillFiles) {
    if (!safeId(name) || HUB_ID_RE.test(name)) {
      throw new AgentPackageError('AGENT_PACKAGE_PRIVATE_SKILL', `invalid private skill name: ${name}`);
    }
    if (!list.some((f) => f.rel === 'SKILL.md')) {
      throw new AgentPackageError('AGENT_PACKAGE_PRIVATE_SKILL', `private skill ${name} has no SKILL.md`);
    }
    privateSkills ??= new AdmZip();
    for (const { rel, entry } of list) privateSkills.addFile(`${name}/${rel}`, entry.getData());
  }

  // skill_list 里名字形式的条目必须有对应的包内目录，否则包自相矛盾
  const skillList = Array.isArray(agentJson.skill_list) ? agentJson.skill_list : [];
  for (const ref of skillList) {
    if (typeof ref === 'string' && classifySkillRef(ref) === 'bundled' && !skillFiles.has(ref)) {
      throw new AgentPackageError('AGENT_PACKAGE_PRIVATE_SKILL', `skill_list references ${ref} but the package has no skills/${ref}`);
    }
  }

  return {
    agentJson: { ...agentJson, agent_id: opts.installedAgentId },
    version,
    publishedAt: toEpochMillis(meta.published_at) ?? null,
    privateSkills,
    hasReadme: files.has('README.md'),
  };
}

/** 按 `{content_id, version}` 从 Hub 取 B-02 字节（流式落临时文件、sha256 与大小校验），读取后清理临时文件。 */
export async function fetchAgentPackage(req: {
  contentId: string;
  version: string;
  artifact: ImmutableArtifactRef;
  assertContinue?: () => void;
}): Promise<AgentPackage> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `cogseed-agent-pkg-${randomBytes(3).toString('hex')}-`));
  const destPath = path.join(dir, 'agent.zip');
  try {
    await fetchImmutableAgentSource({
      contentId: req.contentId, version: req.version, artifact: req.artifact, destPath,
      ...(req.assertContinue ? { assertContinue: req.assertContinue } : {}),
    });
    const bytes = await fsp.readFile(destPath);
    return readAgentPackage(bytes, { expectedVersion: req.version, installedAgentId: req.contentId });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
