# 会话区域 9.1 统一框架 —— 交接文档

> 更新日期：2026-08-15
> 交接对象：接手对话界面（会话区域）开发的同事
> 代码基线：`dev/niubaokang`（已推送 origin；MR !84 已合并进 develop）
> 规范来源：`CogSeed_60秒Aha一级导航与认知资产交互规范_doc-v0.2_Review` §9.1（Review 候选，未最终冻结）

---

## 1. 背景

9.1「会话区域统一框架」要求会话区固定为四区结构：

```text
左侧：任务与Session
中间：自然语言消息、Action Plan、工具事件、状态、Artifact、Evidence和Receipt
右侧：本次最小Context、来源、权限、运行证明或协作参与者
底部：输入、附件、执行方、继续和风险操作
```

硬约束：**主区域必须像真实 Agent 会话，不使用连续大型卡片替代过程；运行中只显示真实工具事件、状态和检查点**（不造数据、不用动画冒充执行）。

## 2. 已实现功能（对照 9.1 四区）

### 2.1 左侧：任务与 Session

会话列表项（`conversation.js`）聚合**任务状态行**（`_convTaskStatusLine` / `_refreshConvTaskLine`），三类真实运行态徽标：

- 运行中：`state_changed` 在途执行方（`_latestInFlight`）→ `conv-task-chip is-running`
- 排队：本地消息队列（`_getQueue`，来自 queue-draft.js）→ `is-queued`
- 计划进度：plan-rail 的 plan 状态（`window.planRail.planFor(cid)`）→ `is-failed / is-blocked / is-active / is-plan`，显示 `done/total`

无任何状态时返回空串，不渲染占位。状态行与侧栏徽标同源刷新（`_updateConvSidebarBadge` 顺带调用）。

### 2.2 中间：消息流 + Action Plan

- **执行计划轨道（plan-rail）**：`modules/plan-rail.js` 真实实现（不再是 no-op 桥）。渲染 `#plan-rail`（进度 `n/m` + 分段进度条 + 步骤列表 + 运行中显示「停止」按钮，走 `window.ConversationRuntime.abortConversation` abort 路径）。数据：`stream === 'plan'` 事件（`data.steps[{title|description,status,meta,reason}]` + `data.phase`），实时事件 + 历史消息 process 恢复双通道。API：`setCid / onPlanEvent / restorePlanEvent / planFor(cid)`（`planFor` 供左侧任务状态行查询进度）。
- **运行中工具事件内联**：工具事件以内联行渲染在消息流中（不是大型卡片），真实工具事件/状态/检查点如实呈现。
- **结果块收敛**：Artifact、来源引用、教学回执、KSTAR 审查卡、报销表单、recall 投影、市场请求等**收敛为紧凑结果块**（`chat-bubble` 内的 `evidenceHtml` / artifact 块 / receipt 块），不再裸挂大卡片。
- 消息流内 plan-announce 标签保留。

### 2.3 右侧：运行上下文五段面板

`modules/conversation-info.js`：右侧面板从 5 个互斥 tab 重构为**单列五段「运行上下文」**（`_renderRunContext`），每段是可折叠 `<details>`，聚焦段展开渲染全文，其余段紧凑摘要 + 首次展开懒加载（复用既有 renderer，零新增 IPC）：

| 段 | 内容 | 数据源 |
|---|---|---|
| ① 本次 Context | 最近 3 条执行记录（执行方可读名 + 状态 + 时间 + 产物数 + 查看回执）+ 来源/执行方/权限/边界 | `p3394.execution.list`（按会话过滤） |
| ② 来源 | 来源可读名 + 工作区文件/附件计数 + 最近文件 chips（懒加载全文=文件树+附件） | snapshot files/attachments |
| ③ 权限 | 最近一次执行权限模式 + 边界 + 安全说明 | execution.permissionMode / boundary |
| ④ 运行证明 | 协议事件统计（懒加载全文=协议检查器） | `/protocol-events` |
| ⑤ 协作参与者 | 任务目标 + 状态 + 参与者/步骤数（懒加载全文=协作概览） | cogseed projection / collaboration |

关键辅助函数（**用户语言红线**，勿回退为技术原文）：

- `_carriedPermissionLabel(mode)`：权限模式映射用户语言（read-only→只读 / read_write→可写 / ask→逐次询问 / workspace_approval→工作区审批 / all_files_approval→常规 / all_files_auto→全部文件自动）；**未知模式返回空串，不显示原文**
- `_readableSourceName()`：来源标题剥离内部会话 ID 后缀（`"Lark · oc_xxx"` → `"Lark"`）
- `_carriedExecutorName(execution)`：执行方按 kind 映射（core-agent→CogSeed / codex→Codex / local-agent→本地 Agent / openclaw→OpenClaw），长 ID 截断
- `_carriedBoundaryLabel(boundary)`：边界**仅在异常**（降级执行/测试替身）时显示，正常"real"不显示
- `_shortId(v)`：长 ID 截断（前 12 字符 + …）
- Receipt 明细（点击「查看回执」→ `p3394.contextReuseReceipt.read`）：来源/目标会话、复用引用、权限、边界、状态，全部经上述映射/截断

### 2.4 底部：输入、执行方、继续与风险操作

