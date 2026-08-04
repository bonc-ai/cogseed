# T2-S3-02 产品工作 Workspace — 实施方案与规范

| 项 | 值 |
|---|---|
| 任务编号 | T2-S3-02 |
| 需求编号 | US-20（关联 US-18/19；Main Skill Baseline） |
| 负责人 | 吴嘉宇 |
| 角色 | Tech Lead / PO |
| 团队 | Team2 |
| 技术事项 | Workspace Gate；Task Run；Action Plan；Receipt |
| 硬门禁 | 未达成不得展示 Workspace |
| 基线代码 | 本地 `dev/zhangzh` @ `646e7d1`（已合入 `origin/master`，落后 0） |
| 成文日期 | 2026-08-04 |

---

## 1. 结论先行

四件套里 **Receipt 已经存在完整实现**，不需要新建。本任务的真实工作量集中在「Workspace Gate 如何消费既有 Receipt」和「Task Run 如何复用既有执行记录层」，而不是从零构建证据体系。

早先基于合并前代码得出的「Receipt 全空、应先设计 schema」结论已作废。

| 交付物 | 地基现状 | 本任务要做的 |
|---|---|---|
| Receipt | `p3394/context-reuse-receipt.ts` 328 行，完整 | 消费，不重写 |
| Task Run | `features/execution-records.ts` 689 行，完整 | 桥接到项目任务层 |
| Main Skill | `projects.ts::ProjectBindings` 可扩展 | 加主技能指针 + 基线 |
| Workspace Gate | 无 | 新建准入判定 |
| Action Plan | 无 | 新建**只读投影** |

---

## 2. 既有地基（不要重复建设）

### 2.1 Receipt — `src/main/features/p3394/context-reuse-receipt.ts`

两段式生命周期，字段与状态机均已定型：

```
prepareReceipt(uid, input, expectedTarget)   → status: 'prepared'
completeReceipt(uid, executionId, input)     → 'completed' | 'rejected' | 'degraded'
readReceipt(uid, executionId)                → ContextReuseReceipt
```

关键字段：`receiptId`、`executionId`、`sourceSessionId/ContextId`、`targetSessionId/ContextId`、`reusedRefs`、`omittedRefs`、`permissionMode`、`allowedScopes`、`baselineExecutionId`、`treatmentExecutionId`、`status`、`boundary`。

必须遵守的既有约束：

- **目标校验前置**：`prepareReceipt` 第三参 `expectedTarget` 会走 `assertTargetMatches`，target session/context 不符直接抛错。调用方必须先确定目标会话。
- **完成阶段字段不可变**：`assertImmutableCompletionFields` 锁死 source/target/refs/permission/scopes，`completeReceipt` 只能补 baseline/treatment 执行 id 和 status。不要试图在完成阶段修正准备阶段写错的值。
- **单次终结**：`status !== 'prepared'` 时 `completeReceipt` 抛 `already finalized`。
- **引用自动脱敏**：`redactReference` 对每条 ref 走 `sanitizeLogTextForUpload` + 敏感字段/提示词正则。不要在调用侧重复脱敏。
- 落盘位置 `<uid>/local/kstar/executions/<executionId>/context-reuse-receipt.json`，写入走 `fileEditLock`。

### 2.2 执行记录 — `src/main/features/execution-records.ts`

Task Run 的存储层已经存在，**不要新建 `runs/<rid>.json`**。

```
create / read / list / update / complete
appendEvent / readEvents          事件流，seq 从 1 单调递增
attachArtifact                    产物挂载，走 resolveArtifactDir 校验
createLifecycleSink               推荐入口：queued/started/event/artifact/terminal
readResult                        取溢出的输出正文
```

`ExecutionRecord` 已带 `receiptId` 字段 —— **Run 与 Receipt 的关联已经内建**，这是 Task Run 能直接复用的决定性理由。

必须遵守的既有约束：

- **状态机单向**：`validateTransition` 禁止终态回退，`running → queued` 非法。终态必须走 `complete()`，`update()` 传终态会抛错。
- **`update` 白名单**：`assertKnownPatchKeys` 只允许 7 个字段，传未知键抛 `immutable or unknown execution field`。
- **元数据强制约束**：`sanitizeMetadata` 递归深度 5、键数 64、数组 64、字符串 2048、JSON 总量 12000 字符；命中 `SENSITIVE_KEY_RE`/`PROMPT_KEY_RE` 直接 `[REDACTED]`，绝对路径转 `[PATH]`。
- **输出不进记录**：超过 4096 字符的 output 自动溢出到 `outputs/`，记录里只留 `output:<ref>` 句柄。
- 落盘 `<uid>/local/kstar/executions/<executionId>/{record.json,events.jsonl,outputs/}`。

### 2.3 Skill 校验 — `src/main/features/p3394/skill-validation-run.ts`

已接入 IPC（`p3394.validation.scan` / `p3394.validation.read`），状态 `pass|risk|blocked|degraded`，落盘 `validations/<id>.json`，入口做 `isPathAllowed` 沙箱校验，异常降级为 `degraded` 而非抛错。

