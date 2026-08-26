# RC-T01 — 最小 Renderer 交互测试脚手架（执行记录）

> 执行日期：2026-08-26
> 分支：`feat/run-center-v1-hardening`
> spec: §8 ／ todo: Phase 0.5

## 1. 交付物

| 文件 | 说明 |
|---|---|
| `test/renderer/_run-center-harness.ts` | 脚手架（新建）。`_` 前缀使其不被 `include: ['test/**/*.test.ts']` 当作测试文件 |
| `test/renderer/run-center-harness.test.ts` | 5 条冒烟 + 3 条基线见证（新建） |
| `package.json` | 新增 `jsdom`（`^30.0.1`）与 `@types/jsdom` devDependency |
| `package-lock.json` | +37 个包（jsdom）+ `@types/jsdom`，**0 移除 / 0 版本变更** |
| `sbom.cdx.json` | 重新生成：624 → **658** components |

`vitest.config.ts` **未改动** —— 全局 `environment` 仍为默认 node（见 §3）。

## 2. 与 spec §8 的一处设计偏离（必读）

**spec §8 要求**：用 `// @vitest-environment jsdom` docblock 局部启用 jsdom environment。

**实测不可行。** `vitest.config.ts` 的 `setupFiles: ['./test/setup-env.ts']` 中有 `import 'tsx/cjs'`，它会加载 esbuild；esbuild 在 load 时断言：

```
new TextEncoder().encode("") instanceof Uint8Array
```

在 jsdom environment 下，`TextEncoder` 来自 jsdom realm，产出的 `Uint8Array` 与 Node realm 的不同构，该断言为 false，esbuild 直接抛：

```
Error: Invariant violation: "new TextEncoder().encode("") instanceof Uint8Array" is incorrectly false
 ❯ node_modules/esbuild/lib/main.js:201:9
 ❯ node_modules/tsx/dist/index-gckBtVBf.cjs:1:125
```

**该文件一个用例都收集不到就死了。**

**可选修法与取舍**

| 方案 | 代价 |
|---|---|
| 在 `setup-env.ts` 里把 `TextEncoder`/`TextDecoder` 换回 Node 版（需新建一个先于 `tsx/cjs` 求值的模块） | 改动**全局 setup**，改变其余 ~900 个测试的 load-time 条件 |
| **（采纳）** 把 jsdom 当**库**用：harness 内部 `new JSDOM(...)`，测试文件跑在默认 node environment | 不碰任何全局配置；每个测试一个独立 window（真隔离）；与 `test/renderer/` 现有做法同构（57 个文件用 `vm.runInContext` 手搓 window，这只是把手搓换成真 DOM） |

**结论**：采纳第二种。`jsdom` devDependency 仍然需要（作为库依赖），但 **`vitest.config.ts` 与全局 environment 一行未改**，spec §8「不改全局默认」的意图完整保留，只是实现手段不同。

> ⚠️ **一个易踩的坑**：Vitest 4 的 environment pragma 检测是
> `content.match(/@(?:vitest|jest)-environment\s+([\w-]+)\b/)`（`node_modules/vitest/dist/chunks/cli-api.*.js:100`），
> 匹配的是**整个文件内容，包括注释与散文**。在注释里提一句该 pragma 的字面名字，就会把整个 suite 切回坏掉的 environment。
> 测试文件里已留警告注释。

## 3. 三条硬约束的落实

| 约束 | 落实方式 |
|---|---|
| **`window.cogseed` 是 contextBridge 冻结对象** | harness 用 `Object.defineProperty(win,'cogseed',{writable:false,configurable:false})` + `Object.freeze(bridge)` 安装，**在 eval 任何模块源码之前**。并非只是「注入得早」——有一条用例断言重新赋值会抛 `TypeError`，即测试里和生产里一样改不动 |
| **jsdom 不做 layout** | 原命题「completed 列实际可见」不可测（`getBoundingClientRect()` 恒为 0），已按 spec §8 改写为**结构断言**：4 个 column 节点存在 + 各列卡片成员精确匹配。真实可见性留给 `RC-T05` 的 Electron/CDP 冒烟 |
| **不得破坏 renderer-safe 隐私边界** | harness 只消费 `ipc-service.ts` 已导出的 renderer projection 接口形状；fixture 不含 prompt / objective / step result / 会话正文 |

