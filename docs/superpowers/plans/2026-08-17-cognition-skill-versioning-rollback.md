# 认知资产 Skill 持续迭代与完整回退实施计划

**目标：** 让一条 `skill_method` 认知资产始终绑定同一个 `skillId`；资产发生变化后先生成可审阅的升级草稿，用户确认后才升版；任意新版本都可以查看差异，并将完整 Skill 文件树回退为一个新的历史版本。

**技术栈：** Electron Main TypeScript、Renderer 原生 JavaScript/HTML/CSS、JSON/JSONL 本地存储、Vitest（通过 `npm run test:js`）、现有 Skill 安全校验链路。

**实施原则：** 先补齐稳定绑定和不可变版本模型，再接入升级/回退写入，最后开放 UI。任何阶段都不能让“版本列表看起来存在，但实际只恢复 `SKILL.md`”继续冒充完整回退。

> **实施状态（2026-08-17）：** 已完成主链路实现并接入现有 Recall/CogSeed 流程。当前代码支持完整 Skill 文件树快照、同一资产稳定 `skillId`、升级草稿与 diff、暂缓/拒绝/接受、完整回退、legacy `SKILL.md` 限制回退、手工编辑版本、任务版本 pin、运行时快照、事务 journal 与启动恢复。版本化定向测试 17 个文件、192 个测试通过；`npm run typecheck` 与 `git diff --check` 通过。资源 Python 测试因当前环境缺少 `pytest` 未执行；仓库全量 JS 测试仍有既有基线失败，未作为本次版本化实现的失败判定。

---

## 1. 当前结论

该能力可以实现，但当前代码只能算“有回退入口，没有完整版本闭环”。

现状如下：

- 能力资产自身已经支持不可变版本和回退；回退会生成资产新版本，不改写历史。
- Recall 沉淀首次生成 Skill 时，总是调用 `createCustomSkill`。
- 同一资产更新后，当前实现保留旧 Skill，再创建一个新 `skillId`。
- `readInstalledSkillForAsset` 只承认与资产当前版本完全一致的草稿记录；资产一升级，旧 Skill 绑定会被视为不存在，升级待办也可能因此消失。
- Skill 版本存储目前只保存可选的 `content` 字符串，实际仅代表 `SKILL.md`。
- Skill 回退目前只写回 `SKILL.md`，不会恢复 `references/`、`schemas.json`、`scripts/`、`evals/` 等文件。
- `appendSkillVersion` 没有接入 Recall 生成、升级和常规编辑生产链路，因此新 Skill 常显示为 `unversioned`。
- “查看更新”页面已有壳和回退按钮，但升级 diff、接受、暂缓、拒绝通道尚未接通。
- CogSeed 任务当前只冻结 `allowedSkillIds`，未冻结 Skill 版本；升级或回退不能静默改变一个已经开始的任务所使用的内容。

必须先修复稳定绑定，再实现升级与回退。否则系统无法可靠判断“这是同一 Skill 的新版本”，也无法为用户提供可信的 diff。

---

## 2. 产品语义

### 2.1 资产版本与 Skill 版本分离

- 资产版本回答：方法资产本身发生了什么变化。
- Skill 版本回答：技能库中实际可被加载或执行的文件树发生了什么变化。
- 一次资产变化只产生一个“Skill 升级草稿”，不会自动改写已安装 Skill。
- 用户接受后，升级同一个 `skillId`，并产生一个新的 Skill 版本。
- 用户暂缓后，当前 Skill 保持不变，待办保留但降低打扰。
- 用户拒绝后，该资产版本不再重复建议；资产出现更高版本时可再次生成新建议。

### 2.2 回退不是改写历史

例如当前版本为 `v4`，用户选择恢复 `v2`：

- `v1`、`v2`、`v3`、`v4` 全部保留。
- 系统先展示 `v4 → v2` 的完整文件差异。
- 确认后恢复 `v2` 的文件树，但记录为新的 `v5`。
- `v5.operation = rollback`，并记录 `restoredFromVersion = 2`。
- 能力资产本身不跟随 Skill 回退；二者版本轴保持独立。

### 2.3 运行中的任务不被改写

