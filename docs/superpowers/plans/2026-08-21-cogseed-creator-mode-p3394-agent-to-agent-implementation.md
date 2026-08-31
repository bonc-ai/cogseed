# CogSeed Creator Mode + P3394 Agent-to-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** 在 CogSeed 中实现一个受约束、可审阅、可验证、可版本化和可回滚的 Creator Mode，并把发布后的 preset 通过现有 P3394 Bridge 安全地连接到已登记的远程 Agent。

**Architecture:** Creator Mode 新增为 `src/main/features/creator/` 独立业务域，负责 Agent 设计、验证、审批和版本治理；发布时由 materializer 调用现有 `src/main/features/agents.ts` 的 `createCustomAgent`/`updateCustomAgent`，把 approved preset 绑定到既有 `agent.json` 和 Agent/session runtime。使用 JSON/JSONL 保存草案、不可变版本、激活指针、验证报告、Agent 绑定和审计事件；renderer 只通过既有 `window.cogseed.invoke/stream` 访问脱敏投影。P3394 不另起协议栈，而是在现有 `src/main/features/p3394_bridge/` 的 registry、outbound hub、session/task manager、outbox、replay protection 和 runtime adapter 之上新增受限的远程任务编排，把 peer endpoint、token 和原始 envelope 留在 main 内。

**Tech Stack:** Electron、TypeScript、vanilla renderer JavaScript、JSON/JSONL storage、现有 core-agent model client、现有 P3394 Bridge、Vitest、Node.js。

**技术栈约束：** 本实施在当前技术栈上做增量扩充，不替换现有技术栈和基础设施。允许新增业务模块、类型、服务、IPC channel、renderer 页面/模块、测试 fixture、存储目录和审计能力；这些扩充必须继续使用当前仓库已有的 Electron、TypeScript main、vanilla JavaScript renderer、IPC/preload、JSON/JSONL 存储、模型客户端、P3394 Bridge、测试运行器和脚本。原则上不引入新的运行时或 npm 依赖；不得用 React、JSX、前端 bundler、新 HTTP server、数据库、Python 服务或另一套 Agent/P3394 协议栈替换现有实现。

---

## 0. 实施决策与边界

### 0.1 首版产品范围

本节以及后续所有任务均遵守“在现有技术栈上增量扩充、不替换技术栈”约束；若当前 `develop` 的实际目录结构与计划示例不同，优先适配既有接口和文件组织，通过新增模块和最小修改完成能力扩展，不以迁移技术栈为代价重写现有系统。

首版只交付一种可完整验收的 preset：**远程研究协作者**。

它可以：

- 选择一个已配置的模型；
- 引用已安装且可解析的 Skill/能力；
- 使用只读本地能力；
- 选择已登记的 P3394 peer 与其声明的 capability；
- 设置超时、token/cost 预算、委派深度和审批策略；
- 经过模拟、固定 fixture 验证和用户批准后发布；
- 发送一对一远程任务并把结果、错误和 receipt 投影回本地。

首版不做：动态安装任意插件、任意 JS/import 路径、任意 shell 字符串、任意 URL、A→B→C 多级委派、远程私有 Skill 内容复制、renderer 直连网络。

### 0.2 设计问题的落地答案

| 设计问题 | 首版决定 |
|---|---|
| 第一个 preset 类型 | 远程研究协作者 |
| capability 来源 | 只允许 CogSeed 已登记/已安装能力；不开放模型动态安装第三方代码 |
| P3394 远端对象 | 已登记且 identity/capability 校验通过的 peer；另一台 CogSeed 和兼容节点使用同一 registry 投影 |
| 入站审批 | 首版不开放通用远程入站执行；现有 bridge 行为不扩权。新增 outbound 首次调用每次确认 |
| schema 关系 | `CreatorPresetManifestV1` 只作为创作/治理模型；approved/published 版本必须经 materializer 调用现有 Agent schema/quality gate，写入既有 Agent 记录并建立 preset/version/digest ↔ agentId 绑定 |
| receipt | 所有远程任务终态都写 audit record；成功、拒绝、取消和失败都生成远程执行 receipt |

### 0.2.1 运行面与控制面分工

```text
Creator Mode = Agent 设计、验证、审批控制面
现有 Agent runtime = 本地 Agent 的创建、加载、session 和执行运行面
P3394 Bridge = 跨 Agent 传输、身份、会话、任务、恢复和安全裁决面
```

- Creator 只允许组合已登记、已安装、可审计的 capability 引用；`configRef` 不能是 URL、shell、import path 或 secret。
- Creator preset 不能直接启动第二套 Agent loop。materializer 必须调用 `src/main/features/agents.ts` 的现有创建/更新入口，并通过现有 Agent quality gate。
- 一个运行中的 session 使用创建时的 Agent/preset snapshot；rollback 只切换 active version，不原地改变运行实例。
- P3394 capability、speech act、relationship、context scope、epoch 和 replay 检查必须映射到当前协议类型与 controller，不能创建平行 envelope 或平行 protocol。
- renderer 只能看到脱敏 peer/capability、task/session 状态和结果摘要；endpoint、token、socket、session handle、raw envelope 和认证 header 永不出现在 renderer contract。

### 0.3 数据布局

```text
<uid>/cloud/creator/
  drafts/<draftId>.json
  presets/<presetId>/versions/<version>.json
  presets/<presetId>/state.json
  audit.jsonl

<uid>/local/creator/
  verification/<runId>.json
  trajectories/<runId>.jsonl
  remote-runs/<runId>.json
  agent-bindings/<presetId>.json
```

- `cloud` 保存可同步的用户意图、不可变 manifest、激活状态和审计摘要。
- `local` 保存机器相关验证细节、fixture 输出、Agent materialization 绑定和网络运行记录。
- manifest、renderer 投影和 audit metadata 都不得出现 API key、bearer token、node key、私钥、原始 endpoint、认证 header 或本机绝对路径。

### 0.4 Feature flags

```text
creator_mode_enabled                 # 用户开关，默认 false
creator_mode_publish_enabled         # 用户开关，默认 false
p3394_remote_agent_enabled           # 新远程任务能力，默认 false
p3394_remote_agent_streaming_enabled # P2 流式能力，默认 false
```

环境变量 `COGSEED_CREATOR_MODE=0`、`COGSEED_CREATOR_PUBLISH=0`、`COGSEED_P3394_REMOTE_AGENT=0` 是更高优先级 kill switch。关闭这些 flag 不能影响现有 Agent、group chat、local CLI 或现有 `p3394.external.*` 路径。

### 0.5 基线决策

本次按用户要求，**直接以当前本地 `develop` 为实施基线**，不等待远端同步，也不把 `origin/develop` 当作基准。

当前基线记录为：

```text
branch: develop
commit: 3e016b56edf9b6cf74fe2aebfc8d604d01ca0ece
```

实施约束：

- 先记录当前 `develop` 的完整 SHA，后续所有 contract diff、验证报告和回滚说明都以该 SHA 为基线；
- 当前工作树包含 renderer 重写相关未跟踪文件，不能清理、覆盖或 reset；
- 在当前 `develop` 的同一提交上创建独立 worktree/feature branch 实施；
- 远端 `origin/develop` 是否落后不影响本次实施，也不在本任务中强制 fetch；
- 如果实施期间用户继续向当前 `develop` 提交变更，必须重新记录新的基线 SHA，不得混用两个基线。

---

## 1. 文件结构

### Creator Mode 新文件

