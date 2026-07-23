# Mate Agent Commander Backend 与模型配置设计

> 日期：2026-07-22  
> 版本：v0.1  
> 适用分支：`feature/p3394-integration-mvp`  
> 适用产品：基于 Orkas 基座的 Mate Agent / Mate 智伴第三版  
> 状态：设计稿，待确认后进入实施计划

---

## 1. 背景

第三版 Mate Agent 已经基于 Orkas 基座完成品牌独立化，并实现最小 P3394 治理闭环：Wake Gate、KSTAR Review、ExperienceCandidate 与历史恢复。

但当前“指挥官”仍依赖 Orkas 内置 Core Agent 模型链路：

```text
User Message
→ group_chat bus
→ chat_commander.md
→ chatWithModel / streamChatWithModel
→ Core Agent Runner
→ Provider Registry
→ Model Provider / Auth Profile
```

当用户没有在设置中配置可用云模型时，指挥官无法实际完成推理和调度，会出现类似：

```text
模型调用失败：未配置模型
```

现有设置页已经支持 Provider / Model / API Key / OAuth 的通用模型授权，但缺少角色级配置：无法明确指定“指挥官用 Orkas Core Agent 还是 Hermes CLI”“PRM Agent 用什么后端”“默认工作 Agent 用什么后端”。

因此，本设计目标是为 Mate Agent 增加最小的角色后端绑定能力，优先解决指挥官无模型配置时不可用的问题。

---

## 2. 目标

### 2.1 产品目标

1. 在设置页增加“指挥官后端配置”。
2. 指挥官支持两种后端：
   - Orkas Core Agent，继续使用现有云模型 Provider/Auth Profile。
   - Hermes CLI，复用现有 Local Agents / ACP 后端。
3. 用户未配置云模型但已安装并配置 Hermes CLI 时，可以选择 Hermes CLI 作为指挥官后端。
4. Hermes CLI 作为指挥官后端时，仍不得绕过 Orkas/P3394 的 Wake Gate、Policy、AgentOps、KSTAR 和 Audit。
5. 设置页保留现有云模型授权 UI，不重做 API Key 管理系统。

### 2.2 架构目标

1. 增加 `CommanderBackend` 抽象，不硬替换现有指挥官链路。
2. 默认后端保持 `orkas-core-agent`，避免破坏现有行为。
3. Hermes CLI 后端以 Adapter 方式接入。
4. 模型配置吸收 LiveAgent 的 Role Binding / Model Profile 思路，但不引入第二套独立模型密钥系统。
5. 云模型密钥继续由现有 `auth-profiles.json` / `auth.entries` 管理。
6. Hermes CLI 的登录、凭证和默认模型仍由 Hermes CLI 自己管理，Mate Agent 只保存选择和可选模型 ID。

---

## 3. 非目标

本阶段不实现以下内容：

1. 完整 PRM Agent。
2. 完整 EvaluationSpec / PRMEvaluationReport。
3. 多角色复杂模型矩阵。
4. Hermes 动态模型发现。
5. 云端同步配置。
6. 多设备配置同步。
7. 团队级模型权限。
8. 成本统计、预算和细粒度 token accounting。
9. 直接迁移或照搬 LiveAgent 的完整模型配置文件格式。
10. 让 Hermes CLI 直接执行 Orkas 内部工具或绕过权限系统。

---

## 4. 当前事实

### 4.1 已有云模型授权配置

设置页已有模型授权区：

```text
Provider
Model
Add account
Configured by priority
```

对应 IPC：

```text
auth.listProviders
auth.listModels
auth.addApiKey
auth.addEntry
auth.listEntries
auth.reorderEntries
auth.testConnection
auth.hasConfiguredModel
```

对应后端：

```text
src/main/features/auth.ts
src/main/ipc/index.ts
```

语义：

```text
第一个 auth entry = 默认模型
后续 auth entries = fallback chain
```

### 4.2 已有 Hermes Local Agent 后端

Hermes 已经在 Local Agents 中存在：

```text
src/main/features/local_agents/registry.ts
src/main/features/local_agents/backends/hermes.ts
src/main/features/local_agents/backends/_acp.ts
src/main/features/local_agents/models.ts
```

