# 个人微信（iLink）接入设计规格

日期：2026-08-08
状态：已确认（第 1、2 节评审通过）
关联实现计划：待 writing-plans 生成

## 1. 背景与目标

PC 的 messaging 框架已支持 Telegram、飞书/Lark、企业微信三个渠道。本次新增**个人微信**渠道（区别于已支持的企业微信 WeCom），让用户扫码绑定后在自己的微信里直接与 Mate Agent 对话。

**技术路线**：腾讯官方 **iLink Bot API**（产品名 ClawBot，2026-03 开放，域名 `ilinkai.weixin.qq.com`）。与 Hermes Agent 的 weixin adapter 同路线：扫码登录 + HTTP 长轮询收消息 + `sendmessage` 发消息，**无需公网端点/webhook**，符合 PC 单进程、无 HTTP server 的架构边界。纯 `fetch` 实现，零新 npm 依赖（官方 npm 包是 OpenClaw 插件形态、依赖 OpenClaw 账号体系，不适用）。

**产品形态**：
- 受众：仅绑定者本人（owner）与 bot 私聊
- 主动消息：支持，但为"尽力而为"（产品侧 24h 保守保护，非协议承诺）
- `PLATFORM_CATALOG` 中 `wechat_personal` 条目（`manager.ts`）已预留，本次从 `available: false` 转正

## 2. 关键决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 技术路线 | iLink 官方通道 | 合规（腾讯官方条款背书）、无公网端点、与现有 Telegram 长轮询 adapter 同构 |
| 聊天受众 | 仅 owner 本人 | 个人助手定位；iLink 群聊不可用，私聊为主 |
| owner 来源 | **注册时绑定**（`confirmed.ilink_user_id`） | 消除"首条消息认领"的抢占竞态；现有飞书自动绑定（先读后写、只写 owner 不写 allowlist、并发可互踩）不能照搬 |
| context_token 落盘 | 机器私有 `local/`，加密存储 | 动态回复凭据，不应参与 cloud sync；崩溃/重启后回复延续（Hermes 同款思路） |
| `get_updates_buf` | 服务端 opaque cursor，整体替换 + 落盘 | 非"自增 offset"；官方实现如此 |
| 24h 窗口 | 产品侧保守 guard，非协议承诺 | 官方未定义该窗口；本地 guard + 服务端 stale-context 错误双保险 |
| 健康检查 | 最近一次成功 `getupdates` + terminal token 状态 | `getconfig` 需要用户参数，不是独立探针 |
| Base URL 信任 | 静态白名单 `TRUSTED_ILINK_HOSTS` | "confirmed 返回什么就信什么"会让白名单失去防护意义 |

## 3. 架构与组件

```text
src/main/features/messaging/
├── wechat-personal.ts         # 新增：iLink HTTP 协议与 WechatPersonalAdapter
├── wechat-registration.ts     # 新增：扫码登录状态机
├── wechat-state-store.ts      # 新增：cursor/context_token/lastInboundAt
├── adapters.ts                # 改：createAdapter 增加 wechat_personal
├── registry.ts                # 改：平台、凭据校验、注册时原子绑定 owner
├── types.ts                   # 改：平台和 iLink 凭据类型
├── manager.ts                 # 改：平台目录、运行状态和主动投递接入
└── proactive.ts               # 改：owner-only + 24h 保守保护

src/main/
└── paths.ts                   # 改：定义 userMessagingWeChatStateFile(uid)
```

### 3.1 `WechatPersonalAdapter`（`wechat-personal.ts`）

使用原生 `fetch`，不增加依赖。生命周期复用现有 adapter 约定（`MessagingAdapter` 接口）。

**start()**：
- 进入 `connecting`，加载本机动态状态，直接开始 `getupdates` 长轮询
- `get_updates_buf` 是服务端生成的 opaque cursor：**响应值整体替换，不能自增**；一批消息全部交给 `onInbound` 后才提交新 cursor；崩溃导致重放时由现有 inbound ledger 去重
- 临时网络错误：`error → 退避 → connecting`，退避从 2 秒起指数增长并设上限
- HTTP 401 或 `getupdates` 返回 `ret/errcode = -14`：**终态**"需要重新扫码"，终止轮询，不自动重试
- `checkHealth()` 不调用 `getconfig`（无安全独立探针）；健康来自最近一次成功长轮询及 terminal token 状态

**入站处理**（顺序固定）：
1. 只接受用户消息和文本 item
2. 存在 `group_id` → 直接忽略（官方插件当前只声明 direct 能力）
3. 提取 `from_user_id`、message id、文本、`context_token`
4. **先**持久化该 peer 的最新 token 和 `lastInboundAt`，**再**进入 manager
5. 只有确认不存在 `group_id` 后，才归一化 `isGroup: false`；无法确认私聊的消息在 adapter 边界拒绝，不产生 envelope

