# 飞书个人上下文连接器设计（伴侣智能体底座）

**日期：** 2026-08-10
**状态：** 设计草案（待组会同步）
**参考输入：**
- `docs/Cogseed-Hermes-飞书-MVP实施计划.md`（Hermes Agent 分支上的 Cogseed 学生伴侣规划，借鉴其产品理念与实施节奏）
- 2026-08-10 讨论例会纪要（赵丽霞 / 牛保康）：定位"面向各行各业的个人伴侣智能体（学生为首个场景案例）"，旅程对齐为"身份授权 → 资源选择 → 本体确认 → 执行汇报"，默认只读、写入需确认
- cogseed-agent 现有代码盘点（本文档第 3 节）

## 1. 目标与范围

### 1.1 一句话定位

在 cogseed-agent（Electron + TS）上实现"**个人上下文连接器框架 + 飞书首实现**"：把用户授权的飞书个人数据（日历/云空间/文档/联系人）选择性接入，经"候选实体 → 本体确认"治理后成为**个人上下文底座**，喂给可无限扩展的场景层（今日简报、日程助理、学习/研究任务、学期地图等）。**定位不锁人群**：面向各行各业的个人用户，学生（学期地图、课程-截止推理）只是首个场景案例，场景层按"场景注册制"向各行业扩展，连接器与本体代码不随人群变化。

### 1.2 设计目标

1. **连接器只产标准资源，不懂场景**；场景只信本体，不直接摸 provider。
2. 用户旅程全程**用户发起 + 用户批准**：默认只读，对外写入需确认。
3. 场景注册制：新场景 = 技能/auto_task + 本体查询模板，不碰连接器代码。
4. 薄抽象：先把 `ConnectorProvider` 接口契约定稳，实现只做飞书；不为想象中的未来 provider 过度设计。

### 1.3 MVP 边界

**包含：**
- 飞书用户 OAuth（授权码/刷新/撤销/健康检查，只读权限默认）
- 选择性资源接入：主日历、课程/项目日历、课程资料文件夹、作品集文件夹、单个文档/知识库页面、获准聊天话题
- 有限回填（近 30 天事件、未来 90 天日历）与游标增量同步
- 资源标准化（`ExternalResource`）+ 幂等键
- 资源 → 候选实体 → 个人本体候选确认（复用现有 `personal_ontology_candidates` 流水线）
- 身份绑定补齐：`tenant + union_id` 稳定键优先、`open_id` 兜底；双向绑定入口（机器人侧 + 桌面端）
- 场景一"今日简报"：auto_tasks 每日定时 → 聚合本体+已授权日历 → 推送到飞书主页会话（归属人）
- 治理：候选确认/拒绝、撤销授权、按范围遗忘、写操作审批

**不包含（二期或明确不做）：**
- 全量同步飞书消息/联系人/租户资源（选择性原则）
- 云空间自动写入（日报/PRD 自动上传）——涉及"写入审批"扩展，MVP 只读
- 偏好模型（基于历史行为预测加班、智能调整提醒时机）
- 智能日程助理的复杂编排（抓领导日程等）——依赖日历数据成熟后
- 微信/邮件等其他 provider（接口就位，不实现）
- 小程序/公众号触点
- 宣称 xAPI LRS 认证、IEEE P3394 合规认证（项目已有 P3394 实现，但不做认证承诺）

## 2. 用户旅程

> 场景主体：各行各业的个人用户（学生为首个场景案例）。前置条件：已在 cogseed-agent"设置 → 消息平台"完成飞书机器人配置（QR 绑定，现有能力）。

### 2.1 首次接入（一次性，约 10 分钟）

第 2–4 步全部由**用户主动发起**，系统默认只读、只接入用户选定的资源：

