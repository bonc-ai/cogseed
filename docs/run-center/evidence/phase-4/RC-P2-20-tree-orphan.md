# RC-P2-20 — `taskTree()` 吞掉父任务缺失的 turn

> 修复 2026-08-26 · 分支 `feat/run-center-v1-hardening`
> 性质：**Renderer correctness**，pre-existing（`0c0b7907` 起即存在），非本轮引入
> 登记：spec §17.5（**不是** Debt Registry —— 它有确定修法与可验证 DoD）

## 1. 实证（修复前，最小真实 fixture）

fixture：一个 child turn，`parentTaskId = cogseed-task-run-1`，而 `run-1` **不在本次投影中**。

```
{ "treeNodes": 0, "emptyState": "No tasks in this run" }
```

比 RC-P0-13 evidence 原先的记录更严重：不是「这一条不渲染」，而是
**整个 Runs 视图落到「无任务」空态** —— 而同一时刻**看板仍然显示这张卡片**
（探针里对该卡片的点击成功执行，说明它确实在 DOM 中）。
同一条真实数据，在两个视图里存在与否不一致。

## 2. 根因

```js
const roots = tasks.filter((task) => !task.parentTaskId || !byParent.has(task.parentTaskId));
```

`byParent` 以 `parentTaskId` 为 key，而这些 key 是**由子任务自己登记**的：

```js
for (const task of tasks) byParent.set(task.parentTaskId || '', [...]);
```

所以对任何 `task.parentTaskId` 非空的任务，`byParent.has(task.parentTaskId)` **恒为真**
（至少它自己登记过这个 key）。整个判定退化成 `!task.parentTaskId`。

后果：父任务不在投影中的 turn ——
- 不满足 `!task.parentTaskId` → 不是 root；
- 其 parentTaskId 没有对应的已渲染节点 → 也挂不上去；

→ `roots` 为空 → `stateView('run_center.tasks_empty')`。

**父任务缺失不是异常数据**：`RC-P1-15` 的保留窗口按 `updatedAt` 裁剪已完成任务，
虽然它显式保留「被保留任务的祖先」，但 session 详情走的是不套窗口的路径，
历史残缺、跨版本数据同样可能产生这种形状。

## 3. 修法

判定改为「我的父任务**是否真的在这次投影里**」：

```js
const present = new Set(items.map((task) => task.taskId));
const isRoot = (task) => !task.parentTaskId || !present.has(task.parentTaskId);
```

父任务缺失的 turn **提升为自己的 root**，仍然可见。

**明确没有做**（Part C 约束）：
- 不创建假的 parent task
- 不猜测 parent status
- 不修改 task-store 数据
- 不自动修复磁盘结构
- 不扩大为 task model 重构
- 不把 orphan child 当成应该删除的数据

**附带加固**（两处，均与既有实践一致）：
1. 渲染递归加 `seen` 环路守卫 —— 后端 `cogSeedTaskIdentity()` 与 `applyCogSeedTaskWindow()`
   已各自守同一风险，渲染侧不守则会**挂起**而非降级；
2. 环形数据导致根集为空时**扁平列出**全部任务（每个恰好一次），
   而不是在真实数据之上显示空态。不变量：**真实存在的 task 不得消失**。

## 4. UI 表达

先看既有低侵入表达方式：树节点已有 `<small data-run-center-identity>` 显示
「第 1 次运行 · 第 2 轮 · …」，本身已说明这是某次 run 的第 2 轮。
但它无法区分「父节点被折叠」与「父记录不存在」。

因此只加一个同级 `<small>`：`[data-run-center-orphan="<parentTaskId>"]` +
`run_center.parent_run_unavailable`（en `Parent run unavailable` / zh `父运行记录不可用`）。
**仅在 orphan 情况下渲染**，不改 Runs tree 视觉结构，identity 字符串本身不受污染。

## 5. 测试（13 条，`test/renderer/run-center-tree-orphan.test.ts`）

| Case | 覆盖 |
|---|---|
| 1 正常 parent-child | 树形嵌套不变，健康树上**无** orphan 标记 |
| 2 orphan child | 渲染为 root 而非空态；status（`Failed`）与 identity（`Turn 2`）真实；标记只带 parentTaskId；**不生成假 parent 行**；无 `undefined` / `null` / `NaN` |
| 3 多个 orphan | 三个不同缺失父 → 三个独立 root，互不吞掉、不合并成假 run；同名缺失父的两个 orphan 并列 |
| 4 混合 | 正常树与 orphan 共存，各自正常，仅 orphan 被标记 |
| 5 可达性 | orphan 的 detail 可达；Open Conversation 可达且 `setViewCalls === [['conversation', cid]]`；不误显示 resume / retry |
| 6 隐私 / identity | fallback 不引入新的 renderer 敏感字段（标记只有固定文案 + parentTaskId）；**不伪造 run ordinal**（投影给 7 就显示 7） |
| 环路 | 扁平列出，每个任务恰好一次，不显示空态、不挂起 |
| 真空态 | 真正没有任务时仍显示 `tasks_empty` |

## 6. 回归

| 范围 | 结果 |
|---|---|
| RC-P2-20 专项 | 13 passed |
| renderer + cogseed backend 全集 | 202 files / **1963 passed** |
| Phase 0 baseline | **266 passed / 7 skipped**（与基线逐数吻合） |
| 全量 `npm run test:js` | **9535 passed / 24 failed / 105 skipped** |
| 失败集合比对 | 与已知 canvas 24 条**逐条同名**，零新增、零消失 |
| tsc / eslint | 通过 |

`+13` 相对 Phase 3 结束（9522）完全由本次新增测试解释。

## 7. 与 Phase 4 `RC-P1-14` 的区别

两者都叫 orphan，含义相反，**不可混淆**：

| | 含义 | 应做 |
|---|---|---|
| **RC-P2-20**（本条） | 父记录缺失，但 child task **本身仍真实存在** | UI **不能吞掉它** |
| **RC-P1-14**（Phase 4） | conversation **已被明确删除** | 对应 shadow task / events / claims **应一并清理** |

两者配合后的语义：conversation 还在 → child 必须能显示；conversation 被明确删除 → child 才应被清理。
