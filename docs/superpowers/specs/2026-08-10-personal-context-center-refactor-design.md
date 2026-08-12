# 个人伴侣数据中心整体重构设计

**日期：** 2026-08-10  
**状态：** 已获用户确认，进入实现计划阶段  
**范围：** 消息平台设置、飞书真实连接、资源同步、内容理解、本体确认、简报预览与投递  
**主路径：** 真实飞书连接  
**辅助路径：** 隔离的体验模式，用于无真实租户时展示完整产品闭环

## 1. 设计目标

当前实现已经具备 OAuth、资源注册表、同步游标、候选池、简报生成和消息投递等能力，但这些能力分散在多个页面和业务入口中。用户无法从界面上理解连接之后会发生什么，真实飞书配置、用户 OAuth、资源选择、本体确认和简报投递也没有形成一条一致的产品流程。

本次重构不再以“增加一个设置卡片”作为目标，而是建立一个统一的个人伴侣数据中心：

```text
平台应用连接
    ↓
用户个人数据授权
    ↓
资源选择与同步
    ↓
内容规范化与来源追踪
    ↓
本体候选审核
    ↓
简报预览、测试投递与定时投递
```

### 1.1 必须达成

1. 真实飞书连接是默认主路径，体验模式不能掩盖真实连接失败。
2. 消息平台应用配置与用户个人数据授权明确分层。
3. 所有页面通过统一聚合状态工作，不在 renderer 内部拼接多个低层 IPC 结果。
4. 用户能够看见每条事实的来源、版本、更新时间和使用范围。
5. 用户能够在一个工作台中确认、拒绝或编辑候选事实。
6. 简报可以先预览，再测试投递，最后配置自动投递。
7. 日历、云空间文件、文档、知识库、表格和多维表格等可见资源都必须有完整的读取与状态语义；不支持正文读取的资源不能伪装成可用于内容理解的资源。
8. 撤销、遗忘、网络失败、授权失效、应用重启和部分资源失败都必须有收敛状态。
9. 保留现有用户数据和经过验证的存储、安全、幂等基础设施。
10. 删除被新应用层和新页面替代的旧编排代码，不保留两套长期并行路径。

### 1.2 明确不做

1. 不新增 HTTP 服务，也不让 OAuth 回调占用固定本地端口。
2. 不把 appSecret、user_access_token 或原始授权响应传入 renderer、日志、提示词或云同步数据。
3. 不让 renderer 直接调用 registry、oauth manager、provider 或 ontology 存储。
4. 不把未确认候选直接写入正式个人本体。
5. 不在体验模式中伪造真实连接状态、真实授权状态或真实投递成功。
6. 不新增 npm 依赖；优先复用现有 Electron 协议、文件提取、消息投递和本体设施。
7. 不把项目范围编码进用户目录、会话 ID 或路径。

## 2. 用户与角色

### 2.1 普通使用者

普通使用者只负责：

1. 点击连接个人飞书数据；
2. 在真实 OAuth 页面同意授权；
3. 选择要接入的日历、文件夹、文档或知识库节点；
4. 审核系统提取出的候选事实；
5. 预览或调整简报投递设置。

普通使用者不应被要求进入飞书开发者后台配置应用。

### 2.2 应用部署者

开源或自部署场景中，部署者一次性负责：

1. 创建飞书应用；
2. 开启机器人和网页应用能力；
3. 配置平台要求的回调方式和权限；
4. 将机器人凭据绑定到消息平台实例；
5. 完成应用发布或可用范围配置。

界面可以提供部署诊断和复制配置内容，但不能把部署者步骤伪装成普通用户的连接步骤。

### 2.3 平台运行时

平台运行时负责：

- OAuth 状态机；
- 加密凭据；
- provider API 调用；
- 资源注册表与游标；
- 内容提取和候选生成；
- 本体确认；
- 简报生成与投递；
- 日志、错误链和恢复。

## 3. 信息架构

