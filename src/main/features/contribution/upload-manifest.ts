/**
 * 上行请求体的**组装**：`metadata` 白名单投影 + `manifest` 全字段（C02 §1）。
 *
 * ## 为什么单独抽一个叶模块
 *
 * 两件事都需要一个**无依赖**、可被外部直接调用的地方：
 *
 * 1. **契约白名单**。`inspectCompletion()` 返回的 `present` 是**超集**：除契约允许的
 *    `name` / `description` / `version` 外，有安全声明时还带 `security_manifest`。
 *    Hub 对 `manifest.metadata` 是白名单校验（多余字段拒绝而不是忽略）。原实现用一句类型
 *    断言把它当 metadata 发出去——断言只管类型，运行时的第四个键照样在线上，于是
 *    **每一个带安全声明的提交（即所有合法社区贡献）都被 `UNEXPECTED_FIELD` 拒掉**。
 *    2026-09-28 桌面端真机联调发现。
 * 2. **可联调**。`ipc/contribution.ts` 会拉起半个主进程（Electron、paths、扫描器适配层…），
 *    联调进程导入不了；而这段组装恰恰是「客户端发出什么」的最后一站。抽到叶模块后，
 *    联调脚本可以直接调用**客户端的真实组装代码**，而不是自己镜像一份（镜像会漂移：
 *    上面那个缺陷在镜像里根本不存在，所以一直没被发现）。
 */
export interface SubmissionMetadata {
  description: string
  name: string
  version: string
}

/** 只投影契约允许的三个键；缺项留空串（调用方在此之前已判过 `completion.missing`）。 */
export function submissionMetadata(present: {
  description?: unknown
  name?: unknown
  version?: unknown
} | null | undefined): SubmissionMetadata {
  return {
    description: String(present?.description ?? ''),
    name: String(present?.name ?? ''),
    version: String(present?.version ?? ''),
  }
}

export interface ClientCheckIssue {
  level: string
  message: string
  path?: string
  rule_id: string
}

export interface ClientCheckResult {
  /** 与 `hub-client.ts` 的 `JsonObject` 对齐：上行体按索引签名接收。 */
  [key: string]: unknown
  blocking: ClientCheckIssue[]
  checker: { side: string; version: string }
  warnings: ClientCheckIssue[]
}

export interface ManifestFileEntry {
  path: string
  sha256: string
  size: number
}

/** 上行 `manifest`：字段集**逐字对应** C02 §1 的白名单。 */
export interface SubmissionUploadManifest {
  /** `hub-client.createSubmission()` 收 `SubmissionManifest extends JsonObject`，故需索引签名。 */
  [key: string]: unknown
  content_type: 'skill'
  declarations: Record<string, unknown>
  file_list: ManifestFileEntry[]
  local_check: ClientCheckResult
  local_skill_id: string
  metadata: SubmissionMetadata
  package_digest: string
  package_size: number
  target_content_id: null | string
}

export interface SubmissionUploadInput {
  declarations: Record<string, unknown>
  fileList: readonly ManifestFileEntry[]
  localCheck: ClientCheckResult
  localSkillId: string
  packageDigest: string
  packageSize: number
  /** `inspectCompletion().present`：**超集**，由 `submissionMetadata()` 投影后上行。 */
  present: { description?: unknown; name?: unknown; version?: unknown } | null | undefined
  targetContentId: null | string
}

export function buildSubmissionUploadManifest(input: SubmissionUploadInput): SubmissionUploadManifest {
  return {
    content_type: 'skill',
    declarations: input.declarations,
    file_list: [...input.fileList],
    local_check: input.localCheck,
    local_skill_id: input.localSkillId,
    metadata: submissionMetadata(input.present),
    package_digest: input.packageDigest,
    package_size: input.packageSize,
    target_content_id: input.targetContentId,
  }
}
