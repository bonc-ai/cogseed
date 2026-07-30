# 统一模型供应商与 CC Switch 导入设计

**日期：** 2026-07-30

**来源基线：** `origin/dev/wujiayu` 的供应商功能提交 `9da8c00`、`06f9d18`、`c9d694d`、`2ebc4b4`、`f75c90e`。

## 目标

用统一的“模型供应商”设置体验替代当前用户可见的“模型授权”入口，同时保留现有 OAuth、API Key、模型优先级、多账号轮换、冷却和 fallback。新增自定义 Anthropic、OpenAI-compatible、Gemini 供应商，支持手工配置、CC Switch 预览导入、内置聊天运行时以及 Claude/Codex CLI 环境注入。

## 非目标

- 不删除或重置现有授权凭据、模型 entry 或 OAuth session。
- 不把目标分支的旧版 `auth.ts`、`settings.js`、locale 或 CSS 整文件覆盖到当前 `main`。
- 不新增 npm 依赖；CC Switch 读取复用项目已有 sqlite 运行时。
- 不在本轮为 Hermes、OpenClaw 或 OpenCode 增加供应商环境变量注入。
- 不改变图片、视频、TTS、搜索等独立授权页面的数据模型。
- 不迁移目标分支最后一个与供应商无关的 Agent 治理提交 `9476c99`。

## 当前约束

当前模型授权体系不仅保存密钥，还承担以下运行时职责：

- `profiles`：API Key 与 OAuth 账号。
- `entries`：有序的 provider/model/profile 组合。
- 同 provider/model 多账号轮换。
- OAuth 刷新、profile cooldown、fallback 和连接测试。
- `openai-compatible` 的自定义 Base URL 与最大输出 token 配置。

因此“替代模型授权”定义为替代设置页的信息架构和操作入口，而不是删除底层授权引擎。

## 总体架构

```text
设置页：模型供应商
  ├─ 内置供应商账号
  │    ├─ OAuth
  │    ├─ API Key
  │    └─ 模型优先级/轮换
  ├─ 自定义供应商
  │    ├─ 手工 CRUD
  │    └─ CC Switch 预览与导入
  └─ CLI Agent 供应商绑定
       ├─ Claude -> Anthropic 协议
       └─ Codex  -> OpenAI 协议

加密 auth-profiles 存储
  ├─ profiles / entries（现有）
  └─ customProviders（新增）

运行时
  ├─ 现有内置/OAuth provider runner
  ├─ cp:<id> 自定义 provider runner
  └─ local_agents provider env overlay
```

## 决策一：保留现有授权数据，统一设置页

设置页中原“模型授权”标题和导航改为“模型供应商”。页面继续呈现现有账号、OAuth、模型 entry、优先级和测试能力，并新增自定义供应商区及 CC Switch 导入入口。

renderer 可以继续调用现有 `auth.*` IPC 处理内置供应商，同时调用新增 `customProviders.*` 处理自定义供应商。旧 `auth.*` IPC 保留，避免其他 renderer 流程和已发布版本的调用失效。

页面不把 API Key 回填到输入框。列表只显示 masked key、协议、Base URL、来源、模型数和状态。

## 决策二：扩展现有加密 ProfilesFile

在现有 `ProfilesFile` 中新增可选字段：

```typescript
interface CustomProvider {
  id: string;
  name: string;
  protocol: 'anthropic' | 'openai' | 'gemini';
  baseUrl: string;
  apiKey: string;
  models?: string[];
  notes?: string;
  websiteUrl?: string;
  needsModelMapping?: boolean;
  source: 'manual' | 'ccswitch';
  externalId?: string;
  createdAt: number;
  updatedAt?: number;
}

interface ProfilesFile {
  // existing fields unchanged
  customProviders?: CustomProvider[];
}
```

文件仍通过 `util/local-secret-store.ts` 整体加密。读取旧版本时缺少 `customProviders` 等价于空数组；升级不改写现有 profiles/entries 的语义。