1. **建立身份绑定**：用户在飞书私聊中向机器人打招呼。
   → 系统识别 `tenant + union_id`，与 cogseed-agent 用户建立持久绑定（双向：用户也可在桌面端发起连接，录入 `open_id` 完成绑定）。绑定完成后，机器人知道"这个飞书用户 = 这个 cogseed-agent 用户"。
2. **授权飞书个人数据（用户 OAuth）**：用户发起"连接我的飞书"。
   → 跳转飞书授权页，勾选只读权限（日历 / 云空间 / 文档）；回跳后 token 加密存储于机器私有区，界面显示"已连接"。
3. **选择接入资源（选择性，不扫全租户）**：用户勾选主日历（个人 + 课程）、课程资料文件夹、作品集文件夹、单个文档 / 知识库页面（此处为学生场景示例，实际资源类型按用户行业接入）。
   → 系统记录接入范围（scope-manifest），做一次有限回填（近 30 天事件、未来 90 天日历），之后按游标增量同步。
4. **生成个人事实建议（学生场景示例：学期地图）**：系统从已接入资源抽取候选事实（课程、截止日期、项目、师生关系等）。
   → 用户收到飞书待确认卡片，逐条批准 / 拒绝（复用现有候选确认流水线）。已批准事实进入个人本体。
5. **完成接入**：用户可随时查看"已接入资源 / 授权状态"；后续新资源接入可增量补充，无需重新走全流程。

**关键原则：第 2–4 步全是"用户发起 + 用户批准"，系统默认只读、只接选定资源。**

### 2.2 日常使用

- **每日简报（自动）**：早 8 点（可配置），机器人向主页会话推送"今日简报"：
  - 今日日程 / 会议（来自已授权日历）；
  - 近期截止日期（**仅来自本体已确认事实**——未确认候选只提示"有 N 条待确认"，不展示内容）；
  - 空闲时段建议（基于空档与截止推算）。
  简报只读展示，无需用户确认；数据缺失时降级为通用简报。
- **随时提问（被动）**：用户在私聊或获准群聊中提问，例如"下周三之前有什么要交的？"
  → agent 检索：个人本体（已确认事实）+ 授权日历 + 相关文档引用 → 在当前会话上下文作答（不污染稳定系统提示词），回答可追溯到来源。
- **任务委派（需批准）**：用户提出有边界的研究任务，例如"对比这三种传感器，帮我们选方案"
  → 系统先展示任务目的 + 权限范围 + 预算，等用户批准 → 在隔离工作空间执行（现有 P3394 边界，工具受限）→ 结果带引用和来源回到原飞书话题。
- **持续治理（需批准）**：系统从对话 / 文档中抽到新事实 → 飞书"待确认"卡片 → 用户批准 / 拒绝；**新会话上下文只出现已批准事实**。
- **控制权始终在手**：
  - `/权限`：随时查看授权了哪些资源、有无待审批事项；
  - 随时撤销 OAuth 授权（系统停止同步并标记资源失效）；
  - 一切对外写入 / 发送 / 修改均需确认——默认只读；
  - 按范围遗忘：`/遗忘 <scope>` 预览并删除对应资源引用与派生候选。

## 3. 差距映射（现有设施盘点）

| 所需能力 | cogseed-agent 现有设施 | 状态 |
|---|---|---|
| 飞书通道（WS/私聊/群聊/流式卡片/交互卡片） | `features/messaging/`（registration、post、adapters 含 `MessagingCardAdapter`、registry、policy） | ✅ 已有 |
| 持久化身份 | `memory.ts`（USER.md）+ `bindings.ts` + `allowUserIds` | 🟡 缺 `tenant+union_id` 稳定键 |
| 个人本体 + 候选治理 | `personal_ontology_candidates.ts`（addCandidates/confirmCandidate/rejectCandidate）+ `personal_ontology_router.ts` + `template_files` + `role_templates` | ✅ 已有 |
| 情节账本 | `kstar/episode-store` + `messaging/ledger`（入站/投递账本） | ✅ 已有 |
| 记忆写入审批 | `kstar` review-card + requirement 闭环 | ✅ 已有 |
| 长期记忆 | `memory.ts` + `cognition/` | ✅ 已有 |
| 有边界任务 Agent | `features/p3394/`（wake-dispatcher、execution-boundary、protocol）+ Commander worker | ✅ 已有 |
| 定时/主动推送 | `auto_tasks.ts`（daily/weekly，bus 单派发）+ `proactive.ts` + `task_notifications.ts` | 🟡 机制已有；数据源与**飞书推送出口**均未接（auto_tasks 与 messaging 目前零引用） |
| **用户 OAuth（双飞书身份）** | 无（只有应用/机器人令牌） | ❌ 最大缺口 |
| **飞书上下文连接器（日历/云空间/文档同步）** | 无 | ❌ 最大缺口 |

