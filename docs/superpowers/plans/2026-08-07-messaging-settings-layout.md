# 消息平台设置界面双栏改造实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将“设置 → 消息平台”从卡片目录两步结构改为左渠道菜单 + 右配置面板的常驻双栏工作区，并正式接入企业微信（官方扫码）与 Telegram（Bot Token）两个渠道。

**Architecture:** 纯前端重构 + 一处最小 IPC 修复。`messaging-settings.js` 的 `view: 'catalog' | 'detail'` 收敛为单面板（左栏选中渠道 → 右栏渲染该渠道面板）；渠道清单 `CHANNELS` 扩展为 8 项并分组；`icons.js` 新增品牌图标字典；`ipc/messaging.ts` 的 `messaging.update` 增加 `responseMode` 转发（`registry.updateInstance` 已支持）。

**Tech Stack:** 原生 renderer JS（无打包器）、`data-ui-icon` SVG 图标机制、i18n locale JSON、Vitest（经 `scripts/run-tests.mjs` 跑在 Electron Node 运行时）。

## Global Constraints

- 单文件测试命令：`node scripts/run-tests.mjs run <file>`；全量：`npm test`。
- 渲染器测试沿用 `vm.runInContext` 源码断言模式（`test/renderer/settings-tabs.test.ts`、`test/renderer/icons.test.ts` 先例），纯函数通过 `module.exports` 守卫暴露。
- 后端只允许改 `src/main/ipc/messaging.ts` 的 `messaging.update`（`responseMode` 转发）；`src/main/features/messaging/` 不动。
- 不新增 npm 依赖；renderer 保持经典脚本。
- 新 UI 文案必须同时进 zh/en/ja/pt 四个 locale。
- 禁用渠道（wechat/qq/dingtalk/discord）：`aria-disabled="true"`、无 click handler、不进入 Tab 焦点。
- 飞书/Lark 面板不得出现“已有应用”按钮与 App ID/Secret 手工绑定表单。
- 企业微信消息校验：`event.origin === 'https://work.weixin.qq.com'`、`event.source === popupWindow`、消息含 `wecomBotId` + `wecomBotSecret` 字符串字段，全部通过才调 `messaging.wecom_qr.complete`。
- Telegram “保存并连接”：新建后必须 `messaging.set_enabled(instanceId, true)`，失败回滚删除实例。
- 提交信息前缀 `feat:` / `fix:` / `test:` / `docs:`，单任务一提交。

---

### Task 1: 品牌图标字典（icons.js）

**Files:**
- Modify: `src/renderer/modules/icons.js`（新增 `BRAND_ICONS` 字典，改 `uiIconHtml`）
- Test: `test/renderer/icons.test.ts`（新增 describe 块）

**Interfaces:**
- Consumes: 现有 `uiIconHtml(name, className)` 签名不变。
- Produces: `uiIconHtml('feishu' | 'lark' | 'wechat' | 'wecom' | 'telegram' | 'qq' | 'dingtalk' | 'discord', className)` 返回品牌 SVG（48×48 viewBox、fill、自带 `is-{name}` class）；未命中的名称仍回退 `UI_ICONS`。

- [ ] **Step 1: 写失败测试**

在 `test/renderer/icons.test.ts` 末尾追加：

```ts
describe('brand channel icons', () => {
  it('renders a fill-style brand svg for every messaging channel', () => {
    const { uiIconHtml } = loadIcons();
    for (const name of ['feishu', 'lark', 'wechat', 'wecom', 'telegram', 'qq', 'dingtalk', 'discord']) {
      const html = uiIconHtml(name, 'messaging-brand-glyph');
      expect(html).toContain(`is-${name}`);
      expect(html).toContain('<svg');
      expect(html).toContain('fill=');
      expect(html).not.toContain('stroke="currentColor"');
    }
  });

  it('keeps generic icons routing through the ui-icon wrapper', () => {
    const { uiIconHtml } = loadIcons();
    const html = uiIconHtml('qr-code', 'messaging-icon');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('is-qr-code');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/run-tests.mjs run test/renderer/icons.test.ts`
Expected: FAIL —— `uiIconHtml('feishu', ...)` 返回的是 stroke 包装的 `message-square`（当前 `UI_ICONS` 无 `feishu` 键，回退 `info`），断言 `fill=` 失败。

- [ ] **Step 3: 实现品牌图标字典**

在 `icons.js` 的 `UI_ICONS` 定义之后（`wrapUiIcon` 函数附近）新增：

```js
  // Fill-style brand glyphs for the messaging platform menu. Brand marks are
  // multi-color by nature, so they bypass the stroke-based ui-icon wrapper and
  // carry their own class. Simplified marks; swap for official assets if the
  // brand guidelines require exact artwork.
  const BRAND_ICONS = {
    feishu: '<svg class="is-feishu" viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><path fill="#00C2B8" d="M8 9h25l7 7-16 23H8z"/><path fill="#175CE6" d="M7 21l13 14c7 7 16 4 21-2l-7-7-8 5z"/><path fill="#0A3EAA" d="M7 21l13 14 14-9-12-11z"/></svg>',
    lark: '<svg class="is-lark" viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><path fill="#00C2B8" d="M8 9h25l7 7-16 23H8z"/><path fill="#175CE6" d="M7 21l13 14c7 7 16 4 21-2l-7-7-8 5z"/><path fill="#0A3EAA" d="M7 21l13 14 14-9-12-11z"/></svg>',
    wechat: '<svg class="is-wechat" viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><path fill="#07C160" d="M20 8c-8.3 0-15 5.4-15 12 0 3.8 2.1 7.2 5.4 9.5L9 34l5.2-2.6c1.8.6 3.7.9 5.8.9h.9a9.9 9.9 0 0 1-.3-2.4C20.6 23.5 26.8 18 34 18c.6 0 1.1 0 1.7.1A10.3 10.3 0 0 0 35 16c0-6.6-6.7-12-15-12z"/><path fill="#07C160" d="M46 30c0-5.2-5.4-9.5-12-9.5S22 24.8 22 30s5.4 9.5 12 9.5c1.5 0 2.9-.2 4.2-.7L41.5 41l-1-4.2A8.4 8.4 0 0 0 46 30z"/><circle fill="#fff" cx="27.5" cy="30" r="1.6"/><circle fill="#fff" cx="34.5" cy="30" r="1.6"/><circle fill="#fff" cx="19" cy="19" r="1.6"/><circle fill="#fff" cx="25" cy="19" r="1.6"/></svg>',
    wecom: '<svg class="is-wecom" viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><path fill="#3D9BF8" d="M14 8c-5 0-9 3.4-9 7.6 0 2.4 1.3 4.5 3.4 6l-1.4 4 4.6-2.3c.8.2 1.6.3 2.4.3h.6A6.4 6.4 0 0 1 14 16c0-4.4 4.5-8 10-8H14z"/><path fill="#2F6FE4" d="M34 17c-6.1 0-11 4-11 9s4.9 9 11 9c1 0 2-.1 2.9-.4l4.7 2.4-1.5-4.2A7.4 7.4 0 0 0 45 26c0-5-4.9-9-11-9z"/><circle fill="#fff" cx="26" cy="26" r="1.5"/><circle fill="#fff" cx="34" cy="26" r="1.5"/><circle fill="#fff" cx="16" cy="16" r="1.5"/><circle fill="#fff" cx="22" cy="16" r="1.5"/></svg>',
    telegram: '<svg class="is-telegram" viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><circle cx="24" cy="24" r="19" fill="#27A7E7"/><path fill="#fff" d="M13.5 22.8 33.5 14c1.2-.5 2.3.3 1.9 1.9l-3.7 17.3c-.3 1.3-1.1 1.6-2.2 1l-6.2-4.6-3 2.9c-.3.3-.6.6-1.3.6l.5-6.6 12-10.8c.5-.4-.1-.7-.8-.3L16.4 26.9l-6.4-2c-1.4-.4-1.4-1.4.3-2.1z"/></svg>',
    qq: '<svg class="is-qq" viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><path fill="#1D9BF0" d="M24 6c4.5 0 8 3 8.6 7l2.6 1.2c.8.4 1.3 1.2 1.3 2.1l-.6 3.7c.7.6 1.1 1.5 1.1 2.4 0 .9-.4 1.7-1 2.3.6 1.8 1.2 4.6.8 6.9-2.6-.6-5-1.8-6.8-3.4-.6.6-1.4.9-2.3 1-2.5 1.4-5.6 2.2-8.7 2.2s-6.2-.8-8.7-2.2c-.9-.1-1.7-.4-2.3-1-1.8 1.6-4.2 2.8-6.8 3.4-.4-2.3.2-5.1.8-6.9a3.2 3.2 0 0 1-1-2.3c0-.9.4-1.8 1.1-2.4l-.6-3.7c0-.9.5-1.7 1.3-2.1L15.4 13c.6-4 4.1-7 8.6-7z"/><path fill="#fff" d="M18.5 20.5a1.9 1.9 0 1 1-3.8 0 1.9 1.9 0 0 1 3.8 0zm14.8 0a1.9 1.9 0 1 1-3.8 0 1.9 1.9 0 0 1 3.8 0z"/></svg>',
    dingtalk: '<svg class="is-dingtalk" viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><rect x="6" y="6" width="36" height="36" rx="10" fill="#3B9DFF"/><path fill="#fff" d="M16 17l16 7-8 10-2-7z"/></svg>',
    discord: '<svg class="is-discord" viewBox="0 0 48 48" width="24" height="24" aria-hidden="true"><path fill="#5865F2" d="M38.5 13.2A39 39 0 0 0 31.9 11l-.7 1.4a36 36 0 0 0-14.4 0L16.1 11a39 39 0 0 0-6.6 2.2C5.3 19.4 4.2 25.4 4.7 31.3A39.8 39.8 0 0 0 12.6 36l2.2-3.6c-1.2-.5-2.4-1.1-3.5-1.8l.9-.7c5.6 2.6 11.4 2.6 17 0l.9.7c-1.1.7-2.3 1.3-3.5 1.8L28.9 36a39.8 39.8 0 0 0 7.9-4.7c.6-6.9-1-12.8-3.3-18.1zM19 27.5c-1.6 0-2.9-1.5-2.9-3.3s1.3-3.3 2.9-3.3 2.9 1.5 2.9 3.3-1.3 3.3-2.9 3.3zm10 0c-1.6 0-2.9-1.5-2.9-3.3s1.3-3.3 2.9-3.3 2.9 1.5 2.9 3.3-1.3 3.3-2.9 3.3z"/></svg>',
  };
```