新增私有数据 feature API 必须以 `userId` 为第一个参数。为避免扩大 legacy auth API 的改动面，新增 user-scoped profiles IO helper；现有无参数 auth API 继续包装 active uid。

## 决策三：自定义供应商 CRUD

新增 `features/custom_providers.ts`，负责：

- list/add/update/remove。
- 名称、备注、模型列表长度限制。
- Base URL 只允许无内嵌凭据的 `http:`/`https:`。
- protocol 严格限定为 anthropic/openai/gemini。
- API Key 只在写入和运行时读取，IPC list 永远返回 masked key。
- CC Switch 以 `externalId` 幂等导入；重复同步更新同一记录，不创建副本。
- 删除供应商时级联移除引用 `cp:<id>` 的模型 entries。
- 删除后 Agent 上残留的 `cli_provider_id` 不导致启动失败；runner 记录 warn 并回退到 CLI 自己的默认配置。

任何增删改都使 core-agent runner 配置缓存失效。

## 决策四：自定义供应商作为一等模型 Provider

自定义供应商使用 synthetic provider id：

```text
cp:<customProviderId>
```

它参与现有 provider picker、model entry、优先级、轮换和 cooldown。自定义供应商的 profile marker 使用 synthetic id，但密钥只保存在 `customProviders`，不重复写入 `profiles`。

自定义 provider 需要以下 auth 兼容：

- `listProviders` 合并 `cp:<id>` 项。
- `listModels` 返回供应商声明模型；空列表时 renderer 使用手工模型输入。
- `addEntry` 接受 `cp:<id>` 并验证供应商存在。
- `listEntries` 从 custom provider 合成 label 和 masked profile 信息。
- `pickChatEntry` 从 custom provider 解析 API Key。
- provider policy 明确允许已存在的 `cp:<id>`，但不把任意 `cp:` 字符串视为可信。

现有 `openai-compatible` provider 完整保留，不迁移、不降级。用户可继续使用单账号快速配置，也可创建多个命名自定义供应商。

## 决策五：内置聊天运行时

新增 `model/core-agent/custom_provider_runtime.ts`，把 CustomProvider 转换为 core-agent provider/model：

| protocol | API dialect |
|---|---|
| anthropic | `anthropic-messages` |
| openai | `openai-completions` |
| gemini | `google-generative-ai` |

Base URL、API Key 和模型 id 来自加密记录与当前 entry。未知模型使用保守的 context/output 默认值。运行时不得把 key、完整 Authorization header 或带凭据 URL写入日志。

`#core-agent` 仍保持 dynamic-import only；不得在新模块或 feature 顶层静态导入。

## 决策六：Claude/Codex CLI 供应商绑定

CLI Agent spec 的 runtime 可选增加：

```typescript
cli_provider_id?: string;
```

Agent 创建/编辑界面根据 CLI 类型过滤可选供应商：

- Claude 只显示 `anthropic` 自定义供应商。
- Codex 只显示 `openai` 自定义供应商。
- 未选择时保持 CLI 原有配置行为。

runner 在唯一 CLI spawn 路径解析 env overlay：

```text
Claude: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
Codex:  OPENAI_BASE_URL + OPENAI_API_KEY
```

env overlay 只传给 child process，不写入 argv、process event、run archive 或日志。自定义供应商缺失、无 key 或协议不匹配时不注入，并记录不含秘密的 warn。

## 决策七：CC Switch 导入

新增 `features/ccswitch_import.ts`，以只读方式探测 CC Switch 数据库。支持 macOS 和 Windows 的已知数据目录；不存在、不可读或 schema 不兼容均返回结构化状态，不抛到 renderer。

导入分两步：

1. Preview：读取非 official provider，解析 protocol/Base URL/model/key 状态，向 renderer 返回 masked key。
2. Sync：用户显式勾选 external id 后导入；缺 key 的记录保留 `needsKey` 状态，必须由用户补齐后才能进入运行时。

映射规则：