Hermes 后端当前以 ACP 方式运行：

```text
hermes acp
```

当前环境变量：

```text
HERMES_YOLO_MODE=1
```

作用：避免 Hermes 在 headless 运行时进入无法处理的交互式权限提示。后续若要引入用户级权限提示，应通过 Orkas UI 显式承接。

### 4.3 当前指挥官依赖的能力

指挥官不仅需要文本生成，还需要稳定支持结构化调度能力：

```text
dispatch_to
hand_off_to
run_worker
```

因此 Hermes CLI 不能作为“纯文本聊天替代品”直接接管指挥官。它必须通过 Adapter 输出可被 Orkas bus 消费的受控决策或文本。

---

## 5. 设计方案

### 5.1 总体方案

新增 Commander Backend 配置：

```text
Commander Backend
├─ orkas-core-agent   默认，现有实现
└─ hermes-cli         新增，可选后端
```

运行时：

```text
读取用户设置
  ↓
backend = orkas-core-agent
  → 走现有 chatWithModel / streamChatWithModel

backend = hermes-cli
  → 走 HermesCommanderAdapter
  → 通过 Hermes ACP 获取输出
  → 转换为 Commander 文本或 CommanderDecision
  → 交回 group_chat bus / P3394 链路处理
```

### 5.2 不改变的事实源

本设计不改变第三版既有事实源边界：

```text
Orkas Conversation = 会话事实源
Orkas Agent Runtime = 原始执行事实源
P3394 = Wake / KSTAR / Verification / Experience 事实源
```

Hermes CLI 作为后端时，不成为新的 Conversation Store、Task Store 或 KSTAR Store。

---

## 6. 设置页设计

### 6.1 设置页分区

建议将设置页模型相关区域整理为三块：

```text
一、云模型授权
二、本地 CLI 后端
三、角色绑定
```

### 6.2 云模型授权

复用现有 UI 与 IPC：

```text
Provider
Model
API Key / OAuth
Configured by priority
```

文案建议：

```text
云模型授权
用于 Orkas Core Agent、默认指挥官、PRM 和其他云模型调用。API Key 与 OAuth Token 仅保存在本机。
```

### 6.3 本地 CLI 后端

显示已有 Local Agents 检测结果：

```text
Hermes CLI
状态：已安装 / 未安装
路径：...
版本：...
模型：留空使用 Hermes 默认，或填写模型 ID
```

Hermes 模型列表当前为空，UI 应使用 free-text 输入，并提供说明：

```text
Hermes 模型可留空；留空时 Mate Agent 不传模型参数，由 Hermes CLI 使用自身默认配置。
```

### 6.4 角色绑定

第一阶段只要求实现指挥官绑定：

```text
指挥官 Mate Agent
Backend: Orkas Core Agent / Hermes CLI
```

当 Backend 为 Orkas Core Agent：

```text
Model: 使用默认云模型 / 指定 auth entry
```

当 Backend 为 Hermes CLI：

```text
CLI: Hermes
Model: 留空使用 Hermes 默认 / 手动填写模型 ID
```

### 6.5 缺省策略

默认配置：

```json
{
  "commander_backend": {
    "backend": "orkas-core-agent",
    "authEntryId": null
  }
}
```

兼容原则：没有写入过该配置的用户，行为完全等同当前版本。

---

## 7. 数据结构

### 7.1 UserPreferences 扩展

建议在现有 preferences 中新增：

```ts
export type CommanderBackendKind = 'orkas-core-agent' | 'hermes-cli';

export interface CommanderBackendSettings {
  backend: CommanderBackendKind;
  authEntryId?: string | null;
  localCli?: {
    type: 'hermes';
    model?: string;
    useCliDefaultModel?: boolean;
  } | null;
}

export interface UserPreferences {
  commander_backend?: CommanderBackendSettings;
}
```

### 7.2 字段语义

| 字段 | 含义 |
|---|---|
| `backend` | 指挥官使用的运行后端 |
| `authEntryId` | Orkas Core Agent 模式下，可选指定云模型 entry；为空则使用默认 entry |
| `localCli.type` | 本阶段固定为 `hermes` |
| `localCli.model` | 可选 Hermes 模型 ID |
| `useCliDefaultModel` | 为 true 或 model 为空时，不向 Hermes 传模型，使用 CLI 默认 |

