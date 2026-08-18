# Desktop-first Feishu Touchpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 在 Electron Desktop 中建立新的 Mate 主体工作台，并以真实飞书连接完成首次接入、主动简报、事实确认、任务审批和结果回报闭环。

**Architecture:** 新增通用 Touchpoint 领域层，业务功能只发布领域事件，Touchpoint Orchestrator 负责策略、幂等、调度和渠道适配。Desktop 保持唯一业务状态源；Feishu adapter 只负责 OAuth 身份、卡片渲染、事件回传和投递回执。

**Tech Stack:** Electron main TypeScript、vanilla classic renderer scripts、现有 IPC allow-list、现有 storage/secret/sync/bus/plan/auto-task 能力、Feishu HTTPS bridge/deep-link、Vitest/Vitest-like project test runner。

---

## Task 1: 固定新领域契约并移除旧聚合边界

**Files:**
- Create: `src/main/features/touchpoints/types.ts`
- Create: `src/main/features/touchpoints/events.ts`
- Create: `src/main/features/touchpoints/intents.ts`
- Create: `src/main/features/touchpoints/ledger.ts`
- Create: `src/main/features/touchpoints/errors.ts`
- Modify: `src/main/features/personal_context/application/types.ts`
- Modify: `src/main/features/messaging/types.ts`
- Test: `test/main/features/touchpoints/contracts.test.ts`

- [ ] 写事件、意图、动作、送达状态和连接状态的严格类型，所有用户私有函数将 `userId` 放在第一个参数。
- [ ] 为事件和意图实现运行时校验，拒绝空 id、非法时间、未知模板、过期时间早于可用时间和跨用户引用。
- [ ] 将简报、候选确认、审批、结果汇报映射到统一 intent contract，保留现有 ledger 的持久化能力但不再由 renderer 拼接业务状态。
- [ ] 为每个事件类型写接受和拒绝 fixture，覆盖重复事件、过期动作、错误用户和非法 subject。
- [ ] 运行 `npm run typecheck` 与 `node scripts/run-tests.mjs run test/main/features/touchpoints/contracts.test.ts`。

## Task 2: 建立 Touchpoint Orchestrator

**Files:**
- Create: `src/main/features/touchpoints/orchestrator.ts`
- Create: `src/main/features/touchpoints/policy.ts`
- Create: `src/main/features/touchpoints/planner.ts`
- Create: `src/main/features/touchpoints/receipts.ts`
- Modify: `src/main/features/messaging/policy.ts`
- Modify: `src/main/features/messaging/burst-merge.ts`
- Modify: `src/main/features/messaging/ledger.ts`
- Test: `test/main/features/touchpoints/orchestrator.test.ts`

- [ ] 让领域事件进入统一编排入口，编排结果只生成 intent，不直接调用飞书 SDK。
- [ ] 实现相关性、优先级、安静时段、去重、合并、过期和触点可达性策略。
- [ ] 保证相同 `dedupeKey` 在 ledger 中只产生一个有效出站意图；失败可重试但不会重复产生业务动作。
- [ ] 实现入站 card action 的命令化转译，校验 `userId`、`intentId`、`actionId`、签名、TTL 和一次性消费状态。
- [ ] 将发送回执和用户操作回写为 domain event，禁止在 adapter 中直接改变任务或认知状态。

## Task 3: 接通真实 Feishu OAuth 和身份绑定

**Files:**
- Create: `src/main/features/touchpoints/feishu/adapter.ts`
- Create: `src/main/features/touchpoints/feishu/oauth.ts`
- Create: `src/main/features/touchpoints/feishu/cards.ts`
- Create: `src/main/features/touchpoints/feishu/inbound.ts`
- Create: `src/main/features/touchpoints/feishu/bridge-contract.ts`
- Modify: `src/main/features/personal_context/feishu/oauth.ts`
- Modify: `src/main/features/personal_context/feishu/api-client.ts`
- Modify: `src/main/features/messaging/feishu-post.ts`
- Modify: `src/main/ipc/messaging.ts`
- Modify: `src/main/preload.js`
- Test: `test/main/features/touchpoints/feishu-oauth.test.ts`
- Test: `test/main/features/touchpoints/feishu-inbound.test.ts`