然后修改 `uiIconHtml`：

```js
  function uiIconHtml(name, className) {
    const key = String(name || 'info');
    const brand = BRAND_ICONS[key];
    if (brand) return brand;
    return wrapUiIcon(key, UI_ICONS[key] || UI_ICONS.info, className);
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/run-tests.mjs run test/renderer/icons.test.ts`
Expected: PASS（两个新用例 + 原有用例）。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/modules/icons.js test/renderer/icons.test.ts
git commit -m "feat: 消息平台渠道品牌图标字典"
```

---

### Task 2: i18n 文案（四语言）

**Files:**
- Modify: `src/renderer/locales/zh.json`、`en.json`、`ja.json`、`pt.json`
- Test: `test/renderer/settings-tabs.test.ts`（i18n keys 列表与 subtitle 断言）

**Interfaces:**
- Consumes: 现有 `messaging.*` key 命名风格。
- Produces: 新 keys（供 Task 5-8 的渲染代码使用）：
  - `messaging.group.open`（已开放）、`messaging.group.soon`（即将支持）
  - `messaging.status.bound`（已绑定，左栏已开放渠道的状态标签）
  - `messaging.channel.qq.title`
  - `messaging.instance.empty`（尚未绑定）、`messaging.instance.add`（新增绑定）、`messaging.instance.title`（绑定实例）
  - `messaging.wecom_qr.start`、`messaging.wecom_qr.open_hint`、`messaging.wecom_qr.cancel`、`messaging.wecom_qr.invalid_message`、`messaging.wecom_qr.expired`、`messaging.wecom_qr.completed`
  - `messaging.telegram.token_label`、`messaging.telegram.token_placeholder`、`messaging.telegram.connect`（保存并连接）、`messaging.telegram.reconnect`（更新并重连）、`messaging.telegram.token_invalid`、`messaging.telegram.enable_failed`

- [ ] **Step 1: 写失败测试（更新 settings-tabs.test.ts）**

在 `test/renderer/settings-tabs.test.ts` 的 `provides every visible catalog and detail label in each renderer locale` 用例中，把 keys 数组替换为：

```ts
    const keys = [
      'messaging.group.open',
      'messaging.group.soon',
      'messaging.status.bound',
      'messaging.channel.coming_soon',
      'messaging.channel.feishu.title',
      'messaging.channel.feishu.badge',
      'messaging.channel.lark.title',
      'messaging.channel.lark.badge',
      'messaging.channel.qq.title',
      'messaging.association_title',
      'messaging.association_sub',
      'messaging.scan',
      'messaging.response_title',
      'messaging.response_subtitle',
      'messaging.response_streaming_card',
      'messaging.workspace_all',
      'messaging.workspace_subtitle',
      'messaging.instance.empty',
      'messaging.instance.add',
      'messaging.instance.title',
      'messaging.wecom_qr.start',
      'messaging.wecom_qr.open_hint',
      'messaging.wecom_qr.cancel',
      'messaging.wecom_qr.invalid_message',
      'messaging.telegram.token_label',
      'messaging.telegram.token_placeholder',
      'messaging.telegram.connect',
      'messaging.telegram.reconnect',
      'messaging.telegram.token_invalid',
      'messaging.telegram.enable_failed',
      'messaging.delete_subtitle',
      'messaging.updated',
      'messaging.update_failed',
      'messaging.open_failed',
    ];
