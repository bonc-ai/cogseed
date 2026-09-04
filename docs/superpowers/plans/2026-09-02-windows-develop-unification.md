# Windows 与 develop 统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将旧 `dev/windows` 的有效 Windows 能力与最新 `develop` 做语义并集，在不触碰 `main` 的前提下形成可通过 Windows 门禁、可构建 Windows 测试包并可向 `develop` 提交 PR 的统一分支。

**Architecture:** 以 `origin/develop` 为基准，在 `integration/windows-unification` 上非快进合入 `origin/dev/windows`。冲突处同时保留 `develop` 的外部 Agent 模型/推理控制和 Windows 的跨平台进程启动能力；随后修复既有跨平台测试夹具与资源打包登记，并让 `develop` PR 同时触发 macOS、Windows 检查及 Windows artifact 构建。

**Tech Stack:** Git worktree、Electron、Node.js 24、TypeScript、Vitest、PowerShell/cmd、GitHub Actions、electron-builder。

---

## 文件结构

- `p3394-gateway/gateway.cjs`：P3394 外部 Agent 网关；融合模型控制与 Windows `spawnCli`。
- `test/main/features/p3394_bridge/external-gateways.test.ts`：真实网关跨平台 CLI 启动/失败回信验证。
- `test/main/features/p3394_bridge/gateway-models-probe.test.ts`：模型配置探测的跨平台路径测试。
- `bin/packaged-resource-gate.cjs`：electron-builder `extraResources` 共享所有权登记。
- `test/main/util/packaged-resource-gate.test.ts`：资源登记闭集约束。
- `package.json`：Windows 构建命令与 Windows sandbox 打包内容。
- `.github/workflows/ci.yml`：`develop`/`cicd` 的 macOS、Windows 验证和 Windows artifact 上传。
- `docs/superpowers/specs/2026-09-02-windows-develop-unification-design.md`：已批准设计。

### Task 1: 合入 Windows 分支并锁定冲突

**Files:**
- Merge: `origin/dev/windows`
- Conflict: `p3394-gateway/gateway.cjs`

- [ ] **Step 1: 更新远端并确认分叉计数**

Run:

```powershell
git fetch origin develop dev/windows
git rev-list --left-right --count origin/develop...origin/dev/windows
```

Expected: `50 7`；若远端继续前进，则记录新计数并确保当前分支先包含最新 `origin/develop`。

- [ ] **Step 2: 合入 Windows 分支**

Run:

```powershell
git merge --no-ff origin/dev/windows
```

Expected: 只在 `p3394-gateway/gateway.cjs` 产生内容冲突，其他 Windows 文件进入索引。

- [ ] **Step 3: 验证冲突状态确实不可运行**

Run:

```powershell
node --check p3394-gateway/gateway.cjs
git diff --name-only --diff-filter=U
```

Expected: `node --check` 因 `<<<<<<<` 失败，未解决文件列表仅包含 `p3394-gateway/gateway.cjs`。

### Task 2: 语义融合 P3394 网关

**Files:**
- Modify: `p3394-gateway/gateway.cjs`
- Test: `test/main/features/p3394_bridge/external-gateways.test.ts`
- Test: `test/main/features/p3394_bridge/gateway-models-probe.test.ts`

- [ ] **Step 1: 融合 oneshot 启动参数和进程启动**

保留 `develop` 的 `execPrefs`、模型参数、推理强度和 Claude 环境变量，把参数拆分与最终进程启动替换为 Windows 分支实现：