## 4. 架构

```
┌─ 场景层（可扩展，不锁人群）──────────────────────┐
│  今日简报 | 日程助理(二期) | 学习/研究任务 | 学期地图 │
│  （学生为首个场景案例，各行业场景按注册制接入）      │
│  （场景 = 技能/auto_task + 本体查询 + 飞书推送）     │
└──────────────────┬──────────────────────────────┘
                   │ 只读：查本体 + 查资源引用
┌──────────────────▼──────────────────────────────┐
│  个人本体 + 记忆（现有 personal_ontology、memory） │
│  —— 治理后的语义事实，场景只信这里                 │
└──────────────────┬──────────────────────────────┘
                   │ 候选实体（addCandidates / confirmCandidate）
┌──────────────────▼──────────────────────────────┐
│  连接器层：features/personal_context/             │
│  ExternalResource 标准化 + 资源注册表 + 幂等同步    │
│  ┌──────────┐ ┌──────────┐                     │
│  │ feishu/  │ │ (未来)    │ ← 微信/邮件/企微      │
│  │ (首个)   │ │          │                     │
│  └──────────┘ └──────────┘                     │
└──────────────────┬──────────────────────────────┘
                   │ 统一 OAuth 管理器（授权/刷新/撤销/健康检查）
```

### 4.1 关键决策

- **连接器与场景解耦**：连接器产出 `ExternalResource` 与候选实体；场景只通过本体 API 与资源引用消费。
- **资源与本体分离**：`ExternalResource` 是来源事实引用（含版本/来源/敏感级别）；本体只存治理后的语义事实。
- **机器私有与云同步分离**：OAuth 凭据/刷新令牌存 `userLocalConfigDir`（机器私有，不进云同步）；资源注册表、游标、候选存 `userCloudRoot/.../context/`（云同步用户私有数据）。
- **命名避免冲突**：现有 `features/connectors/` 是 MCP 工具连接器，本方案新模块用 `features/personal_context/`，不混用。

## 5. 详细设计

### 5.1 连接器契约（`features/personal_context/contract.ts`）

```ts
export interface ConnectorProvider {
  readonly id: 'feishu' | string;          // 稳定标识
  readonly kind: 'oauth';                  // MVP 只支持 OAuth 型
  /** 授权状态与健康检查 */
  status(ctx: ConnectorContext): Promise<ConnectorStatus>;
  /** 发现可接入的资源类型与顶层容器（日历/文件夹/知识库节点列表，不展开内容），条目由 sync 拉取 */
  discoverResources(ctx: ConnectorContext): Promise<ExternalResource[]>;
  /** 用户选择后的增量同步；返回新资源与变更 */
  sync(ctx: ConnectorContext, cursor?: SyncCursor): Promise<SyncResult>;
  /** 撤销授权：停同步、标记失效、可选级联清理 */
  revoke(ctx: ConnectorContext): Promise<void>;
}

export interface ExternalResource {
  resourceId: string;       // 幂等键：feishu:tenant-1:calendar:cal_xxx
  resourceType: string;     // calendar | document | file | folder | chat | contact
  sourceVersion?: string;   // 版本/事件 ID，用于幂等
  title: string;
  ownerRef?: string;        // feishu:union_id:ou_xxx（union_id 前缀 ou_）
  containerRef?: string;    // 父容器（文件夹/日历组）
  sourceUrl?: string;
  observedAt: string;
  contentHash?: string;
  accessLabel: 'personal' | 'shared' | 'public';
  retentionPolicy: string;  // source-linked=跟随来源生命周期（来源删除/撤销授权即失效）
                            // fixed=独立保留，仅按范围遗忘或用户手动删除时移除
  /** 是否已读全文（按需读取标记，避免大文件全文入库） */
  bodyLoaded?: boolean;
}
```