- 新任务默认解析到 Skill 当前版本。
- 功能上线后新开始的 CogSeed TaskRun 保存 `{ skillId, version, manifestHash }`。
- 任务重试或恢复继续使用原冻结版本，而不是重新解析当前版本。
- 历史运行记录只展示当时的版本引用，不因升级或回退变化。
- 上线前没有版本引用的 legacy TaskRun 明确显示 `unpinned`，不能伪造一个历史版本。

### 2.4 第一阶段边界

本计划覆盖 Recall 认知资产生成的自定义 Skill，并把底层版本服务做成可复用能力。

本计划不包含：

- Marketplace Skill 的发布版本管理。
- 自动把 Skill 回退同步为能力资产回退。
- 自动删除旧实现留下的重复 Skill。
- 跨设备同步完整历史快照；第一阶段沿用 `local/skills/versions`，只保证本机完整回退。
- 未经用户确认自动接受升级。

---

## 3. 目标数据模型

### 3.1 完整 Skill 版本快照

将 `src/main/features/skills/version-store.ts` 从“字符串列表”升级为带 schema 的不可变版本仓库：

```ts
export interface SkillVersionFile {
  path: string;
  content: string;
  contentHash: string;
}

export interface SkillVersionSecurity {
  outcome: 'pass' | 'restricted';
  payloadHash: string;
  scannerVersion?: string;
  rulesetVersion?: string;
  findingCount: number;
  scannedAt: string;
}

export interface SkillVersionSource {
  kind: 'recall_asset' | 'manual_edit' | 'rollback' | 'migration';
  assetId?: string;
  assetVersion?: string;
  draftHash?: string;
  restoredFromVersion?: string;
  runId?: string;
}

export interface SkillVersionRecordV2 {
  schemaVersion: 2;
  revisionId: string;
  version: string;
  parentRevisionId?: string;
  at: string;
  note?: string;
  operation: 'install' | 'upgrade' | 'manual_edit' | 'rollback' | 'migration';
  files: SkillVersionFile[];
  manifestHash: string;
  source: SkillVersionSource;
  generator?: {
    kind: 'model' | 'user' | 'system';
    providerId?: string;
    modelId?: string;
  };
  security: SkillVersionSecurity;
  rollbackScope: 'full_tree';
}

export interface SkillVersionEnvelopeV2 {
  schemaVersion: 2;
  skillId: string;
  currentRevisionId: string;
  records: SkillVersionRecordV2[];
}
```

规则：

- `version` 对新 Recall Skill 使用单调递增整数字符串：`1`、`2`、`3`。
- `revisionId` 是不可变唯一键；UI 可以显示 `v2`，写操作必须使用 `revisionId` 和 `manifestHash` 做并发校验。
- `files` 按规范化相对路径排序，拒绝绝对路径、`..`、重复路径、符号链接和超出大小上限的文件。
- `manifestHash` 对 `path + contentHash` 的稳定排序结果计算 SHA-256。
- 快照不包含 `_install.json`、安全回执、缓存、临时文件和现有 Skill tree ignore 集合中的文件。
- V1 旧记录继续可读，但标记 `rollbackScope: 'skill_md_only'`；UI 不得把它显示成“完整回退”。

### 3.2 资产与 Skill 的稳定绑定

新增 `src/main/features/recall/skill-binding-service.ts`，在 Recall 记录域保存：

```ts
export interface RecallSkillBindingRecord {
  schemaVersion: 1;
  ownerId: string;
  assetId: string;
  skillId: string;
  installedAssetVersion: string;
  currentSkillVersion: string;
  currentRevisionId: string;
  currentManifestHash: string;
  createdAt: string;
  updatedAt: string;
  decisions: Array<{
    assetVersion: string;
    action: 'installed' | 'upgraded' | 'deferred' | 'rejected';
    at: string;
    draftHash?: string;
    skillVersion?: string;
  }>;
  legacySkillIds?: string[];
}
```

规则：

