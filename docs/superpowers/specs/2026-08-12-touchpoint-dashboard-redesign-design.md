# 飞书触点界面重设计与后端语义聚合

日期：2026-08-12
状态：设计已确认（方案 A：状态仪表 + 待办卡）

## 1. 背景与问题诊断

「触点」tab 当前有两个视图：**触点概览页**（`touchpoint-settings.js`）与**连接管理页**（`messaging-settings.js`）。经评审（含截图与代码对照），核心问题：

| # | 问题 | 现状证据 |
|---|------|---------|
| 1 | 状态自相矛盾 | 顶部绿色「可正常使用」、四步 stepper 全绿，但「数据访问范围」面板显示「授权账号：未授权」。根因：`renderAccessCard` 把 `identityLabel` 为空渲染成「未授权」，而状态判定看的是 `authorization.kind === 'connected'` —— **状态判定与展示文案耦合** |
| 2 | 一页多角色 | 触点页同时是状态页（hero）、向导页（stepper+当前下一步）、配置页（投递/资源）、说明页（治理卡），7 个区块互相竞争注意力 |
| 3 | 术语未翻译 | 「接收身份 ou_ca4c...534e」「实例 2」「机器人回复颗粒度：流式卡片（Card JSON 2.0）」直接暴露给普通用户 |
| 4 | 重复入口 | 「管理连接」3 处、「查看今日简报」2 处，行为各不相同 |
| 5 | 平台列表是假选择 | 连接管理页 8 个平台，4 个「即将支持」、2 个「待配置」，路线图当 UI 用 |
| 6 | 概念碎片化 | 「飞书连接详情/绑定实例/关联机器人」三个区块表达同一个事实；「机器人」一词出现 5 次 |
| 7 | 危险操作平级 | 红色「删除机器人」与普通下拉框同列，无视觉分层 |

**根因**：后端返回的是组件级状态（messaging 实例、OAuth 凭据、registry 计数、同步水位四个子系统各说各话），前端直接平铺，缺少一层**用户语义整合**。「飞书能不能用」「我现在该做什么」「这是什么」三个问题，用户都无法从界面直接得到答案。

## 2. 目标、原则与非目标

**目标用户**：普通办公用户（ToB 企业员工）。不懂技术术语；配置动作低频（设置一次后不再进入）；需要「点按钮 → 扫码 → 完事」。

**设计原则**：
1. **状态第一**：页面首先回答「飞书触点现在能用吗」，一句话 + 一条链路图。
2. **一卡一问一动作**：每个待办是一张卡，卡上只有一个主按钮。
3. **术语翻译**：所有用户可见文案零技术词（无 ou_、实例、颗粒度、Card JSON）。唯一例外：授权前置的「回调地址配置引导卡」必须保留该措辞——它是飞书开发者后台的一次性必需步骤，程序无法代改，由 5 步向导承接（见 §5.4）。
4. **单一事实源**：整体状态/链路环节/待办清单由后端同一聚合函数产出，根除自相矛盾。
5. **高级设置折叠**：普通用户永不需要动的项（消息样式、工作区范围、断开连接）收进手风琴。

**非目标**（本次不做）：
- 其他消息平台（企业微信/Telegram/个人微信）的深层配置流程
- 多平台触点（触点仅飞书）
- iOS/移动端
- 「即将支持」平台的开发

## 3. 触点页设计（前端）

一屏最多 4 个区块，自上而下：

```
┌────────────────────────────────────────────────────┐
│ 飞书移动触点              ● 可正常使用     [↻]      │
│ 你离开电脑后，Mate 通过飞书联系你。                  │
├────────────────────────────────────────────────────┤
│ ┌─ 连接状态图（纯展示）──────────────────────────┐  │
│ │ [你的头像·昵称] ──→ [日历·资料 (2项)] ──→ [每日简报 08:00] │
│ │     连接环节          读取范围环节         投递环节    │
│ └────────────────────────────────────────────────┘  │
│ 待办卡区（有 issues 才出现）                          │
│ ┌─ ⚠ 令牌已过期 ───────────────────────────────┐  │
│ │ 重新授权即可恢复日历读取。          [重新授权]  │  │
│ └────────────────────────────────────────────────┘  │
│ ┌─ 今日简报（ready 才出现）─────────────────────┐  │
│ │ 每天 08:00 投递   [预览] [发送测试] [改时间]    │  │
│ └────────────────────────────────────────────────┘  │
│ ▸ 高级设置（折叠手风琴）                            │
│    消息样式 · 工作区范围 · 你的飞书账号 · [断开连接] │
└────────────────────────────────────────────────────┘
```

