# Research: 9.17 Bug 清单根因定位

**Feature**: `002-sept17-bug-fixes`

## Bug 1 — 连接测试正常但任务红圈卡死

**观察**：连通性测试通过；任务红圈不执行；重新测试连接后任务恢复。

**链路对比**

| 路径 | 入口 | 是否受冷却影响 | 失败时的副作用 |
|---|---|---|---|
| 连通性测试 | `auth.testConnection` → `provider.complete()`（短 ping） | 否，`testConnection` 直接构造 provider | 成功时 `clearCooldown(profileId)` |
| 真实任务 | `runner` → `pickChatEntryGroup()` → `rotating-provider.stream()` | 是，`pickChatEntryGroup` 跳过 `isCooledDown(profileId)` | 可轮转失败 → `markCooldown(profileId, kind, reason)`（默认 10 分钟） |

**结论**：上一次长任务在流式过程中遇到可轮转失败（401/403/429/402 等），profile 进入 10 分钟冷却；下一次新任务在 `pickChatEntryGroup` 被过滤掉，候选集为空，runner 走 `errors.model_temporarily_unavailable` 分支抛错 → 界面红圈、模型不运行。用户手动「测试连接」用的是另一条不受冷却约束的链路，成功后又 `clearCooldown`，于是任务又能跑通。这正是「测试说没问题、跑任务却卡死、重测又好了」的成因。

**修复方向**：冷却不应硬阻断一次全新的用户任务。当主候选集因冷却被清空、且存在其它条件均合格的冷却候选时，把它们作为兜底候选返回，让本次任务重试一次；健康候选仍优先，失败则照旧重新冷却并上抛。

**未采用**：改动「流式已产出内容后的失败重试策略」。已产出内容后重放请求会重复输出、重复触发工具副作用，风险高于收益，属于 Out of Scope。

## Bug 2 — 三选一必填无法跳过

**定位**：`src/renderer/modules/chat-input-form.js` 的 `_validate()` 对 `required` 字段强制校验；表单只有「重置 / 确认」两个动作，没有跳过入口。

**修复方向**：当表单存在必填字段时，增加「跳过」按钮；跳过路径复用提交锁定与 `onSubmit` 通道，但不走 `_validate`，并在提交值中加入 `__skipped: true` 显式标记。编码契约（`<agent-input-submission>` 标签结构）不变，主进程 `decodeSubmission` 仍按对象解析，未知键不影响既有摘要渲染。

**契约约束**：renderer 的 `encodeChatFormSubmission` 与主进程 `router.encodeSubmission` 保持结构一致；跳过标记只作为额外取值键存在，不新增标签属性。

## Bug 3 — 知识库问答输入框固定高度

**定位**：`src/renderer/modules/kb-workbench.js` 的 `#kb-qa-input`（`rows="1"`），CSS `.kb-qa-input { height: 26px; max-height: 120px; resize: none; }`，无自动扩容逻辑。

**修复方向**：新增自动扩容函数，在 `input` 事件中按 `scrollHeight` 调整高度，封顶 `max-height`（120px），超过上限才启用纵向滚动；发送清空后复位到单行高度。复用既有 textarea 与共享控件样式，不新增可见控件。

## Bug 4 — 任务状态错乱 / 重试冲突

**现状**：`specs/001-reconcile-task-status` 已完成实现，代码位于 `src/renderer/modules/conversation.js`，测试覆盖：

- `test/renderer/conversation-polling.test.ts`
- `test/renderer/conversation-failed-retry.test.ts`
- `test/main/features/group_chat/failed-turn-retry.test.ts`

**处理**：纳入本轮回归验证，不重复改造。

## 契约变更说明（Bug 1，重要）

`test/main/model/runner.test.ts` 中原有一条用例断言：「唯一配置项处于冷却时，runner 报 `configured model is temporarily unavailable`」。这正是用户遇到的卡死行为本身——冷却把新任务直接判成模型不可用。

本次修复有意改变该契约：

- 冷却候选仍是**兜底**，健康候选永远优先（既有「健康候选优先」用例继续通过）；
- 只有当主候选集为空、且存在仅因冷却被排除的候选时，才把冷却候选交给本轮重试一次；
- 兜底候选再次失败时，`markCooldown` 照旧重新冷却并上抛真实错误，不会静默吞错；
- 真正没有任何可用凭据（删除 / 禁用 / 无法解析）时，仍保留清晰错误提示。

因此该用例已改写为「不再报临时暂停，而是重试该条目」，并在 `test/main/features/auth.test.ts` 增加冷却兜底的直接覆盖。