## 4. 测试结果

```
✓ RC-T01 Run Center harness > injects a frozen window.cogseed before run-center.js loads
✓ RC-T01 Run Center harness > drives the full refresh IPC chain and reaches cogseed.session.read
✓ RC-T01 Run Center harness > renders the selected task id into the detail pane
✓ RC-T01 Run Center harness > moves a card between columns when the backing projection flips
✓ RC-T01 Run Center harness > renders all four board columns with the expected card membership
✓ RC-T01 Run Center harness > reaches the Open Task button and routes through setView …
✓ RC-T01 baseline witnesses > RC-P0-01: Refresh does NOT re-read the detail once a task is selected
✓ RC-T01 baseline witnesses > RC-P0-07: no Open Task button on the healthy path …
✓ RC-T01 baseline witnesses > RC-P2-10: resume is never offered for a group-chat task

Test Files  1 passed (1)      Tests  9 passed (9)
Duration    756ms (environment 0ms  ← 确认跑在 node environment)
```

### 4.1 spec §8 五条冒烟的对应关系

| # | spec §8 原文 | 本轮实现 | 状态 |
|---|---|---|---|
| 1 | 点 Refresh → `cogseed.session.read` 被调用 | 改为断言**首次 refresh 全链路**（`task.list` + `session.list` + `session.read`），并断言 detail 拉取被限定到自动选中的首个 board task | ✅ 见下方说明 |
| 2 | 选中 Task → detail 渲染 taskId | 点击 `task-attention` 卡片 → 断言最后一次 `session.read` 的 payload、以及 detail 区 `dd` 含 taskId 与 `errorCode` | ✅ |
| 3 | mock 状态翻转 → 卡片换列 | 翻转 `cogseed.task.list` 的 column → 点 Refresh → 断言卡片的 `closest([data-dashboard-board-column])` 从 `running` 变 `completed` | ✅ |
| 4 | 4 个 column 节点存在且 completed 含预期卡片数 | 断言 column 顺序 `[pending,running,attention,completed]` + 各列卡片 id 精确相等 + archived 不在列内但折叠区存在 | ✅ |
| 5 | `[data-run-center-open]` 可达 | 当 projection 带 `conversationId` 时按钮存在、值正确、点击后 `setView('conversation', cid)` 被调用 | ✅ 见下方说明 |

**关于第 1 与第 5 条的措辞调整（重要，不是降低标准）**

这两条**按字面写今天必然失败**，因为它们正踩在 Phase 1 / Phase 3 要修的缺陷上：

- 第 1 条字面义「点 Refresh 按钮 → `session.read` 被调用」：在**已有选中项**时今天**不会**被调用（`run-center.js:186` 守卫），这正是 `RC-P0-01`；
- 第 5 条字面义「按钮可达」：在**正常加载路径**下今天**不存在**（`taskSummary()` 不返回 `conversationId`），这正是 `RC-P0-07`。

因此把「能力」与「当前缺陷」拆成两组：
- **冒烟组**验证 harness **有能力**观测这些行为（给定正确数据即可观测到）；
- **基线见证组**（`baseline witnesses`）钉死**今天的错误行为**，每条标题写明将由哪个 ticket 反转。

> **这三条见证是负向断言，Phase 1 / Phase 3 落地时必须被反转。**
> 反转本身就是修复生效的证据：
> - `RC-P0-01` → `callsTo('cogseed.session.read')` 从 1 变 2
> - `RC-P0-07` → 正常路径下 `[data-run-center-open]` 从 null 变存在
> - `RC-P2-10` → 保持不变（这条是**不变量**，不是缺陷，永远不该反转）

## 5. 反「字符串匹配」硬性要求