### 3.1 Hero
- 标题保留原文「飞书移动触点」；副标题保留原文「桌面端负责完整工作，飞书负责你离开电脑后的提醒、确认和结果回报」（i18n 键 `touchpoint_settings.title/subtitle`，与截图一致，不重写措辞）。
- 整体状态徽标：`ready` → 「可正常使用」（绿）；`attention` → 「需要处理」（琥珀）；`off` → 「未连接」（灰）。
- 保留刷新按钮（排障兜底）；「管理连接」按钮删除（入口收敛到高级设置）。

### 3.2 连接状态图（替代 stepper + 双信息面板）

> ⚠️ 明确：现有**四步 stepper**（连接机器人→授权数据→选择资源→开始使用）与「飞书连接与身份」「数据访问范围」**双信息面板将整体移除**，由本链路状态图 + 待办卡替代。stepper 隐含线性步骤语义，但真实状态非线形（断连≠进度回退），故弃用。

- 三环节链路：`connection`（你的飞书账号）→ `authorization`（读取范围，显示资源数）→ `delivery`（每日简报，显示时间）。
- 环节色：`ok` 绿 / `broken` 红（显示原因一行）/ `missing` 灰（占位文案：尚未连接 / 未允许读取 / 未设置简报）。
- **纯展示**：环节不做点击跳转，操作一律由待办卡承担，避免双交互入口。

### 3.3 待办卡区
- 数据源：后端 `overall.issues[]`，前端逐张渲染，**不做任何业务判断**。
- 卡片结构：severity 图标 + 标题 + 一行说明 + 右侧主按钮（`action.label`）。
- 多卡并存（如「令牌过期」+「同步失败」同时出现）；全部解决后整区消失。
- 错误场景（令牌过期、回调端口被占、同步失败）都落成待办卡而非全局红条。

### 3.4 今日简报卡
- 仅 `ready` 时渲染；未就绪不渲染（待办卡已解释原因），删除原「锁形提示」。
- 内容：投递时间展示 + 内联修改 + [预览] [发送测试] [取消每日简报]。
- 预览结果折叠在卡内（原 preview 区域保留，改为卡内展开）。

### 3.5 高级设置（折叠手风琴，初始为折叠态）

> 普通用户默认不展开；手风琴标题行只显示「高级设置」。以下各项初始折叠。

- **消息样式**（原「机器人回复颗粒度」）：选项用白话——「简洁文字」/「富文本卡片」，隐藏 Card JSON 2.0 等实现细节。
- **工作区范围**：保留原下拉。
- **你的飞书账号**：昵称 + 头像（原「归属/接收身份」合并至此，不显示 ou_ 原始 ID）。
- **停止读取数据**（原「数据访问范围」面板的「撤销授权」，动作复用现有 `authorization.revoke`）：白话文案「不再同步日历和资料，飞书消息通道保留」。轻量二次确认（单步弹窗）。
- **断开连接**（原「删除机器人」）：**彻底移除**——删除机器人实例 + 数据授权一并停止。红色 + 强二次确认（弹窗内明确列出影响：「断开后 Mate 将无法通过飞书联系你，日历和资料的读取也会停止，已保存的数据不会被删除」）。
- **「停止读取数据」与「断开连接」的关系**：前者只停数据读取、保留消息通道（温和，可随时重新授权恢复）；后者全停（彻底，需重新扫码绑定才能恢复）。两个操作分层放置，红色仅用于「断开连接」。

## 4. 连接管理页瘦身（前端）

「设置 → 消息平台」的页面（`messaging-settings.js`）：

1. **平台网格**：只展示有真实实现的平台（飞书、Lark、企业微信、Telegram、个人微信）；已绑定的显示状态，未绑定的显示「去配置」。「即将支持」（QQ/钉钉/Discord）收成一行灰字。
2. **飞书详情卡（白话字段）**：

