# Run Center v1 Hardening — 执行 TODO

> Spec：`docs/run-center/run-center-v1-hardening-spec.md`
> 基线 commit：`0c0b7907`
> 分支：`feat/run-center-v1-hardening`
>
> **本清单严格按真实依赖排序。** 上一项未完成，下一项不得开工（除非标注「可并行」）。
> 每项字段：`depends` / `files` / `verify` / `spec`。

---

## DECISION（阻塞项，需团队拍板）

- [ ] **DECISION-01** 卡片身份可辨识信息边界
  - blocks: `RC-P0-13`，进而阻塞 Phase 3 DoD
  - 候选：A 纯结构化标识（run ordinal + 相对时间 + conv 短 id）／ B = A + agentId + turn ordinal ／ C 复用用户会话标题
  - 决策角度：可辨识性 / 隐私 / 稳定性 / 实现成本
  - 工程侧倾向：**B**（agentId 已在现有 projection 中，不扩大暴露面）
  - **必须在 Phase 1 期间完成决策**（可与 Phase 1 并行）
  - spec: §5 DECISION-01

- [ ] **DECISION-02** 每个 actor turn 是否继续独占一个 CogSeed Task
  - blocks: 无（本轮默认不重构）
  - 本轮结论：**不重构**，记为架构债务 D-1
  - 需团队确认该结论，而非默认接受
  - spec: §5 DECISION-02

---

## Phase 0 — 基线与开发安全

- [ ] **RC-T00** 建立修复分支与测试基线
  - depends: 无
  - files: —
  - verify:
    - `feat/run-center-v1-hardening` 已从 `0c0b7907` 切出（**不是从 develop**）
    - 以下测试全绿并存档结果：`test/main/features/cogseed_backend/task-store.test.ts`、`group-chat-task-bridge.test.ts`、`group-chat-dashboard-action.test.ts`、`renderer-projection.test.ts`、`runtime-controller.test.ts`、`test/main/features/group_chat/bus.test.ts`、`bus-integration.test.ts`、`failed-turn-retry.test.ts`、`test/renderer/run-center.test.ts`、`test/main/ipc/cogseed-backend.test.ts`
    - 冲突热点清单（`bus.ts` 的 `_enqueueBody` / `runActorTurn` / `_emitTaskRunTerminalIfQuiescent`、`conversations.sendStream` 签名）已同步给并行开发者
    - 已确认 `git rev-list --left-right --count origin/develop...0c0b7907` 仍为 `0  1`
  - spec: §7

---

## Phase 0.5 — 最小 Renderer 交互测试脚手架

- [ ] **RC-T01** 引入 DOM 测试环境与 Run Center harness
  - depends: `RC-T00`
  - files:
    - `package.json`（新增 `jsdom` devDependency）
    - `vitest.config.ts`（**不改全局 environment**，测试文件用 `// @vitest-environment jsdom` docblock）
    - `test/renderer/_run-center-harness.ts`（新建）
    - `THIRD_PARTY_NOTICES.md`、`third_party_licenses/`（license 归档）
  - verify:
    - `npm run sbom:check` 通过
    - `npm run reuse:check` 通过
    - harness 能**在加载 `run-center.js` 之前**注入 mock `window.cogseed`（实测 contextBridge 对象 `writable:false, configurable:false, frozen:true`，事后覆盖必然失败）
    - 5 条冒烟通过：①点 Refresh → `cogseed.session.read` 被调用；②选中 Task → detail 渲染 taskId；③mock 状态翻转 → 卡片换列；④**改写后**：4 个 column 节点存在且 completed 含预期卡片数；⑤`[data-run-center-open]` 可达
    - 新测试**零 source-string 主断言**
  - ⚠️ 注意：jsdom **不做 layout**，`getBoundingClientRect()` 恒为 0 —— 原「completed 列实际可见」命题不可测，已按 spec §8 改写为结构断言
  - spec: §8

---

## Phase 1 — Refresh / Realtime / 状态收敛

- [ ] **RC-P0-01** 修完整 Refresh（Board + Session + Detail + Timeline + Collaboration）
  - depends: `RC-T01`
  - files: `src/renderer/modules/run-center.js`
  - 修改点: `refresh()` 的 `:186` 守卫 `if (task && (!state.selectedTaskId || !state.selectedSessionId))`
  - verify:
    - 已选中状态下 `refresh()` → 断言 `cogseed.session.read` 被调用
    - detail / timeline / collaboration DOM 内容随之更新
    - selected task 已消失 → 回落 board 首项，不抛错
    - selected session 已删除 → 清空选中并显示空态，不停在 error
    - detail 重拉期间不整屏闪空
    - 去除 `action()` 路径（`:204-205`）的重复 `select()`，断言单次 action 不产生重复 `session.read`
  - spec: §9.1 / RC-P0-01