消息平台设置仍然是设置页中的一个入口，但内部改为三层结构：

```text
消息平台
├── 平台实例
│   ├── 飞书机器人
│   ├── 微信
│   ├── 企业微信
│   └── 其他平台
├── 个人伴侣数据
│   ├── 连接总览
│   ├── 资源与同步
│   ├── 待确认事实
│   └── 简报与投递
└── 管理员诊断
```

### 3.1 平台实例页

职责仅限于消息收发连接：

- 实例列表；
- 创建、编辑、删除；
- 二维码或平台授权；
- 归属人；
- 连接状态；
- 测试发送；
- 平台错误诊断。

飞书卡片中显示两个独立状态：

- “机器人消息”：平台收发是否可用；
- “我的数据”：当前用户 OAuth 是否可用。

### 3.2 个人伴侣数据中心

使用统一页面状态模型，不再由多个设置卡片各自请求和更新：

```ts
interface PersonalContextDashboard {
  mode: 'real' | 'demo';
  messaging: MessagingConnectionSummary;
  authorization: AuthorizationSummary;
  resources: ResourceSummary;
  sync: SyncSummary;
  review: CandidateSummary;
  briefing: BriefingSummary;
  actions: DashboardAction[];
}
```

页面的首屏必须说明：

- 当前是不是连接真实飞书；
- 已经接入了什么；
- 系统已经理解了什么；
- 还有什么等用户确认；
- 下一步能看到什么结果。

## 4. 状态机

连接和数据处理状态分别建模，不能用一个 `connected` 字段承载全部流程。

### 4.1 授权状态

```text
disconnected
→ ready_to_authorize
→ authorizing
→ connected
→ needs_reauth
→ revoked
→ error
```

状态转移要求：

- 重复点击连接必须复用或取消已有流程，不产生第二个授权流；
- 授权取消必须回到 `ready_to_authorize`；
- 授权回调 state 不匹配必须拒绝并保留原状态；
- token 失效只能进入 `needs_reauth`，不能假装断开；
- 撤销必须停止同步并级联标记来源失效；
- 应用重启后从加密凭据恢复状态并重新健康检查。

### 4.2 同步状态

```text
idle
→ discovering
→ syncing
→ extracting
→ awaiting_review
→ ready
→ partial_failure
→ failed
```

每个资源单独记录状态，整轮同步只反映汇总结果。单个文档失败不得让其他日历或文件全部回滚。

### 4.3 简报状态

```text
not_configured
→ preview_ready
→ sending
→ delivered
→ delivery_failed
→ paused
```

生成、预览和投递必须是三个可独立重试的动作。

## 5. 真实飞书 OAuth 设计

### 5.1 回调方式

飞书 OAuth 的 `redirect_uri` 必须是开发者后台已配置的 HTTP/HTTPS 地址，不能把桌面应用自定义协议直接当作飞书回调地址。现有 `src/main/features/connectors/protocol.ts` 的 deep-link 机制仍然复用，但它只负责“HTTPS 回调中转后的最后一跳”。这一点与飞书官方 OAuth 文档要求的 HTTP 回调地址保持一致。

真实模式使用现有 API profile 对应的 HTTPS bridge：

```text
飞书授权页
  ↓
<accountApiBase>/personal-context/oauth/feishu/callback
  ↓
<现有应用协议>://connectors/oauth/callback
  ↓
当前 Electron 实例
```

bridge 只做回调转发，不接触 `appSecret`、`user_access_token` 或个人资源正文。PC 仍然使用本地消息平台实例中的 `appId/appSecret` 完成 code exchange；bridge 通过短时、一次性的 flow token 将回调送回发起授权的设备。

如果当前 API profile 没有个人上下文回调 bridge，真实模式必须显示“部署者需要启用回调中转能力”的明确诊断，不能退回本地 HTTP server，也不能把体验模式伪装成真实连接。这个 bridge 是真实模式的部署前置契约，不是 renderer 的隐藏行为。