**出站处理**：
- `sendMessage(peerId, text)` 从内存或 state store 读最新 `context_token`；缺失时**不调用服务端**，返回明确错误
- `sendmessage` 成功只更新 delivery ledger；**不刷新 token**（响应不含新 `context_token`，token 只能由后续入站消息刷新）
- wire payload 是普通 `text_item.text`；不把"客户端一定渲染 Markdown"作为协议保证

### 3.2 `wechat-state-store.ts`

保存位置：`<uid>/local/config/messaging-wechat-state.json`，路径只能通过 `paths.ts` helper 获取；使用现有原子 JSON 写入能力，feature 内加 per-user mutex。

```json
{
  "version": 1,
  "instances": {
    "<instanceId>": {
      "stateEnc": "<encrypted payload>"
    }
  }
}
```

加密 payload（使用现有 local-secret facade）包含：

```json
{
  "getUpdatesBuf": "...",
  "peers": {
    "<peerId>": {
      "contextToken": "...",
      "updatedAt": 0,
      "lastInboundAt": 0
    }
  }
}
```

cursor、peer ID、context token 与交互时间全部位于加密 payload 内，不明文落盘。该文件是运行状态，不塞进实例 registry。

### 3.3 扫码注册与 owner（`wechat-registration.ts`）

状态机至少覆盖：

```text
starting
→ awaiting_scan
→ scanned
→ redirecting / verification_required
→ completed / expired / blocked / cancelled / failed
```

识别原始状态：`wait`、`scaned`、`scaned_but_redirect`、`need_verifycode`、`verify_code_blocked`、`binded_redirect`、`expired`、`confirmed`。

`confirmed` 后接收并校验：

- `bot_token`
- `baseurl`（原始字段名）
- `ilink_bot_id`
- `ilink_user_id`

凭据字段：`ilinkBotToken`、`ilinkBaseUrl`、`ilinkBotId`。Token 是 opaque 字符串，只做长度和字符边界校验，不猜测未公开格式。

**owner 注册时绑定**（registry 原子操作）：
- `ilink_user_id` 同时写入 `ownerExternalUserId` 和 `policy.allowUserIds`
- 两项在 registry 的同一个 per-user 锁内落盘，无中间态
- 不打开"等待首条消息认领 owner"的窗口
- 第一条入站必须与已绑定 owner 一致；不一致 → 拒绝并标记绑定异常，**不回退为首发者认领**

### 3.4 Base URL 与 SSRF 防护

- 一期采用静态 `TRUSTED_ILINK_HOSTS`：初始只含已验证的 `ilinkai.weixin.qq.com`
- URL 必须是 HTTPS、无用户名密码、无非标准端口
- QR redirect 与 confirmed `baseurl` 都必须命中同一静态白名单
- 真实环境发现其他官方 host 后补充固定 host 与回归 fixture
- Renderer 不提供手填 Base URL 入口

### 3.5 主动消息（`proactive.ts`）

发送条件（全部满足才发）：
- 实例启用并处于 connected
- owner 已在注册时绑定
- 目标固定为 `self`，模型不能指定任意微信用户
- owner 存在最新 `context_token`
- `lastInboundAt` 距当前时间不超过 24 小时（产品侧保守 guard）
- 保留现有 renderer 发送确认流程

稳定错误码至少区分：
- `wechat_context_missing`（从未取得 token）
- `wechat_context_expired_locally`（本地 24h guard 拦截）
- `wechat_reauth_required`（401 / -14，需重新扫码）
- `wechat_context_rejected`（服务端 stale-context 拒绝，服务端是最终裁决者）
- `wechat_not_connected`

### 3.6 Renderer / IPC

- 新增"个人微信"可用渠道卡片和扫码弹窗（复用飞书二维码 UI 模式）
- IPC 使用 `messaging.wechat_qr.start/status/cancel` 一类现有命名风格；IPC 仅校验参数并调用 registration feature，不承载业务状态机
- Renderer 只收到二维码、公开状态和脱敏实例 DTO，永远不接触 token、Base URL 动态信任或 `context_token`
- 注册完成提示："绑定成功，可在微信中与 ClawBot 对话"（不提示"发首条消息完成 owner 绑定"）
- 补齐 zh/en/ja/pt，语言切换时重绘动态状态

## 4. 数据流

### 注册