Workspace Gate 若需要「技能安全」维度，直接调 `findLatestSkillValidation(uid, skillId)`，不要另起扫描。

### 2.4 项目层 — `projects.ts` / `project_tasks.ts`

- `<uid>/cloud/projects/<pid>/`，目录存在即真相，**无聚合索引**
- `bindings.json` 严格作用域（`resolveProjectScope` 是唯一解析器）
- `ORKAS.md` 用户所有、agent 只读
- 任务一文件一任务，`computeProgress` 派生不存储
- 已有 `result_ref` / `origin_cid` / `depends_on`

### 2.5 现有 IPC 通道（已可用）

```
p3394.execution.list / .read
p3394.contextReuseReceipt.read
p3394.behaviorContrast.start / .read
p3394.validation.scan / .read
```

---

## 3. 命名规范（务必先定）

`features/user_workspace.ts` 里的 "workspace" 是**用户选的本地磁盘目录**（`selectedPath` + `recentPaths`），职责是路径解析、TCC 隐私规避、空目录清扫，已被 `bus.ts`、file-tools、`file_indexer` 深度依赖。

US-20 的「产品工作 Workspace」是**工作容器**，与之同名不同物。

**规范**：新模块不得命名为 `workspace`，建议 `features/workbench/`。工作容器需要落盘位置时调用 `user_workspace.getWorkspacePath(uid, projectId)`，把它当下层依赖，不得改写其语义或在其中新增容器字段。

---

## 4. 四件套实施规范

### 4.1 Main Skill（工作量最小，建议先做）

在 `ProjectBindings` 增加主技能指针与基线：

```ts
export interface ProjectBindings {
  agents: string[];
  skills: string[];
  main_skill_id?: string;        // 必须 ∈ skills
  main_skill_baseline?: {
    skill_id: string;
    validation_id?: string;       // 指向 skill-validation-run
    recorded_at: string;
  };
}
```

规范：

- `_normaliseBindings` 必须兼容缺字段（缺失 = 无主技能），旧数据不迁移
- `main_skill_id` 写入时校验 ∈ `skills`，不在集合内拒绝
- 主技能指针属项目配置，**只落 `bindings.json`**，不得写入 skill 自身的 `SKILL.md`（AGENTS.md：组件启用状态是用户偏好，不进 spec）
- 基线的 `validation_id` 复用 §2.3，不新建校验

### 4.2 Task Run

在项目任务与执行记录之间建立引用，**不新建存储**：

```ts
// ProjectTask 增加
run_ids?: string[];       // → execution-records 的 executionId
latest_run_id?: string;
```

规范：

- 发起执行走 `createLifecycleSink(uid, {...})`，不直接调 `create`/`appendEvent`
- `receiptId` 在 sink 创建时传入，使 Run ↔ Receipt 关联在落盘那一刻成立
- Run 的状态**不镜像**进 `ProjectTask.status`，按需读 `execution-records.read`（对齐 `computeProgress` 的「派生不存储」原则，避免漂移）
- 产物走 `sink.artifact()`，不手写 `artifactIds`
- 事件元数据不得塞入完整提示词、凭据、绝对路径（会被强制脱敏，且违反日志规范）

### 4.3 Action Plan（只读投影）

**硬性约束：不得复活 `plan_executor.ts`。**

该文件头部明确记录 G8b 已用 commander-in-the-loop（`dispatch_to` / `run_worker` + handback）替换静态 plan DAG，`onPlanSet` / `reconcile` / `retryStep` 等导出仅为让调用方编译而保留的 inert no-op。AGENTS.md 将「重新引入并行 group-chat dispatch 路径」列入 Do Not。

规范：

- Action Plan 是 **读模型**，数据源为 `project_tasks`（`depends_on`）+ `execution-records`（Run 状态/事件）
- 不新建调度权威，不写入任何计划状态文件
- 渲染层投影，主进程只提供聚合查询
- 重试/跳过等操作必须走既有 group-chat 路径，不在 Action Plan 内实现调度

### 4.4 Workspace Gate（最后收口）

判据建立在既有证据之上：

```ts
export type GateStatus = 'blocked' | 'ready';
export interface WorkspaceGateDecision {
  status: GateStatus;
  reasons: string[];              // 未达成时逐条列出缺口
  receipt_execution_id?: string;
  validation_id?: string;
  evaluated_at: string;
}
```

达成条件（全部满足才 `ready`）：

1. 项目存在且 `bindings.main_skill_id` 有效
2. 关联 Receipt `status === 'completed'`
3. 该 Receipt `boundary === 'real'`（`degraded` / `test-double` 不得放行 —— 对齐「组件可用 ≠ 产品接入」与 Mock 边界须标注）
4. 主技能最近一次校验 `status !== 'blocked'`

规范：