- Claude/Claude Desktop -> anthropic。
- Codex -> openai。
- Gemini -> gemini。
- 没有自定义 Base URL 的 official/default row 跳过。
- URL 在写入前再次通过 custom provider 校验，不能因为来自本地 DB 而绕过安全边界。

不得监视 CC Switch 文件或自动后台同步。每次同步都由用户在设置页主动发起。

## 决策八：IPC 与 UI

新增 IPC 仅做参数检查和 feature 调用：

```text
customProviders.list
customProviders.add
customProviders.update
customProviders.remove
customProviders.ccswitch.probe
customProviders.ccswitch.preview
customProviders.ccswitch.sync
```

所有 handler 从 IPC context 取得 `userId`，renderer 不提供 uid。返回对象不包含完整 API Key。

设置页使用现有按钮、表单、dialog、select、status 和列表样式，不复制近似组件。新增可见字符串进入四套 renderer locale。动态内容在 `i18n-change` 后重绘。

统一页面包括：

1. 当前模型优先级与账号列表。
2. 添加内置供应商 OAuth/API Key。
3. 自定义供应商列表及新增、编辑、删除。
4. CC Switch 检测、预览、多选导入 dialog。

不保留第二个独立的“模型授权”导航入口，避免两个页面同时修改同一 auth store。

## 迁移与兼容

- 旧 auth-profiles 文件原样可读；`customProviders` 默认为空。
- 已有 OAuth、API Key、entry 顺序和 cooldown 语义不变。
- 已有 `openai-compatible` profile 不自动转换为 custom provider。
- custom provider 删除后，其 entries 自动清理；历史对话不改写。
- 旧 Agent spec 没有 `cli_provider_id` 时行为不变。
- 开放源构建继续使用现有 local-secret facade；不直接导入 hosted secret backend。

## 测试策略

### Feature 与存储

- CRUD 验证、URL scheme/credentials 拒绝、模型归一化。
- 旧 ProfilesFile 无 customProviders 时兼容。
- 增删改不破坏 profiles、entries 和其他媒体授权数组。
- 删除供应商级联清理 custom entries。
- IPC list 不泄露完整 key。

### 运行时

- 三种 protocol 映射到正确 API dialect/Base URL/model。
- custom entry 参与 priority、rotation、cooldown 和 fallback。
- 未知、缺 key、协议错误时安全失败或回退。
- `#core-agent` 继续保持动态导入。

### CLI

- Claude/Codex 注入正确 env。
- env 不进入 argv、process-info、日志和 archive。
- 未绑定/供应商删除/协议不匹配时不注入。
- 其他 CLI 类型不受影响。

### CC Switch

- 用临时 sqlite fixture 覆盖 Claude、Codex、Gemini、official skip、缺 key、坏 JSON 和 schema mismatch。
- Preview 掩码；Sync 只导入用户选择项；externalId 幂等。
- macOS/Windows 路径解析分别测试。

### Renderer

- 统一导航替代旧“模型授权”入口。
- 自定义供应商 CRUD 与 CC Switch dialog IPC 合同。
- i18n-change 重绘和最长文本布局检查。

### 回归

- auth/model/provider/local-agent 定向测试。
- `npm run typecheck`。
- 完整 `npm test`。
- 手动启动 Electron，验证设置页新增、编辑、删除、导入和 CLI 绑定流程。

## 验收标准

- 设置页只有统一“模型供应商”入口，旧授权能力全部可达。
- 现有 OAuth、API Key、模型优先级、轮换、cooldown/fallback 无回归。
- 用户能手动创建并使用 custom provider。
- 用户能预览并显式导入 CC Switch 第三方供应商。
- custom provider 可用于内置聊天。
- Anthropic custom provider 可绑定 Claude，OpenAI custom provider 可绑定 Codex。
- API Key 在磁盘、IPC、日志、argv 和 UI 中均满足现有秘密保护要求。
- 当前 `main` 的 P3394、Engine 和其他近期改动不被目标分支旧文件覆盖。