- 既有 composer 控件全部保留：`+` / `给:执行方` / `工作区` / 模型 / 思考 / 发送（**红线：不得删除**）
- **继续/重试按钮**（`index.html` composer 内，`data-role="continue-label"`）：按会话状态决定动作——空闲时显示「继续」（发送本地化继续提示），**最后一次交互失败时自动转为「重试」**；仅执行方空闲时显示。绑定见 conversation.js（主会话 `bindInput=false` 需单独绑定——修复记录见提交 1d89e570）
- **风险区**：composer 待发送区标注为风险操作确认区

## 3. 数据流速览

```text
main 侧执行（group_chat bus / core-agent）
  │  process 事件（type: event|progress，event.stream: plan|tool|...）
  ▼
renderer conversation.js _handleGroupBusEvent
  ├─ plan 事件 → window.planRail.onPlanEvent(cid, evt)   （轨道实时更新）
  ├─ 历史渲染 → _renderPersistedProcess → restorePlanEvent（重开会话恢复）
  └─ 工具事件 → 内联渲染 + 结果块收敛
  ▼
conversation-info.js（右侧五段面板）
  ├─ p3394.execution.list（IPC）→ executions（含 permissionMode/boundary/receiptId）
  ├─ p3394.contextReuseReceipt.read（IPC，点击回执时按 executionId 读）
  ├─ /protocol-events（HTTP）→ 协议事件
  └─ cogseedAgentProjection.session(cid) → collaboration 参与者
```

## 4. 关键文件

| 文件 | 职责 |
|---|---|
| `src/renderer/modules/plan-rail.js` | 执行计划轨道：状态合并、渲染、停止按钮、`planFor` |
| `src/renderer/modules/conversation.js` | 事件分发 hook、左侧任务状态行、结果块、继续/重试绑定 |
| `src/renderer/modules/conversation-info.js` | 右侧五段「运行上下文」面板、carried 系列用户语言函数 |
| `src/renderer/modules/chat-input-form.js` | composer（继续/重试按钮相关绑定） |
| `src/renderer/index.html` | `#plan-rail` 壳、五段面板容器、继续按钮 DOM |
| `src/renderer/style.css` | plan-rail / run-context / conv-task-chip / 结果块样式 |
| `src/renderer/locales/{zh,en,ja,pt}.json` | 全部新增文案（`conversation_info.run_context.*`、`conversation_info.carried.*`、`plan.stop`、`chat.continue` 等） |

## 5. 测试

- `test/renderer/session-area-framework.test.ts`（新增）：结果块容器/继续按钮/重试切换/风险区标签等
- `test/renderer/conversation-info.test.ts`：五段面板、执行记录用户语言断言（断言不出现 `all_files_approval` 等原文）、会话 ID 掩码、回执展开
- `test/renderer/conversation-produced-chips.test.ts`、`sidebar-navigation-contract.test.ts` 等同步更新

跑法：`npm run typecheck`；`npm test`（或 `node scripts/run-tests.mjs run test/renderer/` 只跑 renderer）。

## 6. 已知问题与待办

1. **未合入主线的独立改进**（在本地 worktree `dev/niubaokang-session-area` 分支，未推送）：plan-rail 纯函数测试桥 + 10 个单测（`test/renderer/plan-rail.test.ts`）、侧边栏拉伸手柄增强（命中区 10px + 悬停指示条）。如需可 cherry-pick：`9493f9a0`（测试桥）、`fcf725ff`（手柄增强，含右侧用户语言重构——**该重构大部分已被主线吸收，只需 cherry-pick 手柄部分**）。
2. **「本次最小 Context 内容摘要」未做**：右侧 ① 段显示真实执行记录与引用，但"携带了哪项能力/角色切片"的内容级摘要需要主进程 ContextProjection 数据链路（recall/p3394 投影），尚未接入。
3. **实机验证**：五段面板、继续/重试、拖拽手柄建议在真实运行环境过一遍（本机 `./run.sh` 启动）。
4. **存量测试失败（与本次改动无关，基线同样失败）**：`test/main/features/security/` 约 27 项（sentry 适配器环境依赖）；`test/renderer/lazy-features.test.ts`、`skills-nseap-declaration.test.ts` 3 项（develop 合并漂移）。
5. **规范未冻结事项**：doc-v0.2 是 Review 候选；初始额度数值、Token 平台、Hub 首发范围等（§13）**未冻结，不得硬编码为 UI 承诺**（如"剩余 2 次短任务"等原型数字）。

## 7. 红线（评审与后续开发必须遵守）

- **用户语言原则**：内部 ID / 技术模式名（`oc_*`、`context_id`、`executionId`、`all_files_approval`、`read_write` 等）**禁止直接暴露给用户**；未知值宁可隐藏也不显示原文。这是本功能评审中用户反复强调的第一红线。
- **只显示真实状态**：无执行记录显示空态，不造数据、不用占位冒充；边界/权限必须来自真实执行数据。
- **不删除既有交互**：composer 全部控件（+ / 给 / 工作区 / 模型 / 思考 / 发送）、消息流 plan-announce 标签保留。
- 新增 IPC 需走 `src/main/ipc/index.ts` 校验模式；renderer 新窗口类能力走 `window.cogseed.invoke`。
- 分支纪律：并行功能分支只存在于本地，合回 `dev/niubaokang` 后由该分支统一推送；不新建远端分支。

## 8. 提交清单（本功能相关）

- MR !84（已合并）：执行计划轨道接通 + 「本次携带」面板（执行记录/回执）
- 主线 `dev/niubaokang`（已推送）：运行上下文五段面板、左侧任务状态行、继续/重试、结果块收敛、工具事件内联（提交 `3cd6db7d..e88275e1`，作者牛保康）
- 本地 worktree 未推送：见 §6.1