| 文件 | 责任 |
|---|---|
| `src/main/features/creator/types.ts` | manifest、draft、verification、receipt、audit 的稳定类型 |
| `src/main/features/creator/schema.ts` | 纯函数校验、边界限制、秘密字段拒绝和规范化 |
| `src/main/features/creator/flags.ts` | 用户开关与环境 kill switch |
| `src/main/features/creator/store.ts` | 草案、不可变版本、状态指针和审计存储 |
| `src/main/features/creator/catalog.ts` | model/Skill/tool/P3394 peer 的脱敏能力目录 |
| `src/main/features/creator/inspect-service.ts` | Creator inspect 快照 |
| `src/main/features/creator/proposal-service.ts` | 自然语言目标 → 模型输出 → 严格 manifest 草案 |
| `src/main/features/creator/simulation-service.ts` | disposable scope 和 mock capability 执行 |
| `src/main/features/creator/verification-service.ts` | fixture/golden task、policy 检查和报告 |
| `src/main/features/creator/lifecycle-service.ts` | approve/publish/activate/disable/rollback 状态机 |
| `src/main/features/creator/materializer.ts` | approved/published preset → 现有 Agent schema/runtime 的受控物化 |
| `src/main/features/creator/agent-binding-store.ts` | preset/version/digest 与既有 agentId 的可追溯绑定 |
| `src/main/features/creator/remote-execution-service.ts` | preset policy 与 P3394 remote task 的联合入口 |
| `src/main/features/creator/index.ts` | 对外导出，不暴露存储细节 |
| `src/main/prompts/creator_preset.md` | 只生成 JSON manifest proposal 的静态提示词 |
| `src/main/ipc/creator.ts` | 参数校验后调用 feature；不放业务逻辑 |

### P3394 修改/新增文件

| 文件 | 责任 |
|---|---|
| `src/main/features/p3394_bridge/renderer-projection.ts` | peer/session/task/receipt 的脱敏 renderer view |
| `src/main/features/p3394_bridge/remote-agent-service.ts` | 基于既有 registry/session/task/outbox 的一对一 outbound send/cancel/read-run 编排；不向 renderer 暴露连接或 session handle |
| `src/main/features/p3394_bridge/remote-run-store.ts` | 本地 remote run 终态和 receipt |
| `src/main/features/p3394_bridge/outbound-hub.ts` | 补充显式 cancel、状态观察和可靠终止；复用现有 outbox |
| `src/main/features/p3394_bridge/app-wiring.ts` | 只向新 service 提供 main 内部 handle；不向 renderer 返回 endpoint/token |
| `src/main/ipc/p3394_agent.ts` | 新 `p3394.agent.*` invoke/stream handlers；只暴露 peer 摘要、send/cancel/read-run 和状态事件 |
| `src/main/ipc/p3394_external.ts` | 移除 renderer 响应中的 endpoint，保持旧 UI 所需字段兼容 |

### Renderer 修改/新增文件

CogSeed 当前 renderer 是 classic script，不引入 React、TypeScript、JSX 或 bundler。

| 文件 | 责任 |
|---|---|
| `src/renderer/modules/creator-mode.js` | Creator UI 状态、IPC 调用、manifest diff、验证和发布流程 |
| `src/renderer/modules/p3394-remote-agent.js` | peer 选择、审批、远程任务状态与取消 |
| `src/renderer/index.html` | 在 Agent modal 增加 Creator tab，并按顺序加载新脚本 |
| `src/renderer/style.css` | 复用现有 modal/tab/card 类，新增最少修饰类 |
| `src/renderer/locales/zh-CN.json` | 中文 UI 文案 |
| `src/renderer/locales/en.json` | 英文 UI 文案 |
| `src/main/locales/zh-CN.json` | main 生成的 Creator/P3394 错误文案 |
| `src/main/locales/en.json` | main 生成的 Creator/P3394 错误文案 |

---

## 2. Task 1：冻结当前 develop 基线、建立隔离 worktree 和契约快照

**Files:**
- Read: `AGENTS.md`
- Read: `docs/superpowers/specs/2026-08-21-cogseed-creator-mode-p3394-agent-to-agent-design.md`
- Create: `docs/superpowers/migrations/2026-08-21-creator-p3394-baseline.md`
- Generate/verify: `src/renderer-app/ipc/contract.generated.json`

- [ ] **Step 1: 记录当前 develop 基线**

```bash
cd /Users/sudai/Documents/CogSeed
git switch develop
git rev-parse HEAD
git log -1 --format='%H%n%ad%n%an <%ae>%n%s' --date=iso-strict
```

Expected: 记录当前 `develop` 的完整 40 位 SHA；本次实施以该 SHA 为唯一基线，不执行 `git fetch`，也不使用 `origin/develop` 替换它。

- [ ] **Step 2: 从当前 develop 创建独立 worktree**

```bash
git worktree add -b feat/creator-mode-p3394-a2a \
  /Users/sudai/Documents/CogSeed/.worktrees/creator-mode-p3394-a2a develop
```

Expected: 新 worktree 从当前本地 `develop` 创建；原 `/Users/sudai/Documents/CogSeed` 的未跟踪 renderer 重写文件保持不变。

- [ ] **Step 3: 把已评审设计和本计划带入 worktree**

```bash
mkdir -p /Users/sudai/Documents/CogSeed/.worktrees/creator-mode-p3394-a2a/docs/superpowers/{specs,plans,migrations}
cp /Users/sudai/Documents/CogSeed/docs/superpowers/specs/2026-08-21-cogseed-creator-mode-p3394-agent-to-agent-design.md \
  /Users/sudai/Documents/CogSeed/.worktrees/creator-mode-p3394-a2a/docs/superpowers/specs/
cp /Users/sudai/Documents/CogSeed/docs/superpowers/plans/2026-08-21-cogseed-creator-mode-p3394-agent-to-agent-implementation.md \
  /Users/sudai/Documents/CogSeed/.worktrees/creator-mode-p3394-a2a/docs/superpowers/plans/
```

- [ ] **Step 4: 记录基线证据**

`docs/superpowers/migrations/2026-08-21-creator-p3394-baseline.md` 必须记录：完整 SHA、日期、现有 IPC channel 数、P3394 定向测试命令和当前结果、feature flag 默认关闭策略。

- [ ] **Step 5: 运行基线门禁**

```bash
cd /Users/sudai/Documents/CogSeed/.worktrees/creator-mode-p3394-a2a
npm ci
npm run typecheck
node scripts/run-tests.mjs run \
  test/main/features/p3394 \
  test/main/features/p3394_bridge \
  --maxWorkers=1 --reporter=dot
node scripts/capture-ipc-contract.cjs --check
```

Expected: typecheck 和当前基线已有 P3394 tests 通过；contract snapshot 没有无解释差异。脚本参数若在当前 `develop` 已变化，以 `node scripts/capture-ipc-contract.cjs --help` 的实际输出为准并把命令写入基线记录。

- [ ] **Step 6: 提交基线文档**

```bash
git add docs/superpowers/specs docs/superpowers/plans docs/superpowers/migrations/2026-08-21-creator-p3394-baseline.md
git commit -m "docs: freeze creator mode and p3394 implementation baseline"
```

---

## 3. Task 2：冻结 Creator Manifest V1、限制和 feature flags

**Files:**
- Create: `src/main/features/creator/types.ts`
- Create: `src/main/features/creator/schema.ts`
- Create: `src/main/features/creator/flags.ts`
- Create: `src/main/features/creator/index.ts`
- Modify: `src/main/features/config.ts`
- Test: `test/main/features/creator/schema.test.ts`
- Test: `test/main/features/creator/flags.test.ts`

- [ ] **Step 1: 写 schema 失败测试**

测试至少构造一个合法 manifest，并拒绝以下输入：

