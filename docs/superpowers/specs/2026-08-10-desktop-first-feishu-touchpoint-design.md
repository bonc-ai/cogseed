# Mate Desktop 主体与飞书移动触点设计

## 目标

把 Mate 从“个人上下文设置中心 + 飞书消息投递器”重构为：

> Mate Desktop 是认知、任务、执行和治理主体；飞书是用户离开电脑后的移动交互触点。

第一阶段以学生场景完成真实飞书闭环，但领域模型、触点协议和前端结构不绑定课程领域。

## 产品边界

### Desktop 是唯一主体

Desktop 负责：

- 个人认知、本体和来源证据；
- 对话、任务、Agent 执行和执行证据；
- 授权范围、遗忘范围和外部写入确认；
- 简报内容生成和主动触达策略；
- 触点连接、权限、送达和诊断状态；
- 连接恢复后的最终状态合并。

### Feishu 是移动触点

Feishu 只承载移动场景的高价值交互：

- 今日简报；
- 截止风险和日程冲突提醒；
- 待确认事实；
- Agent 任务审批；
- 任务结果汇报；
- 快速问答和控制指令；
- 权限撤销和范围遗忘。

Feishu 不拥有独立的任务、本体、简报或 Agent 执行状态。

## 前端信息架构

桌面端一级区域：

1. **今日**：按“Mate 注意到的事情 / 接下来 / 需要你决定 / 正在进行”组织动态工作台；
2. **对话**：主对话与当前上下文、来源、任务和待决策信息；
3. **行动**：任务、Agent 执行、审批、结果和失败恢复；
4. **认知**：以“Mate 对我的了解”展示事实、来源、置信度、确认、修改和遗忘；
5. **触点**：连接身份、资源授权、主动联系规则、送达记录和真实连接诊断。

原“消息平台设置”“简报投递”“本体确认”不再作为三个割裂的业务中心：

- 消息平台设置重组为“触点”详情；
- 简报投递重组为“今日”内容和“触点”投递策略；
- 本体确认重组为“今日 → 需要你决定”和“认知”详情中的统一决策流。

## 领域模型

### Domain Event

业务功能只产生领域事件，不直接调用 Feishu：

- `briefing.ready`
- `ontology.confirmation_required`
- `task.approval_required`
- `task.completed`
- `task.failed`
- `deadline.risk_detected`
- `calendar.conflict_detected`
- `touchpoint.binding_changed`

事件包含 `eventId`、`userId`、`occurredAt`、`subjectId`、`kind`、最小化的非敏感摘要和可重建上下文引用，不包含 token。

### Touchpoint Intent

触点编排层把事件转换为触达意图：

- `intentId`；
- `userId`；
- `eventId`；
- `channel`；
- `template`；
- `priority`；
- `availableFrom` / `expiresAt`；
- `dedupeKey`；
- `requiresAction`；
- `actionContract`；
- `deliveryState`。

### Delivery Ledger

所有出站消息和入站卡片动作都必须幂等：

- 生成意图；
- 规划与合并；
- 发送；
- 记录外部 message id；
- 记录送达、失败、过期；
- 记录用户动作；
- 将动作转译成 Desktop 领域命令。

## 触点编排

```text
Domain Events
    -> Touchpoint Orchestrator
        -> relevance / urgency / quiet hours
        -> dedupe / burst merge / scheduling
        -> channel adapter
            -> Feishu card/message
        -> delivery ledger

Feishu callback/card action
    -> inbound command validator
    -> Desktop domain command
    -> normal business workflow
    -> state projection + receipt
```

触点层不执行 Agent、不读取个人本体、不产生平行业务状态。

## 真实连接模式

### 在线

桌面端通过现有 API profile、OAuth bridge 和 deep-link 体系完成授权。桌面端在线时，飞书事件通过 HTTPS bridge 转发给当前实例，卡片动作即时进入业务总线。

### 桌面端暂时离线

允许一个最小 HTTPS Touchpoint Relay 承担传输职责，但它不运行 Agent，也不成为状态源。它只保存短期、加密、带 TTL 的待投递信封和入站动作，待 Desktop 恢复后同步。

离线可用：

- Desktop 已预生成的定时简报和提醒；
- 卡片动作排队；
- 连接恢复后状态同步。

离线不可用：

- 新的云端 Agent 推理；
- 不在 Desktop 计划中的自主行动；
- 读取完整个人数据回答新问题。

OAuth 不使用本地 HTTP callback，不把 demo 连接当成真实成功：

```text
Feishu OAuth -> HTTPS bridge -> encrypted grant -> Electron deep link -> current Desktop instance
```

## 首次接入

1. Desktop 发起真实 OAuth；
2. 完成身份绑定；
3. 以只读默认列出可授权资源；
4. 用户选择日历、文档、知识库或云盘范围；
5. 读取近 30 天事件和未来 90 天日历；
6. 从授权资源抽取候选课程、项目、截止日期、角色和关系；
7. Desktop 展示带证据的理解摘要；
8. 用户确认关键候选；
9. 生成第一份简报；
10. 通过飞书发送可操作欢迎卡；
11. 进入持续同步、认知更新和主动触达。

## 学生场景验收

- 真实连接飞书；
- 授权日历和课程资料；
- 识别课程、作业、考试、截止日期；
- Desktop 确认认知；
- 飞书收到今日简报；
- 飞书快速查询下周课程；
- 飞书审批课程资料整理任务；
- Desktop Agent 执行并回报结果；
- 新资料产生候选事实；
- 飞书和 Desktop 都能确认、修改、遗忘；
- 撤销授权后不再读取和投递。

## 安全与治理

- 默认只读；
- 所有资源授权可查看、撤销；
- 所有外部写入和发送需要明确确认；
- 事实带来源和证据；
- 遗忘操作必须按范围生效；
- token、grant、transport 只存在加密 Secret 存储，不进入 renderer DTO、日志、本体、workspace 或 prompt；
- 卡片动作必须校验用户、连接、意图、签名、过期时间和幂等键。