- 一个 `assetId` 最多有一个 active `skillId`。
- 首次安装创建绑定；以后资产版本变化只更新 `installedAssetVersion` 和当前 Skill 版本字段，不更换 `skillId`。
- 绑定写入使用 Recall 记录层现有 revision/CAS 语义，并与 Skill 文件事务共享每 `skillId` 锁。
- `readInstalledSkillForAsset` 改为读取稳定绑定，不再要求 `sourceAssetVersion === asset.version`。
- 另提供 `readRecallSkillFreshness` 返回 `current | upgrade_available | missing | unknown`，避免把“已安装但落后”误报成“尚未创建”。

### 3.3 升级草稿

扩展现有 Recall Skill 草稿，而不是建立第二套模型生成链路：

```ts
type RecallSkillDraftMode = 'install' | 'upgrade';

interface RecallSkillDraftReadyRecord {
  // existing fields...
  mode: RecallSkillDraftMode;
  targetSkillId: string;
  baseRevisionId?: string;
  baseManifestHash?: string;
  diff: SkillTreeDiff;
}
```

- 首次生成使用 `mode: install`，`targetSkillId` 为新分配 ID。
- 已有绑定使用 `mode: upgrade`，`targetSkillId` 必须等于绑定中的稳定 `skillId`。
- 升级时 `skillName` 继续使用已绑定的内部 ID；资产标题变化只能改显示内容，不能触发换 ID。
- 草稿 hash 必须覆盖 `mode`、目标 Skill、基础 revision/hash 和全部文件，防止预览后内容被替换。

---

## 4. 写入与恢复事务

新增 `src/main/features/skills/version-mutation-service.ts` 作为生成、升级、编辑和回退的唯一完整文件树写入口。

一次升级或回退按以下顺序执行：

1. 获取每用户、每 `skillId` 的互斥锁。
2. 读取当前完整文件树并计算 `manifestHash`。
3. 校验请求中的 `expectedManifestHash`，不一致则返回 `skill_changed`，要求重新预览。
4. 将目标文件树写入同一父目录下的隐藏 staging 目录。
5. 在 staging 上执行结构校验、质量校验和深度安全扫描；`blocked`、`unknown` 都不得提交。
6. 生成目标版本记录、绑定变更和事务 journal，但尚不切换 current pointer。
7. 将现有 Skill 目录原子重命名为 backup，再将 staging 原子重命名为正式目录。
8. 校验正式目录 hash 与已扫描 staging hash 完全一致。
9. 原子写入版本 envelope、Recall 绑定和安全回执。
10. 失效 SkillLoader、列表和安全校验缓存，然后删除 backup 和 journal。

任何一步失败：

- 正式目录已切换时，必须从 backup 恢复原目录。
- 版本 envelope 或绑定已经写入时，必须恢复事务开始前的 JSON 快照。
- 保留失败 journal 供启动恢复检查，但不得把失败版本设为 current。
- 启动恢复只处理本服务命名的 staging/backup/journal，不能扫描或删除任意用户目录。

安全校验需要把 `admitCustomSkill` 拆成两个阶段：

- `inspectCustomSkillTree(userId, skillId, skillDir)`：可检查 staging 目录，不写正式回执。
- `recordAdmittedCustomSkill(...)`：正式目录 hash 与检查结果一致后写安全回执。
- 原有 `admitCustomSkill` 保留为兼容包装，避免其他导入链路被迫同时迁移。

---

## 5. 实施任务

### Task 0：冻结行为基线和范围

**文件：**

- Modify: `test/main/features/recall/skill-draft-service.test.ts`
- Modify: `test/main/features/skills/version-store.test.ts`
- Modify: `test/main/features/skills/rollback-service.test.ts`

步骤：

- [x] 增加回归测试，锁定资产升级后保持同一 `skillId` 的行为。
- [x] 增加测试证明旧版本记录只有 `SKILL.md` 内容，不能冒充完整树快照。
- [x] 增加测试证明资产升级后 `readInstalledSkillForAsset` 当前返回空，锁定升级待办丢失的根因。
- [x] 运行定向测试并保存预期失败/通过基线。
- [x] 确认本任务不触碰现有未提交的会话 UI 文件与 `design-qa-assets/`。

验证：

```bash
npm run test:js -- test/main/features/recall/skill-draft-service.test.ts test/main/features/skills/version-store.test.ts test/main/features/skills/rollback-service.test.ts
```

