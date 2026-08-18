# 消息平台设置界面改造设计

- 日期：2026-08-07
- 状态：已确认（v2，纳入审查修正）
- 范围：
  - `src/renderer/modules/messaging-settings.js`、`src/renderer/style.css`、`src/renderer/modules/icons.js`、`src/renderer/locales/*.json`
  - `src/main/ipc/messaging.ts`（仅一处最小修复：`messaging.update` 转发 `responseMode`）
  - `test/renderer/settings-tabs.test.ts`、`test/main/ipc/messaging.test.ts`（或对应 IPC 测试文件）

## 背景与目标

当前“设置 → 消息平台”是“渠道卡片目录 → 单渠道详情 → 返回”的两步结构（`messaging-settings.js` 中 `view: 'catalog' | 'detail'`），仅飞书中国与 Lark 全球可操作，个人微信为禁用占位，且所有渠道图标都是通用 `message-square`。

本次按参考图将页面改为常驻双栏工作区：

- 左栏：渠道菜单列表，使用各渠道真实品牌图标，按“已开放 / 即将支持”分组展示。
- 右栏：当前选中渠道的实际配置面板（扫码、Token 配置、实例列表、连接管理、解绑等），随选择即时切换，无页面跳转。

## 已确认决策

1. 布局采用紧凑双栏（方案 A），左栏约 224px，右栏占主要宽度。
2. 渠道按开放状态分组，组内按固定产品顺序排列。
3. 企业微信、Telegram 正式开放为可操作渠道（主进程已具备能力，本次接入 UI）。
4. 个人微信、QQ 机器人、钉钉、Discord 为“即将支持”：使用真实品牌图标但整体降对比度，`pointer-events: none`，不可点击、不可聚焦、不进入右栏。
5. 右侧配置区**不出现“已有应用”按钮**，也不提供 App ID/Secret 手工绑定表单；飞书/Lark 仅保留扫码创建应用路径，已绑定后保留“解绑”操作。
6. 同一渠道允许绑定多个实例，右栏展示该渠道下的**实例列表**；无实例时显示扫码/配置入口。不采用“每渠道仅最新实例”的隐藏逻辑（现有 `instanceForChannel` 取 updatedAt 最新即删除该行为）。
7. 后端改动限制为最小修复：`messaging.update` IPC 增加 `responseMode` 转发（`registry.updateInstance` 已支持，registry.ts:494-495）；其余后端协议与 IPC 不变。不引入新 npm 依赖。

## 渠道清单与分组

### 已开放（可点击，右栏加载真实配置）

| 渠道 | 平台 | 右栏流程 | 依赖 IPC |
|---|---|---|---|
| 飞书中国 | `feishu_lark` (brand=feishu) | 实例列表 + 扫码创建应用 + 响应模式/工作区 + 解绑/删除 | `messaging.feishu_qr.start/status/cancel`、`messaging.feishu_draft.create`、`messaging.update`、`messaging.unbind`、`messaging.delete` |
| Lark 全球 | `feishu_lark` (brand=lark) | 同上（brand=lark） | 同上 |
| 企业微信 | `wecom` | 实例列表 + 官方扫码绑定（受控弹窗 + postMessage） + 连接管理 + 删除 | `messaging.wecom_qr.start/status/complete/cancel`、`messaging.update`、`messaging.delete` |
| Telegram | `telegram` | 实例列表 + Bot Token 输入保存（保存后**启用**）+ 连接管理 + 删除 | `messaging.create`、`messaging.set_enabled`、`messaging.update`、`messaging.delete` |

### 即将支持（低对比度、不可点击）

个人微信（`wechat_personal`）、QQ 机器人、钉钉、Discord。

- 左栏显示“即将支持”文案（`messaging.channel.coming_soon`）。
- 菜单项不绑定点击、不进入 Tab 焦点序；`aria-disabled="true"`。

## 左栏菜单设计

- 结构：分组标签（已开放 / 即将支持）+ 菜单项。
- 菜单项：品牌图标（24–30px）+ 渠道名 + 右侧状态标签（未绑定 / 已绑定 / 连接中 / 异常，仅已开放渠道显示；已绑定 = 该渠道至少有一个实例）。
- 选中态：`is-active` 高亮（沿用现有 `is-*` 前缀的视觉语言）。
- 切渠道时：先取消进行中的扫码流程（关闭企微弹窗并 `cancelQr`/`wecom_qr.cancel`，`silent: true`），再渲染新面板。