- [ ] OAuth 只接受现有 API profile 生成的 HTTPS bridge redirect，不接受 localhost、自定义桌面协议或空 redirect。
- [ ] bridge 回调只返回一次性授权交换码，Desktop 通过 deep-link 完成 grant 交换；token 和 transport 只进入现有加密 secret facade。
- [ ] 身份绑定记录 Feishu tenant/user/bot identity 的非敏感元数据，不记录 token。
- [ ] 卡片渲染使用版本化模板和严格 action schema；action payload 不包含 token、完整本体或大段用户内容。
- [ ] inbound 校验签名、时间窗、用户映射、intent 过期和幂等性；非法回调返回可诊断错误并记录脱敏日志。
- [ ] 真实模式缺少 bridge 配置时显示“未配置真实连接”，不得显示成功。

## Task 4: 首次接入与资源回填

**Files:**
- Create: `src/main/features/touchpoints/onboarding.ts`
- Create: `src/main/features/touchpoints/backfill.ts`
- Create: `src/main/features/touchpoints/resource-grants.ts`
- Modify: `src/main/features/personal_context/feishu/discovery.ts`
- Modify: `src/main/features/personal_context/feishu/sync.ts`
- Modify: `src/main/features/personal_context/ontology-pipeline.ts`
- Modify: `src/main/ipc/personal-context.ts`
- Test: `test/main/features/touchpoints/onboarding.test.ts`
- Test: `test/main/features/touchpoints/backfill.test.ts`

- [ ] 首次授权流程使用明确状态机：`unbound -> authorizing -> bound -> selecting_resources -> backfilling -> reviewing -> ready`，失败必须保留错误上下文和可重试入口。
- [ ] 默认只读，资源选择存储为可撤销 grant；不同资源类型不能通过 renderer 自由拼接权限字符串。
- [ ] 回填窗口固定为过去 30 天事件和未来 90 天日历，时间保存使用源时区和绝对时间。
- [ ] 候选事实必须保留来源资源、来源片段引用、抽取时间、置信度和确认状态。
- [ ] 回填过程提供阶段进度和已处理/总数，不能以无进度的长 IPC 调用阻塞界面。

## Task 5: Desktop 新工作台 IPC projection

**Files:**
- Create: `src/main/features/desktop_workbench/types.ts`
- Create: `src/main/features/desktop_workbench/dashboard.ts`
- Create: `src/main/features/desktop_workbench/commands.ts`
- Create: `src/main/ipc/desktop-workbench.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/main/preload.js`
- Test: `test/main/ipc/desktop-workbench.test.ts`

- [ ] dashboard 只返回聚合 projection：今日时间轴、需要决策、执行中任务、触点状态和待发送信息摘要。
- [ ] projection 不暴露 token、原始 transport、内部路径或无关个人数据。
- [ ] 写操作统一走命令：确认事实、拒绝事实、修改事实、遗忘范围、批准任务、调整触达规则。
- [ ] IPC 只校验参数并调用 feature，不包含业务判断。
- [ ] 长任务使用 stream 返回进度、阶段、可恢复错误和完成结果。

## Task 6: 重做 renderer 应用壳和“今日”页面

**Files:**
- Create: `src/renderer/modules/cogseed-workbench.js`
- Create: `src/renderer/modules/cogseed-workbench-view.js`
- Create: `src/renderer/modules/cogseed-workbench-actions.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/modules/state.js`
- Modify: `src/renderer/modules/icons.js`
- Modify: `src/renderer/modules/i18n.js`
- Test: `test/renderer/cogseed-workbench-view.test.js`

- [ ] 将默认导航从旧的个人本体/设置入口改为今日、对话、行动、认知、触点；保留既有功能的深链兼容但不保留旧布局。
- [ ] 以共享 layout、surface、status、timeline、decision、task 和 empty-state 类构建页面，不新增重复 card/button 体系。
- [ ] 今日页渲染四个明确区域：Mate 注意到的事情、接下来、需要你决定、正在进行；每个动作调用集中 shim。
- [ ] 所有可见字符串进入 renderer locales，图标只使用 `modules/icons.js`。
- [ ] 加载、刷新、网络不可达、空状态、无权限和操作失败都显示明确状态；不能静默 catch。
- [ ] 对宽窗口、窄窗口和系统字体放大进行 DOM/CSS 验收。

## Task 7: 重做认知与触点页面