- 新增两个文件对渲染器源码**零 `readFileSync` + `toContain` 主断言**；
- 每条用例至少断言一项运行时产物：被调用的 IPC channel / payload、DOM 节点与属性、spy 调用参数、属性描述符。

> 说明：`_run-center-harness.ts` 里确实 `readFileSync` 了 `run-center.js` 与 `run-center-board.js`——那是**加载被测模块**（等价于 `import`），不是拿源码做断言。原有 `test/renderer/run-center.test.ts` 的 4 个用例未改动，其中 3 个仍是字符串匹配，按 spec 属 `RC-T02` 的清理范围。

## 6. 门禁

| 检查 | 结果 |
|---|---|
| `npm run reuse:check` | ✅ `OK: 3433 tracked files covered by .reuse/dep5` |
| `npx eslint`（两个新文件） | ✅ exit 0，零告警 |
| `npm run sbom:check` | ✅ `OK: 658 components in sync (CycloneDX 1.6)` |
| `npx tsc --strict`（两个新文件） | ✅ 零错误（加 `@types/jsdom` 后；未加时 `JSDOM` 静默退化为 `any`，报 TS7016） |
| `THIRD_PARTY_NOTICES.md` / `third_party_licenses/` | **无需改动**，见 §7 |

## 7. License / SBOM 归档 —— 实际成本与 spec §5-E 的预期不同

spec §5-E 预计「新增 jsdom devDependency 会触发 `sbom:check` / `reuse:check` / `THIRD_PARTY_NOTICES.md` / `third_party_licenses/` 归档流程」。实测**一半为真**：

- **`THIRD_PARTY_NOTICES.md` / `third_party_licenses/` 不需要改。** 该文件 §1 标题即为 *Production npm dependencies*，且 §6 只保留「随发行分发或内联」的包的 license 正文。实测现有 devDependencies（`vitest` / `electron` / `typescript` / `eslint`）在该文件中**均零命中**。jsdom 是仅测试期、不随产品分发的 devDependency，按同一政策不入册。
- **`sbom.cdx.json` 需要重新生成。** 实测该 BOM **包含 devDependencies**（`vitest` / `electron` / `typescript` / `eslint` 均为 components），因此新增 jsdom 后必须 `npm run sbom:generate` 并提交，否则 `npm run sbom:check` 的语义比对会失败。**已执行**：624 → 658 components，`sbom:check` 通过。（注：`@types/jsdom` 未出现在 BOM 中，是 CycloneDX 生成器自身的取舍，不影响比对一致性。）

### 7.1 顺带发现：`THIRD_PARTY_NOTICES.md` 已有三处过期（**非本轮引入，未改动**）

对 `package-lock.json` 逐项比对生产依赖：

| 包 | NOTICES 记载 | lock 实际 |
|---|---|---|
| `@larksuiteoapi/node-sdk` | 1.72.0 | 1.73.0 |
| `electron-log` | 5.4.3 | 5.4.4（#71 bump） |
| `mammoth` | 1.12.0 | 1.12.1 |

其中 `mammoth` 影响最大：该文件 §6 声明其 license 正文保留在 `third_party_licenses/mammoth/LICENSE`，§9 又规定「升级依赖时必须同步刷新保留文件与版本条目」——这三次 bump 都没做。

**本轮未处置**（超出 RC-T01 范围，且属发行合规文档），仅记录待定。

## 8. RC-T01 verify 勾选（对照 todo）

- [x] harness 能**在加载 `run-center.js` 之前**注入 mock `window.cogseed`，且以生产同款描述符安装（另有用例断言不可覆盖）
- [x] 5 条冒烟通过（第 1、5 条的措辞调整见 §4.1）
- [x] 新测试**零 source-string 主断言**
- [x] `npm run reuse:check` 通过
- [x] `npm run sbom:check` 通过 —— `npm run sbom:generate` 后 **658 components in sync**
- [x] `THIRD_PARTY_NOTICES.md` / `third_party_licenses/` —— 经核查**本项不适用**（§7）

## 9. 环境事故记录（本轮引入，**已全部修复**）

安装 jsdom 期间连续两次踩坑，记录以免他人重演：

