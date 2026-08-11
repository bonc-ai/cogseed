# CogSeed 全量内部身份迁移设计

- 日期：2026-08-10
- 状态：待用户书面复核
- 实施分支：`dev/cogseed-full-identity-migration`
- 实施工作树：`/Users/sudai/.config/codex/worktrees/Mate Agent/cogseed-full-identity-migration`
- 基线：`origin/develop@4aa6c60`
- 发布策略：一次性切换到 CogSeed canonical 身份，保留一个版本的旧身份兼容适配层

## 1. 背景

当前用户可见品牌已经是 CogSeed，但内部仍存在上一代身份：

- App ID：`com.mateagent.desktop`
- URL scheme：`mateagent`、`orkas`
- 数据根：`.orkas`、`.orkas-dev`
- 环境变量：`ORKAS_*`
- renderer bridge：`window.orkas`
- IPC transport：`orkas.invoke`、`orkas:bootI18n` 等
- runtime variant：`mate`
- feature 目录：`mate_agent_runtime`、`mate_agent_backend`
- 可执行入口：`mate-runtime-worker.cjs`、`orkas-bridge.cjs`、`orkas-pkg.cjs`
- artifact iframe 协议：`__orkasArtifact`、`window.orkasArtifact`、`OrkasArtifactSecurity`、`__orkas/bridge.js`、`__orkas-meta.json`
- local-agent MCP 身份：`clientInfo.name=orkas`、`mcp_servers.orkas`、`runs inside Orkas`
- 安全规则与运行时 marker：`.orkas/.../marketplace`、`.orkas-runtime.json`、`.orkas-whisper-ready.json`、`.orkas-import-*.tmp`

本设计将 CogSeed 变为唯一 canonical 内部身份，同时保证现有安装可在一次升级中自动迁移数据，并在一个发布版本内继续接受旧协议、旧 bridge、旧环境变量和旧入口文件。

## 2. 目标

1. 新安装和新代码只使用 CogSeed canonical 标识。
2. 首次启动自动把旧 `.orkas` 数据迁移到 `.cogseed`。
3. 旧数据迁移可重入、可验证、失败不损坏源数据。
4. 旧 `mateagent://`、`orkas://` 深链在兼容期继续工作。
5. renderer 全部改用 `window.cogseed`，`window.orkas` 仅作为一版代理。
6. IPC transport 前缀、启动变量、runtime variant、模块目录和入口文件全部改为 CogSeed。
7. 业务域通道（如 `recall.*`、`skills.*`、`contexts.*`）不因品牌迁移改名。
8. 下一版本能够通过删除集中兼容层完成旧身份清理，而无需再次迁移业务代码。

## 3. Canonical 身份

```text
产品名                  CogSeed
App ID                  com.cogseed.desktop
新 URL scheme           cogseed://
新数据根（macOS/Linux） ~/.cogseed
新 Windows 安装 pin     %LOCALAPPDATA%/CogSeed/install-pin.json
新 preload API          window.cogseed
新 IPC transport        cogseed.invoke / cogseed:* / cogseed.stream.*
新环境变量              COGSEED_*
新 runtime variant      cogseed
新 backend 目录         src/main/features/cogseed_backend/
新 runtime 目录         src/main/features/cogseed_runtime/
新 worker               bin/cogseed-runtime-worker.cjs
新 bridge               bin/cogseed-bridge.cjs
新 package CLI          bin/cogseed-pkg.cjs
新 source restart       scripts/restart-cogseed.sh
新 artifact marker      __cogseedArtifact
新 artifact helper      window.cogseedArtifact / CogSeedArtifactSecurity
新 artifact virtual     __cogseed/bridge.js / __cogseed-meta.json
新 local-agent MCP      clientInfo.name=cogseed / mcp_servers.cogseed
```

业务域 ID 和数据记录字段不因品牌变化改名，例如：

```text
recall.*
skills.*
contexts.*
conversation id
agent id
skill id
workspace id
```

## 4. 一版兼容身份

兼容期继续接受：

```text
com.mateagent.desktop（仅作为旧安装来源/迁移识别）
mateagent://
orkas://
~/.orkas
~/.orkas-dev
%LOCALAPPDATA%/Orkas/install-pin.json
window.orkas
orkas.invoke
orkas:bootI18n
ORKAS_*
variant=mate
bin/mate-runtime-worker.cjs
bin/orkas-bridge.cjs
bin/orkas-pkg.cjs
scripts/restart-mate.sh
__orkasArtifact / window.orkasArtifact / OrkasArtifactSecurity
__orkas/bridge.js / __orkas-meta.json
mcp_servers.orkas / clientInfo.name=orkas
.orkas-runtime.json / .orkas-whisper-ready.json / .orkas-import-*.tmp
```