个人上下文授权需要在 callback 参数中携带一次性 flow token。flow token 只用于定位内存中的授权流程，不携带用户 ID、token 或敏感数据；授权上下文由服务端绑定设备 ID，PC 回调后再次用 state、nonce 和 code verifier 校验。

改造要求：

1. 为 personal context 增加独立且可校验的 callback action；
2. redirect URI 由既有 API-base helper 计算，禁止硬编码生产域名；
3. 只接受当前应用协议、固定 host 和固定 path 的 deep-link；
4. 通过 state 绑定 uid、provider、nonce、device ID 和过期时间；
5. 支持 macOS `open-url`、Windows/Linux `second-instance` 两种回调入口；
6. 冷启动回调由已有 protocol bootstrap 统一消费；
7. 删除个人上下文专用的 `callback-server.ts`、固定端口和动态端口测试；
8. bridge 不可用、回调失败、state 不匹配和授权拒绝都必须聚合到当前 dashboard，而不是只写日志。

### 5.2 凭据边界

- appSecret 只从现有消息平台 secret store 读取；
- user_access_token 只写入现有 local-secret facade；
- renderer 只能收到 masked identity 和授权状态；
- token refresh、revoke、health check 都在 main feature 层完成；
- 所有错误日志使用脱敏后的错误码、阶段和资源类型。

### 5.3 授权诊断

应用不能检测飞书开发者后台全部配置，因此 UI 分开显示：

- 本地凭据是否存在；
- 机器人是否可用；
- OAuth 是否成功；
- 最近一次授权错误；
- 需要部署者处理的配置提示。

用户授权失败时，错误页面必须提供：

- 人话说明；
- 错误阶段；
- 是否可以重试；
- “复制诊断信息”；
- 管理员诊断入口；
- 不泄露 secret 的配置检查结果。

## 6. 资源与内容管线

### 6.1 统一资源模型

所有 provider 数据先变成 `ExternalResource`，然后进入 registry。资源必须包含：

- provider；
- resource type；
- stable ID；
- tenant 和 owner identity；
- title；
- source URL；
- parent resource；
- version 或 updatedAt；
- capability；
- selected 状态；
- content status；
- source validity。

幂等键必须包含：

```text
provider + tenant + owner + resourceType + stableId + version
```

### 6.2 资源能力

资源发现时返回 capability，而不是只返回一个类型：

```ts
interface ResourceCapability {
  canList: boolean;
  canReadMetadata: boolean;
  canReadContent: boolean;
  canSyncIncrementally: boolean;
  canGenerateCandidates: boolean;
  unsupportedReason?: string;
}
```

只有 `canReadContent` 和 `canGenerateCandidates` 满足要求的资源，才能进入“用于个人伴侣理解”的选择范围。

### 6.3 飞书资源处理器

使用处理器映射，不把所有逻辑堆进 `feishu/sync.ts`：

```text
calendar-handler
calendar-event-handler
drive-folder-handler
docx-handler
wiki-handler
sheet-handler
bitable-handler
file-handler
chat-topic-handler
contact-handler
```

Wiki 处理器必须先解析底层对象，再转发给对应处理器。处理器统一返回：

```ts
interface NormalizedContent {
  resource: ExternalResource;
  version: string;
  title: string;
  text?: string;
  structured?: JsonCompatibleValue;
  evidence: ContentEvidence[];
  warnings: ContentWarning[];
}
```

大文档和大表格必须采用分页、分块和长度上限，不允许一次性把全文塞入模型上下文。

### 6.4 同步与恢复

- 先写资源和内容快照，再推进游标；
- 游标推进使用 expected previous cursor；
- 重复事件必须幂等；
- 网络错误不得推进游标；
- 认证错误转为 `needs_reauth`；
- 内容解析错误只影响当前资源；
- 同步完成后只对新增或版本变化的资源生成候选；
- 撤销后资源保留来源失效标记，不伪造“从未存在”。

