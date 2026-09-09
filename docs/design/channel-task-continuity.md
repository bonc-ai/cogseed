# 渠道任务接续（G0）：命令、标注与失败回执

> 状态：已实现（分支 feat/channel-task-continuation，待评审合并） · 2026-09-03

## 1. 定位

同一渠道会话内，任务不因切换执行智能体而断线，且全程可见"谁在执行、结果谁产出、失败有回执"。一手需求来自 2026-08-26 Richard 拍板的场景："我一开始用 Claude Code，换成 Codex，然后在 Codex 上跟微信可以接着说话"。

跨渠道身份映射（微信的你 = 飞书的你）、服务端账号体系、跨机远端接续、多渠道权限治理框架均属 G2，本阶段明确不做。

## 2. 用户可见行为

| 命令/行为 | 作用 | 渠道 |
|---|---|---|
| `/agent` | 列出可切换的智能体（含指挥官；超 15 个折叠为"等 N 个"，附用法提示） | 全渠道 |
| `/agent <名字>` | 切换执行智能体；支持完整名、唯一前缀（`cod`→Codex）、原始 agent_id；多候选时列出匹配名单；`/agent 指挥官` 切回默认路由 | 全渠道（微信/Telegram 单聊的主要入口） |
| `@<名字>` | 飞书群聊内提及切换（总线既有路由，与 `/agent` 共用同一"楼层"状态） | 飞书 |
| `/status` | 显示当前任务（会话标题）与当前执行智能体 | 全渠道 |
| `/unbind` | 解绑当前渠道会话；此后消息（含一切 slash 命令）统一回复"已解绑，发送 /new 开始新任务"；`/new` 重建绑定恢复接收。历史消息与会话数据不删除 | 全渠道 |
| 回复标注 | 每条回合回复带 `【智能体名】` 前缀；飞书流式卡片在计结帧把标题拼为「实例名 · 智能体名」 | 全渠道（文本）/飞书（卡片） |
| 失败回执 | 智能体回合意外失败时渠道收到 `【智能体】执行失败：<摘要>`；用户主动取消与正常静默不发送 | 全渠道 |

## 3. 机制要点（开发者视角）

- **切换 = 楼层路由**：`/agent` 与飞书 `@提及` 最终都落到会话 `active_recipient`（`group_chat/state.ts` 的 `setActiveRecipient` + `addMember`），切换后普通消息免 @ 直达目标智能体。
- **交接 = 既有 context_handoff**：新执行的智能体首轮自动获得它可见性切片之外的有界对话摘要（`<group-context-summary>`，`group_chat/context_handoff.ts`），接续零新增交接代码。
- **撤权 = 标记不删数据**：binding 记 `unboundedAt`，入站在 `/new` 之后统一拦截（`manager.ts` 拒绝分支），`/new` 的 forceNew 轮换自然清除标记。
- **失败回执 = turn_silent 带 error**：总线仅在意外失败（非用户 abort）的静默事件携带截断摘要，`runtime.handleTurnFailure` 经出站投递台账投递（幂等键 `turn-fail-<turn_id>`），错误文本经 `sanitizeFailureText` 剥掉本地绝对路径。
- **命令注册**：`messaging/continuity_commands.ts` 经 `registerDeferred` + `manager.ts` 副作用导入安装；命令识别在 `messaging/commands.ts`。

## 4. 测试

- `test/main/features/messaging-continuity.test.ts`：命令识别、前缀/歧义/禁用拒切、切换落盘、撤权拒绝与 `/new` 恢复、标注（文本+卡片）、失败回执（含静默不扰）、入站重投幂等。
- `test/main/features/group_chat/bus.test.ts`：`/agent` 式切换后新智能体回合收到含旧对话的 `<group-context-summary>` 摘要。

## 5. 边界与后续

- 微信个微单聊无 @ 与卡片能力，交互全部走 slash 命令（渠道能力差异按平台分支处理，未建统一 capability 框架——G2 再抽象）。
- 真机验证（CDP 连真实飞书/微信演示"切换后接着做"）与 Mimosa 完整审计在合并前完成。