```

再在该用例内追加：

```ts
    for (const locale of ['zh', 'en']) {
      const messages = JSON.parse(fs.readFileSync(path.join(root, `src/renderer/locales/${locale}.json`), 'utf8')) as Record<string, string>;
      expect(messages['messaging.feishu_qr.subtitle']).not.toMatch(/已有应用|existing/i);
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: FAIL —— 新 keys 缺失、subtitle 含“已有应用”。

- [ ] **Step 3: 修改四个 locale**

`zh.json`（`messaging.channel.dingtalk.title` 附近，约 3075-3091 行区域）：

```json
  "messaging.group.open": "已开放",
  "messaging.group.soon": "即将支持",
  "messaging.status.bound": "已绑定",
  "messaging.channel.qq.title": "QQ 机器人",
  "messaging.channel.wecom.description": "扫码创建官方智能机器人，使用 WebSocket 长连接双向对话。",
```

把 `messaging.feishu_qr.subtitle`（zh.json:2984）改为：

```json
  "messaging.feishu_qr.subtitle": "使用飞书官方授权流程扫码创建新应用，应用凭据会安全保存在本机。",
```

在 `messaging.association_sub` 附近追加：

```json
  "messaging.instance.title": "绑定实例",
  "messaging.instance.empty": "尚未绑定",
  "messaging.instance.add": "新增绑定",
  "messaging.wecom_qr.start": "开始扫码绑定",
  "messaging.wecom_qr.open_hint": "扫码窗口已打开，请在企业微信中完成授权。",
  "messaging.wecom_qr.cancel": "取消扫码",
  "messaging.wecom_qr.invalid_message": "收到无法校验的企业微信授权消息，已忽略。",
  "messaging.wecom_qr.completed": "企业微信机器人绑定成功",
  "messaging.telegram.token_label": "Bot Token",
  "messaging.telegram.token_placeholder": "粘贴 BotFather 生成的 token",
  "messaging.telegram.connect": "保存并连接",
  "messaging.telegram.reconnect": "更新并重连",
  "messaging.telegram.token_invalid": "Bot Token 格式无效，请检查后重试。",
  "messaging.telegram.enable_failed": "机器人已创建但启用失败，已回滚删除，请重试。",
```

`en.json` 对应翻译：

```json
  "messaging.group.open": "Available",
  "messaging.group.soon": "Coming soon",
  "messaging.status.bound": "Bound",
  "messaging.channel.qq.title": "QQ Bot",
  "messaging.channel.wecom.description": "Scan to create an official smart bot with two-way WebSocket chat.",
  "messaging.feishu_qr.subtitle": "Scan with Feishu's official flow to create a new app. App credentials stay encrypted on this device.",
  "messaging.instance.title": "Bound instances",
  "messaging.instance.empty": "Not bound yet",
  "messaging.instance.add": "Add binding",
  "messaging.wecom_qr.start": "Start scan binding",
  "messaging.wecom_qr.open_hint": "The scan window is open. Complete the authorization in WeCom.",
  "messaging.wecom_qr.cancel": "Cancel scan",
  "messaging.wecom_qr.invalid_message": "Ignored an unverifiable WeCom authorization message.",
  "messaging.wecom_qr.completed": "WeCom bot bound successfully",
  "messaging.telegram.token_label": "Bot Token",
  "messaging.telegram.token_placeholder": "Paste the token from BotFather",
  "messaging.telegram.connect": "Save & connect",
  "messaging.telegram.reconnect": "Update & reconnect",
  "messaging.telegram.token_invalid": "Invalid Bot Token format. Please check and retry.",
  "messaging.telegram.enable_failed": "Bot created but enable failed; rolled back and deleted. Please retry.",
```

`ja.json`、`pt.json` 同样位置加对应翻译：ja 用“利用可能 / 近日対応 / 接続済み”、pt 用“Disponível / Em breve / Conectado”。`messaging.channel.qq.title`：ja“QQボット”、pt“QQ Bot”。`messaging.channel.wecom.description`：ja“公式スマートボットをQRコードで作成し、WebSocket長接続で双方向会話。”、pt“Crie um bot oficial via QR code com conversa bidirecional por WebSocket.”。`messaging.feishu_qr.subtitle`：ja“飞書の公式認証フローでQRコードをスキャンして新しいアプリを作成します。認証情報はこのデバイスに安全に保存されます。”、pt“Use o fluxo oficial do Feishu para escanear e criar um novo aplicativo. As credenciais ficam criptografadas neste dispositivo.”。其余新增 keys 按现有 `messaging.*` 的 ja/pt 翻译风格逐条补齐（与 zh/en 同义即可）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/locales/ test/renderer/settings-tabs.test.ts
git commit -m "feat: 消息平台渠道分组与企微/Telegram 配置文案（四语言）"
```

---

### Task 3: IPC 修复 —— messaging.update 转发 responseMode

**Files:**
- Modify: `src/main/ipc/messaging.ts:168-183`
- Test: `test/main/features/messaging.test.ts`（`messaging IPC validation` describe 块内）

**Interfaces:**
- Consumes: `registry.updateInstance`（已支持 `responseMode`，registry.ts:494-495）。
- Produces: `messaging.update` IPC 接受 `payload.responseMode: 'text' | 'streaming_card'`，非法值抛错，缺省不覆盖。

- [ ] **Step 1: 写失败测试**

在 `test/main/features/messaging.test.ts` 的 `messaging IPC validation` describe 块内（`:335-341` 的 `messaging.update` 用例附近）新增：

```ts
  it('forwards responseMode on update and rejects invalid values', async () => {
    const created = await invokeHandlers['messaging.feishu_draft.create']({
      feishuTenantBrand: 'feishu',
      displayName: '响应模式测试',
    });
    const instanceId = created.instance.id;

    const updated = await invokeHandlers['messaging.update']({
      instanceId,
      responseMode: 'streaming_card',
    });
    expect(updated.instance.responseMode).toBe('streaming_card');

    const untouched = await invokeHandlers['messaging.update']({
      instanceId,
      displayName: '不覆盖响应模式',
    });
    expect(untouched.instance.responseMode).toBe('streaming_card');

    await expect(invokeHandlers['messaging.update']({
      instanceId,
      responseMode: 'bogus_mode',
    })).rejects.toThrow();
  });
```

（若该文件已有类似 setEnabled 的前置结构，沿用其创建 instance 的既有辅助函数。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/run-tests.mjs run test/main/features/messaging.test.ts`
Expected: FAIL —— `updated.instance.responseMode` 为 undefined（IPC 未转发）。

- [ ] **Step 3: 实现转发**

`src/main/ipc/messaging.ts` 的 `messaging.update` handler 中，在 `...(payload?.policy !== undefined ...)` 行后追加：

```ts
      ...(payload?.responseMode !== undefined ? { responseMode: responseMode(payload.responseMode) } : {}),
```

并在文件顶部 `policy()` 函数附近新增枚举校验函数：

```ts
function responseMode(value: unknown): MessagingResponseMode {
  const result = text(value, 'responseMode', 40);
  if (result !== 'text' && result !== 'streaming_card') throw new Error('invalid responseMode');
  return result;
}
```

更新类型导入（`MessagingResponseMode` 加进 `from '../features/messaging/types'` 的导入列表，若类型文件已导出该类型——`registry.ts` 中已使用 `MessagingResponseMode`，确认 `types.ts` 有导出）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/run-tests.mjs run test/main/features/messaging.test.ts`
Expected: PASS（新增用例 + 原有用例）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ipc/messaging.ts test/main/features/messaging.test.ts
git commit -m "fix: messaging.update IPC 转发 responseMode 并校验枚举"
```

---

### Task 4: 渠道模型扩展（CHANNELS / channelForInstance / instancesForChannel）

**Files:**
- Modify: `src/renderer/modules/messaging-settings.js:34-40`（CHANNELS）、`:100-118`（channelForKey / channelForInstance / instanceForChannel）
- Test: `test/renderer/settings-tabs.test.ts`（CHANNELS 精确断言更新）

**Interfaces:**
- Consumes: Task 1 的品牌图标名。
- Produces:
  - `CHANNELS`：8 项，`{ key, platform, feishuTenantBrand?, icon, group: 'open' | 'soon' }`。
  - `channelForInstance(instance)`：支持 wecom / telegram / feishu_lark（brand 区分），其余返回 null。
  - `instancesForChannel(channel)`：返回该渠道全部实例（按 updatedAt 降序），替代 `instanceForChannel` 的单实例取最新逻辑。
  - `channelForKey(key)` 保留。

- [ ] **Step 1: 写失败测试**

`settings-tabs.test.ts` 中 `channelForInstance(telegram) 为 null、CHANNELS 精确为 ['wechat','feishu','lark']` 的用例替换为：

```ts
  it('exposes the full grouped channel catalog and maps every platform instance', () => {
    expect(hooks.CHANNELS.map((channel: any) => channel.key)).toEqual([
      'feishu', 'lark', 'wecom', 'telegram', 'wechat', 'qq', 'dingtalk', 'discord',
    ]);
    const open = hooks.CHANNELS.filter((channel: any) => channel.group === 'open').map((channel: any) => channel.key);
    const soon = hooks.CHANNELS.filter((channel: any) => channel.group === 'soon').map((channel: any) => channel.key);
    expect(open).toEqual(['feishu', 'lark', 'wecom', 'telegram']);
    expect(soon).toEqual(['wechat', 'qq', 'dingtalk', 'discord']);
    for (const channel of hooks.CHANNELS) expect(typeof channel.icon).toBe('string');

    expect(hooks.channelForInstance({ id: 'a', platform: 'wecom' })).toBe('wecom');
    expect(hooks.channelForInstance({ id: 'b', platform: 'telegram' })).toBe('telegram');
    expect(hooks.channelForInstance({ id: 'c', platform: 'feishu_lark', feishuTenantBrand: 'lark' })).toBe('lark');
    expect(hooks.channelForInstance({ id: 'd', platform: 'feishu_lark', feishuTenantBrand: 'feishu' })).toBe('feishu');
    expect(hooks.channelForInstance({ id: 'e', platform: 'wechat_personal' })).toBeNull();
  });
```

并在同一文件追加多实例行为用例（挂在 `hooks.__test` 上，需要 Task 5 的 `instancesForChannel`；若 Task 4 先落地则先在 `__test` 暴露）：

```ts
  it('lists every instance of a channel instead of hiding older ones', () => {
    hooks.__test.state.instances = [
      { id: 'old', platform: 'feishu_lark', feishuTenantBrand: 'feishu', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'new', platform: 'feishu_lark', feishuTenantBrand: 'feishu', updatedAt: '2026-08-02T00:00:00.000Z' },
    ];
    const list = hooks.__test.instancesForChannel(hooks.CHANNELS[0]);
    expect(list.map((instance: any) => instance.id)).toEqual(['new', 'old']);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: FAIL —— CHANNELS 仍是旧三项、channelForInstance 不支持 wecom/telegram、无 instancesForChannel。

- [ ] **Step 3: 实现**

`messaging-settings.js` 的 `CHANNELS` 替换为：

```js
  // The messaging channel catalog is product content: `open` channels get a
  // live configuration panel, `soon` channels render disabled so the roadmap
  // stays visible without a false affordance.
  const CHANNELS = Object.freeze([
    { key: 'feishu', platform: 'feishu_lark', feishuTenantBrand: 'feishu', icon: 'feishu', group: 'open' },
    { key: 'lark', platform: 'feishu_lark', feishuTenantBrand: 'lark', icon: 'lark', group: 'open' },
    { key: 'wecom', platform: 'wecom', icon: 'wecom', group: 'open' },
    { key: 'telegram', platform: 'telegram', icon: 'telegram', group: 'open' },
    { key: 'wechat', platform: 'wechat_personal', icon: 'wechat', group: 'soon' },
    { key: 'qq', platform: 'qq', icon: 'qq', group: 'soon' },
    { key: 'dingtalk', platform: 'dingtalk', icon: 'dingtalk', group: 'soon' },
    { key: 'discord', platform: 'discord', icon: 'discord', group: 'soon' },
  ]);
```

`channelForInstance` 替换为：

```js
  function channelForInstance(instance) {
    if (!instance) return null;
    if (instance.platform === 'wecom' || instance.platform === 'telegram') return instance.platform;
    if (instance.platform === 'feishu_lark') return instance.feishuTenantBrand === 'lark' ? 'lark' : 'feishu';
    return null;
  }
```

`instanceForChannel` 替换为（并同步更新 `renderCatalogPage`/`openChannel` 中的旧调用点 —— 本任务只保留函数，Task 5 重写渲染时统一使用）：

```js
  function instancesForChannel(channel) {
    if (!channel) return [];
    return state.instances
      .filter((instance) => channelForInstance(instance) === channel.key)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  }
```

在 `__test` 导出中追加 `instancesForChannel`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/modules/messaging-settings.js test/renderer/settings-tabs.test.ts
git commit -m "feat: 消息平台渠道清单扩展为 8 项并按开放状态分组"
```

---

### Task 5: 双栏布局与面板分派

**Files:**
- Modify: `src/renderer/modules/messaging-settings.js`（state、renderCurrent、renderCatalogPage→renderMenuPage、openChannel→selectChannel、detailPage 拆分为按渠道面板）
- Test: `test/renderer/settings-tabs.test.ts`（主断言重写）

**Interfaces:**
- Consumes: Task 4 的 `CHANNELS`/`channelForInstance`/`instancesForChannel`；Task 2 的 `messaging.group.*` 文案。
- Produces:
  - `state.selectedChannel`（左栏选中渠道 key，默认 'feishu'）
  - `state.selectedInstanceId`（右栏选中实例 id，默认 ''）
  - `renderCurrent()` 渲染 `renderLayoutPage()`：左 `renderMenuPage()` + 右 `renderPanelPage()`。
  - `selectChannel(key)`：取消进行中的扫码（feishu `cancelQr` / wecom 关弹窗 + cancel），设置 `selectedChannel`，清空 `selectedInstanceId`，重渲染。
  - `renderPanelPage()` 按渠道分派到 `renderFeishuPanel` / `renderWecomPanel` / `renderTelegramPanel`（Task 6-8 实现）。

- [ ] **Step 1: 写失败测试（重写 settings-tabs.test.ts 主断言）**

把 `loads tabs eagerly and loads the focused messaging settings page on demand` 用例中以下旧断言：

```ts
    expect(style).toContain('.messaging-channel-grid');
    expect(style).not.toContain('.messaging-instance-rail');
    expect(messagingSettings).toContain("view: 'catalog'");
    expect(messagingSettings).toContain("state.view = 'detail';");
    expect(messagingSettings).not.toContain('messaging.wecom_qr');
    expect(messagingSettings).not.toContain('messaging.health');
```

替换为：

```ts
    expect(style).toContain('.messaging-menu');
    expect(style).toContain('.messaging-menu-item.is-disabled');
    expect(messagingSettings).toContain("view: 'panel'");
    expect(messagingSettings).not.toContain("view: 'catalog'");
```

（`messaging.health` 与 `messaging.use_existing` 的“不存在”断言删除，改为分别在 Task 8 / Task 6 中验证，避免引用尚未改动的内容。`messaging.wecom_qr.start` / `messaging.set_enabled` / `closeWecomPopup` 的源码断言分别在 Task 8 / Task 7 / Task 8 中新增。）

再追加渠道切换清理用例（本任务只验证 feishu 侧清理；wecom 侧清理在 Task 8 的用例中覆盖）：

```ts
  it('cancels an in-flight feishu QR flow when switching channels', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain('cancelQr({ silent: true, render: false })');
    expect(source).toContain('state.selectedChannel = key');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: FAIL —— 旧结构断言不满足。

- [ ] **Step 3: 实现双栏结构**

`state` 修改：

```js
  const state = {
    view: 'panel',
    instances: [],
    selectedChannel: 'feishu',
    selectedInstanceId: '',
    ...
  };
```

新增 wecom 扫码状态（与 `qr` 平级）：

```js
    wecom: {
      flowId: '',
      state: '',
      authUrl: '',
      popup: null,
      starting: false,
      cancelling: false,
      error: '',
      timer: null,
    },
```

重写渲染入口：

```js
  function renderCurrent() {
    const root = rootNode();
    if (!root) return;
    root.replaceChildren();
    root.appendChild(renderLayoutPage());
    hydrate(root);
  }

  function renderLayoutPage() {
    const layout = el('div', 'messaging-layout');
    layout.append(renderMenuPage(), renderPanelPage());
    return layout;
  }
```

左栏菜单：

```js
  function renderMenuPage() {
    const aside = el('aside', 'messaging-menu');
    aside.appendChild(el('h1', 'messaging-menu-title', labelFor('messaging.catalog.page_title', '')));
    for (const group of ['open', 'soon']) {
      const section = el('div', `messaging-menu-group is-${group}`);
      section.appendChild(el('div', 'messaging-menu-group-label', labelFor(
        group === 'open' ? 'messaging.group.open' : 'messaging.group.soon', '',
      )));
      for (const channel of CHANNELS.filter((item) => item.group === group)) {
        const active = state.selectedChannel === channel.key;
        const bound = instancesForChannel(channel).length > 0;
        const row = el('button', `messaging-menu-item is-${channel.key}${active ? ' is-active' : ''}${group === 'soon' ? ' is-disabled' : ''}`);
        row.type = 'button';
        row.disabled = group === 'soon';
        row.dataset.channel = channel.key;
        row.setAttribute('aria-disabled', String(group === 'soon'));
        const visual = el('span', 'messaging-menu-item-icon');
        visual.appendChild(icon(channel.icon, 'messaging-menu-item-glyph'));
        row.appendChild(visual);
        row.appendChild(el('span', 'messaging-menu-item-name', labelFor(`messaging.channel.${channel.key}.title`, channel.key)));
        if (group === 'open') {
          const status = el('span', `messaging-menu-item-status is-${bound ? 'bound' : 'empty'}`);
          status.appendChild(el('span', '', labelFor(
            bound ? 'messaging.status.bound' : 'messaging.status.unbound', '',
          )));
          row.appendChild(status);
        }
        if (group === 'open' && !row.disabled) row.addEventListener('click', () => selectChannel(channel.key));
        aside.appendChild(row);
      }
      aside.appendChild(section);
    }
    return aside;
  }
```

（新增 i18n key `messaging.status.bound`，加入 Task 2 的 locale：zh“已绑定”/en“Bound”。）

渠道切换（含扫码清理；wecom 清理在 Task 8 追加）：

```js
  async function selectChannel(key) {
    const channel = channelForKey(key);
    if (!channel || channel.group !== 'open' || state.selectedChannel === key) return;
    cancelQr({ silent: true, render: false });
    // Task 8 追加: await cancelWecomFlow({ silent: true, render: false });
    state.selectedChannel = key;
    state.selectedInstanceId = '';
    setNotice('', '');
    renderCurrent();
  }
```

右栏容器与分派（feishu 面板先以占位实现，Task 6 替换为 renderFeishuPanel；wecom/telegram 分支在 Task 8/7 追加）：

```js
  function renderPanelPage() {
    const channel = channelForKey(state.selectedChannel) || channelForKey('feishu');
    const panel = el('section', `messaging-panel is-${channel.key}`);
    panel.appendChild(renderPanelHeader(channel));
    // Task 8 追加: else if (channel.platform === 'wecom') panel.appendChild(renderWecomPanel(channel));
    // Task 7 追加: else if (channel.platform === 'telegram') panel.appendChild(renderTelegramPanel(channel));
    panel.appendChild(renderPanelPlaceholder(channel));
    appendNotice(panel);
    return panel;
  }

  function renderPanelPlaceholder(channel) {
    const wrapper = el('div', 'messaging-panel-body');
    wrapper.appendChild(card('messaging.association_title', 'messaging.association_sub'));
    return wrapper;
  }
```

（`renderPanelPlaceholder` 为 Task 5 的临时占位，Task 6 完成 renderFeishuPanel 后删除。）

`renderPanelHeader(channel)` 实现（含右栏头部状态）：

```js
  function renderPanelHeader(channel) {
    const header = el('header', 'messaging-detail-header');
    const brand = el('div', `messaging-brand-icon is-${channel.key}`);
    brand.appendChild(icon(channel.icon, 'messaging-brand-glyph'));
    const titleWrap = el('div', 'messaging-detail-title-wrap');
    const titleRow = el('div', 'messaging-detail-title-row');
    titleRow.appendChild(el('h2', '', labelFor(`messaging.channel.${channel.key}.title`, channel.key)));
    if (channel.feishuTenantBrand) {
      titleRow.appendChild(el('span', 'messaging-channel-badge', labelFor(`messaging.channel.${channel.key}.badge`, '')));
    }
    titleWrap.appendChild(titleRow);
    const instances = instancesForChannel(channel);
    const instance = instances.find((item) => item.id === state.selectedInstanceId) || instances[0] || null;
    const status = instance ? statusForInstance(instance) : 'unbound';
    const stateRow = el('div', `messaging-detail-state is-${status}`);
    stateRow.append(icon(status === 'connected' ? 'check-circle' : 'clock', 'messaging-status-icon'));
    stateRow.appendChild(el('span', '', statusLabel(status)));
    titleWrap.appendChild(stateRow);
    header.append(brand, titleWrap, instance ? switchControl(instance) : el('span', 'messaging-detail-switch-placeholder', ''));
    return header;
  }
```

删除 `renderCatalogPage`、`openChannel`、`detailPage` 中的 catalog 返回逻辑与返回按钮（`back` 相关代码），`state.view = 'detail'` 相关赋值替换为 `state.selectedChannel` 驱动。

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/modules/messaging-settings.js test/renderer/settings-tabs.test.ts
git commit -m "feat: 消息平台双栏布局与渠道切换"
```

---

### Task 6: feishu/lark 面板（移除手工绑定 + 实例列表）

**Files:**
- Modify: `src/renderer/modules/messaging-settings.js`（`manualLinkSection`、`associationCard`、新增 `renderFeishuPanel` / 实例列表）

**Interfaces:**
- Consumes: Task 5 的 `renderPanelPage` 分派。
- Produces:
  - `renderFeishuPanel(channel)`：实例列表 + 扫码卡片（无“已有应用”）。
  - `renderInstanceList(channel, instances)`：复用卡片，每实例行含状态、启用开关、解绑、删除。
  - 删除 `manualLinkSection`、`linkWithCredentials`；`associationCard` 不再挂 `manualLinkSection`。

- [ ] **Step 1: 写失败测试**

`settings-tabs.test.ts` 追加：

```ts
  it('removes the manual App ID/Secret binding path from the Feishu panel', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).not.toContain('manualLinkSection');
    expect(source).not.toContain('linkWithCredentials');
    expect(source).not.toContain('messaging.use_existing');
    expect(source).not.toContain('renderPanelPlaceholder');
    expect(source).toContain('renderFeishuPanel');
    expect(source).toContain('renderInstanceList');
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: FAIL —— 代码仍含 manualLinkSection。

- [ ] **Step 3: 实现**

删除 `manualLinkSection` 与 `linkWithCredentials` 两个函数；`associationCard` 中删除 `const manual = manualLinkSection(instance); if (manual) section.appendChild(manual);` 两行。

新增实例列表（放在 `associationCard` 之后）：

```js
  function renderInstanceList(channel) {
    const section = el('section', 'messaging-config-card messaging-instance-card');
    const heading = el('div', 'messaging-config-card-heading');
    heading.appendChild(el('h3', '', labelFor('messaging.instance.title', '')));
    section.appendChild(heading);
    const instances = instancesForChannel(channel);
    if (!instances.length) {
      section.appendChild(el('p', 'messaging-instance-empty', labelFor('messaging.instance.empty', '')));
      return section;
    }
    const list = el('div', 'messaging-instance-list');
    for (const instance of instances) {
      const row = el('div', `messaging-instance-row is-${statusForInstance(instance)}`);
      const active = state.selectedInstanceId === instance.id;
      if (active) row.classList.add('is-selected');
      const copy = el('div', 'messaging-instance-copy');
      copy.appendChild(el('strong', '', instance.displayName || instance.id));
      copy.appendChild(el('span', 'messaging-instance-state', statusLabel(statusForInstance(instance))));
      row.appendChild(copy);
      row.appendChild(switchControl(instance));
      const unbind = el('button', 'btn messaging-secondary-button', labelFor('messaging.unbind', ''));
      unbind.type = 'button';
      unbind.disabled = state.updating;
      unbind.addEventListener('click', () => void unbindInstance(instance, unbind));
      row.appendChild(unbind);
      row.addEventListener('click', () => {
        state.selectedInstanceId = instance.id;
        renderCurrent();
      });
      list.appendChild(row);
    }
    section.appendChild(list);
    return section;
  }
```

新增 `renderFeishuPanel(channel)`（替代原 `detailPage` 的 feishu 分支）：

```js
  function renderFeishuPanel(channel) {
    const wrapper = el('div', 'messaging-panel-body');
    wrapper.appendChild(renderInstanceList(channel));
    const instances = instancesForChannel(channel);
    const instance = instances.find((item) => item.id === state.selectedInstanceId) || instances[0] || null;
    if (instance) {
      wrapper.appendChild(associationCard(instance));
      const responseSelect = selectControl([
        { value: 'text', label: labelFor('messaging.response_text', '') },
        { value: 'streaming_card', label: labelFor('messaging.response_streaming_card', '') },
      ], instance.responseMode || 'text', state.updating);
      responseSelect.addEventListener('change', () => {
        if (responseSelect.value !== (instance.responseMode || 'text')) {
          void updateInstance({ responseMode: responseSelect.value }, responseSelect);
        }
      });
      const workspaceSelect = selectControl([
        { value: 'all', label: labelFor('messaging.workspace_all', '') },
      ], 'all', state.updating);
      workspaceSelect.addEventListener('change', () => {
        void updateInstance({ workspace: { type: 'all' } }, workspaceSelect);
      });
      wrapper.appendChild(preferencesCard(responseSelect, workspaceSelect));
      const deletion = card('messaging.delete_title', 'messaging.delete_subtitle', 'messaging-delete-card');
      const deleteButton = el('button', 'btn btn-danger messaging-delete-button', labelFor('messaging.delete', ''));
      deleteButton.type = 'button';
      deleteButton.disabled = state.updating;
      deleteButton.addEventListener('click', () => void deleteInstance(instance, deleteButton));
      deletion.appendChild(deleteButton);
      wrapper.appendChild(deletion);
    } else {
      const empty = el('div', 'messaging-config-card messaging-empty-card');
      const scan = el('button', 'btn messaging-scan-button', labelFor('messaging.scan', ''));
      scan.type = 'button';
      scan.appendChild(icon('qr-code', 'messaging-action-icon'));
      scan.addEventListener('click', () => void startQrForChannel(channel));
      empty.appendChild(scan);
      wrapper.appendChild(empty);
      renderQrPanelForChannel(wrapper, channel);
    }
    return wrapper;
  }
```

新增 `startQrForChannel(channel)`：复用原 `openChannel` 的 draft 创建逻辑（`messaging.feishu_draft.create`），创建/复用实例后设 `state.selectedInstanceId` 并 `startQr(instance)`：

```js
  async function startQrForChannel(channel) {
    if (!channel || state.openingChannel) return;
    const operation = ++state.operation;
    state.openingChannel = channel.key;
    setNotice('', '');
    renderCurrent();
    try {
      let instance = instancesForChannel(channel)[0] || null;
      if (!instance) {
        const result = await invoke('messaging.feishu_draft.create', {
          feishuTenantBrand: channel.feishuTenantBrand,
          displayName: labelFor(`messaging.channel.${channel.key}.title`, channel.key === 'lark' ? 'Lark' : '飞书'),
        });
        instance = result && result.instance;
      }
      if (!instance || typeof instance.id !== 'string' || !instance.id) throw new Error(labelFor('messaging.open_failed', ''));
      if (state.operation !== operation) return;
      state.instances = state.instances.some((candidate) => candidate.id === instance.id)
        ? state.instances.map((candidate) => candidate.id === instance.id ? instance : candidate)
        : [...state.instances, instance];
      state.selectedInstanceId = instance.id;
      state.openingChannel = '';
      renderCurrent();
      await startQr(instance);
    } catch (error) {
      if (state.operation !== operation) return;
      state.openingChannel = '';
      setNotice(errorMessage(error, labelFor('messaging.open_failed', '')), 'error');
      renderCurrent();
    }
  }
```

（`renderQrPanelForChannel`：与现有 `renderQrPanel(instance, cardRoot)` 同构，用于空状态下的扫码展示；或直接复用 `qrIsVisibleFor` + `renderQrPanel`，确保 `state.qr.instanceId` 与新实例一致。）

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/modules/messaging-settings.js test/renderer/settings-tabs.test.ts
git commit -m "feat: 飞书/Lark 面板移除手工绑定并增加实例列表"
```

---

### Task 7: Telegram 面板（Token 保存 + 启用 + 回滚）

**Files:**
- Modify: `src/renderer/modules/messaging-settings.js`（新增 `renderTelegramPanel`、`saveTelegramToken`、`validateBotToken`）

**Interfaces:**
- Consumes: Task 5 分派；`messaging.create` / `messaging.update` / `messaging.set_enabled` / `messaging.delete` IPC。
- Produces:
  - `validateBotToken(token)` → boolean（IPC 同规则 `^\d+:[A-Za-z0-9_-]{20,}$`）。
  - `renderTelegramPanel(channel)`：实例列表 + Token 表单。
  - `saveTelegramToken(instance, tokenInput, button)`：无实例 → create → set_enabled(true)，失败回滚 delete；有实例 → update({ secret, enabled: true })。

- [ ] **Step 1: 写失败测试**

`settings-tabs.test.ts` 追加（源码断言 + 纯函数行为）：

```ts
  it('validates telegram bot tokens with the IPC token shape', () => {
    expect(hooks.__test.validateBotToken('123456:ABCdefGHIJKLMNOPQRSTuvwxyz_9')).toBe(true);
    expect(hooks.__test.validateBotToken('nope')).toBe(false);
    expect(hooks.__test.validateBotToken('123:short')).toBe(false);
  });

  it('saves telegram tokens through create + set_enabled with rollback', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("invoke('messaging.create', { platform: 'telegram'");
    expect(source).toContain("invoke('messaging.set_enabled', { instanceId: created.id, enabled: true })");
    expect(source).toContain("invoke('messaging.delete', { instanceId: created.id })");
    expect(source).toContain("enabled: true }");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: FAIL —— `validateBotToken` 未定义、无 create+set_enabled 链。

- [ ] **Step 3: 实现**

在 `messaging-settings.js` 中（`unbindInstance` 之后）新增：

```js
  function validateBotToken(token) {
    return typeof token === 'string' && /^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim());
  }

  async function saveTelegramToken(instance, tokenInput, button) {
    if (button.disabled) return;
    const token = String(tokenInput.value || '').trim();
    if (!validateBotToken(token)) {
      setNotice(labelFor('messaging.telegram.token_invalid', ''), 'error');
      tokenInput.focus();
      return;
    }
    button.disabled = true;
    state.updating = true;
    setNotice('', '');
    try {
      if (!instance) {
        const created = await invoke('messaging.create', {
          platform: 'telegram',
          displayName: 'Telegram',
          secret: { botToken: token },
        });
        if (!created || !created.instance || typeof created.instance.id !== 'string') {
          throw new Error(created?.error || labelFor('messaging.update_failed', ''));
        }
        try {
          await invoke('messaging.set_enabled', { instanceId: created.instance.id, enabled: true });
        } catch (error) {
          try { await invoke('messaging.delete', { instanceId: created.instance.id }); } catch (_) { /* rollback best effort */ }
          throw new Error(labelFor('messaging.telegram.enable_failed', ''));
        }
        state.instances = [...state.instances, created.instance];
        state.selectedInstanceId = created.instance.id;
        setNotice(labelFor('messaging.link_success', ''), 'success');
      } else {
        const result = await invoke('messaging.update', {
          instanceId: instance.id,
          secret: { botToken: token },
          enabled: true,
        });
        if (!result || !result.instance || typeof result.instance.id !== 'string') {
          throw new Error(result?.error || labelFor('messaging.update_failed', ''));
        }
        state.instances = state.instances.map((candidate) => candidate.id === result.instance.id ? result.instance : candidate);
        setNotice(labelFor('messaging.updated', ''), 'success');
      }
    } catch (error) {
      setNotice(errorMessage(error, labelFor('messaging.update_failed', '')), 'error');
    } finally {
      state.updating = false;
      renderCurrent();
    }
  }
