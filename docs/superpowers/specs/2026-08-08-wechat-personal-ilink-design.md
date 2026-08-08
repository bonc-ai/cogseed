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
| 聊天受众 | 仅 owner 本人 | 个人助手定位；一期只支持 direct（协议是否支持群聊留待验证） |
| owner 来源 | **注册时绑定**（`confirmed.ilink_user_id`） | 消除"首条消息认领"的抢占竞态；现有飞书自动绑定（先读后写、只写 owner 不写 allowlist、并发可互踩）不能照搬 |
| context_token 落盘 | 机器私有 `local/`，加密存储 | 动态回复凭据，不应参与 cloud sync；崩溃/重启后回复延续（Hermes 同款思路） |
| `get_updates_buf` | 服务端 opaque cursor，整体替换 + 落盘 | 非"自增 offset"；官方实现如此 |
| 24h 窗口 | 产品侧保守 guard，非协议承诺 | 官方未定义该窗口；本地 guard + 服务端 stale-context 错误双保险 |
| 健康检查 | 最近一次成功 `getupdates` + terminal token 状态 | `getconfig` 需要用户参数，不是独立探针 |
| Base URL 信任 | 静态白名单 `TRUSTED_ILINK_HOSTS` + `redirect: "error"` | "confirmed 返回什么就信什么"会让白名单失去防护意义；默认 fetch 跟随重定向会跨 origin 传播 bearer |
| 回复 token | 入站消息携带的 `context_token` 绑定到该轮回复，全程传递 | Agent 回复异步，发送时重读"最新 token"会被新消息覆盖，导致旧回复串用新上下文 |
| 请求代际 | adapter generation 递增 + 结果校验 | 停止/重绑时旧 in-flight 请求可能在 abort 竞态下污染新 runtime 状态 |

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

**Wire contract（mock-fetch 断言依据）**：

所有请求固定携带以下 header：

```text
AuthorizationType: ilink_bot_token
Authorization: Bearer <bot_token>
X-WECHAT-UIN: base64(random uint32)   // 每次请求随机，防重放
iLink-App-Id: <ilink_bot_id>
iLink-App-ClientVersion: <固定版本串>
Content-Type: application/json
```

- 所有请求 `redirect: "error"`（见 3.4）；固定超时 + AbortSignal
- `getupdates` body：`{ base_info, get_updates_buf }`
- `sendmessage` body：`{ base_info, msg: { to_user_id, context_token, item_list: [{ type: "text_item", text_item: { text } }] } }`
- 响应错误判断以 JSON `ret`/`errcode` 为准；HTTP 非 2xx 与 JSON 错误均需处理

**start()**：
- 进入 `connecting`，加载本机动态状态，直接开始 `getupdates` 长轮询
- `get_updates_buf` 是服务端生成的 opaque cursor：**响应值整体替换，不能自增**
- **整批并发处理与 cursor 提交边界**：
  1. 一批消息到达后，先逐条校验/归一化，为整批建立处理任务，**并发** dispatch 全部 `onInbound`（不逐条 await——逐条等待会破坏现有约 600ms 的 burst merge 窗口，同一批消息将永远无法合并）
  2. `Promise.allSettled` 等待所有任务到达 inbound ledger 终态（`accepted/rejected/duplicate`）；`accepted` 只表示消息已可靠入队，不等待 Agent 回复完成
  3. 全部到达终态 → 提交本批服务端返回的 cursor（落盘带 generation）
  4. 任一任务异常退出或未到终态 → 不提交 cursor，下轮重放，由 inbound ledger 去重兜底
- 临时网络错误：`error → 退避 → connecting`，退避从 2 秒起指数增长并设上限（外部 abort 与长轮询超时是正常控制流，不进错误退避）
- HTTP 401 或 `getupdates` 返回 `ret/errcode = -14`：**终态**"需要重新扫码"，终止轮询，不自动重试
- **generation 代际**：adapter 持有一个单调递增的 generation；`start()` 递增并捕获为本次生命周期的代际；`stop()` abort 所有 in-flight 请求；fetch 返回后、写 state 前、调用 `onInbound` 前都校验代际，旧代际结果全部丢弃
- `checkHealth()` 不调用 `getconfig`（无安全独立探针）。返回最近一次成功长轮询的缓存状态：距最后成功 `getupdates` 超过阈值（90s）视为 `disconnected`，无轮询记录同样 `disconnected`；terminal token 状态（401/-14）为 `error`

**入站处理**（顺序固定）：
1. 只接受用户消息和文本 item；存在 `group_id` → 直接忽略（一期只支持 direct）
2. 字段校验（缺失任一即拒绝，不创建 envelope、不写 peer state、不刷新 `lastInboundAt`）：`message_id`、`from_user_id`、有效文本 item、`context_token` 必须存在且非空
3. **owner 校验前置**：`from_user_id !== ownerExternalUserId` → 仍进入 manager 产生 ledger 拒绝记录（`reason: policy_denied`），**但不写 peer state**
4. 提取 `from_user_id`、message id、文本、`context_token`；先持久化该 peer 的 token 和 `lastInboundAt` 并生成 **tokenRef**（指向 state store 加密条目），再进 manager
5. 确认无 `group_id` 后归一化 `isGroup: false`；`contextTokenRef` 写入 `InboundEnvelope`（仅微信 adapter 设置），不携带明文 token