| 现状 | 改为 |
|---|---|
| 机器人 / 绑定实例 / 关联机器人（三区块） | 合并为「你的飞书账号：昵称」 |
| 机器人归属 ou_ca4c...534e | 你的飞书账号（昵称，不显示 ID） |
| 机器人回复颗粒度：富文本/流式卡片（Card JSON 2.0） | 消息样式：简洁文字 / 富文本卡片 |
| 工作区访问范围 | 保留，折叠进「高级设置」 |
| 删除机器人（平级裸露） | 「断开连接」，红色 + 二次确认 |

3. 该页与触点页共享同一后端数据（messaging registry），触点页「高级设置」里的飞书连接项可内嵌此页组件或复用同一块渲染逻辑（实施时二选一，倾向复用）。

## 5. 后端语义聚合 API（倒推设计）

### 5.1 `dashboard.get` 增加 `overall` 聚合块

```ts
interface DashboardOverall {
  status: 'ready' | 'attention' | 'off';   // 唯一整体状态
  chain: {
    connection:    { state: 'ok' | 'missing' | 'broken'; label: string; detail?: string };
    authorization: { state: 'ok' | 'missing' | 'broken'; label: string; detail?: string };
    delivery:      { state: 'ok' | 'missing' | 'broken'; label: string; detail?: string };
  };
  issues: Array<{
    severity: 'error' | 'warning';
    step: 'connection' | 'authorization' | 'delivery';
    title: string;                            // 用户可见白话标题
    detail: string;
    action: { id: string; label: string } | null;
  }>;
}
```

原有组件级字段（`messaging.*`、`authorization.kind`、`resources.*`、`sync.*`、`briefing.*`）**保留**，仅供高级页与排障。

### 5.2 聚合规则（`dashboard-model.ts` 纯函数，单一事实源）

环节判定（按序）：

- `chain.connection`：`ok` ⇔ 有已启用飞书实例且归属已配置（复用现 `botConnected` 语义）；`missing` = 无实例；`broken` = 实例存在但状态为 error/disabled。
- `chain.authorization`：`ok` ⇔ `authorization.kind === 'connected'`；`missing` = 未授权过；`broken` = token 失效（`needsReauth`）或撤销中。
- `chain.delivery`：`ok` ⇔ `authorization` 环节 `ok` 且已选资源 > 0 且同步状态非失败；`missing` = 未选资源或未设简报；`broken` = 同步持续失败。

整体 `status` 决策树（按序判定）：

```
三环节全 ok                                → ready（可正常使用）
三环节全 missing（无实例 且 无授权 且 无资源）→ off（未连接，全新状态）
其余（任一环节 ok 或 broken）               → attention（需要处理）
```

典型中间态示例：

| 场景 | connection | authorization | delivery | status |
|------|-----------|---------------|----------|--------|
| 从未配置 | missing | missing | missing | off |
| 已连机器人、未授权 | ok | missing | missing | attention |
| 已连+已授权、未选资源 | ok | ok | missing | attention |
| 授权令牌过期 | ok | broken | missing | attention |
| 全部就绪 | ok | ok | ok | ready |

> 「已连接但未选资源」落入 `attention`（待办：选择资源），而非 `off` —— `off` 只表示用户尚未开始任何配置。

`issues[]` 生成规则：每个非 `ok` 环节产出一条（或两条）待办；`broken` 优先于 `missing`（如授权环节 `broken` 只发「重新授权」卡，不叠加发「去授权」卡）。`action.id` 复用现有 `runAction` 动作名（`connection.connect` / `authorization.begin` / `authorization.revoke` / `resources.discover` / `sync.start` / `briefing.schedule` 等），新增 `authorization.reauth`（重新授权）。

**一致性不变量（契约测试锁定）**：`status === 'ready' ⇔ chain 三环节全 ok ⇔ issues 为空`。

### 5.3 矛盾根因修复

现有 bug：`authorization.kind === 'connected'` 但 `identityLabel` 为空 → 前端渲染「未授权」。

修复：**状态判定与展示文案解耦**。`authorization` 环节 label 缺省文案为「已连接账号」，前端兜底也禁止把 label 缺失渲染成「未授权」。授权账号行的可见文案只表达「已授权/未授权」这一事实，与昵称是否解析成功无关。

### 5.4 术语翻译

