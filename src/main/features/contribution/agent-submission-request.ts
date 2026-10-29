/**
 * Agent 提交请求体组装 —— 无 Electron、网络、存储依赖的**叶模块**。
 *
 * 为什么单独成叶：`ipc/contribution.ts` 会拉起半个主进程，联调进程导入不了；而这段组装恰恰是
 * 「客户端发出什么」的最后一站。抽成叶模块后，联调脚本可以直接调用客户端的**真实组装代码**，
 * 而不是自己镜像一份（Skill 联调时镜像漂移导致缺陷长期未被发现，见 `upload-manifest.ts`）。
 *
 * 字段集对应 Agent 提交契约的字段规则（Hub 侧 b03）：
 * 与 Skill 的 C-02 同形，`local_skill_id` → `local_agent_id`。Hub 白名单是**拒绝而非忽略**，
 * 所以这里只投影契约允许的键，绝不把超集字段带出去。
 */
import type { ClientCheckResult, ManifestFileEntry } from './upload-manifest';

export interface AgentSubmissionMetadata {
  description: string;
  name: string;
  version: string;
}

/** 提交清单 `metadata.description` 的映射：`description_zh`，缺省取 `description_en`。 */
export function agentDescription(agent: { description_zh?: unknown; description_en?: unknown } | null | undefined): string {
  const zh = typeof agent?.description_zh === 'string' ? agent.description_zh : '';
  if (zh.trim() !== '') return zh;
  return typeof agent?.description_en === 'string' ? agent.description_en : '';
}

/**
 * 只投影契约允许的三个键。`version` 来自提交清单，**不写进 `agent.json`**（Hub 发布时写 `_meta.json`）。
 */
export function agentSubmissionMetadata(
  agent: { name?: unknown; description_zh?: unknown; description_en?: unknown } | null | undefined,
  version: string,
): AgentSubmissionMetadata {
  return {
    description: agentDescription(agent),
    name: String(agent?.name ?? ''),
    version: String(version ?? ''),
  };
}

export interface AgentUploadManifest {
  /** 与 `hub-client.AgentSubmissionManifest` 对齐：上行体按索引签名接收。 */
  [key: string]: unknown;
  content_type: 'agent';
  declarations: Record<string, unknown>;
  file_list: ManifestFileEntry[];
  local_agent_id: string;
  local_check: ClientCheckResult;
  metadata: AgentSubmissionMetadata;
  package_digest: string;
  package_size: number;
  target_content_id: null | string;
}

export interface AgentUploadInput {
  /** 暂存副本里的 `agent.json`（已剥离后的作者原文）。 */
  agent: { name?: unknown; description_zh?: unknown; description_en?: unknown } | null | undefined;
  declarations: Record<string, unknown>;
  fileList: readonly ManifestFileEntry[];
  localAgentId: string;
  localCheck: ClientCheckResult;
  packageDigest: string;
  packageSize: number;
  targetContentId: null | string;
  /** 本次提交的 SemVer。 */
  version: string;
}

export function buildAgentSubmissionManifest(input: AgentUploadInput): AgentUploadManifest {
  return {
    content_type: 'agent',
    declarations: input.declarations,
    file_list: [...input.fileList],
    local_agent_id: input.localAgentId,
    local_check: input.localCheck,
    metadata: agentSubmissionMetadata(input.agent, input.version),
    package_digest: input.packageDigest,
    package_size: input.packageSize,
    target_content_id: input.targetContentId,
  };
}