## 7. 本体确认工作台

候选模型增加：

- sourceResourceId；
- sourceVersion；
- evidence；
- candidateHash；
- generatedAt；
- changedFromCandidateId；
- review state；
- review note。

审核工作台支持：

1. 候选列表；
2. 来源和证据展开；
3. 编辑文本后确认；
4. 批量确认；
5. 批量拒绝；
6. 只显示当前有效来源；
7. 显示来源失效和资源删除；
8. 以 confirmed facts 为唯一简报和问答输入。

体验模式的候选使用独立 `demoSessionId`，不会写入正式用户本体。

## 8. 简报与投递

### 8.1 生成输入

简报只能使用：

- 已确认本体事实；
- 已授权且有效的资源；
- 当前任务允许的内容范围；
- 当前时间窗口内的数据。

未确认候选只显示数量，不显示未经批准的事实正文。

### 8.2 预览模型

简报预览返回结构化区块：

```ts
interface BriefingPreview {
  id: string;
  date: string;
  sections: BriefingSection[];
  sourceSummary: BriefingSourceSummary;
  warnings: BriefingWarning[];
  canDeliver: boolean;
}
```

每个区块可展示来源计数和来源链接，但不会把 token 或内部路径暴露给 renderer。

### 8.3 投递模型

投递目标必须显式选择：

- messaging instance；
- owner identity；
- home conversation；
- locale；
- timezone。

测试投递与定时投递共用同一个 delivery service。使用稳定幂等键：

```text
briefing:<taskId>:<local-date>:<destination-id>
```

## 9. IPC 设计

新增统一的应用层 IPC：

```text
personal_context.dashboard.get
personal_context.mode.set
personal_context.authorize.begin
personal_context.authorize.cancel
personal_context.authorize.revoke
personal_context.resources.discover
personal_context.resources.select
personal_context.sync.start
personal_context.sync.retry
personal_context.review.list
personal_context.review.approve
personal_context.review.reject
personal_context.review.edit_and_approve
personal_context.briefing.preview
personal_context.briefing.test_delivery
personal_context.briefing.schedule
personal_context.briefing.pause
personal_context.diagnostics.get
```

IPC 层只负责：

- payload 结构校验；
- userId 注入；
- 调用 application service；
- 统一错误序列化。

所有业务逻辑放在 `features/personal_context/application/`。

## 10. 数据迁移

保留并读取现有：

- OAuth 加密凭据；
- `registry.json`；
- `scope-manifest.json`；
- 同步游标；
- 个人本体候选；
- auto task 配置。

新增版本化文件：

```text
<uid>/cloud/context/dashboard.json
<uid>/cloud/context/briefing-destinations.json
<uid>/cloud/context/content-snapshots/
<uid>/cloud/context/review-events.jsonl
<uid>/local/config/personal-context/runtime.json
```

迁移规则：

1. 读取旧格式；
2. 构造新模型；
3. 校验完整性；
4. 原子写入新格式；
5. 新格式可读后才切换版本；
6. 旧数据保留可恢复副本；
7. 任一迁移失败都不覆盖旧数据。

## 11. 体验模式

体验模式必须与真实模式共用：

- dashboard view model；
- 状态机；
- 资源选择 UI；
- review UI；
- briefing preview UI；
- delivery result UI。

不同点只有 provider 和 delivery adapter：

```text
DemoProvider      → 隔离示例资源
DemoReviewStore   → demoSessionId 隔离候选
DemoDelivery      → 明确标记“演示投递”，不发送到真实飞书
```

体验模式不能显示“已连接真实飞书”，不能写入正式用户本体，也不能创建真实 auto task。

## 12. 测试策略

### 12.1 Main 测试