### Task 1：实现完整文件树快照和 V1 兼容读取

**文件：**

- Create: `src/main/features/skills/snapshot-service.ts`
- Modify: `src/main/features/skills/version-store.ts`
- Create: `test/main/features/skills/snapshot-service.test.ts`
- Modify: `test/main/features/skills/version-store.test.ts`

步骤：

- [x] 先写文件路径规范化、排序、内容 hash、manifest hash 的失败测试。
- [x] 覆盖 `SKILL.md`、`references/`、`schemas.json`、`scripts/`、`evals/` 的完整捕获与恢复数据。
- [x] 拒绝绝对路径、路径穿越、重复路径、符号链接、超出数量/单文件/总大小限制的快照。
- [x] 将新存储写为 `SkillVersionEnvelopeV2`，通过 `writeJson` 原子写入。
- [x] 使用 `fileEditLock(versionsPath)` 序列化版本号分配和 current pointer 更新。
- [x] 兼容读取当前 flat-array V1 和 `local/kstar/versions`；转换为只读 `skill_md_only` 视图，不伪造缺失文件。
- [x] 由服务生成不可变 `revisionId`，并对版本号冲突明确报错。

核心测试：

```ts
it('captures every allowed file with stable hashes and ordering')
it('rejects traversal, symlinks, duplicate paths, and oversized trees')
it('appends monotonic immutable full-tree versions under one lock')
it('reads legacy content records as skill-md-only rollback points')
it('does not expose a partial legacy record as full-tree rollbackable')
it('preserves the prior envelope when an atomic write fails')
```

### Task 2：建立资产到 Skill 的稳定绑定

**文件：**

- Create: `src/main/features/recall/skill-binding-service.ts`
- Modify: `src/main/features/recall/skill-draft-service.ts`
- Modify: `src/main/features/recall/index.ts`
- Modify: `src/main/features/cognition/assets-adapter.ts`
- Modify: `src/main/features/cognition/inbox-adapter.ts`
- Create: `test/main/features/recall/skill-binding-service.test.ts`
- Modify: `test/main/features/recall/skill-draft-service.test.ts`
- Modify: `test/main/features/cognition/inbox-adapter.test.ts`

步骤：

- [x] 实现绑定记录的读取、首次创建、CAS 更新、决策追加和完整校验。
- [x] 首次读取时，将仍可识别的 legacy installed draft 懒迁移为绑定；迁移必须保留原 `skillId`。
- [x] 修改 `readInstalledSkillForAsset`，返回稳定绑定的 Skill；另返回 freshness 供 UI 和 inbox 使用。
- [x] 资产版本高于 `installedAssetVersion` 时返回 `upgrade_available`，不能退化成 `missing`。
- [x] 修复 `listCognitionAssets` 和 `listCognitionInbox`，让生成入口、升级待办和当前 Skill ID 同时正确显示。
- [x] 旧行为产生的额外 Skill 只在迁移审计中报告；无法证明关联时保持孤立，禁止按名称自动合并或删除。

核心测试：

```ts
it('keeps one stable skill id after the source asset advances')
it('reports upgrade_available instead of missing for a stale installed skill')
it('lazily migrates a legacy installed draft without changing its skill id')
it('does not auto-link a same-name unrelated custom skill')
it('serializes concurrent binding updates with compare-and-swap')
```

### Task 3：实现文件级和文本级 diff

**文件：**

- Create: `src/main/features/skills/version-diff.ts`
- Create: `test/main/features/skills/version-diff.test.ts`
- Modify: `src/main/features/cognition/types.ts`

步骤：

- [x] 定义 `SkillTreeDiff`：`added`、`modified`、`deleted`、`unchangedCount` 和每个文本文件的有限行差异。
- [x] 使用路径和内容 hash 先做文件级 diff；仅对受支持的 UTF-8 文本生成行差异。
- [x] 行差异设置单文件和总字符上限，超限时返回摘要，避免把大脚本或二进制内容直接送进 Renderer。
- [x] diff API 不返回绝对路径、临时目录、安全回执或被 ignore 的文件。
- [x] 相同 manifest 返回空 diff；换行差异按实际内容保留，不做破坏性归一化。

