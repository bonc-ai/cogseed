# 消息平台设置界面改造设计

- 日期：2026-08-07
- 状态：已确认
- 范围：`src/renderer/modules/messaging-settings.js`、`src/renderer/style.css`、`src/renderer/modules/icons.js`、`src/renderer/locales/*.json`、`test/renderer/settings-tabs.test.ts`

## 背景与目标

当前“设置 → 消息平台”是“渠道卡片目录 → 单渠道详情 → 返回”的两步结构（`messaging-settings.js` 中 `view: 'catalog' | 'detail'`），仅飞书中国与 Lark 全球可操作，个人微信为禁用占位，且所有渠道图标都是通用 `message-square`。

本次按参考图将页面改为常驻双栏工作区：

- 左栏：渠道菜单列表，使用各渠道真实品牌图标，按“已开放 / 即将支持”分组展示。
- 右栏：当前选中渠道的实际配置面板（扫码、Token 配置、连接管理、解绑等），随选择即时切换，无页面跳转。

## 已确认决策

1. 布局采用紧凑双栏（方案 A），左栏约 224px，右栏占主要宽度。
2. 渠道按开放状态分组，组内按固定产品顺序排列。
3. 企业微信、Telegram 正式开放为可操作渠道（主进程已具备能力，本次接入 UI）。
4. 个人微信、QQ 机器人、钉钉、Discord 为“即将支持”：使用真实品牌图标但整体降对比度，`pointer-events: none`，不可点击、不可聚焦、不进入右栏。
5. 右侧配置区**不出现“已有应用”按钮**，也不提供 App ID/Secret 手工绑定表单；飞书/Lark 仅保留扫码创建应用路径，已绑定后保留“解绑”操作。
6. 不改后端协议与 IPC 层；不引入新 npm 依赖。

## 渠道清单与分组

### 已开放（可点击，右栏加载真实配置）

| 渠道 | 平台 | 右栏流程 | 依赖 IPC |
|---|---|---|---|
| 飞书中国 | `feishu_lark` (brand=feishu) | 扫码创建应用 + 响应模式/工作区 + 解绑/删除 | `messaging.feishu_qr.start/status/cancel`、`messaging.feishu_draft.create`、`messaging.update`、`messaging.unbind`、`messaging.delete` |
| Lark 全球 | `feishu_lark` (brand=lark) | 同上（brand=lark） | 同上 |
| 企业微信 | `wecom` | 企微官方扫码绑定 + 连接管理 + 删除 | `messaging.wecom_qr.start/status/complete/cancel`、`messaging.update`、`messaging.delete` |
| Telegram | `telegram` | Bot Token 输入保存 + 连接管理 + 删除 | `messaging.create`（新建）、`messaging.update`（改 Token/启用）、`messaging.delete` |

### 即将支持（低对比度、不可点击）

个人微信（`wechat_personal`）、QQ 机器人、钉钉、Discord。

- 保持现有 `messaging.channel.coming_soon` 文案语义（左栏显示为“即将支持”）。
- 菜单项不绑定点击、不进入 Tab 焦点序；`aria-disabled="true"`。

## 左栏菜单设计

- 结构：分组标签（已开放 / 即将支持）+ 菜单项。
- 菜单项：品牌图标（24–30px）+ 渠道名 + 右侧状态标签（未绑定 / 已绑定 / 连接中 / 异常，仅已开放渠道显示）。
- 选中态：`is-active` 高亮（沿用现有 `is-*` 前缀的视觉语言）。
- 已绑定渠道可在菜单项上给出已绑定提示（复用实例状态）。
- 切渠道时：先 `cancelQr({ silent: true, render: false })` 取消进行中的扫码轮询，再渲染新面板。

## 右栏配置面板（按平台差异化）

### feishu_lark（飞书中国 / Lark 全球）

复用现有 `detailPage` 主体：

- 头部：品牌图标 + 标题（含中国/全球 badge）+ 连接状态 + 启用开关。
- 扫码卡片：扫码创建应用（二维码 + 状态 + 取消/重试）；**移除“已有应用”按钮与 App ID/Secret 手工绑定入口**；已绑定后保留“解绑”操作。
- 偏好卡片：响应模式（text / streaming_card）、工作区（all）。
- 删除卡片。