兼容入口不得成为新代码的依赖：

- 新 renderer 模块只能调用 `window.cogseed`。
- 新 main/preload 代码只能发送 canonical `cogseed.*` transport。
- 新启动脚本只导出 `COGSEED_*`。
- 旧入口仅位于集中 compatibility 模块或薄 wrapper 文件。
- 静态测试对旧名称设置 allowlist；allowlist 外出现旧名称即失败。

## 5. 子项目拆分

该迁移作为一个发布目标和一个 MR，但按以下顺序形成独立绿色 checkpoint。

### 5.1 身份契约与静态边界

新增集中身份模块，统一定义：

- canonical App ID、协议、数据目录名、环境变量前缀；
- legacy aliases；
- compatibility window 版本；
- runtime variant 归一化；
- 旧名称 allowlist。

`src/resources/brand.json` 继续负责产品展示值。新增 `src/resources/identity.json` 作为可打包的身份数据源，新增 `src/main/identity-contract.cjs` 读取该 JSON 并导出纯 CJS 归一化函数；bootstrap 和 TypeScript main 都通过这一契约读取身份，禁止维护两套常量。

`package.json.main` 保持 `bootstrap.cjs`，不新增 bootstrap 之前的第二入口。精确启动顺序为：

```text
Electron loads bootstrap.cjs
→ require src/main/identity-contract.cjs
→ normalize legacy argv/env/runtime identifiers
→ require src/main/cogseed-install-migration.cjs
→ resolve + migrate canonical data root
→ set COGSEED_* canonical environment
→ register tsx/cjs and tsx/esm
→ require src/main/index.ts
```

`src/resources/identity.json` 必须加入 electron-builder files allowlist。`src/main/cogseed-install-migration.cjs` 在 tsx 注册前运行，不得导入 TypeScript、feature、model 或 renderer 模块。

### 5.2 数据根自动迁移

迁移必须在 `bootstrap.cjs` 注册 tsx、加载 feature 和解析用户路径之前运行。

#### 启动判定

1. 解析 canonical CogSeed container。
2. 如果 canonical container 已存在且含有效 migration marker，直接使用。
3. 如果 canonical container 不存在、legacy `.orkas` 存在，执行生产数据迁移。
4. packaged-dev/source-dev 同理把 `.orkas-dev` 迁移到 `.cogseed-dev`，使用独立 marker，禁止与生产 root 混用。
5. 如果新旧目录都不存在，创建新的 CogSeed container。
6. 如果 canonical 与对应 legacy 目录都存在但没有 marker，canonical 目录为 authoritative；不自动合并，写冲突诊断并提示人工处理，避免覆盖两个活跃数据集。

#### 迁移算法

为兑现“兼容期保留 legacy root、旧版本仍可读取原 `.orkas`”的回滚承诺，**同卷和跨卷均不得 rename 或移动 legacy root**。所有平台使用 copy/clone + verify + canonical rename：

```text
legacy root
→ acquire migration lock outside both roots
→ build file manifest (relative path, size, critical hashes)
→ create canonical sibling temporary directory
→ copy files; same-volume macOS/APFS may use clonefile/reflink optimization but must preserve source
→ verify file count, sizes and critical hashes
→ atomic rename canonical temporary directory to canonical root
→ write migration marker
→ retain legacy root unchanged as compatibility backup
```

Windows drive migration使用同一算法；只改变复制实现和 canonical temporary directory 的所在卷。迁移需要预估所需空间，空间不足时在复制前失败，不得留下半成品 canonical root。

#### Migration marker

Canonical root 内写：

```json
{
  "schema_version": 1,
  "migration": "legacy-orkas-to-cogseed",
  "source_kind": "orkas",
  "completed_at": "ISO-8601",
  "file_count": 0,
  "critical_manifest_hash": "sha256",
  "legacy_root_retained": true
}
```

marker 不包含用户名、token、路径原文或文件内容。

#### 失败策略

- 不删除 legacy root。
- 不在半迁移的 canonical root 上启动业务层。
- 清理未完成的临时目录或在下一次启动继续验证。
- 启动失败返回可操作错误，日志只记录阶段、计数、哈希和粗粒度错误码。
- 不在失败后继续向 `.orkas` 写数据，避免形成双写分叉。