核心测试：

```ts
it('classifies added, modified, deleted, and unchanged files')
it('returns bounded line hunks for utf-8 text files')
it('summarizes oversized content without leaking the full file')
it('returns an empty diff for equal manifests')
```

### Task 4：把首次安装和升级接入统一事务

**文件：**

- Create: `src/main/features/skills/version-mutation-service.ts`
- Modify: `src/main/features/security/custom-skill-admission.ts`
- Modify: `src/main/features/recall/skill-draft-service.ts`
- Create: `test/main/features/skills/version-mutation-service.test.ts`
- Modify: `test/main/features/security/custom-skill-admission.test.ts`
- Modify: `test/main/features/recall/skill-draft-service.test.ts`

步骤：

- [x] 提取 staging 目录安全检查，使正式 Skill 未切换前即可完成校验。
- [x] 实现每 `skillId` 互斥的事务式 `installVersionedSkillTree` 和 `applyVersionedSkillTree`。
- [x] 首次确认生成 Skill 后立即写 `v1` 完整快照和稳定绑定，不能再出现 `unversioned`。
- [x] 资产变更后的 `prepareRecallSkillDraft` 生成 `mode: upgrade`，目标为现有 `skillId`，并带基础 hash 和完整 diff。
- [x] 升级确认时同时校验 draft hash、Recall context、资产版本、绑定 revision 和当前 manifest hash。
- [x] 通过事务替换完整目录，显式删除新版本中不存在的旧文件，防止陈旧脚本残留。
- [x] 安全结果为 `blocked` 或 `unknown` 时不切换目录、不追加版本、不更新绑定。
- [x] 把原“保留旧 Skill 并创建另一个 Skill”的测试改为“保留同一 ID 并追加版本”。
- [x] 两个并发确认只能有一个成功；另一个得到稳定的 `draft_already_applied` 或 `skill_changed` 结果。

核心测试：

```ts
it('installs a recalled skill as version 1 with a full-tree snapshot')
it('upgrades the same skill id when the source asset advances')
it('removes files deleted by the approved upgrade')
it('rejects a stale preview after the live tree changes')
it('leaves the old tree, version index, and binding intact when scanning fails')
it('restores all three stores when a post-rename persistence step fails')
it('allows only one of two concurrent confirmations to commit')
```

### Task 5：接通升级决策状态和待办生命周期

**文件：**

- Create: `src/main/features/recall/skill-upgrade-service.ts`
- Modify: `src/main/features/recall/formal-assets/inbox.ts`
- Modify: `src/main/features/cognition/inbox-adapter.ts`
- Modify: `test/main/features/recall/formal-assets-inbox.test.ts`
- Create: `test/main/features/recall/skill-upgrade-service.test.ts`

步骤：

- [x] 升级建议只依赖稳定绑定的 `installedAssetVersion < current asset version`，不再依赖“当前版 installed draft”。
- [x] `prepare` 生成或复用当前资产版本的升级草稿，并返回真实 diff。
- [x] `defer` 保存暂缓决定，保留待办但不重复自动生成或高频提醒。
- [x] `reject` 记录被拒绝的资产版本并关闭该版本待办；更高资产版本仍可重新建议。
- [x] `accept` 只调用 Task 4 的统一事务，不能直接逐文件写入。
- [x] 资产在预览后再次变化时，旧决定失效并要求重新生成。

核心测试：

```ts
it('keeps one actionable upgrade item while asset and skill versions differ')
it('does not reopen a rejected suggestion for the same asset version')
it('reopens an upgrade suggestion when a newer asset version appears')
it('defers without mutating the installed skill')
it('requires a fresh preview when the source asset changes')
```

### Task 6：实现完整回退并把回退记录为新版本

**文件：**

- Modify: `src/main/features/skills/rollback-service.ts`
- Modify: `src/main/features/skills/version-mutation-service.ts`
- Modify: `src/main/features/cognition/skill-summary.ts`
- Modify: `test/main/features/skills/rollback-service.test.ts`
- Modify: `test/main/features/cognition.test.ts`

步骤：