1. 首次 `npm install --save-dev jsdom` 在 **electron postinstall** 阶段因网络 `TypeError: terminated` 失败，`package.json` / `package-lock.json` 被 npm 回滚（未写入）。
2. 为绕开该 110MB 下载，改用 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 重跑——jsdom 成功写入，但该次 reify **重新解包了 `electron` 包**，删掉了 `node_modules/electron/path.txt` 与 `dist/`，而跳过的 postinstall 正是重建这两者的步骤。结果 `require('electron')` 抛 `Electron failed to install correctly`，经 `electron-log` 传导，令 3 个基线测试文件加载失败。

**修复**：重跑 electron postinstall（`npm rebuild electron`，带重试）重新下载并解包。

3. 修复时官方源下载 ~0.6 MB/min（110MB 约需 3 小时），经确认后改用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，**数秒完成**。`install.js` 自带 SHASUMS256 校验，镜像产物完整性可验。
   - 附带差异：`path.txt` 恢复为 `Electron.app/...`，而原先是 `CogSeed.app/...`。该重命名由 `scripts/prepare-source-runtime.cjs` 完成，经 `prestart` 触发，**下次 `npm start` 会自动重建**，无需手工处理。

**教训**：本仓库根 `package.json` 有 `postinstall`（`ensure-sqlite-electron-abi` → `ensure-node-pty-electron-abi` → `fetch-embedding-model`）。任何 `npm install` 中断或跳过安装脚本，都可能让原生模块与 electron 分发处于半损状态；**改完依赖必须重跑完整基线，不能只跑新增测试**。


## 10. 全量测试基线（首次建立）—— 24 项失败均为**既存问题**，与本轮无关

`RC-T00` 只跑了 spec 指定的 10 个文件。本轮首次跑全量（`npm run test:js`）：

```
Test Files  7 failed | 840 passed | 9 skipped (856)
     Tests  24 failed | 9352 passed | 105 skipped (9481)
```

### 10.1 归因：`@napi-rs/canvas` 原生二进制被截断

24 项失败全部是 PDF / DOCX 抽取，集中在 7 个文件：
`auto_tasks` / `chat_attachments` / `file_indexer` / `personal_context-forget` / `session_import` / `core-agent/file-tools` / `util/extract-pdf`。

根因一条链：

```
pdfjs-dist@6.2.108 → @napi-rs/canvas@1.0.7 → @napi-rs/canvas-darwin-arm64@1.0.7
```

```
dlopen(.../@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node, 0x0001):
  segment '__TEXT' load command content extends beyond end of file
```

即那个 19,799,664 字节的 `.node` 是**下载不全的 Mach-O**。`@napi-rs/canvas` 捕获后抛出 npm optional-dependency 的通用提示（npm/cli#4828），实际是文件损坏而非依赖缺失。

### 10.2 为什么可以确定不是本轮引入

`node_modules/@napi-rs/` 下**每一个文件**的 mtime 都是 **8月18**（部分残留隐藏目录为 8月5），**无一为 8月26**（本轮工作日）。本轮两次 `npm install` 与一次 `npm rebuild electron` 均未触及该包。

> 该损坏自 **2026-08-18** 起就存在，只是此前没人跑过全量。

### 10.3 处置建议（未执行，待定）

重装该平台包即可，`package.json` / `package-lock.json` **无需改动**（lock 已正确记录 1.0.7）：

```
npm install --force @napi-rs/canvas-darwin-arm64
# 或：rm -rf node_modules/@napi-rs && npm install
```

**本轮未执行**——超出 RC-T01 范围，且属本机环境修复而非仓库改动。但**建议尽快修**：在它修好之前，全量套件无法作为「绿」基线使用，Phase 6（`RC-T06` 覆盖率守门）也会受影响。

### 10.4 本轮相关范围的基线（真实可用）

Run Center 相关 11 个文件（10 个 spec 指定 + 新增 harness）：

```
Test Files  11 passed (11)
     Tests  275 passed | 7 skipped (282)
```

即 `RC-T00` 的 266 + 本轮新增 9，**零回归**。