### 5.3 App ID 与协议

- packaged App ID 改为 `com.cogseed.desktop`。
- source variant 使用 `com.cogseed.desktop.source.<variant>`。
- canonical protocol owner 注册 `cogseed`。
- 同一 CogSeed app 在兼容期同时注册 `mateagent` 和 `orkas`。
- 所有 URL 进入同一个 deep-link normalizer，先把 legacy scheme 映射为 `cogseed` 再解析业务 path。
- renderer、Server callback 和 connector start URL 新生成值只使用 `cogseed://`。
- 旧回调 URL 仍能被新应用消费，但不会再次生成。

App ID 变化会使系统把 CogSeed 视作新身份，可能需要用户重新授予通知、摄像头或麦克风权限。应用应在首次新身份启动时检测权限状态并使用现有 UX 提示，而不是尝试绕过系统权限。

### 5.4 Preload 与 IPC transport

Canonical surface：

```js
window.cogseed.invoke(channel, payload)
window.cogseed.stream(channel, payload, onEvent)
window.cogseed.ping()
window.cogseed.diagnostics()
```

Preload 只实现一份 frozen API：

```text
contextBridge.exposeInMainWorld('cogseed', canonicalApi)
contextBridge.exposeInMainWorld('orkas', legacyProxy)
```

`legacyProxy`：

- 转发到 canonical implementation；
- 开发模式下记录一次 deprecated warning；
- 不新增旧 API；
- 与 canonical API 返回相同结构。

IPC transport：

```text
cogseed.invoke
cogseed:bootI18n
cogseed.stream:start
autogenerated cogseed stream event/cancel channels
```

Main 在兼容期注册旧 transport alias，alias 立即调用 canonical handler。业务 channel 字符串保持不变。

同步 i18n boot global 改为 `window.__cogseedI18nBoot`，同时提供 `window.__orkasI18nBoot` 兼容值。


### 5.5 Artifact iframe 隔离协议

Artifact iframe 不暴露 `window.cogseed`、`window.orkas` 或任意 IPC；它继续只通过经过验证的 `postMessage` 通道与宿主通信。Canonical artifact 协议改为：

```text
postMessage sentinel     __cogseedArtifact: true
iframe helper global     window.cogseedArtifact
host security global     CogSeedArtifactSecurity
virtual bridge path      __cogseed/bridge.js
metadata file            __cogseed-meta.json
```

兼容期必须继续支持已保存 artifact 中的旧协议：

```text
__orkasArtifact
window.orkasArtifact
OrkasArtifactSecurity
__orkas/bridge.js
__orkas-meta.json
```

具体规则：

- 新 artifact 只生成 canonical bridge path、sentinel、global 和 metadata 文件。
- `chat-app://` handler 在兼容期同时服务 `__cogseed/bridge.js` 与 `__orkas/bridge.js`，两者使用同一个实现。
- artifact resolver 优先读取 `__cogseed-meta.json`，缺失时读取 `__orkas-meta.json`；不得同时写两份 metadata。
- host message validator 接受新旧 sentinel，但两者必须经过完全相同的 `event.source === frame.contentWindow`、frame lookup、message type 和 payload validation。
- `CogSeedArtifactSecurity` 是 canonical global；`OrkasArtifactSecurity` 仅代理同一个 frozen API。
- `window.cogseedArtifact` 是 canonical iframe helper；`window.orkasArtifact` 仅为旧 artifact bridge 保留。
- reserved-path security 同时保护 `__cogseed/`、`__cogseed-meta.json`、`__orkas/` 和 `__orkas-meta.json`，防止 artifact 文件覆盖宿主注入协议。
- `AGENTS.md` / `CLAUDE.md` 的 artifact 安全约束同步改为“iframe 不暴露 `window.cogseed` 或 legacy `window.orkas`”。

### 5.6 环境变量和 runtime variant

Canonical 环境变量使用 `COGSEED_*`。启动入口执行一次归一化：

1. 新变量存在时使用新变量。
2. 新变量不存在、旧变量存在时复制到对应新变量并记录 deprecated 使用计数。
3. 新旧变量同时存在且值不同，启动失败，避免使用不明确的数据根或 runtime。
4. 归一化完成后，内部模块只读取 `COGSEED_*`。
5. 启动子进程时只传新变量，除非目标是旧 wrapper。