### 5.2 统一 OAuth 管理器（`features/personal_context/oauth-manager.ts`）

- 通用授权码流程：`authorize(providerId, scopes) → 浏览器授权页 → 回调 → 兑换 token`。
- **回调机制（关键决策）**：飞书 OAuth 重定向 URL 必须是 http(s)，无法直接回跳 `cogseed://` 自定义协议（现有 `connectors/protocol.ts` 的 Server 中转模式是 hosted 依赖，开源版不可用）。采用**授权时临时监听本地回环端口**：发起授权时绑定 `http://127.0.0.1:<临时端口>/oauth/feishu/callback`（OS 分配空闲端口），兑换完成立即关闭监听。这是 AGENTS.md「无 HTTP server、无端口占用」的**受控例外**——仅授权瞬间存在、仅回环地址、不常驻，配合随机 `state` 校验（+ PKCE，若飞书支持）防 CSRF/中间人。阶段 1 需验证飞书对重定向 URL 的校验规则（是否允许 http://127.0.0.1、是否允许动态端口）。
- 凭据加密存 `userLocalConfigDir(uid)/personal-context/<provider>.json`（机器私有，复用现有 secret 存储模式）。
- 刷新/撤销/健康检查统一入口；失败时连接器状态置 `error` 并在 UI 明确显示（参考 messaging 实例状态机 `disconnected/connecting/connected/error`）。
- 令牌写入规则（借鉴 Hermes 文档 9.2）：**令牌绝不进入** xAPI/情节账本、本体事实、日志、任务工作空间或提示词。

### 5.3 飞书 provider（`features/personal_context/feishu/`）

**应用形态决策（阶段 1 第一验证点）**——飞书官方约束（open.feishu.cn 应用类型与能力）：
- 企业自建应用：**仅限同一企业内发布和使用**，企业外用户无法授权/使用；
- 商店应用：第三方 ISV 上架，**所有企业 + 飞书个人版用户**可用；但**无 user_id（仅 open_id/union_id）**——正好支持本设计的 union_id 稳定键；
- 对外共享（外部群/外部用户单聊）：**仅自建应用可开启**，需企业/团队认证或**个人实名认证**；开启后消息/群组 API 存在权限限制。

决策：MVP 用「自建应用 + 开启对外共享（个人实名认证）」快速验证外部用户授权链路与单聊可行性；商店应用（或合作方租户）作为正式发行形态，阶段 1 并行评估两条路径的成本与限制后定稿。

- `oauth.ts`：飞书授权码 + `user_access_token` 管理（接入现有飞书注册体系，但身份与机器人应用令牌严格分离）。
- `discovery.ts`：列出可选日历、文件夹、知识库节点、聊天话题（只读元数据）。
- `sync.ts`：
  - 事件驱动（二期）：日历/文档变更属应用事件订阅（calendar.changed 等），是独立通道，不复用 messaging 消息事件；MVP 以定时增量轮询为主；
  - 定时增量：游标 + `updated_at` 水位同步日历/文件夹元数据/文档版本/联系人；
  - 按需取全文：仅当前任务需要时读取（`bodyLoaded` 标记）；
  - 有限回填：入门时近 30 天事件、未来 90 天日历。