- [ ] **RC-P1-15** `listCogSeedTasks()` 查询边界（**提前到此，因 RC-P0-02 会放大扫描成本**）
  - depends: `RC-T00`
  - files: `src/main/features/cogseed_backend/task-store.ts`、`ipc-service.ts`
  - verify:
    - `listCogSeedTasks()` 支持可选 `{ limit, since }`
    - 构造 > limit 个 task → 断言按 `updatedAt` 降序截断
    - 断言**非终态（活跃）任务永不被时间窗裁掉**
    - 单次 Refresh 不产生两次完整目录扫描
    - 保留策略已文档化（active 永久可见 / recent 近 N 天 / archived 仅 session 详情可达）
  - spec: §12 / RC-P1-15

- [ ] **RC-P0-02** Run Center 可见期轮询
  - depends: `RC-P0-01`, `RC-P1-15`
  - files: `src/renderer/modules/run-center.js`
  - verify:
    - 条件 `panel-run-center.active && !document.hidden && !state.busyAction` → 5s `refresh()`
    - 进入 Run Center 建立 interval
    - 离开页面 / `document.hidden` → 停止
    - 重复进入**不产生第二个 interval**
    - `busyAction` 期间不并发 refresh
    - `visibilitychange` 回到可见立即补一次 refresh
    - teardown 正确（无泄漏 timer）
  - ⚠️ 不得复用 `cogseed.task.events` stream —— 它是一次性分页读，不是订阅
  - spec: §9.2 / RC-P0-02

- [ ] **RC-P1-09** retry 新旧 task 建立关联（**提前到此，因 RC-P1-03 的 retry 终止条件依赖它**）
  - depends: `RC-P0-01`
  - files: `src/main/features/cogseed_backend/ipc-service.ts`、`group-chat-task-bridge.ts`、`src/main/features/group_chat/bus.ts`、`src/renderer/modules/run-center.js`
  - ⚠️ **触碰 `bus.ts:_enqueueBody`（并行开发热点）→ 单独成 PR 且优先合入**
  - verify:
    - retry 后新 parent task 的 `retryOfTaskId === 旧 taskId`
    - projection 透出 `retryOfTaskId`
    - UI 在卡片与详情区渲染「重试自 …」关联标注
    - 旧 failed task 状态不被篡改
  - spec: RC-P1-09

- [ ] **RC-P1-03** abort / retry 状态收敛确认窗口
  - depends: `RC-P0-01`, `RC-P0-02`, `RC-P1-09`
  - files: `src/renderer/modules/run-center.js`
  - verify:
    - action 后进入确认窗口：cadence 1s，timeout 10s
    - abort 终止条件：task ∈ `{cancelled, failed, completed}`
    - retry 终止条件：出现 `retryOfTaskId === 原 taskId` 的新 task
    - mock 延迟 2 tick 翻转 → UI 最终收敛，`busyAction` 正确释放
    - **超时路径不伪造状态**，保留最后真实快照 + 提示
    - 前端全程无假改状态代码
  - spec: §9.3 / RC-P1-03

**Phase 1 完成条件** — spec §9 DoD 全部勾选。

---

## Phase 2 — 重启恢复（RC-P0-04 与 RC-P0-05 必须同一 PR）

- [ ] **RC-P0-04 + RC-P0-05** 启动恢复 + action 语义（**不可拆分**）
  - depends: `RC-T00`（可与 Phase 1 并行开发，但需在 Phase 3 前合入）
  - files:
    - `src/main/index.ts`（`registerDeferred('cogseed:task-recovery', ...)`，先例 `:1223` `skills:version-recovery`、`:1336` `recall:capture-recovery`）
    - `src/main/features/cogseed_backend/recovery.ts`
    - `src/main/features/cogseed_backend/ipc-service.ts`（`taskActions()`）
    - `src/main/features/cogseed_backend/lifecycle.ts`
  - 方案（唯一）：group-chat 非终态 task → `transitionCogSeedTask(..., 'failed', {errorCode:'app_restart'})`，**不进 `recoverable`**；非 group-chat 维持 `markCogSeedTaskRecoverable()`
  - 依据：`group_chat/index.ts:213-216` `healing orphan running state` → Group Chat 自身无 run 恢复能力
  - verify:
    - 构造 `running` group-chat parent + child task → 跑 recovery → 全部 `status==='failed' && errorCode==='app_restart'`
    - **断言不存在任何 `recoverable` 的 group-chat task**（禁止 running zombie → recoverable zombie）
    - `taskActions().retry === true` 对 `app_restart` 失败任务成立
    - `groupChatMessageId` 缺失的 parent run task 有明确处理（可 retry 或明确不可 retry + 文案）
    - recovery 失败不阻塞应用启动
    - 非 group-chat task 恢复行为无回归（现有 `runtime-controller.test.ts` 仍绿）
  - spec: §10