```js
const args = splitArgs(CLI_ARGS).map((part) => part.replace('{message}', message));
const prefs = execPrefs || {};
const template = modelArgTemplate();
if (prefs.model && template) args.push(...splitModelArgs(template, prefs.model));
const effortTemplate = effortArgsFor(preset, process.env);
const effortLevel = prefs.reasoningEffort ? effortLevelFor(preset, prefs.reasoningEffort) : null;
if (effortLevel && effortTemplate) args.push(...splitModelArgs(effortTemplate, effortLevel));
const claudeEnv = (PRESET_NAME === 'claude' && prefs.maxThinkingTokens)
  ? { MAX_THINKING_TOKENS: prefs.maxThinkingTokens }
  : null;
const child = spawnCli(CLI, args, {
  cwd: cwd || undefined,
  env: claudeEnv ? Object.assign({}, process.env, claudeEnv) : undefined,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

- [ ] **Step 2: 融合 stream-json 启动**

使用 `splitArgs` 生成基础参数和 stream 参数，保留 `modelArgv`、`effortArgv`、`thinkingEnv`，最终调用：

```js
const child = spawnCli(CLI, args, {
  cwd: (opts && opts.cwd) || undefined,
  env: thinkingEnv ? Object.assign({}, process.env, thinkingEnv) : undefined,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

- [ ] **Step 3: 融合 Claude 常驻进程**

`_args(model)` 使用 `splitArgs`，`_spawn(sessionId, cwd, maxThinkingTokens, model)` 保留模型和 thinking token 状态，并通过：

```js
const child = spawnCli(CLI, this._args(model), {
  cwd: cwd || undefined,
  env: childEnv,
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

- [ ] **Step 4: 确认冲突解析通过静态门禁**

Run:

```powershell
node --check p3394-gateway/gateway.cjs
git add p3394-gateway/gateway.cjs
git diff --name-only --diff-filter=U
git diff --cached --check
```

Expected: 语法检查成功、无未解决文件、无 whitespace 错误。

- [ ] **Step 5: 运行网关回归测试**

Run:

```powershell
npm run test:js -- --maxWorkers=1 test/main/features/p3394_bridge/external-gateways.test.ts test/main/features/p3394_bridge/gateway-models-probe.test.ts test/renderer/cli-exec-control.test.ts
node p3394-gateway/test/smoke.cjs
```

Expected: smoke 全通过；当前测试夹具在 Windows 暂有 4 个既有失败，进入 Task 3 处理。

- [ ] **Step 6: 完成合并提交**

Run:

```powershell
git commit --no-edit
```

Expected: 创建包含 Windows 分支历史的 merge commit。

### Task 3: 让 P3394 测试夹具跨平台

**Files:**
- Modify: `test/main/features/p3394_bridge/external-gateways.test.ts`
- Modify: `test/main/features/p3394_bridge/gateway-models-probe.test.ts`

- [ ] **Step 1: 重新运行四个失败用例验证 RED**

Run:

```powershell
npm run test:js -- --maxWorkers=1 test/main/features/p3394_bridge/external-gateways.test.ts test/main/features/p3394_bridge/gateway-models-probe.test.ts
```

Expected: `/bin/echo ENOENT`、`spawn EFTYPE` 和两个 `status unavailable` 路径比较失败。

- [ ] **Step 2: 把真实 CLI 夹具改成跨平台 Node shebang 脚本**

在 `external-gateways.test.ts` 增加辅助函数：

```ts
function writeNodeCli(name: string, body: string): string {
  const file = path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}.cjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}
```

成功用例使用 `writeNodeCli('p3394-echo-cli', "process.stdout.write(process.argv.slice(2).join(' '));")`；失败用例使用 `writeNodeCli('p3394-fail-cli', 'process.exit(3);')`。两个用例都在 `finally` 删除夹具，不再引用 `/bin/echo` 或 `.sh`。

- [ ] **Step 3: 把模型配置夹具路径改为平台路径**

在每个配置枚举用例中使用：

```ts
const fakeHome = path.join(os.tmpdir(), 'p3394-model-probe-home');
```

传入 `env: { HOME: fakeHome }`，并用 `path.join(fakeHome, '.hermes', 'config.yaml')`、`path.join(fakeHome, '.hermes', 'provider_models_cache.json')`、`path.join(fakeHome, '.openclaw', 'openclaw.json')` 比较 `readFileSync` 参数。

- [ ] **Step 4: 运行 GREEN 验证**

Run:

```powershell
npm run test:js -- --maxWorkers=1 test/main/features/p3394_bridge/external-gateways.test.ts test/main/features/p3394_bridge/gateway-models-probe.test.ts test/renderer/cli-exec-control.test.ts
```

Expected: 3 个测试文件全部通过，无未处理错误。

- [ ] **Step 5: 提交跨平台测试修复**

Run:

```powershell
git add test/main/features/p3394_bridge/external-gateways.test.ts test/main/features/p3394_bridge/gateway-models-probe.test.ts
git commit -m "test(windows): make P3394 fixtures cross-platform"
```

### Task 4: 修复 builtin-packages 打包门禁

**Files:**
- Modify: `bin/packaged-resource-gate.cjs`
- Modify: `test/main/util/packaged-resource-gate.test.ts`

- [ ] **Step 1: 验证缺失登记的 RED**

Run:

```powershell
npm run test:js -- --maxWorkers=1 test/main/util/packaged-resource-gate.test.ts
```

Expected: `unregistered extraResources destination: builtin-packages`。

- [ ] **Step 2: 更新测试期望值**

把闭集期望更新为：

```ts
[
  'embedding-model', 'sherpa-onnx', 'runtime', 'builtin', 'builtin-packages',
  'officecli', 'guardrail', '.',
]
```

再次运行测试，确认仍因生产登记缺失而失败。

- [ ] **Step 3: 添加最小资源所有权登记**

在 `EXTRA_RESOURCES_CONTRACT` 的 `builtin` 后添加：

```js
'builtin-packages': 'builtin-package-seed-contract',
```

该登记只修复闭集所有权；`resources/builtin-packages/_builtin.json` 和 seed 业务校验继续由现有 builtin packages 测试负责。

- [ ] **Step 4: 验证门禁和 Windows 打包**

Run:

```powershell
npm run test:js -- --maxWorkers=1 test/main/util/packaged-resource-gate.test.ts test/main/features/builtin_packages.test.ts
npm exec -- electron-builder --win --x64 --dir
```

Expected: 两个测试文件通过，electron-builder 成功生成 `dist/win-unpacked`。

- [ ] **Step 5: 提交门禁修复**

Run:

```powershell
git add bin/packaged-resource-gate.cjs test/main/util/packaged-resource-gate.test.ts
git commit -m "fix(build): register builtin packages resource"
```

### Task 5: 增加 develop 双平台门禁和 Windows 测试包

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 添加 Windows 构建命令**

在 `package.json` scripts 中加入：

```json
"build:win": "electron-builder --win --x64 --publish never"
```

- [ ] **Step 2: 让 develop PR 触发 CI**

将 workflow 触发器改为：

```yaml
on:
  pull_request:
    branches:
      - develop
      - cicd
  push:
    branches:
      - cicd
  workflow_dispatch:
```

为 Email hygiene step 增加：

```yaml
if: github.event_name == 'push' || github.base_ref == 'cicd'
```

这样 `develop` PR 不会错误执行 `origin/cicd..HEAD` 的发布邮箱门禁。

- [ ] **Step 3: 在 Windows job 构建并上传测试包**

在 P3394 smoke 后增加：

```yaml
      - run: npm run build:win
      - name: Upload Windows test package
        uses: actions/upload-artifact@v4
        with:
          name: cogseed-windows-x64-${{ github.sha }}
          path: dist/CogSeed-*-win-x64.exe
          if-no-files-found: error
          retention-days: 14
```

- [ ] **Step 4: 验证配置语法和脚本**

Run:

```powershell
node -e "const fs=require('fs'), YAML=require('yaml'); YAML.parse(fs.readFileSync('.github/workflows/ci.yml','utf8')); const p=require('./package.json'); if(!p.scripts['build:win']) process.exit(1)"
npm run build:win
```

Expected: YAML/JSON 检查退出 0，`dist/CogSeed-0.7.6-win-x64.exe` 存在。

- [ ] **Step 5: 提交 CI 和构建入口**

Run:

```powershell
git add package.json .github/workflows/ci.yml
git commit -m "ci: verify develop on Windows and macOS"
```

### Task 6: 完整本地验证与 PR

**Files:**
- Verify all changed files

- [ ] **Step 1: 运行静态与 Windows 原生门禁**

Run:

```powershell
npm run typecheck
npm run lint
npm run test:platform-native
node p3394-gateway/test/smoke.cjs
node scripts/diagnose-local-agents.mjs --json --only codex
```

Expected: typecheck/lint/smoke 退出 0；平台原生测试 18/18 文件通过；Codex CLI 被识别为可用，认证状态单独报告。

- [ ] **Step 2: 运行涉及区域的完整回归**

Run:

```powershell
npm run test:js -- --maxWorkers=1 src/core-agent/test/sandbox.test.ts test/main/features/local_agents/base.test.ts test/main/features/local_agents/registry.test.ts test/main/features/local_agents/spawn-command.test.ts test/main/features/local_agents/which-recursive.test.ts test/main/features/local_agents/which.test.ts test/main/features/p3394_bridge/external-gateways.test.ts test/main/features/p3394_bridge/gateway-models-probe.test.ts test/main/util/packaged-resource-gate.test.ts test/main/features/builtin_packages.test.ts test/scripts/diagnose-local-agents.test.ts test/renderer/cli-exec-control.test.ts
```

Expected: 所列测试文件全部通过，只有显式平台跳过项，无失败和未处理错误。

- [ ] **Step 3: 检查仓库状态和相对差异**

Run:

```powershell
git diff --check origin/develop...HEAD
git status --short
git log --oneline --decorate origin/develop..HEAD
```

Expected: 无 whitespace 错误，工作树干净，日志包含设计、Windows merge、跨平台测试、资源门禁和 CI 提交。

- [ ] **Step 4: 推送集成分支并创建 develop PR**

Run:

```powershell
git push -u origin integration/windows-unification
gh pr create --base develop --head integration/windows-unification --title "feat(windows): unify Windows support with develop" --body "Unifies the latest develop line with the seven Windows support commits. Preserves develop model/effort control and Liu Tingting's UI work while adding Windows CLI discovery, cmd shim execution, process-tree cleanup, sandbox support and the external-agent modal close action. Local gates: typecheck, lint, Windows platform-native tests, P3394 smoke, targeted P3394/local-agent tests and Windows NSIS packaging. Target is develop only; main is unchanged. Merge only after both macOS verify and Windows verify-windows pass."
```

PR 描述必须列出 Windows 前后能力矩阵、合并冲突策略、Windows package 名称、已知认证状态和 macOS CI 必须通过的要求。不得合并到 `main`。

- [ ] **Step 5: 等待 GitHub 检查**

Run:

```powershell
$prNumber = gh pr view integration/windows-unification --json number --jq '.number'
gh pr checks $prNumber --watch
```

Expected: macOS `verify` 和 Windows `verify-windows` 均成功；Windows workflow 提供 14 天保留的测试安装包。若任一检查失败，保持 PR 未合并并按日志定位根因。