## 右栏配置面板（按平台差异化）

### 通用结构

- 头部：品牌图标 + 渠道标题（含中国/全球 badge）+ 连接状态 + 启用开关（作用于当前选中实例）。
- **实例列表卡片**（feishu_lark / wecom / telegram 均适用）：
  - 无实例时：显示“尚未绑定”与扫码/配置入口按钮。
  - 有实例时：列出该渠道全部实例（名称、状态、启用开关、解绑/删除），点击实例进入其配置（响应模式/工作区仅 feishu_lark 支持）。
  - 允许继续新增实例（再次发起扫码 / 保存新 Token）。

### feishu_lark（飞书中国 / Lark 全球）

- 扫码卡片：扫码创建应用（二维码 + 状态 + 取消/重试）；**无“已有应用”按钮与 App ID/Secret 手工绑定表单**。
- 偏好卡片（选中实例后）：响应模式（text / streaming_card）、工作区（all），通过 `messaging.update` 保存。
- 已绑定实例：解绑 + 删除。

### wecom（企业微信）

**扫码绑定契约（关键）**：`messaging.wecom_qr.start` 返回的是官方授权页地址 `authUrl`（`https://work.weixin.qq.com/ai/qc/gen`），**不是**二维码或凭据；二维码与结果轮询均由官方页负责。流程：

1. 调 `messaging.wecom_qr.start({ displayName })`，得到 `{ flowId, state: 'awaiting_scan', authUrl, expiresAt }`。
2. 用 `window.open(authUrl)` 打开官方受控窗口（popup）。
3. 监听 `message` 事件，**全部通过才接受**：
   - `event.origin === 'https://work.weixin.qq.com'`（`AUTH_ORIGIN`，wecom-registration.ts:20）；
   - `event.source === popupWindow`（精确匹配打开窗口）；
   - 消息类型与凭据字段存在（凭据 = wecomBotId + wecomBotSecret，对应 `complete` 参数）。
4. 校验通过后调 `messaging.wecom_qr.complete({ flowId, wecomBotId, wecomBotSecret })`；`complete` 内部幂等（`flow.activation` 去重，重复成功消息不会创建第二个实例）。
5. 轮询 `messaging.wecom_qr.status({ flowId })` 直到终态（completed / cancelled / expired / failed）。
6. 切换渠道、取消或关闭面板时：关闭弹窗 + 调 `messaging.wecom_qr.cancel({ flowId })`。
7. 任何校验失败：不调 `complete`，关闭弹窗，提示后允许重试或取消。

### telegram

**“保存并连接”启用语义（关键）**：新实例默认 `enabled: false`（registry.ts:353），仅 `create`/`update` 不会真正连接。流程：

- 新建：调 `messaging.create({ platform: 'telegram', displayName: 'Telegram', secret: { botToken } })` 成功后，**继续调 `messaging.set_enabled({ instanceId, enabled: true })`**；`set_enabled` 失败时回滚（删除刚创建的实例，并提示错误）。
- 更新已有实例 Token：调 `messaging.update({ instanceId, secret: { botToken }, enabled: true })`（若用户保持关闭状态则不传 enabled，仅在表单语义为“保存并连接”时传）。
- Token 校验：沿用 IPC 侧 `^\d+:[A-Za-z0-9_-]{20,}$` 规则，renderer 侧做同样的预校验并展示错误文案。
- 表单按钮文案：无实例时“保存并连接”，有实例时“更新并重连”。

## IPC 最小修复

`src/main/ipc/messaging.ts` 的 `messaging.update`（当前 `:168-183`）增加 `responseMode` 转发：

```ts
...(payload?.responseMode !== undefined
  ? { responseMode: text(payload.responseMode, 'responseMode', 40) } // 需枚举校验
  : {}),
```

- 校验枚举：`text | streaming_card`（与 `policy.replyMode` 类似的显式校验），非法值抛错。
- 新增 IPC 测试：`responseMode` 合法值透传、非法值拒绝、缺省不覆盖。

## 图标

- `icons.js` 新增品牌 SVG 字典：`feishu`、`lark`、`wechat`、`wecom`、`telegram`、`qq`、`dingtalk`、`discord`（沿用 `data-ui-icon` 替换机制，`aria-hidden="true"`）。
- 禁用渠道使用同一图标，菜单项整体 `filter: saturate(.42)`、文字使用弱化色。
- 保留现有 `is-{channel}` 彩色块样式（`style.css:12353-12362` 已有 telegram/wechat/dingtalk/discord/wecom 预设）作为图标底色/选中辅助。