**Phase 2 完成条件** — spec §10 DoD 全部勾选。

---

## Phase 3 — 用户可达性

### 3A 交互可达

- [ ] **RC-P0-07** 修「打开任务」按钮
  - depends: `RC-T01`
  - files: `src/main/features/cogseed_backend/ipc-service.ts`（`taskSummary()` `:390-408`）
  - 修改点: 增加 `...(task.conversationId ? { conversationId: task.conversationId } : {})`
  - verify:
    - 选中 group-chat task → `[data-run-center-open]` 存在且值 === `conversationId`
    - 点击触发 `setView('conversation', cid)`
    - **回归**：正常加载路径下按钮存在（当前 bug 是「功能正常时按钮消失，异常时才出现」）
  - spec: RC-P0-07

- [ ] **RC-P1-08** `waiting_user` 出口
  - depends: `RC-P0-07`
  - files: `src/renderer/modules/run-center.js`、`src/renderer/locales/en.json`、`src/renderer/locales/zh.json`
  - verify:
    - `waiting_user` task 选中后「打开任务」按钮突出显示
    - 渲染说明文案（新增 i18n key，en/zh 双语齐全）
    - **不新增后端动作**
  - spec: RC-P1-08

- [ ] **RC-P2-10** resume 语义核验（仅补测试，不改代码）
  - depends: `RC-T01`
  - files: `test/`
  - verify:
    - group-chat task 各状态下 `actions.resume === false`
    - DOM 中无 `data-run-center-action="resume"`
    - 锁定该不变量防止回归
  - spec: RC-P2-10

- [ ] **RC-P2-11** filter scope 与 tab 语义一致
  - depends: 无（可并行）
  - files: `src/renderer/modules/run-center.js`
  - verify: 切到 runs / collaboration 视图后 `.run-center-filter` 不可见或 `disabled` + `aria-disabled`
  - spec: RC-P2-11

### 3B 视觉可达

- [ ] **RC-P0-06** 修看板 completed 列裁剪 ★ **P0**
  - depends: `RC-T00`
  - files: `src/renderer/style.css`、（若改结构）`src/renderer/modules/run-center-board.js`
  - 现状实测: 1456px 下 completed 列 `left=1152px` == `.run-center-main` `right=1152px`；`colsScrollW=820 / clientW=608`，溢出 212px 无滚动条
  - 方案倾向: **(a) 窄栏时 2×2 wrap**（`repeat(auto-fit, minmax(190px,1fr))`，去掉 `min-width:820px`）—— 让可见性不再依赖 layout，从而可被结构化测试覆盖
  - verify:
    - **不得只在 1456px 修死一个宽度**
    - 结构断言：4 个 column 节点均在 DOM，无 `min-width` 强约束
    - 真实浏览器冒烟（Electron + CDP）：**720 / 1050 / 1456 / 1920 四档**均满足 `column.right <= main.right`
  - spec: RC-P0-06

- [ ] **RC-P2-12** 补 `activity` icon
  - depends: 无（可并行）
  - files: `src/renderer/modules/icons.js`（或 `src/renderer/index.html`）
  - verify: `UI_ICONS['activity']` 存在；侧边栏不再回退到 `info`
  - spec: RC-P2-12

- [ ] **RC-P2-13a** 空看板文案与保留窗口协同
  - depends: `RC-P0-06`, `RC-P1-15`
  - files: `src/renderer/modules/run-center-board.js`、`locales/{en,zh}.json`
  - verify: 因时间窗被裁而空 vs 真正无任务，文案可区分，不再误导
  - spec: §4 D5

### 3C 卡片身份

- [ ] **RC-P0-13** 卡片身份可辨识 ★ **阻塞于 DECISION-01**
  - depends: **DECISION-01**, `RC-P0-01`
  - files: `src/main/features/cogseed_backend/ipc-service.ts`、`src/renderer/modules/run-center.js`、`run-center-board.js`、`locales/{en,zh}.json`
  - verify:
    - 同一 session 下多个 run 的卡片标识**两两不同**
    - 运行记录列表项两两可区分
    - **断言 projection 不含 prompt / objective / step result / 首条消息文本**
    - 隐私复审通过
  - spec: RC-P0-13 / §5 DECISION-01

**Phase 3 完成条件** — spec §11 DoD 全部勾选。

---

## Phase 4 — 数据生命周期止血