- `normalize.ts`：飞书对象 → `ExternalResource`（幂等键含 tenant + 资源类型 + 稳定 ID + 版本）。
- 知识库节点 token 与底层对象 token 分离：先解析节点，再按实际对象类型（docx/sheet/bitable/file）分派处理器（借鉴 Hermes 文档 9.5）。

### 5.4 数据布局

```
<uid>/local/config/personal-context/    ← 机器私有（OAuth 凭据、加密，与 messaging.json 同级）
  feishu.json
<uid>/cloud/context/                    ← 云同步（资源注册表、游标、候选）
  registry.json                         ← ExternalResource 索引（幂等键 → 资源）
  cursors/<provider>.json               ← 同步水位
  scope-manifest.json                   ← 用户勾选的接入范围（可审计）
```

候选实体池不新增存储：直接复用 `personal_ontology_candidates` 的既有数据文件，连接器只负责写入候选与来源引用。

> 复用现有路径工具（`src/main/paths.ts`）：凭据存 `userLocalConfigDir(uid)/personal-context/<provider>.json`（即 `<uid>/local/config/personal-context/`，机器私有，与 messaging.json 同级）；资源注册表、游标、候选存 `userCloudRoot(uid)/context/`（云同步）。不新建全局常量。
> ⚠️ 落地前核对 `personal_ontology_candidates` 的既有数据文件位置，`cloud/context/` 与其保持一致或明确差异，避免语义重叠目录。

### 5.5 资源 → 本体管线

1. 同步产出 `ExternalResource`（注册表去重、版本比较）。
2. 对**已确认接入范围**的资源跑候选实体抽取（复用 `personal_ontology` 的抽取与 LLM 对号入座路由：`personal_ontology_router.ts`）。
3. `addCandidates(uid, ...)` 进候选池；用户通过现有确认卡片/UI `confirmCandidate / rejectCandidate`。
4. 已确认事实进本体；新会话上下文只含已确认事实。

### 5.6 场景层：今日简报（MVP 场景一）

- 配置：`auto_tasks` 新建 `daily` 任务（时间可配，默认 8:00），绑定飞书主页会话 + 归属人。
  - ⚠️ 集成验证点：现有 auto_tasks 消息经 bus 单派发（`auto_tasks.ts:13`），需确认派发目标能否指定外部消息平台会话（飞书主页会话）；不支持则扩展派发目标模型（阶段 3 第一集成验证点）。
- 数据：本体已确认事实（日程/截止日期/项目）+ 授权日历近 24h 事件 + 未来 7 天截止。
- 输出：文本/流式卡片推送到主页会话；不要求用户在场确认（只读展示，无写入）。
- 失败处理：同步失败/无数据时降级为不含资源数据的通用简报，不阻塞。

### 5.7 身份绑定补齐

- 稳定键：飞书事件优先用 `tenant + union_id` 解析伴侣身份，`open_id` 作为范围受限后备（`messaging/types.ts:158` 注释已预留该方向）。
- **授权一致性校验**：OAuth 回调兑换 token 后，必须校验 token 对应用户的 `union_id` 与绑定关系一致，不一致拒绝（防止"绑定的身份 A 授权了身份 B 的数据"错位）。
- 双向绑定：机器人侧发起（私聊打招呼）+ 桌面端主动连接（录入 open_id 或扫码）。
- 组织场景（二期）："申请-审批"绑定企业组织，管理员审批兜底权限边界（会议纪要）。

## 6. 权限与治理

- 连接器默认只申请**只读**权限；试点期间所有对外写入/发送需审批。
- 令牌不落日志/账本/本体/工作空间/提示词。
- 飞书事件视为至少一次投递：所有同步处理器幂等（稳定幂等键 + 注册表去重）。
- 撤销 OAuth → 停同步、资源标记失效、候选保留但标注来源失效。
- 按范围遗忘：`/遗忘 <scope>` 预览并删除/失效对应资源引用与派生候选。
- 任务 Agent 默认禁止访问完整用户目录/完整本体/无关项目（现有 P3394 边界延续）。