```ts
expect(validateCreatorPresetManifest(validManifest).ok).toBe(true);
expect(validateCreatorPresetManifest({ ...validManifest, capabilities: [{ capabilityId: 'x', version: '1', configRef: 'https://evil.test' }] }).ok).toBe(false);
expect(validateCreatorPresetManifest({ ...validManifest, permissions: { ...validManifest.permissions, networkPeers: ['https://peer.test'] } }).ok).toBe(false);
expect(validateCreatorPresetManifest({ ...validManifest, secret: 'sk-live-value' }).ok).toBe(false);
expect(validateCreatorPresetManifest({ ...validManifest, remote: { allowedPeers: ['peer-a'], allowedCapabilities: ['research.answer'], delegation: { maxDepth: 4, maxFanout: 1, requireApproval: true } } }).ok).toBe(false);
```

- [ ] **Step 2: 确认测试先失败**

```bash
node scripts/run-tests.mjs run test/main/features/creator/schema.test.ts --maxWorkers=1 --reporter=dot
```

Expected: FAIL，因为 `features/creator/schema` 尚不存在。

- [ ] **Step 3: 定义稳定类型**

`types.ts` 使用以下顶层模型，不允许任意扩展字段穿透到持久化层：

```ts
export type CreatorPresetLifecycle =
  | 'draft' | 'sandboxed' | 'verified' | 'approved'
  | 'published' | 'active' | 'disabled' | 'rolled_back' | 'rejected';

export interface CreatorPresetManifestV1 {
  schemaVersion: 1;
  presetId: string;
  version: string;
  parentVersion?: string;
  displayName: string;
  description: string;
  presetType: 'remote-research-collaborator';
  model: { providerId: string; modelId: string; reasoningProfile?: string };
  capabilities: Array<{ capabilityId: string; version: string; configRef?: string }>;
  prompt: { systemSections: string[]; locale?: string };
  runtime: {
    sessionPolicy: 'new-per-run' | 'resume-explicit';
    memoryPolicy: 'none' | 'read-only';
    loopPolicy: 'single-agent';
    sandboxProfile: 'creator-read-only-v1';
    timeoutMs: number;
    budget: { maxCost?: number; maxTokens?: number };
  };
  permissions: {
    tools: string[];
    files: string[];
    networkPeers: string[];
    sideEffects: string[];
    approvalMode: 'always' | 'on-risk' | 'preapproved';
  };
  remote?: {
    allowedPeers: string[];
    allowedCapabilities: string[];
    delegation: { maxDepth: number; maxFanout: number; requireApproval: boolean };
  };
  provenance: {
    createdBy: 'user' | 'creator-agent';
    sourceSessionId: string;
    sourceAssetRefs: string[];
    verificationRunId?: string;
  };
}
```

- [ ] **Step 4: 实现纯校验器**

`schema.ts` 必须：

- 只接受普通对象和稠密数组；
- 对每层使用 allow-list keys；
- `presetId`、peer id、capability id 使用 `safeId` 或更严格的点号命名校验；
- timeout 限制为 1 秒到 30 分钟；
- `maxDepth` 首版只能为 `0` 或 `1`，`maxFanout` 必须为 `1`；
- `files` 只能为逻辑 grant id，不能为绝对路径、`..` 或 `~`；
- 拒绝任意 key 名匹配 `/api.?key|token|secret|password|private.?key|authorization|endpoint|base.?url|command|shell|import.?path/i`；
- 拒绝 `networkPeers`/`allowedPeers` 之外的 URL；
- 返回 `{ ok: true, value } | { ok: false, issues }`，issue 使用稳定 code 和字段 path。

- [ ] **Step 5: 增加用户开关和 kill switch**

在 `config.ts::UserPreferences` 加入：

```ts
creator_mode_enabled?: boolean;
creator_mode_publish_enabled?: boolean;
p3394_remote_agent_enabled?: boolean;
p3394_remote_agent_streaming_enabled?: boolean;
```

`flags.ts` 对未写入偏好返回 `false`，并让对应 `COGSEED_*='0'` 强制关闭。

- [ ] **Step 6: 运行测试和 typecheck**

```bash
node scripts/run-tests.mjs run \
  test/main/features/creator/schema.test.ts \
  test/main/features/creator/flags.test.ts \
  --maxWorkers=1 --reporter=dot
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/main/features/creator src/main/features/config.ts test/main/features/creator
git commit -m "feat: define creator preset v1 contract"
```

---

## 4. Task 3：实现不可变 preset store、active 指针和 append-only audit

**Files:**
- Modify: `src/main/paths.ts`
- Create: `src/main/features/creator/store.ts`
- Test: `test/main/features/creator/store.test.ts`

- [ ] **Step 1: 写存储不变量测试**

覆盖：

```ts
await saveCreatorDraft(uid, draft);
const v1 = await publishCreatorPresetVersion(uid, draft.draftId, '1');
await expect(publishCreatorPresetVersion(uid, draft.draftId, '1')).rejects.toThrow('creator_preset_version_exists');
await activateCreatorPresetVersion(uid, v1.presetId, '1');
expect((await readCreatorPresetState(uid, v1.presetId)).activeVersion).toBe('1');
await rollbackCreatorPreset(uid, v1.presetId, '1');
expect((await listCreatorAudit(uid)).map((row) => row.event)).toContain('preset.rolled_back');
```

同时用 `Promise.all` 验证两个并发 active 切换不会产生半写文件。

- [ ] **Step 2: 增加 path choke points**

在 `paths.ts` 只新增基于 `userCloudRoot(uid)` / `userLocalRoot(uid)` 的函数；业务代码不得手写目录字面量：

```ts
export const userCreatorCloudDir = (uid: string) => path.join(userCloudRoot(uid), 'creator');
export const userCreatorLocalDir = (uid: string) => path.join(userLocalRoot(uid), 'creator');
export const userCreatorDraftsDir = (uid: string) => path.join(userCreatorCloudDir(uid), 'drafts');
export const userCreatorPresetsDir = (uid: string) => path.join(userCreatorCloudDir(uid), 'presets');
export const userCreatorAuditFile = (uid: string) => path.join(userCreatorCloudDir(uid), 'audit.jsonl');
```

- [ ] **Step 3: 实现原子存储**

`store.ts`：

- 所有处理用户数据的公开函数第一个参数为 `userId`；
- draft 可覆盖，但要使用 `writeJson`/atomic rename；
- version 文件一旦存在即拒绝覆盖；
- `state.json` 使用 `fileEditLock` 串行化状态迁移；
- audit 使用 `appendJsonlAtomic`；
- audit metadata 先过递归 redaction；
- list/read 对损坏 JSON 返回稳定错误，不能静默把损坏版本当成空。

- [ ] **Step 4: 运行测试**

```bash
node scripts/run-tests.mjs run test/main/features/creator/store.test.ts --maxWorkers=1 --reporter=dot
npm run typecheck
```