- `ou_*` 原始 ID：仅在高级页排障区块可显示（可加可不加，倾向不加）；用户主界面一律用昵称。
- **技术词白名单（唯一允许出现技术措辞的两处）**：
  1. 授权前置「回调地址配置引导卡」（重定向 URL / 开发者后台 / 回调地址）——飞书开发者后台的一次性必需步骤，程序无法代改。
  2. 排障日志与错误详情（对用户隐藏，仅诊断）。
  除上述两处外，用户可见渲染串一律白话，由 §7.4 术语快照测试锁定。

## 6. 数据流与错误处理

- 进入触点页 → `personal_context.dashboard.get`（含 overall）+ `messaging.list`（现有两条调用，可并行）。
- **依赖关系澄清（无竞态）**：`overall` 聚合在**后端** `dashboard.get` 内部完成——聚合纯函数自行读取 messaging registry / OAuth store / registry 计数（复用 `resolveFeishuApp`/`getStatus` 既有内部读取路径），**不依赖前端传入**。前端 `messaging.list` 仅用于连接管理视图与高级设置渲染实例列表，不参与聚合判定。两条 IPC 调用并行执行互不阻塞。
- 推送刷新沿用现有：`messaging:instance-status`、`personal-context:authorization` → `refresh()`。
- 错误分层：
  - 业务态问题（未连接/令牌过期/同步失败）→ `chain` 环节 + 待办卡，可恢复。
  - 真异常（IPC 调用失败）→ 保留全局 notice，不伪装成业务状态。

## 7. 测试计划

1. **聚合一致性契约**：`ready ⇔ chain 全 ok ⇔ issues 空`；各中间态（仅断连 / 仅过期 / 仅未授权）下 status/chain/issues 的精确快照。
2. **回归**：`connected` 但 identityLabel 空 → 文案「已连接账号」，非「未授权」。
3. **状态图 model 层**：断链环节标 `broken` 并带原因；`missing` 占位文案。
4. **术语快照（unit + integration 双保险）**：
   - unit：渲染函数纯输出断言——直接调用各区块渲染函数，断言输出串不含 `ou_`/`Card JSON`/`颗粒度`/`实例`。
   - integration：用真实 dashboard 数据（含各中间态 fixture）驱动完整渲染，验证同一断言；防止 unit 层 mock 绕过真实数据路径。
5. **待办卡动作映射（防漏注册）**：测试枚举 `dashboard-model` 可能产出的**全部 action.id**，断言前端 `runAction` 存在对应分支——新增动作必须同时注册 handler，否则测试失败。运行时兜底：未知 action.id 渲染为禁用按钮 + `console.warn`（renderer 为纯 JS 无编译期，用测试强制 + 运行时兜底双保险）。
6. 现有 `personal-context-*` 契约测试保持通过（overall 为增量字段，不破坏旧断言）。

## 8. 实施顺序

1. 后端：`dashboard-model.ts` 聚合纯函数 + `dashboard.get` 注入 overall + identityLabel 矛盾修复 + 契约测试（§7.1-7.2）。
2. 前端触点页：新四区块渲染（状态图/待办卡/简报/高级折叠）+ runAction 映射（§7.5）。
3. 前端连接管理页：平台网格瘦身 + 白话字段 + 断开连接二次确认。
4. 术语快照测试（§7.4）落地。
5. 重启客户端端到端验证（scripts/restart-mate.sh + 真实飞书环境验证授权/简报/断开链路）。

## 9. 现状代码定位（实施参考）

- 触点页渲染：`src/renderer/modules/touchpoint-settings.js`（render/renderSteps/renderConnectionCard/renderAccessCard/renderDelivery）
- 触点页状态推导：`src/renderer/modules/touchpoint-settings-model.js`（`deriveTouchpointSettingsModel`）
- 连接管理页：`src/renderer/modules/messaging-settings.js`（renderFeishuPanel/renderInstanceList/renderLayoutPage）
- 后端 manager：`src/main/features/personal_context/manager.ts`（getStatus/revoke/getSetupGuide）
- 契约与状态机：`src/main/features/personal_context/contract.ts`
- 现有测试：`test/main/features/personal-context-*`
- 既有相关设计：`docs/superpowers/specs/2026-08-10-desktop-first-feishu-touchpoint-design.md`、`2026-08-10-feishu-companion-context-design.md`