## 7. 实施阶段（按会议节奏：先修闭环 → 技术验证 → 最小闭环）

### 阶段 0：基础闭环修复（当前分支进行中）

- 多机器人"创建-绑定"关联问题修复（多个机器人创建报错）。
- 主动发消息依赖"归属人"配置的体验补齐（个人 ID 查找不便、前端隐藏 user ID 隐私风险）。

### 阶段 1：OAuth 技术验证（约 1 周）

- 飞书用户授权码流程跑通：只读日历 + 选定文档访问可行（对应 Hermes 文档"首批工程任务 10"）。
- 凭据加密存储 + 刷新 + 撤销 + 健康检查。

### 阶段 2：连接器框架 + 飞书 provider（约 2–3 周）

- `ConnectorProvider` 契约、`ExternalResource`、注册表、游标、幂等。
- 选择性资源入门（日历 + 文件夹 + 单个文档）+ 有限回填。
- 资源 → 候选实体 → 本体确认管线打通（复用现有流水线）。
- 身份稳定键补齐（`tenant + union_id`）。

### 阶段 3：场景层（约 1–2 周）

- 今日简报（auto_tasks + 本体/日历聚合 + 主页会话推送）。
- 学期地图建议（会议设想的"事件回填 → 事实抽取 → 学习地图"）。
- 端到端演示：对应 Hermes 文档第 18 节的玛雅场景（简报 → 提问 → 任务 Agent → 审批 → 新会话召回）。

### 阶段 4：加固与试点

- 撤销/遗忘/故障恢复测试；令牌刷新、重复事件幂等。
- 试点文档与诊断；升级演练。

## 8. 测试策略

- **单元**：`ExternalResource` 标准化与幂等键；游标推进/回退；OAuth 刷新与撤销状态机；候选抽取路由降级（LLM 失败 → 流水区，与 `personal_ontology_router` 既有契约一致）。
- **集成**：provider sync 与注册表一致性；候选 → 确认 → 本体 → 新会话上下文闭环；令牌不进日志/账本（断言）；简报降级路径。
- **端到端**（真实飞书测试租户 + 合成个人数据）：授权 → 选资源 → 回填 → 候选确认（学生场景示例：学期地图）→ 确认 → 简报推送 → 提问召回 → 任务 Agent 委派/审批/回传 → 撤销授权后同步停止。
- 安全、令牌、事件与交付行为不能只依赖模拟客户端测试。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 分支/代码偏离主线 | 独立 feature 模块 + 复用现有 API，不做大改 |
| 机器人令牌误当用户访问权 | 双身份严格分离；身份不匹配拒绝调用 |
| 过度采集个人数据 | 选择性入门、只读默认、有限回填、按范围遗忘 |
| 原始数据污染个人事实 | 资源只能经候选确认进入本体（复用治理流水线） |
| 重复/延迟事件触发重复任务 | 稳定幂等键 + 注册表去重 + 可重复执行处理器 |
| OAuth 刷新/撤销静默失败 | 健康检查、失败置 `error`、可见权限状态、重新授权流程 |
| 简报数据缺失导致体验差 | 降级为通用简报，不阻塞 |

## 10. 关联行动项

- **竞品调研（会议安排）**：WorkBuddy、Codex 的接入能力与已接入触点，输出调研表，作为后续触点/能力取舍参考。
- 组会同步：本文档梳理后与赵丽霞等对齐，再进入实现排期。

## 参考资料

- `docs/Cogseed-Hermes-飞书-MVP实施计划.md`（理念与节奏来源）
- 2026-08-10 讨论例会纪要（产品定位与旅程对齐）
- `src/main/features/messaging/types.ts`、`adapters.ts`、`personal_ontology_candidates.ts`、`auto_tasks.ts`、`features/p3394/`