Expected: immutable version、atomic active、append-only audit 和损坏文件测试全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/main/paths.ts src/main/features/creator/store.ts test/main/features/creator/store.test.ts
git commit -m "feat: add immutable creator preset storage"
```

---

## 5. Task 4：建立脱敏 Capability Catalog 与 Inspect 快照

**Files:**
- Create: `src/main/features/creator/catalog.ts`
- Create: `src/main/features/creator/inspect-service.ts`
- Create: `src/main/features/p3394_bridge/renderer-projection.ts`
- Modify: `src/main/features/p3394_bridge/app-wiring.ts`
- Modify: `src/main/ipc/p3394_external.ts`
- Test: `test/main/features/creator/catalog.test.ts`
- Test: `test/main/features/creator/inspect-service.test.ts`
- Test: `test/main/features/p3394_bridge/renderer-projection.test.ts`
- Modify: `test/main/features/p3394_bridge/security-boundaries.test.ts`

- [ ] **Step 1: 写泄露回归测试**

构造包含 `endpoints`、`dial_token`、`expected_identity`、`Authorization` 和本机路径的 peer/provider fixtures，断言 Creator inspect 和 `p3394.external.list` renderer 响应的 `JSON.stringify(result)` 不包含这些值。

- [ ] **Step 2: 建立统一 descriptor**

```ts
export interface CreatorCapabilityDescriptor {
  capabilityId: string;
  version: string;
  kind: 'model' | 'skill' | 'tool' | 'peer-capability';
  displayName: string;
  available: boolean;
  permissions: Array<'read' | 'write' | 'network' | 'cost' | 'side-effect'>;
  sourceRef: string;
  health: 'ready' | 'degraded' | 'unavailable';
  peerId?: string;
}
```

数据来源：

- model：复用 `auth.listProviders()`、`auth.listModels()` 的公开 view，不调用 `revealApiKey`；
- Agent capability：复用 `agent_execution/capability-catalog.ts`；
- Skill：复用现有 skills/marketplace listing，只取 id、version、name、启用和安全状态；
- peer：复用 `P3394PeerRegistry`，通过新 projection 转换为不含 endpoint 的摘要。

- [ ] **Step 3: 修正 P3394 renderer projection**

现有 `P3394PeerSummary` 带 `endpoints`，不满足设计边界。新增：

```ts
export interface P3394RendererPeerView {
  peerId: string;
  displayName: string;
  capabilities: string[];
  nodeKind: string;
  locality: string;
  supportedProfiles: string[];
  disabled: boolean;
  online: boolean;
  lastSeenAt?: string;
}
```

`p3394.external.list` 改为返回该 view；main 内部继续保留 `P3394PeerRecord` endpoint 用于拨号。若旧 renderer 读取的是 `agent_id` 等 snake_case 字段，则首个兼容提交保留这些安全字段别名，但不得再返回 `endpoints`。

- [ ] **Step 4: 实现 inspect service**

`inspectCreatorRuntime(userId)` 返回：schema version、flag 状态、模型/能力目录、脱敏 peers、允许的 sandbox profile 和限制。它不能读取文件内容、session 内容或凭证。

- [ ] **Step 5: 运行测试**

```bash
node scripts/run-tests.mjs run \
  test/main/features/creator/catalog.test.ts \
  test/main/features/creator/inspect-service.test.ts \
  test/main/features/p3394_bridge/renderer-projection.test.ts \
  test/main/features/p3394_bridge/security-boundaries.test.ts \
  --maxWorkers=1 --reporter=dot
npm run typecheck
```

Expected: 所有秘密和 endpoint 泄露断言通过，旧 external-agent 管理测试仍通过。

- [ ] **Step 6: 提交**

```bash
git add src/main/features/creator src/main/features/p3394_bridge/renderer-projection.ts \
  src/main/features/p3394_bridge/app-wiring.ts src/main/ipc/p3394_external.ts test/main/features
git commit -m "fix: expose only sanitized creator and p3394 catalog views"
```

---

## 6. Task 5：自然语言 Proposal 服务与严格 JSON 解析

**Files:**
- Create: `src/main/prompts/creator_preset.md`
- Create: `src/main/features/creator/proposal-service.ts`
- Test: `test/main/features/creator/proposal-service.test.ts`
- Create: `test/fixtures/creator/proposals/valid-remote-research.json`
- Create: `test/fixtures/creator/proposals/rejected-url.json`
- Create: `test/fixtures/creator/proposals/rejected-secret.json`

- [ ] **Step 1: 写 parser fixture 测试**

覆盖纯 JSON、fenced JSON、前后解释文本、重复 JSON block、未知字段、任意 URL、秘密值、未登记 capability。只有一个合法对象且通过 schema/catalog resolve 时才接受。

- [ ] **Step 2: 编写静态 prompt**

`creator_preset.md` 只包含稳定规则和输出 schema，不包含品牌名、真实路径、硬编码 tool catalog。最后一个 `## Runtime injection` 段由 service 注入：locale、catalog ids、peer ids、预算上限和用户目标。

- [ ] **Step 3: 实现 proposal service**

```ts
export async function proposeCreatorPreset(
  userId: string,
  input: { goal: string; sourceSessionId: string },
  deps: { runModel?: (args: { systemPrompt: string; message: string }) => Promise<string> } = {},
): Promise<{ draft: CreatorPresetDraft; issues: CreatorSchemaIssue[] }>;
```

规则：

- goal 进行长度限制和控制字符清理；
- 默认模型调用复用 `model/client.ts::chatWithModel`，使用独立 `creator-<id>` session、`disableTools: true`，不传文件 roots；
- 测试通过 `runModel` 注入，禁止真实网络；
- 模型输出必须经过 parser、schema validator 和 catalog resolver；
- model 不能通过输出给自己增加 capability；
- 保存 draft 前再做一次完整校验；
- proposal 阶段不 publish、不 activate、不拨号远程 peer。

- [ ] **Step 4: 运行测试**

```bash
node scripts/run-tests.mjs run test/main/features/creator/proposal-service.test.ts --maxWorkers=1 --reporter=dot
npm run typecheck
```

Expected: 合法 fixture 生成 draft；所有 look-alike、越权和泄密 fixture 被拒绝。

- [ ] **Step 5: 提交**

```bash
git add src/main/prompts/creator_preset.md src/main/features/creator/proposal-service.ts \
  test/main/features/creator/proposal-service.test.ts test/fixtures/creator
git commit -m "feat: propose creator presets from bounded model output"
```

---

## 7. Task 6：Disposable Simulation 与固定 Verification Harness

**Files:**
- Create: `src/main/features/creator/simulation-service.ts`
- Create: `src/main/features/creator/verification-service.ts`
- Test: `test/main/features/creator/simulation-service.test.ts`
- Test: `test/main/features/creator/verification-service.test.ts`
- Create: `test/fixtures/creator/golden/remote-research.json`

- [ ] **Step 1: 写隔离失败测试**

验证 simulation：

- 只创建内存 scope 和 local trajectory；
- 不写现有 sessions、agents、skills、registry；
- timeout/cancel 后没有遗留 timer/listener；
- fixture capability 不能访问未授权工具、文件 grant 或 peer；
- 重复 idempotency key 只产生一个 effect。

- [ ] **Step 2: 定义 disposable scope**

```ts
interface CreatorSimulationScope {
  runId: string;
  manifest: Readonly<CreatorPresetManifestV1>;
  catalogSnapshot: ReadonlyArray<CreatorCapabilityDescriptor>;
  signal: AbortSignal;
  emit(event: CreatorTrajectoryEvent): Promise<void>;
  dispose(): Promise<void>;
}
```

`manifest` 和 catalog 深冻结；`dispose()` 幂等，并在 `finally` 中执行。

- [ ] **Step 3: 实现首版 policy simulator**

首版不动态加载第三方代码。simulation 将 manifest 映射到受控 mock executors：local read、mock search、mock remote peer、timeout、cancel、reject、duplicate。任何未知 capability 直接失败，不能 fallback 到 shell/import。

- [ ] **Step 4: 实现 verification report**

报告至少包含：

```ts
interface CreatorVerificationReport {
  schemaVersion: 1;
  runId: string;
  presetId: string;
  manifestDigest: string;
  status: 'passed' | 'failed' | 'cancelled';
  checks: Array<{ id: string; status: 'passed' | 'failed'; evidence: string[] }>;
  startedAt: string;
  completedAt: string;
}
```

固定 checks：schema、catalog resolution、tool allow-list、file grants、network peer allow-list、side effects、budget、timeout、cancel、idempotency、audit trajectory、mock remote refusal。

- [ ] **Step 5: 运行测试**

```bash
node scripts/run-tests.mjs run \
  test/main/features/creator/simulation-service.test.ts \
  test/main/features/creator/verification-service.test.ts \
  --maxWorkers=1 --reporter=dot
npm run typecheck
```

Expected: 失败场景产生失败报告且 scope 被释放；通过报告的 digest 与 manifest 一致。