`mate` runtime variant 在兼容期归一化为 `cogseed`。新 source run、日志和 bundle identity 只生成 `cogseed`。

其他独立变体（`main`、`cognition`、`expense`、`messaging`、`optimization`）不在本轮改名；它们的 App ID 前缀切换到 `com.cogseed.desktop.source.*`。


### 5.7 Local-agent MCP 客户端与 bridge 身份

Local CLI agents 对外暴露的 MCP 身份必须成为 CogSeed canonical，而不仅是文件名改造：

```text
Codex app-server clientInfo.name   cogseed
Codex app-server clientInfo.title  CogSeed
MCP serverInfo.name                cogseed
Codex config key                   mcp_servers.cogseed
Claude MCP config server key       cogseed
Developer/system prompt            runs inside CogSeed
Bridge environment                 COGSEED_BRIDGE_* / COGSEED_PC_DIR
Bridge config/env filenames        cogseed-mcp-config.json / cogseed-bridge-env.json
```

兼容规则：

- 新 run 只生成 `mcp_servers.cogseed` 和 CogSeed prompt。
- 旧 `orkas-bridge.cjs` wrapper 和 `ORKAS_BRIDGE_*` 在兼容期归一化到 canonical bridge。
- 已保存的旧运行证据或测试 fixture 可以包含 `mcp_servers.orkas`，但 production builder、runner 和 prompt 不得继续生成旧名称。
- bridge server 的工具业务名称不因产品品牌迁移改变；只改 client/server identity、配置 key、环境变量和提示文本。
- 覆盖 Codex、Claude Code 及所有共享 `BridgeRunConfig` 消费方，不能只修 `codex.ts` 的 initialize payload。

### 5.8 Runtime / Backend 模块与入口文件

进行真实路径重命名：

```text
src/main/features/mate_agent_runtime/
→ src/main/features/cogseed_runtime/

src/main/features/mate_agent_backend/
→ src/main/features/cogseed_backend/

test/main/features/mate_agent_runtime/
→ test/main/features/cogseed_runtime/

test/main/features/mate_agent_backend/
→ test/main/features/cogseed_backend/
```

同时更新：

- import specifier；
- logger module name；
- session kind / record kind 中仅用于产品命名的值；
- prompt 中的 Runtime worker 名称；
- packaged file allowlist；
- native/runtime gate；
- worker spawn choke point；
- test fixture path。

旧入口文件保留一版 wrapper：

```text
mate-runtime-worker.cjs → require/exec cogseed-runtime-worker.cjs
orkas-bridge.cjs        → require/exec cogseed-bridge.cjs
orkas-pkg.cjs           → require/exec cogseed-pkg.cjs
restart-mate.sh          → exec restart-cogseed.sh
```

wrapper 只允许转发，不含业务逻辑。

### 5.9 NPM、构建和资源命名

- root package name 改为 canonical CogSeed npm/internal name；若外部发布依赖旧 package name，则保留 deprecated forwarding package。
- electron-builder、DMG、ZIP、NSIS、AppImage、macOS executable 和 Windows product metadata 使用 CogSeed。
- build-info、packaged resource gate、native gate 和 entrypoint gate 使用 canonical 文件名。
- 旧 entrypoint wrapper 仍进入本版包，以支持外部脚本过渡。
- 新文档、命令和 smoke test 只展示 CogSeed 名称。


### 5.10 安全规则、运行时 marker 与项目约束

品牌身份被安全规则、临时文件和运行时 marker 消费时，必须作为安全迁移的一部分，不能依赖普通字符串替换：

- `src/main/quality/rules/skill-runner.ts`
  - marketplace protected-path 正则 canonical 匹配 `.cogseed/data/.../local/marketplace/.../scripts/`；
  - 兼容期同时识别 `.orkas/...`，防止旧路径绕过 runner 规则；
  - `SKILL_DIR`、`NODE`、`PYTHON`、`PC_DIR` 示例改为 `COGSEED_*`，旧变量只在兼容 matcher 中出现；
  - 新增 canonical 和 legacy 正/反例 fixture。
- `src/main/util/file-import.ts`
  - 新临时文件前缀为 `.cogseed-import-*`；
  - 清理/恢复逻辑兼容遗留 `.orkas-import-*`。