- OAuth state、过期、重复、取消、回调入口；
- provider 资源发现和分页；
- Wiki 底层对象解析；
- Docx、Sheet、Bitable、文件内容规范化；
- registry 幂等；
- 游标冲突和失败回退；
- 资源版本变化；
- 候选来源和证据；
- 确认、拒绝、编辑确认；
- 简报只读取已确认事实；
- 测试投递和定时投递幂等；
- 撤销、遗忘和重启恢复；
- token 不进入日志、IPC 返回值和工作区。

### 12.2 Renderer 测试

暴露纯函数 view model 和状态转移测试，覆盖：

- 初始状态；
- 配置缺失；
- 授权中；
- 连接成功；
- 部分同步失败；
- 待审核；
- 简报可预览；
- 投递失败；
- 体验模式和真实模式差异；
- i18n-change 后重新渲染；
- 防重复点击和 IME 输入边界。

### 12.3 真实环境验证

完成代码验证后：

1. 运行 `scripts/restart-mate.sh`；
2. 查看 messaging runtime 启动日志；
3. 检查 launcher 日志；
4. 使用真实飞书应用完成 OAuth；
5. 发现真实资源；
6. 同步真实日历、文件、文档、Wiki、Sheet、Bitable；
7. 确认候选；
8. 生成真实简报；
9. 测试投递到真实主页会话；
10. 验证撤销和重新授权。

## 13. 验收标准

只有以下条件全部满足，才称为“可运行版本”：

1. 用户无需阅读开发者文档即可理解页面下一步；
2. 管理员配置和普通用户授权被明确分开；
3. 真实模式为默认模式；
4. 体验模式可以立即演示完整流程；
5. 真实 OAuth 回调不依赖个人上下文专用 HTTP server；
6. 所有可选资源都有准确的 capability 和状态；
7. 资源正文或结构化内容能进入统一内容模型；
8. 候选带来源、版本和证据；
9. 未确认事实不进入简报和新会话上下文；
10. 简报可以预览、测试发送、定时发送和重试；
11. 部分失败、授权失效、撤销、遗忘和重启都有可见恢复路径；
12. 旧用户数据可以安全迁移；
13. `npm test` 和 `npm run typecheck` 的结果已实际验证；
14. 应用重启后已进行真实环境验证；
15. 新架构替代的旧编排代码已删除或明确保留为底层兼容层。

## 14. 项目约束映射

实现必须继续遵守当前 PC 工程边界：

- renderer 继续使用 classic scripts，不引入 TypeScript、JSX 或 bundler；
- 所有新 renderer 脚本显式加入 `src/renderer/index.html` 或现有 lazy feature manifest；
- IPC 只做参数校验、userId 注入和 application service 调用；
- 处理用户私有数据的 feature 函数把 `userId` 作为第一个参数；
- boot-time scheduler 通过 `util/boot_init.ts` 注册，不使用裸启动 timer；
- 新 IPC channel 必须同步更新 main handler、preload allow-list、renderer shim 和测试；
- 可见字符串通过 main/renderer locale 和 `t(...)` 提供；
- 图标复用 `src/renderer/modules/icons.js`，不硬编码 SVG path 或 emoji；
- 本地迁移备份放入用户 `local` 域，不参与云同步 dirty 标记；
- API URL 通过现有 account/marketplace API-base helper 解析；
- 不新增 npm 依赖；
- 每次 messaging worktree 改动完成后，必须运行 `scripts/restart-mate.sh`，检查 messaging runtime 日志，再做真实环境验证。

## 15. 实现顺序

1. 新建领域状态和 dashboard 聚合模型；
2. 把 OAuth 回调迁移到现有 connector deep-link；
3. 重构 application service 和 IPC；
4. 完成 Feishu provider 内容处理器和 capability 模型；
5. 重构消息平台设置页；
6. 重构个人伴侣数据中心；
7. 重构本体确认工作台；
8. 重构简报预览与投递设置；
9. 增加体验模式适配器；
10. 做数据迁移和兼容检查；
11. 删除旧编排入口；
12. 执行完整测试、重启和真实环境验证。