- [ ] **Step 6: 提交**

```bash
git add src/main/features/creator/simulation-service.ts \
  src/main/features/creator/verification-service.ts test/main/features/creator test/fixtures/creator/golden
git commit -m "feat: add isolated creator preset verification"
```

---

## 8. Task 7：Approve / Publish / Activate / Disable / Rollback 状态机

**Files:**
- Create: `src/main/features/creator/lifecycle-service.ts`
- Test: `test/main/features/creator/lifecycle-service.test.ts`

- [ ] **Step 1: 写非法状态迁移测试**

```ts
await expect(publishPreset(uid, draftId, approval)).rejects.toThrow('creator_verification_required');
await expect(approvePreset(uid, draftId, { approved: true, verificationRunId: 'failed-run' })).rejects.toThrow('creator_verification_not_passed');
await expect(activatePreset(uid, presetId, '2')).rejects.toThrow('creator_preset_version_not_published');
```

同时验证 active 运行 snapshot 不会因之后 rollback 被原地修改。

- [ ] **Step 2: 实现状态迁移表**

允许：

```text
draft -> sandboxed -> verified -> approved -> published -> active
approved -> rejected
published|active -> disabled
active -> rolled_back(previous published version becomes active)
```

每次迁移都要校验 `manifestDigest`、verification report、approval actor 和当前状态，并写 audit。激活只允许指向已发布且已 materialize 成功的版本；active 版本切换不得原地改写已绑定 Agent 或运行中的 session snapshot。

- [ ] **Step 3: 实现显式 approval input**

approval 必须绑定：`draftId`、`manifestDigest`、`verificationRunId`、用户确认时间、批准的 peer/capability/sideEffects。不能只传布尔值。

- [ ] **Step 4: 运行测试**

```bash
node scripts/run-tests.mjs run test/main/features/creator/lifecycle-service.test.ts --maxWorkers=1 --reporter=dot
npm run typecheck
```

Expected: 合法状态迁移通过；跳步、过期 digest、失败验证和错误版本全部拒绝。

- [ ] **Step 5: 提交**

```bash
git add src/main/features/creator/lifecycle-service.ts test/main/features/creator/lifecycle-service.test.ts
git commit -m "feat: add audited creator preset lifecycle"
```

---

## 9. Task 8：将 approved Creator preset materialize 为现有 Agent

**Files:**
- Create: `src/main/features/creator/materializer.ts`
- Create: `src/main/features/creator/agent-binding-store.ts`
- Modify: `src/main/features/creator/lifecycle-service.ts`
- Modify: `src/main/features/creator/index.ts`
- Read/Modify as required by current API: `src/main/features/agents.ts`
- Test: `test/main/features/creator/materializer.test.ts`
- Test: `test/main/features/creator/agent-binding-store.test.ts`

- [ ] **Step 1: 写 materializer 失败测试**

覆盖：

- 非 `approved`/`published`/待激活版本不能 materialize；
- 合法 preset 调用现有 `createCustomAgent`，而不是创建第二个 runtime 或直接启动 agent loop；
- update/re-materialize 使用显式 preset version，不覆盖其他普通 Agent；
- Agent quality gate、skill/capability resolve 或 agent.json 持久化失败时，不留下半成品 Agent 或 binding；
- 成功后 `presetId/version/manifestDigest` 与 `agentId` 双向可追溯；
- 运行中的 session 持有创建时 snapshot，之后 rollback/activate 不改变其行为。

- [ ] **Step 2: 定义 materializer 输入输出**

```ts
export interface CreatorAgentBinding {
  presetId: string;
  version: string;
  manifestDigest: string;
  agentId: string;
  materializedAt: string;
  materializationRevision: string;
}

export async function materializeCreatorPreset(
  userId: string,
  presetRef: { presetId: string; version: string; manifestDigest: string },
): Promise<CreatorAgentBinding>;
```

`materializer.ts` 只接收由 main 从 Creator store 重新读取的 immutable version，不信任 renderer 传来的 manifest。它把已登记 model、skills、workflow、runtime、output contract 和 P3394 policy 转成现有 AgentRaw/Agent schema 能接受的字段；P3394 peer/capability allow-list 保留在 Creator binding metadata 中，由 Task 10 的联合 policy 在每次 remote send 再校验。

- [ ] **Step 3: 实现原子物化与绑定**

实现顺序固定为：读取 immutable version → 校验 digest/lifecycle → 解析现有 Agent schema → 调用 `createCustomAgent`/`updateCustomAgent` 与现有 quality gate → 确认 agent.json 持久化 → 写 binding → 返回 binding。任何失败都必须清理本次新建的 Agent 文件或写入 tombstone，不能留下“已绑定但 Agent 不存在”或“Agent 存在但未绑定”的可见半成品。

- [ ] **Step 4: 接入 lifecycle publish/activate**

`publish` 可以生成不可变 Creator version，但 `activate` 的门禁必须要求 materialization binding 的 digest 与目标 version 一致。重复 materialize 要幂等；显式 version rollback 只能让后续新 run 读取旧 binding，不能修改已有 session 的 snapshot。

- [ ] **Step 5: 运行定向测试**

```bash
node scripts/run-tests.mjs run \
  test/main/features/creator/materializer.test.ts \
  test/main/features/creator/agent-binding-store.test.ts \
  test/main/features/creator/lifecycle-service.test.ts \
  --maxWorkers=1 --reporter=dot
npm run typecheck
```

Expected: materialize 成功、失败回滚、绑定追溯、幂等和 snapshot 隔离全部通过；普通 Agent 创建测试不回归。

- [ ] **Step 6: 提交**

```bash
git add src/main/features/creator src/main/features/agents.ts test/main/features/creator
git commit -m "feat: materialize creator presets into existing agents"
```

---

## 10. Task 9：P3394 Remote Agent Service（P1 一对一请求/响应）

**Files:**
- Create: `src/main/features/p3394_bridge/remote-run-store.ts`
- Create: `src/main/features/p3394_bridge/remote-agent-service.ts`
- Modify: `src/main/features/p3394_bridge/outbound-hub.ts`
- Modify: `src/main/features/p3394_bridge/index.ts`
- Test: `test/main/features/p3394_bridge/remote-agent-service.test.ts`
- Test: `test/main/features/p3394_bridge/remote-agent-golden-path.test.ts`

- [ ] **Step 1: 写 P1 Golden Path 测试**

用 `channel-testkit` / in-process channel 构造 Agent A 和 Agent B，覆盖：discover → identity verified → session created → task submitted → accepted → result persisted → completed。

- [ ] **Step 2: 写失败矩阵测试**

覆盖稳定错误码：

```text
p3394_remote_disabled
p3394_peer_not_found
p3394_peer_disabled
p3394_peer_offline
p3394_capability_denied
p3394_approval_required
p3394_auth_failed
p3394_protocol_incompatible
p3394_remote_rejected
p3394_reply_timeout
p3394_cancelled
p3394_duplicate_request
p3394_result_persist_failed
```

网络连接成功不能直接返回 completed；远程拒绝必须是结构化终态。

- [ ] **Step 3: 定义 service API**

```ts
export interface P3394RemoteTaskRequest {
  requestId: string;
  peerId: string;
  capability: string;
  task: string;
  contextSummary?: string;
  artifactRefs?: string[];
  timeoutMs: number;
  idempotencyKey: string;
  approvalRef: string;
  speechAct: 'query' | 'request';
  contextScope: 'task-summary';
  presetRef: { presetId: string; version: string; manifestDigest: string; agentId: string };
}

export async function submitP3394RemoteTask(
  userId: string,
  request: P3394RemoteTaskRequest,
  options?: { signal?: AbortSignal; onEvent?: (event: P3394RemoteTaskEvent) => void },
): Promise<P3394RemoteTaskResult>;
```