- bundled runtime / fetch / gate
  - canonical marker 为 `.cogseed-runtime.json` 和 `.cogseed-whisper-ready.json`；
  - 兼容期读取旧 marker，新写入只产生 canonical marker；
  - codesign/runtime gate 测试同时覆盖新 marker 和旧 marker 读取。
- smoke/package scripts
  - canonical 使用 `smoke-cogseed-*`、`cogseed-*`；
  - 旧 `smoke-mate-*` 只允许作为 wrapper 或 legacy fixture。
- `AGENTS.md` 与 `CLAUDE.md`
  - renderer hard constraint 改为 `window.cogseed.{invoke, stream}`；
  - 明确 `window.orkas` 只是一版兼容 alias，新代码禁止使用；
  - Runtime worker choke point 改为 `features/cogseed_runtime/worker-process.ts`；
  - restart/log/data-root 示例改为 CogSeed canonical 路径，并注明旧路径只用于迁移测试。

## 6. 读写与兼容矩阵

| Surface | 新代码读取 | 新代码写入 | 旧入口兼容 |
|---|---|---|---|
| 数据根 | `.cogseed` | `.cogseed` | `.orkas` 仅迁移/备份读取 |
| App protocol | `cogseed://` | `cogseed://` | `mateagent://`、`orkas://` 转发 |
| Renderer API | `window.cogseed` | `window.cogseed` | `window.orkas` 代理 |
| IPC transport | `cogseed.*` | `cogseed.*` | `orkas.*` alias |
| Env | `COGSEED_*` | `COGSEED_*` | `ORKAS_*` 启动归一化 |
| Runtime variant | `cogseed` | `cogseed` | `mate` 归一化 |
| Worker entry | `cogseed-*` | `cogseed-*` | 旧文件 wrapper |

不允许双写旧数据根或同时生成新旧协议 URL。

## 7. 兼容期结束条件

本轮实现同时写入静态清理清单。下一版本只有满足以下条件才删除兼容层：

1. migration marker 数量和失败率已观察一个发布周期；
2. 旧 scheme 使用率已降到可接受阈值；
3. `window.orkas` deprecated 使用计数无关键调用；
4. 外部脚本已迁移到 CogSeed entrypoint；
5. 旧 `.orkas` 保留策略和用户恢复文档已发布。

兼容删除必须是单独 MR，不与功能开发混合。

## 8. 测试策略

### 8.1 Migration fixtures

覆盖：

- 新安装，无 legacy root；
- legacy-only 同卷迁移；
- legacy-only 跨卷复制迁移；
- canonical 已迁移；
- canonical 与 legacy 冲突；
- 迁移中断后重入；
- manifest/hash 不匹配；
- token/secret 文件按字节保留；
- Windows pin 文件迁移；
- 用户目录权限不足。

### 8.2 Identity and protocol

覆盖：

- packaged/source App ID；
- canonical scheme 生成；
- legacy scheme 消费；
- single-instance/deep-link second-instance 路由；
- callback URL 与 connector OAuth；
- notification App ID。

### 8.3 Bridge and IPC

覆盖：

- renderer 只依赖 `window.cogseed`；
- legacy `window.orkas` 等价转发；
- canonical/legacy invoke、stream、cancel、push、sync boot；
- allowlist 和 security boundary 不扩大；
- artifact iframe 仍不暴露 bridge；
- canonical `__cogseedArtifact` / `window.cogseedArtifact` / `CogSeedArtifactSecurity`；
- legacy `__orkasArtifact` / `window.orkasArtifact` / `OrkasArtifactSecurity` 等价转发且不扩大 frame/source/payload 安全边界；
- 新旧 bridge virtual path 和 metadata fallback；
- local-agent `clientInfo`、MCP serverInfo、`mcp_servers.cogseed`、CogSeed prompt 和旧 bridge wrapper。

### 8.4 Runtime and packaging

覆盖：

- `cogseed` variant 和 `mate` alias；
- worker spawn 只通过 canonical choke point；
- wrapper 无业务逻辑；
- packaged resource gate 包含新入口和旧 wrapper；
- macOS、Windows launcher；
- source runtime bundle；
- `source-runtime-bundle.test.ts` 的 `com.cogseed.desktop.source.*`、canonical/legacy scheme；
- `package-dev-mac.test.ts` 的 `com.cogseed.desktop.dev` 和 CogSeed Dev bundle；
- `skill-runner` protected-path 正则、file-import temp prefix、runtime/whisper marker；
- `AGENTS.md` / `CLAUDE.md` canonical constraints；
- 完整 `npm test`。