**出站处理（回复 token 绑定）**：
- 每条入站消息的 `context_token` 绑定到**触发它的那一轮回复**：`InboundEnvelope.contextTokenRef` → manager 创建 delivery 时写入 ledger → `adapter.sendMessage(peerId, text, { contextTokenRef })` 按 ref 从 state store 取回 token
- burst merge 合并多轮入站时，使用合并批次中**最后一条有效消息**的 tokenRef
- delivery ledger 只存 tokenRef，不存明文 token；重启后的 delivery retry 按 ref 恢复 token，**不得重读 peer 最新 token**
- 缺少 tokenRef 或 ref 取回失败 → 返回 `wechat_context_missing`，不调用服务端
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
  "credentialFingerprint": "<sha256(ilinkBotId|ownerId|credentialGeneration)>",
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

**生命周期与一致性**：

- **重绑清理**：凭据（`ilinkBotToken`/`ilinkBaseUrl`/`ilinkBotId`）或 owner（`ilink_user_id`）变化时，注册流程在创建/更新实例的同一原子操作内清空该 instance 的 state（cursor 与全部 peer token）；新 runtime 只能在状态重置完成后启动
- **credential fingerprint**：state 读取时校验指纹，不匹配 fail closed（视为无状态，不读取旧 cursor/token）
- **删除实例**：同步删除对应 state 条目
- **损坏处理**：解密失败/JSON 损坏 → 隔离坏文件（rename 为 `.corrupt`）并重建空 state，日志 `error`；cursor 可重放（ledger 去重兜底），token 丢失表现为 `wechat_context_missing`，直到下一条入站重建

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

**confirmed fail closed**：`ilink_bot_id` 与 `ilink_user_id` 任一缺失或非空字符串校验失败 → 注册进入 `failed` 状态，**不创建实例**；不允许创建 enabled/unowned 实例，不允许回退为首条消息 owner claim。

**owner 注册时绑定**（registry 原子操作）：
- `ilink_user_id` 同时写入 `ownerExternalUserId` 和 `policy.allowUserIds`
- 两项在 registry 的同一个 per-user 锁内落盘，无中间态
- 不打开"等待首条消息认领 owner"的窗口
- 第一条入站必须与已绑定 owner 一致；不一致 → 拒绝并标记绑定异常，**不回退为首发者认领**

### 3.4 Base URL 与 SSRF 防护

- 一期采用静态 `TRUSTED_ILINK_HOSTS`：初始只含已验证的 `ilinkai.weixin.qq.com`
- URL 必须是 HTTPS、无用户名密码、无非标准端口
- **所有 iLink 请求使用 `redirect: "error"`**：Node `fetch` 默认跟随重定向，后续 `Location` 可能跳到非白名单 host 并携带 bearer 跨 origin 传播；遇到重定向直接失败，不自动跟随
- QR 协议里的 `redirect_host` 是应用层字段，同样必须先经同一白名单校验（HTTPS/host/端口/无用户信息），再更新轮询 Base URL
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
- `wechat_context_missing`（从未取得 token / tokenRef 取回失败）
- `wechat_context_expired_locally`（本地 24h guard 拦截）
- `wechat_reauth_required`（401 / -14，需重新扫码）
- `wechat_context_rejected`（服务端 stale-context 拒绝，服务端是最终裁决者）
- `wechat_not_connected`

`sendmessage` 非零 `ret` 分类原则：token 失效类 → `wechat_reauth_required`；stale context 类 → `wechat_context_rejected`；其余 → 通用投递失败（映射到现有 delivery 失败路径，ret 码明细表在实现计划中展开）。

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
→ 整批并发 dispatch（不逐条 await，保证 burst merge 生效）：
   1. 仅用户消息 + 文本 item；group_id 存在 → 忽略
   2. 字段校验：message_id / from_user_id / 有效文本 / context_token 任一缺失 → 拒绝，不写 state
   3. from_user_id ≠ owner → 进 manager 产生 ledger 拒绝记录（policy_denied），不写 peer state
   4. owner 消息：先写 state-store（context_token + lastInboundAt + tokenRef），再进 manager
   5. 确认无 group_id → isGroup: false；envelope 携带 contextTokenRef（不明文 token）