```

新增 `renderTelegramPanel(channel)`：

```js
  function renderTelegramPanel(channel) {
    const wrapper = el('div', 'messaging-panel-body');
    wrapper.appendChild(renderInstanceList(channel));
    const instances = instancesForChannel(channel);
    const instance = instances.find((item) => item.id === state.selectedInstanceId) || instances[0] || null;
    const config = card('messaging.telegram.token_label', '', 'messaging-telegram-card');
    const tokenInput = document.createElement('input');
    tokenInput.type = 'password';
    tokenInput.className = 'form-input';
    tokenInput.placeholder = labelFor('messaging.telegram.token_placeholder', '');
    tokenInput.autocomplete = 'off';
    tokenInput.spellcheck = false;
    tokenInput.setAttribute('aria-label', labelFor('messaging.telegram.token_label', ''));
    const save = el('button', 'btn messaging-scan-button', labelFor(
      instance ? 'messaging.telegram.reconnect' : 'messaging.telegram.connect', '',
    ));
    save.type = 'button';
    save.disabled = state.updating;
    save.appendChild(icon('send', 'messaging-action-icon'));
    save.addEventListener('click', () => void saveTelegramToken(instance, tokenInput, save));
    const rows = el('div', 'messaging-manual-fields');
    rows.append(tokenInput, save);
    config.appendChild(rows);
    wrapper.appendChild(config);
    if (instance) {
      const deletion = card('messaging.delete_title', 'messaging.delete_subtitle', 'messaging-delete-card');
      const deleteButton = el('button', 'btn btn-danger messaging-delete-button', labelFor('messaging.delete', ''));
      deleteButton.type = 'button';
      deleteButton.disabled = state.updating;
      deleteButton.addEventListener('click', () => void deleteInstance(instance, deleteButton));
      deletion.appendChild(deleteButton);
      wrapper.appendChild(deletion);
    }
    return wrapper;
  }