- [x] 回退请求使用目标 `revisionId` 和 `expectedCurrentManifestHash`，不只使用可重复的显示版本号。
- [x] 回退前返回当前版本到目标版本的完整 diff 和 `rollbackScope`。
- [x] 新 V2 快照通过统一事务恢复完整文件树并重新执行安全检查。
- [x] 回退成功后分配下一个版本号，记录 `operation: rollback` 和 `restoredFromVersion`。
- [x] 若当前树存在未入版本的手工漂移，先保存 `manual_edit` 恢复点，再继续回退。
- [x] V1 legacy 记录明确显示“仅恢复 SKILL.md”；第一阶段要求二次确认，且成功后立即生成一个完整 V2 快照。
- [x] 回退失败时恢复原目录、版本 current pointer、绑定和安全回执。
- [x] 回退不修改 Recall 能力资产版本或治理状态。

核心测试：

```ts
it('restores SKILL.md, references, schemas, scripts, and deleted paths')
it('records rollback as the next immutable version')
it('re-runs security admission before switching the tree')
it('preserves the current tree and index when rollback fails')
it('captures unversioned drift before rollback')
it('labels and confirms a legacy skill-md-only rollback explicitly')
it('does not change the source ability asset')
```

### Task 7：冻结 CogSeed TaskRun 的 Skill 版本

**文件：**

- Create: `src/main/features/skills/runtime-snapshot-service.ts`
- Modify: `src/main/features/cogseed_backend/types.ts`
- Modify: `src/main/features/cogseed_backend/task-store.ts`
- Modify: `src/main/features/cogseed_backend/runtime-controller.ts`
- Modify: `src/main/features/cogseed_backend/interactive-turn.ts`
- Modify: `src/main/features/cogseed_runtime/protocol.ts`
- Modify: `src/main/features/cogseed_runtime/kernel/types.ts`
- Modify: `src/main/features/cogseed_runtime/runtime-executor.ts`
- Modify: `src/main/features/cogseed_runtime/kernel/tools/runner.ts`
- Modify: `src/main/features/cogseed_runtime/kernel/tools/skill-tools.ts`
- Modify: `test/main/features/cogseed_backend/task-store.test.ts`
- Modify: `test/main/features/cogseed_backend/runtime-controller.test.ts`
- Modify: `test/main/features/cogseed_runtime/runtime-executor.test.ts`
- Modify: `test/main/features/cogseed_runtime/kernel/tool-runtime.test.ts`

步骤：

- [x] 在任务创建时把已绑定、已版本化的 Recall custom Skill ID 解析为 `{ skillId, revisionId, version, manifestHash }`；Marketplace 和尚未建立基线的普通 Skill 继续使用现有 ID allowlist，不在本阶段伪造版本。
- [x] 将引用保存到 `MateTaskRecord.skillVersionPins`，旧任务缺字段或 Skill 未版本化时保持当前兼容行为并标记 `unpinned`。
- [x] 为已冻结版本物化只读 runtime snapshot；路径必须位于用户 `local/skills/runtime-snapshots`，并由 manifest hash 校验。
- [x] 协议只传 ID、revision 和 hash，不接受 Renderer 或模型提供绝对目录。
- [x] `runRuntimeSkillTool` 根据已持久化引用设置 `ORKAS_RUN_SKILL_DIR`，利用现有 runner 的单目录限制执行冻结版本。
- [x] 重试与恢复沿用原任务 refs；新任务才解析新版本。
- [x] 版本升级或回退不能删除仍被非终态任务引用的 runtime snapshot；终态后的清理由单独、可恢复的保留策略完成。

核心测试：

```ts
it('pins the current skill revision when a task is created')
it('keeps the pinned revision after the live skill is upgraded')
it('keeps the pinned revision when a recoverable task resumes')
it('rejects a runtime snapshot whose manifest no longer matches')
it('never accepts a caller-provided absolute skill directory')
```

### Task 8：扩展 IPC 契约

**文件：**

- Modify: `src/main/ipc/index.ts`
- Modify: `test/main/ipc/recall.test.ts`
- Modify: `test/main/ipc/cognition-ipc.test.ts`
- Modify: `test/renderer/ipc-shim-cognition.test.ts`