### 7.3 密钥边界

该配置不得保存 API Key。API Key 仍由现有 `auth` 模块管理。Hermes CLI 的凭证继续由 Hermes CLI 自己管理。

---

## 8. 主进程接口

新增或扩展 IPC：

```text
settings.getCommanderBackend
settings.setCommanderBackend
settings.detectCommanderBackends
```

### 8.1 `settings.getCommanderBackend`

返回当前配置和解析后的状态：

```ts
interface CommanderBackendView {
  settings: CommanderBackendSettings;
  cloudConfigured: boolean;
  hermes: {
    available: boolean;
    path: string | null;
    version: string | null;
    error?: string;
  };
}
```

### 8.2 `settings.setCommanderBackend`

校验并保存配置：

- backend 必须是允许值。
- Hermes 模式下 localCli.type 必须是 `hermes`。
- model 可为空。
- 不要求保存时 Hermes 必须可用，但 UI 应给出警告。

### 8.3 `settings.detectCommanderBackends`

复用现有：

```text
localAgents.detect({ type: 'hermes' })
```

或在 IPC 内部调用 Local Agents registry。

---

## 9. 运行时调用设计

### 9.1 当前 Orkas Core Agent 路径

保持不变：

```text
group_chat bus
→ buildCommanderSystemPrompt()
→ chatWithModel / streamChatWithModel
→ AgentRunner
→ ProviderRegistry
```

### 9.2 Hermes CLI 路径

新增：

```text
group_chat bus
→ resolveCommanderBackend(uid)
→ backend = hermes-cli
→ buildCommanderSystemPrompt()
→ HermesCommanderAdapter.run()
→ hermes acp
→ ACP text/tool events
→ Commander output
→ group_chat bus persist/dispatch
```

### 9.3 Hermes 输出约束

第一阶段可采用保守策略：

1. Hermes Commander 先只返回最终文本，不直接执行工具。
2. 若需要调度，要求 Hermes 输出受控结构，如：

```json
{
  "kind": "dispatch_to",
  "targetAgentId": "...",
  "task": "...",
  "reason": "..."
}
```

3. Adapter 只解析白名单字段。
4. 解析失败时退化为普通文本回复。
5. 真正执行调度仍通过 Orkas bus 的已有工具/流程完成。

### 9.4 不绕过治理

Hermes Commander 不得直接：

- 写 group chat jsonl。
- 写 KSTAR 状态。
- 写 ExperienceCandidate。
- 直接启动专业 Agent。
- 直接执行文件/命令。
- 直接批准 WakeRequest。

所有副作用必须回到现有 Orkas/P3394 流程。

---

## 10. 与 LiveAgent 模型配置流程的关系

本设计吸收 LiveAgent 类似思想：

```text
Role Binding
Model Profile
Provider Profile
Secret Reference
Capability Metadata
Fallback Chain
```

但落地时不新增第二套密钥系统。

映射关系：

| LiveAgent 概念 | Mate Agent 第三版落地 |
|---|---|
| ProviderProfile | 现有 `auth.profiles` / Provider Catalog |
| ModelProfile | 现有 `auth.entries` + 可选角色绑定 |
| SecretRef | 现有 `profileId`，不存明文 key |
| Role Binding | 新增 `commander_backend` / 后续 `prm_backend` |
| Local Runtime | 现有 `localAgents` / Hermes ACP backend |
| Fallback Chain | 现有 auth entries priority |

---

## 11. 错误处理

### 11.1 未配置云模型

如果 backend 为 `orkas-core-agent` 且无可用模型：

```text
显示现有未配置模型提示，并引导到设置页。
```

如果检测到 Hermes 可用，可显示建议：

```text
未配置云模型。你可以添加模型授权，或切换指挥官后端为 Hermes CLI。
```

### 11.2 Hermes 未安装

如果 backend 为 `hermes-cli` 但 Hermes 不可用：

```text
指挥官暂不可用：未检测到 Hermes CLI。请安装 Hermes 或切回 Orkas Core Agent。
```

