# 四步引导 API 存储功能实现总结

## 需求背景

用户的核心安全要求：**默认情况下不能直接将用户的 API 密钥存储到 Mate Agent 平台**。API 密钥只能在用户明确授权（通过下拉选择）的情况下才能被读取和存储。

### 核心要求

1. **默认行为**：连接到 AI 团队时不存储 API，只记录元数据；通过唤醒用户本地 CLI（CLI 读取自己的配置文件）
2. **可选行为**：用户可以通过下拉菜单选择"连接并存储"将 API 存储到 CogSeed 以便后续使用
3. **关键新要求**：当用户选择"连接并存储"时，**只存储当前正在使用的一个 API**（从 CLI 自己的配置文件读取），而不是从 CC Switch 数据库导入全部 API
4. **理由**：设置页面已经支持从 CC Switch 导入全部 API，所以引导流程只需存储当前活跃的一个
5. **UI 交互**：使用下拉菜单而非复选框，提供"只连接"和"连接并存储"两个选项

## 实现方案

### 1. 读取活跃 CLI 配置模块

**文件**：`src/main/features/local_agents/active_config.ts`（已创建）

**功能**：从 CLI 自己的配置文件中读取当前正在使用的 API 配置

支持的 CLI 及其配置文件位置：
- **Claude Code**: `~/.claude/.credentials.json` (OAuth) 或 `~/.claude/settings.json` (API key，优先级更高)
- **Codex**: `~/.codex/auth.json`
- **OpenCode**: `~/.local/share/opencode/auth.json`

核心函数：
```typescript
export interface ActiveCliConfig {
  cli: LocalCliType;
  baseUrl: string;
  apiKey: string;
  mode: 'oauth' | 'api';
  sourcePath: string;
}

export function readActiveCliConfig(cli: LocalCliType, home?: string): ActiveCliConfig | null
export function readAllActiveCliConfigs(home?: string): ActiveCliConfig[]
```

**测试**：`test/main/features/local_agents/active_config.test.ts`（已创建，包含 15 个测试用例）

### 2. UI 层修改

**文件**：`src/renderer/modules/onboarding.js`

**修改位置 1**：第 213-219 行，移除复选框（已删除）

原本添加的复选框已完全移除，不再使用这种交互方式。

**修改位置 2**：第 1099-1107 行，将单个"连接"按钮改为下拉菜单 + 执行按钮

```javascript
const action = connectable
  ? `<div class="cs-team-actions">
      <select class="cs-team-action-select" data-app-type="${_csEsc(appType)}">
        <option value="connect-only">只连接</option>
        <option value="connect-store">连接并存储 API</option>
      </select>
      <button type="button" class="cs-team-connect cs-btn" data-app-type="${_csEsc(appType)}">执行</button>
    </div>`
  : '';
```

**修改位置 3**：第 1116-1123 行，事件监听器读取下拉菜单选择

```javascript
box.querySelectorAll('.cs-team-connect').forEach((btn) => {
  btn.addEventListener('click', () => {
    const appType = btn.dataset.appType;
    const select = box.querySelector(`.cs-team-action-select[data-app-type="${appType}"]`);
    const shouldStore = select && select.value === 'connect-store';
    void _csConnectTeam(box, appType, shouldStore);
  });
});
```

**修改位置 4**：`_csConnectTeam()` 函数签名（第 1124 行），添加 `shouldStoreApi` 参数

```javascript
async function _csConnectTeam(box, appType, shouldStoreApi = false) {
```

**修改位置 5**：存储逻辑更新（第 1169-1184 行），基于参数而非复选框

```javascript
// 3) If user selected "connect and store", store the currently-in-use API.
let storedApi = false;
if (shouldStoreApi && cli) {
  try {
    const storeRes = await window.cogseed.invoke('customProviders.storeActiveCliConfig', { cli });
    if (storeRes && storeRes.ok) {
      storedApi = true;
      _obLog.info('active CLI config stored', { cli, providerId: storeRes.providerId });
    } else {
      _obLog.warn('active CLI config store failed', { cli, error: storeRes?.error || 'unknown' });
    }
  } catch (err) {
    _obLog.warn('active CLI config store error', { cli, error: (err && err.message) || String(err) });
  }
}
```

**修改位置 6**：错误恢复时的按钮文本（第 1152 行和 1216 行）

将 `btn.textContent = '连接'` 改为 `btn.textContent = '执行'`，与新的按钮标签保持一致。

### 3. CSS 样式修改

**文件**：`src/renderer/onboarding.css`

**位置**：第 347-357 行，添加下拉菜单和按钮组样式

```css
#cs-onboarding .cs-team-actions{display:flex;align-items:center;gap:8px}
#cs-onboarding .cs-team-action-select{padding:7px 12px;font-size:12px;border:1px solid var(--cs-line);
  border-radius:6px;background:var(--cs-paper);color:var(--cs-ink);cursor:pointer;
  transition:all .15s;outline:none}
#cs-onboarding .cs-team-action-select:hover{border-color:var(--cs-forest);background:var(--cs-paper-lift)}
#cs-onboarding .cs-team-action-select:focus{border-color:var(--cs-forest);box-shadow:0 0 0 3px var(--cs-forest-ghost)}
```

样式设计遵循现有的设计系统，使用变量定义的颜色和圆角，提供悬停和聚焦状态的视觉反馈。

### 3. IPC 处理器

**文件**：`src/main/ipc/index.ts`

**位置**：第 3627 行之后（紧接 `customProviders.ccswitch.sync` 处理器）