### 8.5 Static residual gates

建立 allowlist scan，至少覆盖：

- `window.orkas`、`window.__orkasI18nBoot`
- `__orkasArtifact`、`window.orkasArtifact`、`OrkasArtifactSecurity`、`__orkas/`、`__orkas-meta.json`
- `orkas.invoke`、`orkas:`、`orkas://`、`Orkas` 大写产品名
- `mcp_servers.orkas`、`clientInfo.name=orkas`、`runs inside Orkas`
- `ORKAS_`
- `.orkas`、`.orkas-dev`、`.orkas-import-*`、`.orkas-runtime.json`、`.orkas-whisper-ready.json`
- `mate_agent`、`mate-agent`、`smoke-mate-`
- `com.mateagent.desktop`

只有集中 compatibility、migration、legacy wrapper、legacy fixture、迁移说明和明确的历史文档允许出现。allowlist 按文件和具体 token 管理，不允许整个目录无条件豁免。

## 9. 发布与回滚

### 发布

1. 先发布 migration-capable CogSeed build。
2. 首次启动在业务模块加载前完成迁移。
3. UI 显示迁移进度，长时间复制不能无反馈。
4. 迁移成功后正常进入应用。
5. 兼容 alias 使用只记录匿名计数和类型，不记录 URL payload、路径或内容。

### 回滚

- 所有平台迁移均采用 copy/clone-preserving-source；legacy root 在本兼容版本内原路径保留，不自动删除。
- migration marker 记录是否保留 legacy root。
- 回滚到旧版本时，旧版本仍可读取原 `.orkas`。
- 新版本期间产生的新数据只在 `.cogseed`，回滚旧版本不会自动反向同步；回滚前需要明确提示可能看到旧快照。
- 不设计双向持续同步，避免数据分叉和覆盖。

## 10. 主要风险

1. **App ID 改变导致系统权限重置**：使用现有权限 UX 明确引导。
2. **跨卷迁移中断**：临时目录 + manifest 验证 + marker 重入。
3. **新旧数据根同时存在**：不自动合并，避免静默覆盖。
4. **bridge 全量替换遗漏**：静态 residual gate + renderer 全量测试。
5. **旧脚本依赖**：一版薄 wrapper，下一版单独删除。
6. **包体同时含新旧入口**：resource gate 明确区分 canonical entrypoint 和 compatibility wrapper。
7. **大范围 rename 造成不可审查 diff**：分 checkpoint 提交，每阶段保持测试绿色。
8. **artifact iframe 协议静默失效或边界扩大**：新旧 sentinel/path/global 使用同一 validator 和 reserved-path policy。
9. **安全正则只匹配旧根或新根**：canonical + legacy 双 fixture，兼容期结束时单独删除 legacy matcher。
10. **local-agent 对外仍宣称 Orkas**：对 clientInfo、serverInfo、MCP config key 和 prompt 建静态/协议测试。

## 11. 验收标准

- 新安装仅创建 `.cogseed`。
- 旧安装首次启动自动迁移 `.orkas`，不丢失用户数据和 secret 文件。
- 新代码只写 `.cogseed`。
- `cogseed://`、`window.cogseed`、`cogseed.*` IPC、`COGSEED_*` 和 `cogseed` runtime 全部成为 canonical。
- 旧协议、bridge、env、variant 和入口在兼容期可用并产生 deprecated 信号。
- `com.cogseed.desktop` 用于 packaged identity。
- Runtime/Backend 真实目录和 imports 已改为 `cogseed_*`。
- artifact 新协议完整使用 `__cogseedArtifact`、`window.cogseedArtifact`、`CogSeedArtifactSecurity`、`__cogseed/bridge.js` 和 `__cogseed-meta.json`，旧 artifact 在兼容期继续工作。
- local-agent MCP client/server identity、config key、bridge env 和 prompt 全部使用 CogSeed canonical。
- marketplace protected-path 安全规则同时拦截 `.cogseed` 和 legacy `.orkas` 安装脚本直调。
- `.orkas-dev`、旧 runtime marker 和 import temp 文件均有迁移/兼容测试。
- `AGENTS.md` 与 `CLAUDE.md` 已更新为 CogSeed canonical 开发约束。
- allowlist 外不存在旧身份引用。
- `npm run typecheck`、focused migration/identity tests、`npm test` 全部通过。
- macOS 和 Windows 启动/数据迁移路径均有平台专项验证。