```

在 `__test` 导出追加 `validateBotToken`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/modules/messaging-settings.js test/renderer/settings-tabs.test.ts
git commit -m "feat: Telegram 渠道 Bot Token 保存并连接（含启用回滚）"
```

---

### Task 8: 企业微信面板（官方扫码 + postMessage 校验）

**Files:**
- Modify: `src/renderer/modules/messaging-settings.js`（新增 `renderWecomPanel`、`startWecomFlow`、`parseWecomAuthMessage`、`closeWecomPopup`、`cancelWecomFlow`）

**Interfaces:**
- Consumes: Task 5 的 wecom state 与分派；IPC `messaging.wecom_qr.start/status/complete/cancel`。
- Produces:
  - `parseWecomAuthMessage(event)` → `{ ok: true, wecomBotId, wecomBotSecret } | { ok: false, reason }`（纯函数，可测）。
  - `closeWecomPopup()`：关闭 `state.wecom.popup`。
  - `cancelWecomFlow({ silent, render })`：关弹窗 + `messaging.wecom_qr.cancel` + 重置 state。
  - `startWecomFlow(channel)`：start → 打开弹窗 → 绑定 `message` 监听。
  - 校验常量 `WECOM_AUTH_ORIGIN = 'https://work.weixin.qq.com'`。