### wecom（企业微信）

- 头部：品牌图标 + 标题 + 连接状态 + 启用开关。
- 扫码卡片：调 `messaging.wecom_qr.start` 获得二维码与 flowId，轮询 `status`；终态后按状态渲染（成功进入连接管理，失败/过期/取消显示对应提示与重试）。扫码成功需要 `wecom_qr.complete` 完成注册（flowId + wecomBotId + wecomBotSecret，由注册流程返回）。
- 连接管理：状态、启用开关、删除。

### telegram

- 头部：品牌图标 + 标题 + 连接状态 + 启用开关。
- 配置卡片：Bot Token 密码输入框（placeholder 如 `123456:ABC...`）+ “保存并连接”按钮；无实例时调 `messaging.create({ platform:'telegram', secret:{ botToken }, displayName:'Telegram' })`，已有实例时调 `messaging.update({ instanceId, secret:{ botToken } })`。
- 连接管理：状态、启用开关、删除。

## 图标

- `icons.js` 新增品牌 SVG 字典：`feishu`、`lark`、`wechat`、`wecom`、`telegram`、`qq`、`dingtalk`、`discord`（沿用 `data-ui-icon` 替换机制，`aria-hidden="true"`）。
- 禁用渠道使用同一图标，菜单项整体 `filter: saturate(.42)`、文字使用弱化色。
- 保留现有 `is-{channel}` 彩色块样式（`style.css:12353-12362` 已有 telegram/wechat/dingtalk/discord/wecom 预设）作为图标底色/选中辅助。

## 状态与数据

- 保留 `state.view` 机制但收敛为右栏单面板：`state.view = 'detail'` 恒为当前渠道配置，不再有 catalog 视图与返回按钮。
- `CHANNELS` 常量扩展为完整清单，每项含 `{ key, platform, available, group, icon, ... }`；`available && 已开放组` 才可点击。
- 实例来源：`messaging.list` 返回全部平台实例，按 `platform`（+ feishuTenantBrand）匹配左栏渠道；`channelForInstance` 需扩展支持 wecom/telegram。

## 文案（i18n）

zh/en/ja/pt 四语言同步：

- 左栏分组：已开放 / 即将支持。
- 新增：QQ 机器人渠道标题、企业微信扫码步骤/状态、Telegram 配置表单（Bot Token 标签、保存并连接、Token 校验错误）。
- 复用现有：`messaging.channel.*.title/description`、`messaging.status.*`、`messaging.feishu_qr.*`、`messaging.response_*`、`messaging.workspace_*`、`messaging.delete_*`。

## 测试

`test/renderer/settings-tabs.test.ts`：

- 删除旧断言：源码不含 `messaging.wecom_qr`（`:136`）、`CHANNELS` 精确为 `['wechat','feishu','lark']`（`:169-190` 相关）。
- 新增断言：
  - 双栏结构类名存在（左栏 rail/menu、右栏 panel），`view: 'catalog'` 不再是渲染路径。
  - 分组顺序：已开放组含 feishu/lark/wecom/telegram，即将支持组含 wechat/qq/dingtalk/discord。
  - 禁用项不可点击：`aria-disabled`、无 click handler。
  - wecom 面板调用 `messaging.wecom_qr.start/status/complete/cancel`；telegram 面板调用 `messaging.create`/`update` 且含 `botToken`。
  - 渠道切换会取消进行中的扫码（`messaging.feishu_qr.cancel` 或 wecom 对应 cancel）。
- i18n 文案检查加入新 key。

后端测试（`test/main/features/messaging.test.ts`、`wecom-registration.test.ts`、`wecom-adapter.test.ts`）无需改动。

## 验证

- `npm test` 全绿。
- 按工作区约定重启 messaging 运行时（`scripts/restart-mate.sh`），实测：双栏渲染、四渠道切换、飞书扫码启动/取消、企微扫码、Telegram Token 保存、禁用项不可交互。

## 明确不做

- 不改 `src/main/` 后端与 IPC 协议。
- 不新增 npm 依赖、不引入 renderer 打包器。
- 个人微信/QQ/钉钉/Discord 不提供任何可操作入口。
- 不在右栏恢复“已有应用”（App ID/Secret）按钮或手工绑定表单。