- Gate 是**纯判定函数**，不修改任何状态、不写盘
- `blocked` 时 `reasons` 必须可读且逐条对应缺口，供 UI 直接展示
- 渲染层在 `status !== 'ready'` 时**不得渲染 Workspace 主体**（对应「未达成不得展示 Workspace」）
- 判定所需数据一次性读取后传入，不在函数内散读

---

## 5. 推进顺序

原「倒着做（Receipt 先行）」的建议随 Receipt 已存在而失效。修正顺序：

| 阶段 | 内容 | 依赖 |
|---|---|---|
| 1 | 命名决策（§3）+ Main Skill 指针与基线 | 无 |
| 2 | Task Run 引用桥接 | 阶段 1 |
| 3 | Workspace Gate 判定 | 阶段 1、2 |
| 4 | Action Plan 投影 | 阶段 2 |
| 5 | 渲染层接线 + Gate 拦截 | 阶段 3、4 |

理由：Gate 的四条判据中两条依赖 Main Skill，一条依赖 Run/Receipt 关联，因此 Gate 必须排在两者之后；Action Plan 纯投影，可与 Gate 并行。

---

## 6. 分层与落盘规范

依 AGENTS.md：

- `ipc/` 只校验参数并转调 feature，不含业务逻辑
- 新建工作容器模块置于 `features/`，可用 storage / paths / util / 同级 feature
- 用户私有数据函数 **第一参为 `userId`**
- 判定/投影类纯函数不得反向 import features
- 执行与校验记录属机器私有 → `local/`；项目、任务、bindings 属可同步 → `cloud/`。不得把执行记录写入 `cloud/`
- 不得缓存 uid 派生路径为模块级常量
- 新增 `window.orkas.*` 必须有对应主进程 handler；渲染层为 classic script，新脚本需登记 `index.html`
- 可见文案走 `locales/*.json` + `t(...)`，动态文案在 `i18n-change` 重渲染
- 日志用 `createLogger`，可恢复失败 `warn`、破坏不变量 `error`，敏感字段先脱敏

---

## 7. 测试规范

覆盖业务不变量与跨层契约，不测试类型包装与happy-path-only：

- Main Skill：`main_skill_id ∉ skills` 必须被拒；缺字段旧数据正常读取
- Task Run：终态回退被拒；`update` 传未知键被拒；`run_ids` 与 `execution-records` 引用一致
- Receipt 交互：`prepared` 之外状态再次 `completeReceipt` 抛错；完成阶段改不可变字段抛错
- Gate：四条判据各自单独不满足时均为 `blocked` 且 `reasons` 命中对应项；`boundary === 'degraded'` 必须 `blocked`
- Action Plan：投影不产生任何写盘副作用

命令：

```bash
npm test                # 全量，脚本自管 sqlite ABI（勿用 npx vitest）
npm run typecheck
npm run rebuild:sqlite:electron   # sqlite ABI 报错时
```

---

## 8. 已知风险与待决事项

| # | 事项 | 处理 |
|---|---|---|
| 1 | **Workspace Gate 与 P3394 Wake Gate 语义重叠** — `wake-service.ts` 已有 approval / behavior_scope / context_scope / 过期判定的准入体系。两套并存会产生双重准入。 | 需 Tech Lead / PO 决策：Workspace Gate 是独立门禁，还是 Wake Gate 的上层视图。**动手前必须澄清。** |
| 2 | **US-18/19 定义缺失** — Sprint 2 v0.94 backlog 中 `US-18/19/20`、`Main Skill`、`Workspace` 均零命中，`P3394/` 文档仅旅程地图提及一次「执行工作台」。 | 本方案中 Main Skill Baseline 的字段形态与 Gate 判据属推断，需以 Sprint 3 backlog 正式定义校准。 |
| 3 | 本地 5 个提交（3 个 T2 工作 + 2 个合并）未推送 | 备份在 `origin/dev/wujiayu` 与本地 `backup/wujiayu-t2-local` |
| 4 | `codex_t2-04_real_run.test.ts` 失败（`timeout`） | 环境问题：需 `http_proxy=http://127.0.0.1:7897`，非代码缺陷。其余 460 文件 / 5559 用例通过 |
| 5 | T2-06（EN-08 Validator 嵌入）历史欠账 | `skill-validation-run.ts` 已含实现 + IPC + 渲染层展示，形态符合 RG-S2-09「产品内接入」而非独立 CLI。需与 PO 确认是否可据此结项 |

---

## 9. 硬性禁止

- 复活 `plan_executor.ts` 的静态 plan DAG，或新建并行 dispatch 路径
- 新建 Receipt / 执行记录存储层，绕过 `context-reuse-receipt.ts` 与 `execution-records.ts`
- 在 `features/user_workspace.ts` 中承载工作容器语义
- 把执行 / 校验记录写入 `cloud/`
- `boundary` 非 `real` 时放行 Gate
- 主技能状态写入 `SKILL.md`
- 在 IPC handler 内写业务逻辑
- 绕过 `isPathAllowed` / `fileEditLock` / 产物解析器