**处理器名称**：`customProviders.storeActiveCliConfig`

**核心逻辑**：

1. 验证输入参数（CLI 类型）
2. 调用 `readActiveCliConfig()` 读取当前活跃配置
3. 检查是否已存在相同的 externalId（避免重复）
4. 如果存在则更新，否则创建新的 custom provider
5. 对于 anthropic 协议，自动绑定默认模型（claude-sonnet-4-6）
6. 返回结果（包含 providerId 和 mode）

**去重逻辑**：
```typescript
const externalId = `${cli}:active`;
const existing = customProviders.listCustomProviders(ctx.userId);
const existingProvider = existing.find((p) => p.externalId === externalId);

if (existingProvider) {
  // 更新现有 provider
  customProviders.updateCustomProvider(ctx.userId, existingProvider.id, {...});
} else {
  // 添加新 provider
  customProviders.addCustomProvider(ctx.userId, {...});
}
```

### 4. 测试覆盖

**文件**：`test/main/features/local_agents/active_config_storage.test.ts`（已创建）

**测试场景**：

1. 只存储 Claude 当前活跃的 API key（不是 CC Switch 的全部）
2. 重复存储同一个活跃配置时的去重处理
3. 存储 Codex OAuth token

注：测试逻辑保持不变，因为 UI 层的改变（复选框 → 下拉菜单）不影响 IPC 处理器和底层存储逻辑。

## 实现细节

### CLI 类型到协议映射

```typescript
const protocolMap: Record<string, 'anthropic' | 'openai' | 'gemini'> = {
  claude: 'anthropic',
  codex: 'openai',
  opencode: 'anthropic',
  hermes: 'anthropic',
  workbuddy: 'anthropic',
};
```

### 默认 Base URL

- Anthropic 协议：`https://api.anthropic.com`
- OpenAI 协议：`https://api.openai.com/v1`

### Provider 命名

格式：`${CLI首字母大写}（当前使用）`

例如：
- `Claude（当前使用）`
- `Codex（当前使用）`

### External ID

格式：`${cli}:active`

例如：
- `claude:active`
- `codex:active`

## 用户体验流程

1. 用户在四步引导的"连接 AI 工具"步骤看到各个 Agent
2. 每个 Agent 下方有一个下拉菜单和"执行"按钮
3. 下拉菜单提供两个选项：
   - **"只连接"**（默认选项）：只连接 Agent 到团队，不存储 API
   - **"连接并存储 API"**：连接 Agent 同时存储当前正在使用的 API
4. 用户选择所需选项后点击"执行"按钮
5. 系统执行相应操作：
   - 如果选择"只连接"：
     - 同步 CC Switch 中的模型提供商（如果有）
     - 添加 CLI 作为团队成员
   - 如果选择"连接并存储"：
     - 同步 CC Switch 中的模型提供商（如果有）
     - 添加 CLI 作为团队成员
     - **存储当前正在使用的 API**（新增）
6. 成功提示示例：
   - 只连接：`已把「Claude Code」连接到 AI 团队（X 个模型，新增 1 位 CLI 成员）`
   - 连接并存储：`已把「Claude Code」连接到 AI 团队（X 个模型，新增 1 位 CLI 成员，已存储当前正在使用的 API）`

## 安全考虑

1. **默认不存储**：下拉菜单默认选项为"只连接"，用户必须主动选择"连接并存储"才会存储 API
2. **只读取活跃配置**：不会扫描或导入所有可能的 API
3. **加密存储**：存储在 `auth-profiles.json` 中，使用与其他凭据相同的加密机制
4. **去重逻辑**：防止重复存储同一个 API
5. **错误处理**：存储失败不会影响连接流程，只会记录日志
6. **用户明确选择**：相比复选框，下拉菜单让用户在执行前必须做出明确的选择

## 与 CC Switch 导入的区别

| 对比项 | 四步引导存储 | CC Switch 导入（设置页面） |
|--------|-------------|--------------------------|
| 触发位置 | 引导流程 | 设置页面 |
| 存储数量 | **仅 1 个**（当前使用） | 全部 |
| 数据源 | CLI 自己的配置文件 | CC Switch 数据库 |
| 用户授权 | 必须在下拉菜单选择"连接并存储" | 在设置页面主动操作 |
| externalId | `${cli}:active` | `${cli}:${id}` |

## 日志记录

成功存储：
```
active CLI config stored { cli: 'claude', providerId: 'cp-xxx', mode: 'api' }
```

更新现有配置：
```
active CLI config updated { cli: 'claude', providerId: 'cp-xxx', mode: 'oauth' }
```

存储失败：
```
active CLI config store failed { cli: 'claude', error: 'no_active_config' }
```

## 后续工作

1. 如需支持更多 CLI 类型，在 `active_config.ts` 中添加相应的读取函数
2. 如需调整协议映射，修改 `ipc/index.ts` 中的 `protocolMap`
3. 如需修改 UI 文案，编辑 `onboarding.js` 中的相关字符串
4. 可以考虑在设置页面也提供"存储当前使用的 API"快捷操作

## 测试说明

由于测试环境缺少 rolldown native binding，测试无法在 Linux ARM64 沙箱中执行，但代码逻辑已通过：

1. 静态代码审查
2. 类型检查
3. 与现有代码模式对比验证
4. 测试用例编写（覆盖主要场景）

实际测试需要在完整的开发环境中运行：
```bash
npm test test/main/features/local_agents/active_config.test.ts
npm test test/main/features/local_agents/active_config_storage.test.ts
```