- [ ] **Step 4: 复用现有 bridge，不复制协议代码**

service 必须调用现有 `P3394PeerRegistry`、`P3394Controller`、session manager、task manager、outbound hub、outbound outbox、event cursor/recovery 和既有 channel adapter。它只负责把已绑定本地 Agent 的一次 outbound 请求映射到现有 P3394 capability declaration/speech act/context/relationship/epoch 校验，再做状态转换、持久化结果和 renderer-safe event projection；不得定义新的 envelope、session protocol 或远程 Agent loop。renderer 不获得 endpoint、socket、connect/createSession/resume handle。

- [ ] **Step 5: 补 cancel 和资源释放**

`outbound-hub.ts` 增加按 request/session 取消 pending waiter 的显式 API；cancel 必须清 timer、pending map、channel subscription，并写 outbox/audit 终态。禁止用新的总墙钟超时替换现有 idle/watchdog 语义；`timeoutMs` 仅约束远程任务等待边界。

- [ ] **Step 6: 写 remote run receipt**

每个终态保存：runId、requestId、peerId、capability、sessionId、taskId、preset ref、trace id、status、submitted/accepted/persisted/completed 时间点、result digest、error code。不得保存 token、endpoint、完整私有上下文或未脱敏 header。

- [ ] **Step 7: 运行定向测试**

```bash
node scripts/run-tests.mjs run \
  test/main/features/p3394_bridge/remote-agent-service.test.ts \
  test/main/features/p3394_bridge/remote-agent-golden-path.test.ts \
  test/main/features/p3394_bridge/outbound-hub.test.ts \
  test/main/features/p3394_bridge/outbound-outbox.test.ts \
  test/main/features/p3394_bridge/replay-protection.test.ts \
  --maxWorkers=1 --reporter=dot
npm run typecheck
```

Expected: P1 成功与失败矩阵通过；现有 P3394 测试无回归。

- [ ] **Step 8: 提交**

```bash
git add src/main/features/p3394_bridge test/main/features/p3394_bridge
git commit -m "feat: add reliable p3394 remote agent task service"
```

---

## 11. Task 10：Creator preset 与 P3394 policy 联合执行

**Files:**
- Create: `src/main/features/creator/remote-execution-service.ts`
- Modify: `src/main/features/creator/index.ts`
- Test: `test/main/features/creator/remote-execution-service.test.ts`

- [ ] **Step 1: 写 policy binding 测试**

覆盖：

- active preset 允许声明的 peer/capability；
- 未列 peer、未列 capability、超预算、超过深度、未提供 approvalRef 全部拒绝；
- renderer 请求中的 preset manifest 不可信，main 必须从 store 重新读取 active immutable version；
- peer capability 在发布后变化时 fail closed；
- remote task 结果绑定 preset/version/digest 和 receipt。

- [ ] **Step 2: 实现联合 preflight**

```ts
export async function executeCreatorRemoteTask(
  userId: string,
  input: {
    presetId: string;
    task: string;
    peerId: string;
    capability: string;
    approvalRef: string;
    contextSummary?: string;
  },
  options?: { signal?: AbortSignal; onEvent?: (event: CreatorRemoteEvent) => void },
): Promise<CreatorRemoteResult>;
```

preflight 顺序固定：feature flag → active immutable preset/version → manifest digest 与 agent binding → local Agent policy → peer identity → declared capability → relationship → speech act/context scope/epoch → budget/timeout/payload → approval binding → idempotency/replay → 现有 P3394 submit。

- [ ] **Step 3: 记录联合审计**

Creator audit 写 preset 视角；P3394 remote receipt 写 transport/run 视角；两者通过 `runId` 和 `traceId` 互相引用，不复制整份 payload。

- [ ] **Step 4: 运行测试**

```bash
node scripts/run-tests.mjs run test/main/features/creator/remote-execution-service.test.ts --maxWorkers=1 --reporter=dot
npm run typecheck
```

Expected: policy 与 transport 双重校验通过，任何一层失败都不产生未授权网络 effect。

- [ ] **Step 5: 提交**

```bash
git add src/main/features/creator/remote-execution-service.ts \
  src/main/features/creator/index.ts test/main/features/creator/remote-execution-service.test.ts
git commit -m "feat: bind creator presets to p3394 peer policy"
```

---

## 12. Task 11：新增 IPC，保持既有 channel 语义不变

**Files:**
- Create: `src/main/ipc/creator.ts`
- Create: `src/main/ipc/p3394_agent.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/main/preload.js` only if push prefix allow-list needs one additive entry
- Test: `test/main/ipc/creator.test.ts`
- Test: `test/main/ipc/p3394-agent.test.ts`
- Test: `test/renderer/creator-ipc-wiring.test.ts`
- Test: `test/static/ipc-contract.test.ts` or current equivalent in latest develop

- [ ] **Step 1: 写 channel contract 测试**

新增 invoke channels：

```text
creator.inspect
creator.draft.propose
creator.draft.read
creator.draft.simulate
creator.draft.verify
creator.draft.approve
creator.preset.list
creator.preset.publish
creator.preset.activate
creator.preset.disable
creator.preset.rollback
p3394.agent.listPeers
p3394.agent.send
p3394.agent.cancel
p3394.agent.readRun
```

新增一个 stream channel：

```text
p3394.agent.stream
```

不新增 renderer 可拨号的 connect/createSession/resume handle；连接、session、task、恢复均由 main 内 service 按 peer registry 和现有 P3394 bridge 管理。

- [ ] **Step 2: 实现薄 IPC handlers**

handler 只做：`boundedText`/safe id/数值范围校验、调用 feature、映射稳定错误码。approval/publish/cancel 等副作用 channel 必须显式检查 flag 和 user context。

- [ ] **Step 3: 保持 preload 单一入口**

renderer 继续使用：

```js
window.cogseed.invoke('creator.inspect', {});
window.cogseed.stream('p3394.agent.stream', payload, onEvent);
```

除非 stream push prefix 校验要求，不新增新的顶层 `window` API。`src/main/preload.js` 继续为 JavaScript。

- [ ] **Step 4: 生成并审查 contract diff**

```bash
node scripts/capture-ipc-contract.cjs
node scripts/capture-ipc-contract.cjs --check
git diff -- src/renderer-app/ipc/contract.generated.json
```

Expected: 只有上述新增 channel；旧 channel 的参数、返回和调用点数量没有无解释变化。

- [ ] **Step 5: 运行测试**

```bash
node scripts/run-tests.mjs run \
  test/main/ipc/creator.test.ts \
  test/main/ipc/p3394-agent.test.ts \
  test/renderer/creator-ipc-wiring.test.ts \
  test/static \
  --maxWorkers=1 --reporter=dot
npm run typecheck
```

- [ ] **Step 6: 提交**

```bash
git add src/main/ipc src/main/preload.js src/renderer-app/ipc/contract.generated.json test/main/ipc test/renderer test/static
git commit -m "feat: expose typed creator and p3394 agent ipc"
```

---

## 13. Task 12：Creator Mode UI 与远程任务状态 UI