### 11.3 Hermes 运行失败

失败应记录为模型/后端错误，不应伪装成 KSTAR 失败：

```text
Commander backend failed: Hermes CLI exited / ACP handshake failed / timeout
```

UI 应保留可恢复入口：

```text
切换后端
重试
打开设置
```

### 11.4 Hermes 输出不可解析

如果 Hermes 返回不合规结构化调度：

1. 不执行副作用。
2. 将输出当作普通文本或显示“无法解析调度意图”。
3. 记录审计日志。

---

## 12. 安全与权限

1. Renderer 不接触 API Key。
2. Renderer 不直接执行 Hermes CLI。
3. Hermes CLI 由主进程 Local Agents 后端调用。
4. Hermes CLI 不能直接绕过 Orkas Tool Permission。
5. Hermes 作为指挥官后端时，不自动拥有文件写入、命令执行或专业 Agent 唤醒权限。
6. Wake Gate 仍然是专业 Agent 加入和执行的入口。
7. KSTAR 和 ExperienceCandidate 仍由 P3394 后端写入。

---

## 13. 测试计划

### 13.1 单元测试

新增测试覆盖：

1. 默认 commander backend 为 `orkas-core-agent`。
2. 保存 Hermes backend 配置。
3. Hermes model 为空时表示使用 CLI 默认。
4. 非法 backend 被拒绝。
5. Hermes 不可用时返回可读状态。
6. `authEntryId` 不存在时返回配置错误或回退默认 entry。

### 13.2 Renderer 测试

新增测试覆盖：

1. 设置页显示指挥官后端配置。
2. 切换 Orkas Core Agent / Hermes CLI。
3. Hermes 未安装时显示警告。
4. Hermes 模型输入可为空。
5. 保存后刷新仍显示选择。

### 13.3 集成测试

新增测试覆盖：

1. 默认配置下现有指挥官路径不变。
2. Hermes backend 被选中时，调用 HermesCommanderAdapter。
3. Hermes 返回普通文本时，不执行调度副作用。
4. Hermes 返回结构化调度时，只通过白名单 CommanderDecision 执行。
5. Hermes 运行失败时返回后端错误，不写 KSTAR 成功状态。

### 13.4 回归测试

必须继续通过：

```bash
git diff --check
npm run typecheck
PYTHONDONTWRITEBYTECODE=1 npm test
```

并做一次真实 Electron QA：

1. 打开设置页。
2. 切换指挥官后端为 Hermes CLI。
3. Hermes 未安装和已安装状态分别验证。
4. 无云模型配置时不再只给出死路提示，应能引导选择 Hermes。
5. 切回 Orkas Core Agent 后行为恢复。

---

## 14. 验收标准

本阶段完成后，应满足：

1. 默认用户不受影响，指挥官仍走 Orkas Core Agent。
2. 设置页能看到并保存指挥官后端配置。
3. Hermes CLI 可被选择为指挥官后端。
4. Hermes CLI 模型可留空，表示使用 Hermes 默认模型。
5. 未配置云模型时，用户有清晰路径切换 Hermes CLI。
6. Hermes CLI 不绕过 P3394 Wake Gate、KSTAR、ExperienceCandidate。
7. 全量自动化测试通过。
8. 真实 Electron 设置页 QA 通过。

---

## 15. 后续扩展

本阶段完成后，可继续扩展：

1. PRM Agent Backend：`orkas-core-agent | hermes-cli`。
2. Worker 默认后端绑定。
3. EvaluationSpec 与 PRMEvaluationReport。
4. Hermes 动态模型发现。
5. 后端能力矩阵：tools / streaming / structured output / long context。
6. 成本、延迟、失败率统计。
7. 配置导入导出。

---

## 16. 推荐实施顺序

```text
1. 增加 CommanderBackendSettings 类型和 preferences 读写
2. 增加 settings.* IPC
3. 设置页增加指挥官后端 UI
4. 接入 Hermes 检测状态
5. 新增 resolveCommanderBackend
6. 保持 Orkas Core Agent 默认路径不变
7. 增加 HermesCommanderAdapter 最小文本模式
8. 再增加受控 CommanderDecision 解析
9. 完成测试和 Electron QA
```