→ callbacks.onInbound → 现有管线：inbound ledger 去重 → burst-merge → policy → 绑定/建会话 → core-agent 回复
→ 全部任务到达 ledger 终态（accepted/rejected/duplicate）→ 提交新 get_updates_buf 落盘（带 generation）
→ 任一任务异常 → 不提交 cursor，下轮重放，ledger 去重兜底
```

### 出站（回复）

```
core-agent 生成回复 → manager → adapter.sendMessage(peerId, text, { contextTokenRef })
→ 按 tokenRef 从 state store 取回绑定该轮的 context_token（不重读 peer 最新 token）
→ 缺失/取回失败 → wechat_context_missing，不调服务端
→ POST sendmessage（text_item.text；redirect: "error"）
→ 成功 → 更新 delivery ledger（只存 tokenRef，不刷新 token）
→ 失败 → 按 ret 分类映射错误
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
| 长轮询网络错误 | `error` → 退避（2s 起指数增长，设上限）→ `connecting`；外部 abort 与长轮询超时是正常控制流，不进错误退避 |
| HTTP 401 或 JSON `ret/errcode = -14` | **终态** `error("需要重新扫码")`，终止轮询不自动重试；UI 提供重新绑定入口 |
| 二维码 expired | 单次 registration flow 内自动刷新 ≤3 次 → `cancelled` |
| verifycode / blocked | 专用状态映射，UI 语义提示，不误报网络错误 |
| 入站字段缺失（message_id/from_user_id/文本/context_token） | 拒绝，不创建 envelope、不写 peer state、不刷新 `lastInboundAt` |
| 入站非 owner | 进 manager 产生 ledger 拒绝记录（`policy_denied`），不写 peer state；不更改实例状态 |
| 群消息 | adapter 边界直接忽略，不产生 envelope |
| sendmessage 缺 token / tokenRef 取回失败 | `wechat_context_missing` |
| sendmessage 服务端拒绝（stale context） | `wechat_context_rejected`，提示用户重新发消息 |
| state 文件损坏 | 隔离为 `.corrupt` 并重建空 state，日志 `error`；cursor 重放由 ledger 去重，token 表现为 `wechat_context_missing` 直到下条入站 |
| 停止/重绑竞态 | generation 校验：旧代际的 fetch 结果一律丢弃，不写 state、不调 onInbound |

## 6. 测试

- **wechat-personal**（mock fetch）：wire contract 断言（headers 全量：`AuthorizationType`/`Authorization`/`X-WECHAT-UIN` 随机性/`iLink-App-Id`/`iLink-App-ClientVersion`；body：`getupdates` 带 `get_updates_buf`、`sendmessage` 带 `to_user_id/context_token/item_list[text_item.text]`）；批次解析；cursor 整体替换与提交时序（**整批并发 dispatch、全部到达 ledger 终态后才提交**）；同一批消息 burst merge 生效（并发 dispatch 不逐条 await）；401/-14 终态；网络退避；入站字段缺失拒绝；owner 前置校验（非 owner 不写 state、仍产生 ledger 拒绝记录）；context_token 先落盘再进 manager 的顺序；**回复绑定 tokenRef（发送时按 ref 取 token，不重读最新）**；delivery retry 恢复 tokenRef；缺 token 不调服务端；`redirect: "error"` 行为；generation 竞态（stop/重绑后旧 fetch 结果被丢弃）
- **wechat-state-store**：加密落盘/读取/损坏文件隔离 `.corrupt` 与重建/per-user mutex/credential fingerprint 不匹配 fail closed/重绑清空/删实例删 state
- **wechat-registration**：状态流转全表（wait/scaned/redirect/verifycode/blocked/expired×3/confirmed）、baseurl 校验（非 HTTPS/非白名单 host/带用户信息/非标准端口全部拒绝）、redirect_host 应用层字段白名单校验、confirmed 四字段解析与 **fail closed（bot_id/user_id 缺失 → failed，不建实例）**
- **registry**：`createWechatInstance` 原子性（owner + allowUserIds 同锁内落盘，无中间态）、validateSecret 边界
- **manager 集成**：微信实例全链路（mock adapter）——入站→owner 校验→绑定→回复（tokenRef 全程传递）；非 owner 拒绝；并发私聊不互踩；重绑后旧状态不残留
- **proactive**：条件矩阵（无 token / 超 24h / 未连接 / 未绑定 → 对应错误码）
- 全量 `npm test` 回归（平台枚举扩展可能影响既有测试夹具）

## 7. 风险与待实测项

1. **接口开放程度**：Hermes 不依赖 OpenClaw 即可用 weixin adapter，说明接口本身开放；但 `get_bot_qrcode` 的调用前置条件需 smoke test 确认
2. **扫码端要求**：社区有文章称早期仅支持 iOS 微信扫码，需实测确认
3. **群聊能力**：一期只支持 direct；发现 `group_id` 的消息忽略。协议服务端是否支持群聊尚未确定，留待后续验证（规格第 1 节"仅私聊可靠"与此处同义，均不构成对协议能力的断言）
4. **未知状态**：状态机按已收集的原始状态建模，实现时遇到未映射状态先按 `failed` 处理并记录
5. **wire contract 细节**：headers/body 字段基于社区逆向文档与 Hermes 实现，正式接入前需用真实接口 smoke test 校准（含 ret 码表）