- [ ] **Step 1: 写失败测试**

`settings-tabs.test.ts` 追加：

```ts
  it('accepts only verified wecom auth messages from the official popup', () => {
    const origin = 'https://work.weixin.qq.com';
    const popup = { closed: false };
    const make = (overrides: any) => ({ origin, source: popup, data: { type: 'AUTH_SUCCESS', wecomBotId: 'wb_abc', wecomBotSecret: 'secret-value' }, ...overrides });

    expect(hooks.__test.parseWecomAuthMessage(make({}), popup)).toMatchObject({
      ok: true,
      wecomBotId: 'wb_abc',
      wecomBotSecret: 'secret-value',
    });
    expect(hooks.__test.parseWecomAuthMessage(make({ origin: 'https://evil.example' }), popup).ok).toBe(false);
    expect(hooks.__test.parseWecomAuthMessage(make({ source: {} }), popup).ok).toBe(false);
    expect(hooks.__test.parseWecomAuthMessage(make({ data: { type: 'AUTH_SUCCESS' } }), popup).ok).toBe(false);
    expect(hooks.__test.parseWecomAuthMessage(make({ data: { type: 'AUTH_SUCCESS', wecomBotId: 'wb_abc', wecomBotSecret: '' } }), popup).ok).toBe(false);
  });

  it('wires the wecom panel to start/complete/cancel IPC and popup cleanup', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules/messaging-settings.js'), 'utf8');
    expect(source).toContain("messaging.wecom_qr.start");
    expect(source).toContain("messaging.wecom_qr.complete");
    expect(source).toContain("messaging.wecom_qr.cancel");
    expect(source).toContain("window.open");
    expect(source).toContain("event.origin");
    expect(source).toContain("event.source !== popup");
    expect(source).toContain("closeWecomPopup");
    expect(source).toContain("await cancelWecomFlow({ silent: true, render: false })");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: FAIL —— `parseWecomAuthMessage` 未定义、wecom 面板不存在。

- [ ] **Step 3: 实现**

在 `messaging-settings.js` 中新增（放在 telegram 相关函数之后）：

```js
  const WECOM_AUTH_ORIGIN = 'https://work.weixin.qq.com';

  function parseWecomAuthMessage(event, popup) {
    const data = event && typeof event.data === 'object' ? event.data : {};
    const wecomBotId = typeof data.wecomBotId === 'string' ? data.wecomBotId.trim() : '';
    const wecomBotSecret = typeof data.wecomBotSecret === 'string' ? data.wecomBotSecret.trim() : '';
    if (!event || event.origin !== WECOM_AUTH_ORIGIN) return { ok: false, reason: 'origin' };
    if (!popup || event.source !== popup) return { ok: false, reason: 'source' };
    if (data.type !== 'AUTH_SUCCESS' || !wecomBotId || !wecomBotSecret) return { ok: false, reason: 'shape' };
    return { ok: true, wecomBotId, wecomBotSecret };
  }

  function closeWecomPopup() {
    const popup = state.wecom.popup;
    if (popup && typeof popup.close === 'function') {
      try { popup.close(); } catch (_) { /* already closed */ }
    }
    state.wecom.popup = null;
  }

  async function cancelWecomFlow(options) {
    const opts = options || {};
    const flowId = state.wecom.flowId;
    if (state.wecom.timer !== null) {
      clearTimeout(state.wecom.timer);
      state.wecom.timer = null;
    }
    closeWecomPopup();
    if (typeof window.removeEventListener === 'function') {
      window.removeEventListener('message', handleWecomAuthMessage);
    }
    if (flowId && state.wecom.state !== 'completed' && state.wecom.state !== 'cancelled') {
      try { await invoke('messaging.wecom_qr.cancel', { flowId }); } catch (_) { /* best effort */ }
    }
    state.wecom.flowId = '';
    state.wecom.state = '';
    state.wecom.authUrl = '';
    state.wecom.starting = false;
    state.wecom.cancelling = false;
    state.wecom.error = '';
    if (opts.render !== false) renderCurrent();
  }

  function handleWecomAuthMessage(event) {
    if (!state.wecom.flowId) return;
    const parsed = parseWecomAuthMessage(event, state.wecom.popup);
    if (!parsed.ok) {
      if (parsed.reason === 'origin' || parsed.reason === 'source') return;
      setNotice(labelFor('messaging.wecom_qr.invalid_message', ''), 'error');
      return;
    }
    void completeWecomFlow(parsed.wecomBotId, parsed.wecomBotSecret);
  }

  function scheduleWecomPoll(flowId) {
    if (state.wecom.timer !== null) clearTimeout(state.wecom.timer);
    if (!flowId || state.wecom.flowId !== flowId || state.wecom.state === 'completed') return;
    state.wecom.timer = setTimeout(() => {
      state.wecom.timer = null;
      void pollWecomStatus(flowId);
    }, 5000);
  }

  async function pollWecomStatus(flowId) {
    if (!flowId || state.wecom.flowId !== flowId || state.wecom.cancelling) return;
    try {
      const result = await invoke('messaging.wecom_qr.status', { flowId });
      const registration = result && result.registration ? result.registration : result;
      const nextState = typeof registration.state === 'string' ? registration.state : 'failed';
      if (nextState === 'completed' && registration.instance && registration.instance.id) {
        state.instances = state.instances.some((candidate) => candidate.id === registration.instance.id)
          ? state.instances.map((candidate) => candidate.id === registration.instance.id ? registration.instance : candidate)
          : [...state.instances, registration.instance];
        state.selectedInstanceId = registration.instance.id;
        setNotice(labelFor('messaging.wecom_qr.completed', ''), 'success');
        await cancelWecomFlow({ silent: true, render: false });
        renderCurrent();
        return;
      }
      if (nextState === 'expired' || nextState === 'cancelled' || nextState === 'failed') {
        setNotice(registration.errorCode || nextState, 'error');
        await cancelWecomFlow({ silent: true, render: false });
        renderCurrent();
        return;
      }
      scheduleWecomPoll(flowId);
    } catch (_) {
      scheduleWecomPoll(flowId);
    }
  }

  async function completeWecomFlow(wecomBotId, wecomBotSecret) {
    if (!state.wecom.flowId || state.wecom.state === 'completed' || state.wecom.cancelling) return;
    const flowId = state.wecom.flowId;
    try {
      const result = await invoke('messaging.wecom_qr.complete', { flowId, wecomBotId, wecomBotSecret });
      const registration = result && result.registration ? result.registration : result;
      if (registration.state === 'completed' && registration.instance && registration.instance.id) {
        state.instances = state.instances.some((candidate) => candidate.id === registration.instance.id)
          ? state.instances.map((candidate) => candidate.id === registration.instance.id ? registration.instance : candidate)
          : [...state.instances, registration.instance];
        state.selectedInstanceId = registration.instance.id;
        state.wecom.state = 'completed';
        setNotice(labelFor('messaging.wecom_qr.completed', ''), 'success');
        await cancelWecomFlow({ silent: true, render: false });
        renderCurrent();
        return;
      }
      if (registration.state === 'failed' || registration.state === 'expired' || registration.state === 'denied') {
        setNotice(registration.errorCode || registration.state, 'error');
        await cancelWecomFlow({ silent: true, render: false });
        renderCurrent();
      }
    } catch (error) {
      setNotice(errorMessage(error, labelFor('messaging.wecom_qr.invalid_message', '')), 'error');
    }
  }

  async function startWecomFlow() {
    if (state.wecom.starting || state.wecom.cancelling) return;
    state.wecom.starting = true;
    setNotice('', '');
    renderCurrent();
    try {
      const result = await invoke('messaging.wecom_qr.start', {
        displayName: labelFor('messaging.channel.wecom.title', '企业微信'),
      });
      const registration = result && result.registration ? result.registration : result;
      const flowId = typeof registration.flowId === 'string' ? registration.flowId.trim() : '';
      const authUrl = typeof registration.authUrl === 'string' ? registration.authUrl.trim() : '';
      if (!flowId || !authUrl) throw new Error(registration.error || labelFor('messaging.wecom_qr.invalid_message', ''));
      state.wecom.flowId = flowId;
      state.wecom.authUrl = authUrl;
      state.wecom.state = registration.state || 'awaiting_scan';
      state.wecom.starting = false;
      const popup = window.open(authUrl, 'wecom_auth', 'width=720,height=640,popup=yes');
      if (!popup) {
        setNotice(labelFor('messaging.wecom_qr.invalid_message', ''), 'error');
        return;
      }
      state.wecom.popup = popup;
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('message', handleWecomAuthMessage);
      }
      setNotice(labelFor('messaging.wecom_qr.open_hint', ''), 'info');
      scheduleWecomPoll(flowId);
      renderCurrent();
    } catch (error) {
      state.wecom.starting = false;
      setNotice(errorMessage(error, labelFor('messaging.wecom_qr.invalid_message', '')), 'error');
      renderCurrent();
    }
  }