**Files:**
- Create: `src/renderer/modules/cognition/cogseed-cognition.js`
- Create: `src/renderer/modules/cognition/cogseed-cognition-view.js`
- Create: `src/renderer/modules/touchpoints/touchpoint-center.js`
- Create: `src/renderer/modules/touchpoints/touchpoint-feishu.js`
- Modify: `src/renderer/modules/personal-ontology.js`
- Modify: `src/renderer/modules/messaging-settings.js`
- Modify: `src/renderer/modules/settings.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/style.css`
- Test: `test/renderer/touchpoint-center.test.js`
- Test: `test/renderer/cogseed-cognition-view.test.js`

- [ ] 认知页按对象、事实、证据和状态展示，支持确认、编辑、拒绝、遗忘，并回到统一命令。
- [ ] 触点页展示身份、授权资源、主动联系规则、送达诊断和历史，不展示 token 或内部 connector 原始状态。
- [ ] 飞书详情页提供真实连接、测试投递、撤销授权和重新授权；测试投递必须使用真实 adapter，未配置 bridge 时显示阻断原因。
- [ ] 简报内容预览放在今日页，发送策略放在触点页；不再维护单独简报中心。

## Task 8: 接通领域事件到现有任务与对话系统

**Files:**
- Modify: `src/main/features/personal_context/briefing.ts`
- Modify: `src/main/features/personal_context/feishu-dispatch.ts`
- Modify: `src/main/features/auto_tasks.ts`
- Modify: `src/main/features/personal_ontology_candidates.ts`
- Modify: `src/main/features/group_chat/bus.ts`
- Modify: `src/main/features/plan/executor.ts`
- Test: `test/main/features/touchpoints/end-to-end-student-flow.test.ts`

- [ ] 简报 ready、候选需要确认、任务审批、任务完成和失败事件都通过 orchestrator 生成触达意图。
- [ ] 飞书卡片动作回到现有 bus/plan/auto-task/ontology 命令，不建立 Feishu 专属执行路径。
- [ ] 用户在飞书提出的问题进入 Desktop 主对话路径；Desktop 离线时生成排队回执，不伪造回答。
- [ ] 任务结果同时更新 Desktop projection 和 Feishu delivery ledger。
- [ ] 撤销 grant 后停止读取、抽取、简报引用和相关投递，并保留可审计的撤销记录。

## Task 9: 离线投递信封与恢复同步

**Files:**
- Create: `src/main/features/touchpoints/offline-envelope.ts`
- Create: `src/main/features/touchpoints/recovery.ts`
- Modify: `src/main/features/sync/transport.ts`
- Modify: `src/main/features/touchpoints/feishu/bridge-contract.ts`
- Test: `test/main/features/touchpoints/offline-envelope.test.ts`
- Test: `test/main/features/touchpoints/recovery.test.ts`

- [ ] Desktop 只将已生成的最小化消息信封交给 relay，信封带 TTL、intent id、dedupe key 和加密内容。
- [ ] relay 不接收完整本体、token、Agent prompt 或任意文件路径。
- [ ] 离线卡片动作按顺序、幂等地回传，冲突时以 Desktop 最终状态和命令版本校验为准。
- [ ] 恢复连接后同步 delivery receipt、用户动作和失败原因，并刷新今日 projection。

## Task 10: 真实环境验收与回归

**Files:**
- Modify: `scripts/restart-cogseed.sh`
- Create: `scripts/verify-feishu-touchpoint.mjs`
- Create: `docs/superpowers/runbooks/feishu-touchpoint-real-mode.md`
- Test: `test/main/features/touchpoints/real-mode-contract.test.ts`

- [ ] 运行 `npm run typecheck`。
- [ ] 运行个人上下文、messaging、touchpoint 和 renderer 聚焦测试。
- [ ] 运行 `npm test`，对既有环境相关失败逐项分类，不把环境失败归因于新代码。
- [ ] 运行 `scripts/restart-cogseed.sh`，检查 `~/.cogseed/runtime-variants/messaging/data/logs/<date>.log` 和 `/tmp/cogseed-agent-messaging-run.log`。
- [ ] 在真实 Feishu profile 下验证 OAuth、资源读取、首次回填、简报投递、卡片动作、任务审批、结果回报、撤销授权和离线排队。
- [ ] 验收失败必须显示具体阶段、请求相关 id、bridge 状态和恢复动作，日志不包含 token 或消息正文。