**Files:**
- Create: `src/renderer/modules/creator-mode.js`
- Create: `src/renderer/modules/p3394-remote-agent.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/modules/agents.js`
- Modify: `src/renderer/locales/zh-CN.json`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/main/locales/zh-CN.json`
- Modify: `src/main/locales/en.json`
- Test: `test/renderer/creator-mode.test.ts`
- Test: `test/renderer/p3394-remote-agent.test.ts`
- Test: `test/renderer/i18n-coverage.test.ts` or current locale gate

- [ ] **Step 1: 写静态 wiring 测试**

断言：

- `agent-modal` 增加 `data-agent-tab="creator"`；
- creator panel 有 goal、catalog summary、manifest preview、permissions、verification、approval、publish controls；
- 新脚本在 `agents.js` 之后按依赖顺序加载；
- 没有 raw endpoint/token 输入框；
- 所有可见文案使用 `data-i18n`/`t()`；
- 没有 emoji 图标或内联 SVG。

- [ ] **Step 2: 增加 Creator tab**

复用 `.skill-modal-tabs`、`.skill-modal-panel`、`.form-row`、`.btn` 和已有状态 card。不要新建第二套 modal。`agents.js::_setAgentModalTab` 扩展为 `create | creator | external`，并保持 create/external 原行为。

- [ ] **Step 3: 实现五阶段 UI 状态**

```text
Inspect -> Compose -> Simulate -> Verify -> Publish
```

每阶段展示：当前状态、可见输入、错误、下一步；长操作显示 progress；运行时允许 cancel；失败后保留 draft 和 report，不自动 publish。

- [ ] **Step 4: 实现权限确认卡**

发布和首次 remote send 前展示：模型、能力、peer、context 摘要范围、预算、timeout、side effects、降级行为。确认后把 main 返回的 digest/run id 带回，不允许 renderer 自己计算授权范围。UI 只能发起 `send`/`cancel`/`readRun` 并消费脱敏事件，不能创建连接、session 或 resume。

- [ ] **Step 5: 实现远程状态投影**

UI 明确区分：`pending`、`accepted`、`streaming`、`persisted`、`completed`、`rejected`、`cancelled`、`failed`、`unreachable`。`transport connected` 不显示成完成。

- [ ] **Step 6: 处理 i18n 和 IME**

动态页面监听 `i18n-change` 重绘；textarea 快捷键使用 `e.isComposing || e.keyCode === 229` guard。

- [ ] **Step 7: 运行 renderer 测试**

```bash
node scripts/run-tests.mjs run \
  test/renderer/creator-mode.test.ts \
  test/renderer/p3394-remote-agent.test.ts \
  test/renderer/new-chat-home.test.ts \
  test/renderer/local-agents-status.test.ts \
  --maxWorkers=1 --reporter=dot
```

Expected: Creator UI 和旧 Create/External tabs 都通过。

- [ ] **Step 8: 提交**

```bash
git add src/renderer src/main/locales test/renderer
git commit -m "feat: add creator mode and remote agent user flows"
```

---

## 14. Task 13：P2 流式、ack、resume 和去重（复用现有恢复设施，独立可延期里程碑）

**Files:**
- Modify: `src/main/features/p3394_bridge/outbound-hub.ts`
- Modify: `src/main/features/p3394_bridge/event-cursor-store.ts`
- Modify: `src/main/features/p3394_bridge/recovery-controller.ts`
- Modify: `src/main/features/p3394_bridge/outbound-outbox.ts`
- Modify: `src/main/ipc/p3394_agent.ts`
- Test: `test/main/features/p3394_bridge/remote-agent-streaming.test.ts`
- Test: `test/main/features/p3394_bridge/remote-agent-recovery.test.ts`

- [ ] **Step 1: 写乱序、重复和断线恢复测试**

事件序列包括：1、2、2、4、3、disconnect、resume。复用现有 `event-cursor-store`、`outbound-outbox`、`recovery-controller` 和 task manager 的 `recoverable` 语义；断言 Creator remote-run projection 按序只产生一次 effect，cursor 持久化到最后 ack 的 sequence。不要新建第二套 streaming protocol。

- [ ] **Step 2: 实现 ack/cursor 规则**

只有本地持久化成功后 ack；重复 sequence 只 ack 不重复投影；gap 暂存到有界 reorder buffer；超过窗口返回 protocol error。

- [ ] **Step 3: 实现 resume**

重连后调用现有 recovery controller 从 cursor 恢复；outbox 只 replay 未有终态的 P3394 message；cancelled/completed 任务不重放。Creator 层只负责 remote-run projection、去重和 UI 适配，不管理 socket/session。

- [ ] **Step 4: 验证 shutdown cleanup**

app exit/feature disable 时关闭 socket、timer、listener、pending waiter 和 reorder buffer。测试使用 fake timers 和 listener counts 验证为 0。

- [ ] **Step 5: 运行测试并提交**

```bash
node scripts/run-tests.mjs run \
  test/main/features/p3394_bridge/remote-agent-streaming.test.ts \
  test/main/features/p3394_bridge/remote-agent-recovery.test.ts \
  --maxWorkers=1 --reporter=dot