```

新增 `renderWecomPanel(channel)`：

```js
  function renderWecomPanel(channel) {
    const wrapper = el('div', 'messaging-panel-body');
    wrapper.appendChild(renderInstanceList(channel));
    const config = card('messaging.association_title', 'messaging.association_sub', 'messaging-wecom-card');
    const flowActive = Boolean(state.wecom.flowId && !['completed', 'cancelled', 'expired', 'failed'].includes(state.wecom.state));
    const scan = el('button', 'btn messaging-scan-button', labelFor(
      flowActive ? 'messaging.wecom_qr.cancel' : 'messaging.wecom_qr.start', '',
    ));
    scan.type = 'button';
    scan.disabled = state.updating || state.wecom.starting || state.wecom.cancelling;
    scan.appendChild(icon(flowActive ? 'x' : 'qr-code', 'messaging-action-icon'));
    scan.addEventListener('click', () => {
      if (flowActive) void cancelWecomFlow();
      else void startWecomFlow();
    });
    config.appendChild(scan);
    if (state.wecom.error) {
      config.appendChild(el('p', 'messaging-wecom-error', state.wecom.error));
    }
    wrapper.appendChild(config);
    const instances = instancesForChannel(channel);
    if (instances.length) {
      const deletion = card('messaging.delete_title', 'messaging.delete_subtitle', 'messaging-delete-card');
      const instance = instances.find((item) => item.id === state.selectedInstanceId) || instances[0];
      const deleteButton = el('button', 'btn btn-danger messaging-delete-button', labelFor('messaging.delete', ''));
      deleteButton.type = 'button';
      deleteButton.disabled = state.updating;
      deleteButton.addEventListener('click', () => void deleteInstance(instance, deleteButton));
      deletion.appendChild(deleteButton);
      wrapper.appendChild(deletion);
    }
    return wrapper;
  }