目标通道：

```ts
recall.skills.prepare({ assetId })
recall.skills.confirm({ assetId, draftHash, expectedManifestHash })
recall.skills.decide({ assetId, draftHash, action: 'defer' | 'reject' })
cognition.skills.summary({ skillId })
cognition.skills.diff({ skillId, fromRevisionId, toRevisionId })
cognition.skills.rollback.preview({ skillId, targetRevisionId })
cognition.skills.rollback({
  skillId,
  targetRevisionId,
  expectedCurrentManifestHash,
  allowPartialLegacy?: boolean,
})
```

步骤：

- [x] IPC 只校验 ID、hash、枚举、长度并调用 feature；事务逻辑不得进入 IPC。
- [x] `summary` 返回 current revision、来源资产版本、安全状态和每版 `rollbackScope`。
- [x] `diff` 和 rollback preview 返回受限大小的渲染安全数据。
- [x] 所有写通道执行用户作用域校验和 expected hash 校验。
- [x] 兼容旧的 `version` 参数；legacy 记录必须显式确认 `SKILL.md` 限制，不能静默执行完整回退。

### Task 9：完成“查看更新”和“版本回退”界面

**文件：**

- Modify: `src/renderer/modules/skills.js`
- Modify: `src/renderer/modules/skills-bindings.js`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Modify: `test/renderer/recall-cognition-flow.test.ts`
- Modify: `test/renderer/skills-cognition-layout.test.ts`
- Modify: `test/renderer/cognition-pages.test.ts`

升级页必须显示：

- 当前 Skill 版本与目标资产版本。
- 新增、修改、删除文件数量。
- 可展开的逐文件 diff；默认先展示 `SKILL.md` 和 governance/validation 相关变化。
- 安全校验状态和受影响 Workspace 数量。
- “确认升级”“暂缓”“拒绝此版本”“保持当前版本”动作。
- 提交中、成功、冲突、扫描失败、内容已变化等明确状态。

回退页必须显示：

- 当前版本、目标版本和“回退后会生成的新版本号”。
- 完整文件差异，尤其突出将被删除或恢复的脚本。
- 安全重新校验说明。
- legacy 单文件回退的醒目限制，不能与完整回退使用相同文案。

交互规则：

- 在 diff 加载完成前禁用确认按钮。
- 提交时锁定重复点击；并发冲突后刷新 summary 和 diff，不假装成功。
- 成功后保持在当前认知资产上下文，刷新资产、inbox、版本 summary 和 Skill 详情。
- 不在 Renderer 自己推断是否可升级、可回退；所有状态来自 Main 返回模型。

### Task 10：接入手工编辑版本和统一缓存失效

**文件：**