npm run typecheck
git add src/main/features/p3394_bridge src/main/ipc/p3394_agent.ts test/main/features/p3394_bridge
git commit -m "feat: add resumable p3394 remote event streaming"
```

发布前 `p3394_remote_agent_streaming_enabled` 仍保持 false，直到故障注入通过。

---

## 15. Task 14：安全门禁、威胁模型和发布证据

**Files:**
- Create: `docs/security/creator-mode-p3394-threat-model.md`
- Create: `docs/security/creator-mode-p3394-data-flow.md`
- Create: `docs/superpowers/migrations/2026-08-21-creator-p3394-verification.md`
- Modify: `SECURITY.md`
- Test: `test/static/creator-security-boundary.test.ts`
- Test: `test/main/features/creator/redaction.test.ts`
- Test: `test/main/features/p3394_bridge/redaction.test.ts`

- [ ] **Step 1: 写静态边界测试**

检查：

- renderer modules 不 import Node/network 模块；
- creator manifest 不包含 endpoint/token 字段；
- `src/main/ipc/*.ts` 不直接读取 secret store；
- Creator 不调用 child process、任意 shell 或动态 import 路径；
- 新网络调用只存在 P3394 approved channel adapters；
- remote result 和 audit logger 使用 redaction。

- [ ] **Step 2: 完成 threat model**

必须覆盖 assets：凭证、peer identity、preset 权限、用户文件、会话、远程结果、审计；trust boundaries：renderer/main/local bridge/gateway/remote bridge；攻击：prompt injection、capability spoofing、SSRF、replay、idempotency bypass、approval replay、budget bypass、delegation loop、malicious artifact、log leakage。

- [ ] **Step 3: 记录 mitigation 与可测试证据**

每个 threat 指向具体代码和 test；没有 test 的控制不能写成“已完成”。

- [ ] **Step 4: 运行安全测试**

```bash
node scripts/run-tests.mjs run \
  test/static/creator-security-boundary.test.ts \
  test/main/features/creator/redaction.test.ts \
  test/main/features/p3394_bridge/redaction.test.ts \
  test/main/features/p3394_bridge/security-boundaries.test.ts \
  --maxWorkers=1 --reporter=dot
```

- [ ] **Step 5: 提交**

```bash
git add docs/security docs/superpowers/migrations/2026-08-21-creator-p3394-verification.md \
  SECURITY.md test/static test/main/features/creator test/main/features/p3394_bridge
git commit -m "docs: add creator and p3394 security release gates"
```

---

## 16. Task 15：全量验证、真实环境 smoke 和回滚演练

**Files:**
- Modify: `docs/superpowers/migrations/2026-08-21-creator-p3394-verification.md`
- No production code unless a failing gate identifies a defect

- [ ] **Step 1: 运行 TypeScript 和完整测试**

```bash
npm run typecheck
npm test
```

Expected: 全部通过；任何既有失败都要记录精确 test name、错误和是否与本改动有关，不能删除测试掩盖失败。

- [ ] **Step 2: 运行定向 Creator/P3394 套件**

```bash
node scripts/run-tests.mjs run \
  test/main/features/creator \
  test/main/features/p3394 \
  test/main/features/p3394_bridge \
  test/main/ipc/creator.test.ts \
  test/main/ipc/p3394-agent.test.ts \
  test/renderer/creator-mode.test.ts \
  test/renderer/p3394-remote-agent.test.ts \
  --maxWorkers=1 --reporter=dot
```

- [ ] **Step 3: 复核 IPC contract**

```bash
node scripts/capture-ipc-contract.cjs --check
BASE_SHA="$(sed -n '1p' docs/superpowers/migrations/2026-08-21-creator-p3394-baseline.md | tr -d ' ' | cut -d: -f2-)"
git diff "${BASE_SHA}"...HEAD -- src/main/ipc src/main/preload.js src/renderer-app/ipc/contract.generated.json
```

Expected: 只有计划内新增 channel 和 endpoint 泄露修复；不存在旧 channel 被删除或改名。

- [ ] **Step 4: 启动真实应用**

```bash
scripts/restart-cogseed.sh
sleep 5
tail -n 200 /tmp/cogseed-agent-cogseed-run.log
```

Expected: 无 preload、IPC、native module 或 boot init 错误。

- [ ] **Step 5: 执行手工 Golden Path**

1. 默认 flag 关闭时，旧 Create/External Agent 流程正常。
2. 开启 Creator Mode 后输入“创建只读远程研究协作者”。
3. inspect 只显示脱敏 model/capability/peer。
4. proposal 展示 manifest；非法 URL/秘密无法保存。
5. simulate 和 verify 生成报告，不污染普通 session/registry。
6. approval 后发布版本 1 并 activate。
7. 首次 remote send 再次显示 peer/capability/budget 确认。
8. Agent B 成功时依次看到 accepted、persisted、completed 和 receipt。
9. 测试远程拒绝、不可达、timeout、cancel、重复提交。
10. rollback 后新 run 使用旧 active version，运行中的旧 snapshot 不突变。

- [ ] **Step 6: 演练 kill switch**

```bash
COGSEED_CREATOR_MODE=0 ./run.sh
COGSEED_P3394_REMOTE_AGENT=0 ./run.sh
```

Expected: Creator/remote API 返回稳定 disabled 错误；本地 Agent、group chat 和 `p3394.external.*` 仍可用。

- [ ] **Step 7: 更新验证报告并提交**

报告写入：基线 SHA、最终 SHA、命令、通过数量、失败详情、contract diff、真实环境结果、回滚结果和剩余风险。

```bash
git add docs/superpowers/migrations/2026-08-21-creator-p3394-verification.md
git commit -m "test: record creator and p3394 release verification"
```

---

## 17. 推荐 MR 拆分

| MR | 内容 | 可独立回滚 |
|---|---|---|
| MR-1 | Task 1–4：基线、schema、store、catalog/脱敏 | 是；无 UI、无远程副作用 |
| MR-2 | Task 5–7：proposal、simulation、verification、lifecycle | 是；publish flag 默认关闭 |
| MR-3 | Task 8：materializer；Task 9–10：P3394 P1 remote service 与 preset policy | 是；remote flag 默认关闭 |
| MR-4 | Task 11–12：IPC 与 UI | 是；关闭 flags 恢复旧入口 |
| MR-5 | Task 13：流式/恢复 | 是；streaming flag 独立关闭 |
| MR-6 | Task 14–15：安全、全量验证、发布证据 | 文档/门禁提交 |

不要把 renderer 全量重写混入这些 MR；如果当前 `develop` 已包含 renderer rewrite，则仅按当前 IPC adapter 形式调整文件路径，业务边界和测试门禁保持不变。

---

## 18. 验收标准

### Creator Mode

- [ ] 自然语言目标能生成合法 `CreatorPresetManifestV1` 草案；
- [ ] 未登记能力、任意 URL、秘密字段、绝对路径和越权权限被拒绝；
- [ ] simulation scope 在成功、失败、timeout 和 cancel 后完整释放；
- [ ] verification report 与 manifest digest 绑定；
- [ ] publish 创建不可变版本，active 切换原子化；
- [ ] approve/reject/disable/rollback 全部可审计；
- [ ] 重启后同一 active version 解析结果一致；approved version materialize 到既有 Agent runtime。
- [ ] 每个 active Creator version 都有匹配的 `preset/version/digest ↔ agentId` binding；失败 materialize 不留下半成品。
- [ ] Creator rollback 不原地改变已运行 Agent/session snapshot。

### P3394 P1

- [ ] peer 投影不包含 endpoint/token/header；
- [ ] 一对一 request/response Golden Path 通过，并使用现有 P3394 protocol/controller/session/task 路径；
- [ ] accepted、persisted、completed 状态不混淆；
- [ ] 拒绝、认证失败、协议不兼容、不可达、timeout、cancel、重复请求有独立错误；
- [ ] 至少一次传输配合 idempotency，不承诺 exactly-once；
- [ ] remote run receipt 绑定 peer、task、preset、trace 和终态；
- [ ] 关闭 remote flag 后现有 P3394 external gateway 与本地 Agent 正常。

### P3394 P2

- [ ] event 可 ack、resume、去重和有界重排；
- [ ] 断线恢复不重复副作用；
- [ ] exit/disable 后 socket、timer、listener、pending waiter 清零。

### 跨层

- [ ] renderer 不接触秘密、endpoint、socket、session handle、raw envelope 或协议连接；
- [ ] 不存在第二套 Agent runtime、平行 P3394 envelope 或自定义 streaming protocol；
- [ ] `src/main/preload.js` 仍为 JavaScript；
- [ ] 新业务逻辑不进入 IPC handler；
- [ ] 没有新增 npm 依赖；
- [ ] 既有 IPC channel 无语义变化；
- [ ] `npm run typecheck`、`npm test`、IPC contract check 和真实应用 smoke 有证据。

---

## 19. 回滚策略

1. **运行时回滚：** 先关闭四个 feature flags；不删除数据。
2. **UI 回滚：** 隐藏 Creator tab 和 remote controls；保留 store/audit 供后续恢复。
3. **P3394 回滚：** 关闭新 `p3394.agent.*` service；不停止旧 `p3394.external.*` gateway。
4. **版本回滚：** active pointer 原子指向上一已发布版本；运行中的实例继续使用创建时 snapshot。
5. **代码回滚：** 按 MR 逆序回退；MR-1 的 endpoint 脱敏修复属于安全修复，不应随产品 UI 回滚恢复泄露。
6. **数据处理：** 不删除历史 manifest、verification、trajectory、receipt 或 audit；只允许增加 tombstone/disabled 状态。

---

## 20. 最终交付物

- Creator Mode manifest/schema/store/catalog/proposal/simulation/verification/lifecycle；
- approved Creator preset materializer、Agent binding store，以及与现有 `agents.ts`/`agent.json`/session runtime 的绑定证据；
- P3394 一对一 remote-agent service、remote receipt 和可选流式恢复；
- Creator + P3394 联合 policy execution；
- additive typed IPC contract；
- classic renderer Creator UI；
- threat model、data-flow、baseline 和 verification 证据；
- 可操作的 feature flags 与回滚演练记录。

## 21. 复审结论与实施前自检

- [ ] Creator 只负责设计/验证/审批；运行时继续复用现有 Agent/session runtime。
- [ ] Task 8 materializer 是发布到运行面的唯一入口，并写入可追溯 binding。
- [ ] P3394 只复用现有 manifest/message/relationship/speech-act/controller/session/task/outbox/recovery 类型和实现。
- [ ] renderer 没有 connect/createSession/resume 或 raw protocol 入口。
- [ ] P2 只扩展现有 cursor/outbox/recovery，不引入第二套 streaming protocol。
- [ ] 首版仅支持本地 Agent A 到远程 Agent B 的一对一 outbound；不做入站、多级委派、fan-out、动态插件。

**Next skill:** `$superpower-subagents`（推荐，按 MR/Task 分派并逐任务审查）或 `$superpower-executing-plans`（在当前任务中按批次执行并设置检查点）。