```

**修改 `selectChannel`（Task 5 中的注释行替换为实际调用）：**

```js
  async function selectChannel(key) {
    const channel = channelForKey(key);
    if (!channel || channel.group !== 'open' || state.selectedChannel === key) return;
    cancelQr({ silent: true, render: false });
    await cancelWecomFlow({ silent: true, render: false });
    state.selectedChannel = key;
    state.selectedInstanceId = '';
    setNotice('', '');
    renderCurrent();
  }
```

`cancelWecomFlow` 为函数声明，与 `selectChannel` 同模块提升，顺序无碍。在 `__test` 导出追加 `parseWecomAuthMessage`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/modules/messaging-settings.js test/renderer/settings-tabs.test.ts
git commit -m "feat: 企业微信官方扫码绑定（受控弹窗 + postMessage 校验）"
```

---

### Task 9: 双栏与面板样式（style.css）

**Files:**
- Modify: `src/renderer/style.css`（`.messaging-*` 区块，约 12256-12650 行）

**Interfaces:**
- Consumes: Task 5-8 新增的类名：`messaging-layout`、`messaging-menu`、`messaging-menu-title`、`messaging-menu-group`、`messaging-menu-group-label`、`messaging-menu-item(.is-active/.is-disabled/.is-{channel})`、`messaging-menu-item-icon/glyph/name/status`、`messaging-panel`、`messaging-panel-body`、`messaging-instance-card/list/row/copy/state`、`messaging-wecom-card`、`messaging-telegram-card`、`messaging-empty-card`。
- Produces: 双栏布局、菜单分组与禁用态、实例行、面板卡片样式；保留现有 `.messaging-config-card`、`.messaging-scan-button`、`.messaging-switch`、`.messaging-qr-*` 等。

- [ ] **Step 1: 写失败测试**

`settings-tabs.test.ts` 的样式断言（Task 5 已改的部分）再补充：

```ts
    expect(style).toContain('.messaging-layout');
    expect(style).toContain('.messaging-menu-group-label');
    expect(style).toContain('.messaging-menu-item.is-disabled');
    expect(style).toContain('.messaging-instance-row');
    expect(style).toContain('.messaging-instance-row.is-selected');
```

（若 Task 5 已含部分断言，保持幂等即可。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: FAIL —— `.messaging-layout` 等未定义。

- [ ] **Step 3: 实现样式**

在 `style.css` 的 `.messaging-page` 之后（约 12272 行）新增：

```css
/* Messaging settings: two-column workspace (channel menu | config panel). */
.messaging-layout {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}

.messaging-menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.messaging-menu-title {
  margin: 0 6px 12px;
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}

.messaging-menu-group { display: contents; }

.messaging-menu-group-label {
  margin: 10px 6px 4px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: .5px;
  color: var(--text-2);
}

.messaging-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 46px;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.messaging-menu-item:hover:not(:disabled) { background: var(--surface-2); }
.messaging-menu-item:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.messaging-menu-item.is-active { background: var(--primary-soft); color: var(--primary); }
.messaging-menu-item.is-disabled { color: var(--text-2); opacity: .55; cursor: default; filter: saturate(.42); }

.messaging-menu-item-icon { display: inline-flex; flex: 0 0 auto; }
.messaging-menu-item-glyph { width: 24px; height: 24px; }

.messaging-menu-item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}

.messaging-menu-item-status { margin-left: auto; font-size: 10px; color: var(--text-2); white-space: nowrap; }
.messaging-menu-item-status.is-bound { color: var(--success); }

.messaging-panel { min-width: 0; }
.messaging-panel-body { display: flex; flex-direction: column; gap: 16px; }
.messaging-detail-title-row { display: flex; align-items: center; gap: 8px; }
.messaging-detail-switch-placeholder { width: 40px; }

.messaging-instance-card { display: flex; flex-direction: column; gap: 12px; }
.messaging-instance-empty { margin: 0; color: var(--text-2); font-size: 13px; }
.messaging-instance-list { display: flex; flex-direction: column; gap: 8px; }

.messaging-instance-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  cursor: pointer;
}

.messaging-instance-row:hover { border-color: var(--border-strong); }
.messaging-instance-row.is-selected { border-color: var(--primary); background: var(--primary-soft); }
.messaging-instance-copy { display: grid; gap: 2px; min-width: 0; flex: 1 1 auto; }
.messaging-instance-copy strong { font-size: 13px; color: var(--text); }
.messaging-instance-state { font-size: 11px; color: var(--text-2); }
.messaging-instance-row.is-connected .messaging-instance-state { color: var(--success); }
.messaging-instance-row.is-error .messaging-instance-state { color: var(--danger); }

.messaging-wecom-card, .messaging-telegram-card, .messaging-empty-card { display: flex; flex-direction: column; gap: 12px; }
.messaging-wecom-error { margin: 0; color: var(--danger); font-size: 12px; }
```

（样式变量全部取自 style.css 顶部 `:root` 现有变量：`--surface`、`--surface-2`、`--text`、`--text-2`、`--border`、`--border-strong`、`--primary`、`--primary-soft`、`--success`、`--danger`。注意：该文件没有 `--text-3`，弱化文字统一用 `--text-2`。）

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/run-tests.mjs run test/renderer/settings-tabs.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/style.css test/renderer/settings-tabs.test.ts
git commit -m "feat: 消息平台双栏与实例列表样式"
```

---

### Task 10: 集成验证

**Files:** 无新代码；执行验证。

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全部 PASS（含 Task 1-9 新增用例与既有 messaging/wecom 后端用例）。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无错误（`src/main/ipc/messaging.ts` 改动需通过 tsc）。

- [ ] **Step 3: 重启 messaging 运行时实测**

Run: `scripts/restart-mate.sh`
Expected: 启动成功；确认日志 `~/.orkas/runtime-variants/messaging/data/logs/<date>.log` 与 `/tmp/mate-agent-messaging-run.log` 无报错。

实测清单（人工/自动化确认后记录结论）：
1. 设置 → 消息平台：左栏 8 渠道、两组分组、禁用项不可点击不可聚焦。
2. 切飞书中国/Lark：右侧实例列表 + 扫码卡片（无“已有应用”），扫码启动/取消正常。
3. 切企业微信：`window.open` 打开官方页，取消/切渠道时弹窗关闭 + `wecom_qr.cancel` 调用。
4. 切 Telegram：输入合法 Token 保存后实例出现在列表且为已启用状态；非法 Token 被拦截。
5. 同渠道绑定第二个实例后，两个实例都在列表且可独立删除。
6. 响应模式切为 streaming_card 后重启应用仍保留（验证 IPC 修复）。

- [ ] **Step 4: 收尾提交（如有遗留改动）**

```bash
git status
# 若有未提交的测试/文档调整，一并提交
git add -A && git commit -m "chore: 消息平台双栏改造集成验证收尾"
```

---

## 依赖顺序

Task 1 → 2 → 3 可并行；Task 4 依赖 1；Task 5 依赖 2、4；Task 6/7/8 依赖 5（可并行）；Task 9 依赖 5-8；Task 10 最后。