## 状态与数据

- `state.view` 收敛为右栏单面板：不再有 catalog 视图与返回按钮。
- `CHANNELS` 常量扩展为完整清单，每项含 `{ key, platform, group, icon, ... }`；`group === 'open'` 才可点击。
- 实例来源：`messaging.list` 返回全部平台实例，按 `platform`（+ feishuTenantBrand）分组到左栏渠道；右栏展示该渠道全部实例（**移除 `instanceForChannel` 的 updatedAt 取最新逻辑**，改为列表）。
- 新增 wecom 扫码流程状态（flowId/authUrl/弹窗引用/轮询）与 telegram 表单状态。

## 文案（i18n）

zh/en/ja/pt 四语言同步：

- 左栏分组：已开放 / 即将支持。
- **修改现有文案**：
  - `messaging.feishu_qr.subtitle`（zh:2984 / en:2984）：移除“可立即创建新应用**或选择已有应用**”表述，改为仅扫码创建新应用。
  - `messaging.channel.wecom.description`（zh:3091 / en:3091）：由“即将支持”改为企微扫码绑定描述。
- 新增：QQ 机器人渠道标题、企业微信扫码步骤/弹窗校验失败提示、Telegram 配置表单（Bot Token 标签、保存并连接、更新并重连、Token 校验错误、启用失败回滚提示）、实例列表（未绑定、新增实例、多实例操作）。
- 复用现有：`messaging.status.*`、`messaging.feishu_qr.*`（除 subtitle）、`messaging.response_*`、`messaging.workspace_*`、`messaging.delete_*`。

## 测试

`test/renderer/settings-tabs.test.ts`：

- 删除旧断言：源码不含 `messaging.wecom_qr`（`:136`）、`CHANNELS` 精确为 `['wechat','feishu','lark']`（`:169-190` 相关）。
- 新增断言：
  - 双栏结构类名存在（左栏菜单、右栏面板），`view: 'catalog'` 不再是渲染路径。
  - 分组顺序：已开放组含 feishu/lark/wecom/telegram，即将支持组含 wechat/qq/dingtalk/discord。
  - 禁用项不可点击：`aria-disabled`、无 click handler。
  - wecom 面板：`messaging.wecom_qr.start` 后使用 `authUrl` 打开弹窗；伪造 `event.origin`、错误 `event.source`、缺凭据字段的消息均被拒绝且不调 `complete`；合法消息调 `complete({ flowId, wecomBotId, wecomBotSecret })`；重复成功消息只产生一次 complete 结果（依赖后端幂等 + renderer 去重）。
  - telegram 面板：`messaging.create` 成功后调用 `messaging.set_enabled(instanceId, true)`；`set_enabled` 失败时调用 `messaging.delete` 回滚；更新 Token 时 `messaging.update` 含 `enabled: true`。
  - 渠道切换会取消进行中的扫码（关闭弹窗 + 对应 cancel IPC）。
  - 实例列表：同渠道多实例全部渲染，无 updatedAt 隐藏逻辑。
- i18n 文案检查加入新 key，并断言 subtitle 不再含“已有应用”。

`test/main/ipc/messaging.test.ts`（或对应 IPC 测试）：

- `messaging.update` 透传 `responseMode`；非法值拒绝；缺省不覆盖已有值。

后端其余测试（`wecom-registration.test.ts`、`wecom-adapter.test.ts`）无需改动。

## 验证

- `npm test` 全绿。
- 按工作区约定重启 messaging 运行时（`scripts/restart-cogseed.sh`），实测：
  - 双栏渲染、四渠道切换、禁用项不可交互。
  - 飞书扫码启动/取消；企微弹窗打开、扫码完成、postMessage 校验、取消清理。
  - Telegram Token 保存后实例为启用状态（而非 enabled:false）。
  - 同渠道绑定两个实例，右栏均可见且可独立管理。
  - 响应模式切换后重启应用仍保留（验证 IPC 修复生效）。

## 明确不做

- 不改 `src/main/features/messaging/` 业务逻辑（仅 `src/main/ipc/messaging.ts` 的 `responseMode` 转发修复）。
- 不新增 npm 依赖、不引入 renderer 打包器。
- 个人微信/QQ/钉钉/Discord 不提供任何可操作入口。
- 不在右栏恢复“已有应用”按钮或手工绑定表单。
- 不引入每渠道单实例的隐藏逻辑。