- [ ] **RC-P1-14** orphan task 级联清理
  - depends: `RC-T00`
  - files: `src/main/features/group_chat/index.ts`（`dropConv()` `:1201`）、`src/main/features/cogseed_backend/task-store.ts`
  - verify:
    - 建 group-chat task → `dropConv` → task JSON / events JSONL / request claim 均不存在
    - **只删 `executionKind==='group-chat'` 且 `conversationId` 精确匹配的 task**
    - 非 group-chat task 不受影响
    - 清理失败不阻塞会话删除（best-effort）
  - spec: RC-P1-14

> `RC-P1-15` 已在 Phase 1 完成（因 `RC-P0-02` 依赖）。

- [ ] **RC-P2-16 / RC-P2-17** N+1 与重复上溯 —— **本轮不做**
  - 在 `RC-P1-15` 落地后重新测量，作为下一阶段输入
  - spec: RC-P2-16 / RC-P2-17

**Phase 4 完成条件** — spec §12 DoD 全部勾选。

---

## Phase 5 — 前后端契约收口

- [ ] **RC-P1-18** 死字段逐项定性
  - depends: `RC-P0-01`, `RC-P0-06`, `RC-P0-13`（这些改动会改变哪些字段真正被消费）
  - files: `src/main/features/cogseed_backend/ipc-service.ts`、`src/renderer/modules/run-center.js`、`run-center-board.js`
  - 处置表:
    - DELETE: `board.counts`、`actions.skip`
    - KEEP + DISPLAY: `reviews`、`conflicts`、`recovery`、`session.taskCount`、`session.activeTaskCount`、`session.hasRecovery`
    - KEEP + RESERVED: `board.updatedAt`、`group.status`、`group.titleKey`、`group.coordinationId`、`skillVersionPinStatus`
  - verify:
    - DELETE 项已从类型定义与实现中移除
    - DISPLAY 项在 UI 中真实渲染
    - **RESERVED 项在类型定义处均有注释说明预期消费方与时间点**
    - 不存在「后端算、前端永不读、且无注释」的字段
  - spec: §13

**Phase 5 完成条件** — spec §13 DoD 全部勾选。

---

## Phase 6 — 补齐所有 P0/P1 测试

- [ ] **RC-T02** Renderer 主链测试补齐
  - depends: `RC-T01`, Phase 1–3 全部完成
  - files: `test/renderer/`
  - verify（每条均需通过）:
    - Refresh 重拉 detail / Timeline 更新 / Collaboration 更新
    - polling lifecycle（建立 / 停止 / 不重复 / busyAction 不并发）
    - completed 列**结构断言**
    - Open Task / waiting_user / retry UI 关联标注 / resume 不误显示 / filter scope / 卡片身份
    - 零 source-string 主断言
  - spec: §14

- [ ] **RC-T03** Main / Integration 测试补齐
  - depends: Phase 1–4 全部完成
  - files: `test/main/features/cogseed_backend/`、`test/main/features/group_chat/`
  - verify:
    - Group Chat run → parent Task；actor turn → child Task
    - abort → Runtime → task 最终 `cancelled`（**真实 FS**）
    - retry → new run/task + `retryOfTaskId` 关联
    - restart → `failed` + `app_restart`，且无 `recoverable`
    - retry after `app_restart` 可成功
    - orphan cleanup
    - query limit / retention（活跃任务不被裁）
  - spec: §14

- [ ] **RC-T04** 一条较真实闭环测试
  - depends: `RC-T02`, `RC-T03`
  - files: `test/renderer/` 或 `test/main/`
  - verify:
    - 链路：`Renderer(harness) → invoke('cogseed.task.action') → 真实 ipc-service.action() → 真实 group_chat action（真实 FS，mock 到 bus 边界）→ 真实 Task projection → Renderer refresh → DOM 收敛`
    - **`ipc-service` 与 `task-store` 必须是真实实现 + 真实文件系统**，不得全部 mock 到只剩函数名
  - spec: §14

- [ ] **RC-T05** 布局冒烟脚本固化
  - depends: `RC-P0-06`
  - files: `scripts/`（新建，如 `scripts/run-center-layout-smoke.mjs`）
  - verify:
    - Electron + CDP（`--remote-debugging-port`）驱动
    - 720 / 1050 / 1456 / 1920 四档断言 `column.right <= main.right`
    - 可手动运行，**不进默认 CI**
  - spec: §14 / §15

- [ ] **RC-T06** 覆盖率守门
  - depends: `RC-T02`, `RC-T03`, `RC-T04`
  - files: `vitest.config.ts`
  - verify: 不低于现有阈值（lines 61 / functions 62 / statements 58 / branches 52）
  - spec: §14

**Phase 6 完成条件** — spec §14 DoD 全部勾选。

---

## 收口

- [ ] **RC-DONE** Run Center v1 Hardening 验收
  - depends: 全部以上
  - verify: spec §16 Definition of Done 全部 20 项勾选
  - 之后方可进入 **Observability Expansion**（spec §17）
  - spec: §16
