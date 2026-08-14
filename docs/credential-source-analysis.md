# API Key 读取源分析与方案建议

## 问题A：环境变量直接读取 vs 从 CC Switch 解析

### 当前实现分析

#### 1. CC Switch 存储机制（ccswitch_import.ts）

CC Switch 在其 SQLite 数据库中存储 provider 配置时，**不是存储环境变量名引用，而是存储实际的值**：

```typescript
// 第 163-164 行
const env = asObject(cfg.env);
const base = (k: string) => (typeof env[k] === 'string' ? (env[k] as string) : '');

// 第 176-177 行 (claude/claude-desktop)
const baseUrl = base('ANTHROPIC_BASE_URL');
const apiKey = base('ANTHROPIC_AUTH_TOKEN') || base('ANTHROPIC_API_KEY');
```

这里的 `cfg.env` 是从 CC Switch 数据库的 `settings_config` JSON 字段解析出来的对象，其中：
- `env.ANTHROPIC_BASE_URL` 存的是实际的 URL 字符串（如 "https://api.anthropic.com"）
- `env.ANTHROPIC_AUTH_TOKEN` 存的是实际的 API Key 值（如 "sk-ant-..."）

**CC Switch 的设计理念：** 配置即快照。用户在 CC Switch UI 中配置 provider 时，会把当时的环境变量值读取并存入数据库，后续不再动态读取环境变量。

#### 2. 特殊情况：codex 的 env_key 引用模式

```typescript
// 第 182-187 行
if (appType === 'codex') {
  const auth = asObject(cfg.auth);
  const apiKey =
    (typeof auth.OPENAI_API_KEY === 'string' ? (auth.OPENAI_API_KEY as string) : '')
    || apiKeyFromCodexConfigToml(cfg.config)
    || '';
```

注释（第 189-191 行）指出：
> "The key is often NOT stored by CC Switch (it uses env_key / OPENAI_API_KEY at runtime)"

这说明 codex 类型的 provider 有时会使用环境变量引用而不是存储实际值，但当前代码已经处理了这种情况（通过 `apiKeyFromCodexConfigToml` 解析 TOML 配置）。

#### 3. Mate Agent 的环境变量注入机制（provider_env.ts）

```typescript
// 第 42-49 行
if (cli === 'claude') {
  if (cp.protocol !== 'anthropic') return undefined;
  return {
    ANTHROPIC_BASE_URL: cp.baseUrl,
    ANTHROPIC_AUTH_TOKEN: cp.apiKey,
  };
}
```

Mate Agent 在启动外部 CLI 时，通过 `spawnCli` 函数将 API Key 注入为环境变量（base.ts 第 182-185 行）：

```typescript
const childEnv = buildCliSpawnEnv(binPath, env ?? process.env);
for (const [key, value] of Object.entries(providerEnv || {})) {
  if (key === 'PATH' || key === 'Path') continue;
  childEnv[key] = value;
}
```

**关键点：** `providerEnv` 的值覆盖继承的 `process.env`，实现了"Orkas 选择优先于 CC Switch 配置"的行为。

### 方案建议

#### 推荐方案：从 CC Switch 数据库解析（当前方案）

**理由：**

1. **数据完整性**
   - CC Switch DB 已经包含了完整的配置快照（baseUrl + apiKey）
   - OpenCode auth.json 也是独立的持久化存储
   - 用户的真实数据已经在这些文件中，不依赖运行时环境变量

2. **环境隔离**
   - Mate Agent 进程的 `process.env` 可能与用户配置 CC Switch 时的环境不同
   - 用户可能在不同 shell/terminal 中设置了不同的环境变量
   - 直接读取当前进程环境变量会导致不确定性

3. **一致性保证**
   - CC Switch UI 显示的配置 = CC Switch DB 存储的配置
   - 如果从环境变量读取，可能出现 Mate Agent 读到的值与 CC Switch 显示的值不一致

4. **已验证的路径**
   - `ccswitch_import.ts` 已经实现了完整的解析逻辑
   - 包括特殊情况处理（codex TOML、opencode auth.json 回退）
   - 已有测试覆盖（test/main/features/ccswitch_import.test.ts）

#### 不推荐直接读取环境变量的原因

1. **环境变量的作用域问题**
   ```
   用户终端 A: export ANTHROPIC_API_KEY=sk-ant-aaa
   用户终端 B: export ANTHROPIC_API_KEY=sk-ant-bbb
   Mate Agent GUI 启动: process.env.ANTHROPIC_API_KEY = ?
   ```
   
   GUI 应用不一定继承用户当前终端的环境变量。

2. **与 CC Switch 语义冲突**
   - CC Switch 的设计是"配置管理器"，不是"环境变量代理"
   - 用户在 CC Switch 中保存配置，期望的是持久化存储，而不是动态读取

3. **增加授权复杂度**
   - 如果从环境变量读取，每次启动都需要重新读取（因为环境变量可能变化）
   - 而 CC Switch DB 是静态文件，可以在授权后缓存到当前会话

### 实施建议

**继续使用现有的 ccswitch_import.ts 逻辑**，但增强授权流程：

```typescript
// 伪代码
async function readCcSwitchWithAuthorization(userId: string) {
  // 1. 检查本次启动会话是否已授权读取 CC Switch
  if (!hasSessionPermission('ccswitch:read')) {
    // 2. 弹出授权对话框
    const granted = await requestPermission({
      type: 'credential_source_access',
      source: 'ccswitch',
      reason: '读取 CC Switch 配置中的 API Key',
      dbPath: ccSwitchDbPath(),
    });
    if (!granted) throw new Error('User denied CC Switch access');
    
    // 3. 记录会话级授权（重启后失效）
    grantSessionPermission('ccswitch:read');
  }
  
  // 4. 读取数据库（只读模式）
  return readCcSwitchImportItems();
}
```

#### OpenCode auth.json 同理

```typescript
async function readOpencodeAuthWithAuthorization(baseUrl: string) {
  if (!hasSessionPermission('opencode:read')) {
    const granted = await requestPermission({
      type: 'credential_source_access',
      source: 'opencode',
      reason: '读取 OpenCode 配置中的 API Key',
      authPath: path.join(os.homedir(), '.local/share/opencode/auth.json'),
    });
    if (!granted) throw new Error('User denied OpenCode access');
    grantSessionPermission('opencode:read');
  }
  
  return opencodeApiKeyFromAuth(baseUrl);
}
```

## 总结

**问题A 答案：** 从 CC Switch 数据库解析更好，不应该直接读取环境变量。

**核心原因：**
- CC Switch DB 和 OpenCode auth.json 存储的是配置快照，包含完整的 API Key 值
- 环境变量在 GUI 应用中不可靠（作用域/继承问题）
- 现有实现已经正确处理了所有边界情况

**安全增强方向：**
- 增加会话级授权检查（读取外部文件前必须用户确认）
- 授权范围：本次启动会话有效，重启后重新授权
- 已存储的 connector 迁移：删除 `.enc` 加密文件，标记为 `storageMode: 'session'`，下次使用时触发授权流程