```
UI 点击"个人微信 → 扫码绑定"
→ IPC messaging.wechat_qr.start → wechat-registration 状态机
→ GET get_bot_qrcode → 二维码回传 → UI 展示
→ 轮询 get_qrcode_status：
   wait → 继续轮询
   scaned → 等待手机确认
   scaned_but_redirect / need_verifycode / verify_code_blocked / binded_redirect → 专用状态，UI 按语义提示
   expired → 自动刷新（最多 3 次）→ 仍过期则 cancelled
   confirmed → baseurl 白名单校验通过
   → 得 bot_token / baseurl / ilink_bot_id / ilink_user_id
→ registry.createWechatInstance 单次原子操作：
   secretsEnc = { ilinkBotToken, ilinkBaseUrl, ilinkBotId }
   ownerExternalUserId = ilink_user_id
   policy.allowUserIds = [ilink_user_id]
→ UI："绑定成功，可在微信中与 ClawBot 对话"
```

### 入站

```
getupdates 长轮询返回一批消息
→ 逐条：
   1. 仅用户消息 + 文本 item；group_id 存在 → 忽略
   2. 提取 from_user_id / message_id / text / context_token
   3. 先写 state-store（context_token + lastInboundAt），再进 manager
   4. 确认无 group_id → isGroup: false
→ callbacks.onInbound → 现有管线：inbound ledger 去重 → burst-merge → policy
   → externalUserId ≠ owner → 拒绝 + 绑定异常标记（不回退认领）
   → 通过 → 绑定/建会话 → core-agent 回复
→ 整批处理完才提交新 get_updates_buf 落盘
```

### 出站（回复）

```
core-agent 生成回复 → manager → adapter.sendMessage(peerId, text)
→ 读最新 context_token（内存优先，state-store 兜底）；缺失 → wechat_context_missing，不调服务端
→ POST sendmessage（text_item.text）
→ 成功 → 更新 delivery ledger（不刷新 token）
→ 失败 → 按错误码分类
```

### 主动消息

```
messaging_send → proactive.ts：启用且 connected → owner 已绑定 → 目标 self
→ owner 最新 context_token 存在 且 lastInboundAt ≤ 24h
→ 通过 → sendMessage；服务端是最终裁决者
→ 错误分类：wechat_context_missing / wechat_context_expired_locally /
  wechat_reauth_required / wechat_context_rejected / wechat_not_connected
→ 保留 renderer 发送确认
```

## 5. 错误处理与状态机

| 场景 | 行为 |
|---|---|
| 长轮询网络错误 | `error` → 退避（2s 起指数增长，设上限）→ `connecting` |
| HTTP 401 或 JSON `ret/errcode = -14` | **终态** `error("需要重新扫码")`，终止轮询不自动重试；UI 提供重新绑定入口 |
| 二维码 expired | 自动刷新 ≤3 次 → `cancelled` |
| verifycode / blocked | 专用状态映射，UI 语义提示，不误报网络错误 |
| sendmessage 缺 token | `wechat_context_missing` |
| sendmessage 服务端拒绝（stale context） | `wechat_context_rejected`，提示用户重新发消息 |
| 入站非 owner | 拒绝 + 绑定异常标记 |
| 群消息 | adapter 边界直接忽略，不产生 envelope |

## 6. 测试

- **wechat-personal**（mock fetch）：批次解析、cursor 整体替换与提交时序（全部 onInbound 完成后才提交）、401/-14 终态、网络退避、context_token 先落盘再进 manager 的顺序、sendmessage payload 断言（`text_item.text`）、缺 token 不调服务端
- **wechat-state-store**：加密落盘/读取/损坏文件恢复/per-user mutex
- **wechat-registration**：状态流转全表（wait/scaned/redirect/verifycode/blocked/expired×3/confirmed）、baseurl 校验（非 HTTPS/非白名单 host/带用户信息/非标准端口全部拒绝）、confirmed 四字段解析
- **registry**：`createWechatInstance` 原子性（owner + allowUserIds 同锁内落盘，无中间态）、validateSecret 边界
- **manager 集成**：微信实例全链路（mock adapter）——入站→owner 校验→绑定→回复；非 owner 拒绝；并发私聊不互踩
- **proactive**：条件矩阵（无 token / 超 24h / 未连接 / 未绑定 → 对应错误码）
- 全量 `npm test` 回归（平台枚举扩展可能影响既有测试夹具）

## 7. 风险与待实测项

1. **接口开放程度**：Hermes 不依赖 OpenClaw 即可用 weixin adapter，说明接口本身开放；但 `get_bot_qrcode` 的调用前置条件需 smoke test 确认
2. **扫码端要求**：社区有文章称早期仅支持 iOS 微信扫码，需实测确认
3. **群聊能力**：官方插件当前只声明 direct；本期按群消息忽略处理，若实测支持群聊再评估二期
4. **未知状态**：状态机按已收集的原始状态建模，实现时遇到未映射状态先按 `failed` 处理并记录