- Modify: `src/main/features/skills.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `test/main/features/skills.test.ts`
- Create: `test/main/ipc/skills-versioning.test.ts`

步骤：

- [x] 对已有版本绑定的 Recall Skill，`skills.writeFile` 在写入前后捕获完整树并追加 `manual_edit` 版本。
- [x] 多文件编辑必须走批量事务，不能每写一个文件产生一个用户不可理解的版本。
- [x] 未绑定普通自定义 Skill 保持现有编辑行为；首次打开版本治理时可选择建立基线。
- [x] 所有成功切换统一失效 Skill 列表、SkillLoader、质量报告和安全校验缓存。
- [x] 手工编辑后的资产升级草稿以真实当前 manifest 为 base，不能覆盖用户未审阅的手工修改。

### Task 11：恢复、迁移和可观测性

**文件：**

- Modify: `src/main/features/skills/version-mutation-service.ts`
- Modify: `src/main/util/boot_init.ts`
- Create: `test/main/features/skills/version-recovery.test.ts`

步骤：

- [x] 注册 boot recovery，按 journal 恢复未完成事务。
- [x] 恢复逻辑必须幂等；连续运行两次结果相同。
- [x] 日志只记录 user-safe ID、版本、阶段和粗粒度错误，不记录 Skill 正文。
- [x] 增加 `skill.version.<operation>` 成功/失败日志，payload 仅含 ID、版本、文件数、结果和失败阶段，不记录 Skill 正文。
- [x] 提供只读迁移审计：已绑定、可懒迁移、可能的 legacy orphan、不可完整回退记录数量。
- [x] 不自动删除 staging 之外的目录，不按名称推测所有权，不自动合并孤立 Skill。

---

## 6. 最终验收矩阵

| 场景 | 预期结果 |
| --- | --- |
| 首次从认知资产生成 Skill | 创建一个稳定 `skillId`、`v1` 完整快照和绑定 |
| 资产从 v1 更新到 v2 | 仍显示原 Skill，状态为“有升级候选” |
| 预览升级 | 展示当前树与草稿树的新增/修改/删除文件 diff |
| 接受升级 | 同一 `skillId` 变为 Skill v2，旧版本仍可回退 |
| 暂缓升级 | Skill 文件不变，决定被记录，待办降噪 |
| 拒绝升级 | 当前资产版本的待办关闭，更高资产版本可重新建议 |
| 回退 Skill v2 到 v1 | 完整恢复文件树并生成 Skill v3（rollback from v1） |
| 回退安全扫描失败 | Skill、current pointer、绑定和回执全部保持回退前状态 |
| 两次并发确认 | 仅一次提交成功，不产生重复版本或半写文件 |
| 手工改动后使用旧预览 | 返回冲突并要求重新生成 diff，不覆盖手工改动 |
| 任务运行中升级 Skill | 当前任务继续使用冻结版本，新任务使用新版本 |
| 读取旧 V1 版本记录 | 明确标记只含 `SKILL.md`，不显示为完整回退 |
| 发现旧重复 Skill | 只报告/登记，不自动删除或错误合并 |

---

## 7. 验证命令

每个 Task 先跑对应定向测试；全部完成后执行：

```bash
git diff --check
npm run typecheck
npm run test:js -- \
  test/main/features/skills/snapshot-service.test.ts \
  test/main/features/skills/version-store.test.ts \
  test/main/features/skills/version-diff.test.ts \
  test/main/features/skills/version-mutation-service.test.ts \
  test/main/features/skills/rollback-service.test.ts \
  test/main/features/recall/skill-binding-service.test.ts \
  test/main/features/recall/skill-upgrade-service.test.ts \
  test/main/features/recall/skill-draft-service.test.ts \
  test/main/features/recall/formal-assets-inbox.test.ts \
  test/main/features/cognition.test.ts \
  test/main/ipc/recall.test.ts \
  test/main/ipc/cognition-ipc.test.ts \
  test/main/ipc/skills-versioning.test.ts \
  test/renderer/recall-cognition-flow.test.ts \
  test/renderer/skills-cognition-layout.test.ts \
  test/renderer/cognition-pages.test.ts \
  test/renderer/ipc-shim-cognition.test.ts
npm test
```

完成代码后按仓库约定重启本 worktree 实例：

```bash
scripts/restart-cogseed.sh
```

真实环境验收至少执行一次：

1. 从一个 `skill_method` 资产生成并安装 Skill。
2. 修改该资产形成下一版本。
3. 打开“查看更新”，核对多文件 diff。
4. 确认升级，验证 `skillId` 未变化且版本增加。
5. 创建一个使用该 Skill 的任务并保持运行。
6. 回退到首版，验证完整文件树和安全状态。
7. 验证运行中任务仍引用启动版本，新任务引用回退后的新版本。

---

## 8. 完成定义

只有同时满足以下条件，功能才算完成：

- 同一认知资产连续升级始终保持同一个 `skillId`。
- 升级前必须展示真实完整 diff，并等待用户确认。
- 每次安装、升级、手工编辑和回退均有完整文件树快照。
- 回退恢复完整文件树，并以新版本记录，不改写历史。
- 升级和回退都执行安全重校验；失败不会留下半写状态。
- 版本写入、绑定写入和文件切换具备并发控制与失败恢复。
- 运行中和历史 TaskRun 的版本引用不会被静默改写。
- legacy 单文件记录被诚实标记，旧重复 Skill 不被静默删除。
- Main、IPC、Renderer 定向测试、`npm run typecheck` 和 `npm test` 全部通过。
