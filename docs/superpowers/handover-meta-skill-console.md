# 交接文档 · Meta-Skill 六页进化控制台

> Archived from active worktree on 2026-08-10. The full implementation is preserved on branch `dev/archive-meta-skill-evolution-console` at `/Users/sudai/.config/codex/worktrees/Mate Agent/meta-skill-evolution-preserve`. The active worktree no longer carries the bundled Meta Skill Engine or standalone Evolution Console.

> 日期：2026-07-28 · 分支：`integration/abc-meta-skill-engine`（领先 main 43 个提交）
> 状态：全部完成并通过验证，**待用户本人合并 main**（未 push / 未 merge）。

## 一、做了什么

以 Python+React 原型「meta-skill-4版」为蓝本，用本仓库技术栈重建一个**功能对齐**的
Meta-Skill 进化控制台，替换原技能库演化能力。技术栈换写（原型的 FastAPI + SQL + React/Vite
违反仓库硬约束），非原样搬运。

**交付范围：**

- 六页进化控制台：总览 / 技能（选择器）/ 进化 / 本体 / 评估 / 补丁
- KSTAR 7 步引擎：Capture→Attribution→Propose→Evaluate→Govern→Apply→Evolve
- 对齐原型补齐 5 块：本体绑定、版本历史、导出 zip、创建向导、进化推荐
- 评估标准（人写分类断言 + 正负用例 + 就绪门槛）
- 观感对齐原型（浅色卡片 / 标签页 / 胶囊 badge，纯 vanilla CSS）
- 技能页改为「技能选择器」，与技能库去重（浏览/新建/编辑归技能库）
- 彻底移除「我的应用」（My Apps）功能（方案 B）

## 二、架构（四层，均遵守 CLAUDE.md 硬约束）

| 层 | 位置 | 说明 |
|---|---|---|
| 渲染层 | `src/renderer/modules/evolution/{pages,console}.js` | classic script，无打包器/框架；入口全屏视图 `panel-evolution` |
| IPC 层 | `src/main/ipc/index.ts` 的 `evolution.*` 通道 | 薄校验转发 |
| Feature 层 | `src/main/features/evolution/`（详见该目录 README） | 编排 + core-agent 接线 + 数据读写 |
| 引擎层 | `packages/nseap-meta-skill-engine`（ESM，进程内动态 import） | KSTAR 引擎、本体、评估、补丁 |

**模块级细节见** `src/main/features/evolution/README.md`。

## 三、关键技术决策（回溯用）

1. **引擎进程内加载**：主仓库 CJS、引擎 ESM，且 p3394 把引擎当 MCP 子进程（无法注入 JS 回调）。
   故新建纯库入口 `packages/.../src/engine.ts`（只 re-export，不启动服务器），
   `engine-loader.ts` 动态 import `dist/engine.js`。**不是 `dist/index.js`**（那个末尾会启动 stdio 服务器）。
2. **LLM 接入**：`llm-bridge.ts` 把 core-agent 的 `buildRunner`+`runReflection` 包成引擎的 `LlmComplete`；
   模型/profile 由 buildRunner 内部解析 = 跟 CogSeed agent 同步；空返回/抛错降级并标 `degraded`，不产假结果。
3. **跨 ESM/CJS 边界**：只共享结构、不共享类型 import（`EvolutionRun`/`EvalRecord` 等在 PC 侧本地同构声明）。
4. **数据落点**：派生机器态 → `<uid>/local/kstar/{evolution,evals,versions,exports}`；
   用户资产（SKILL.md、本体源、绑定）→ `<uid>/cloud/skills/<id>/`。
5. **评估标准存储**：等价原型 SQL evals 表两列，落同一 `local/kstar/evals/<id>.json` 的 `standard` 键，与 cases/runs 共存。
6. **My Apps 移除**：删渲染入口 + save-as-app + 后端 saved_apps + IPC 通道 + `chat-app://saved` 分支；
   **保留** artifact 功能本身（`chat-app://cid` 分支）和回收站 `saved_app` 分类（识别历史回收数据）。

## 四、验证证据（最新一次全量）

- 引擎：`cd packages/nseap-meta-skill-engine && npx vitest run` → 64 通过
- 主仓库全量：`node scripts/run-tests.mjs run` → **414 文件 / 5287 通过 / 9 跳过 / 0 失败**
- 类型检查：`npx tsc --noEmit` → 0 错误
- p3394 契约守护测试通过（现有通道未回归）

## 五、待办 / 注意

- **合并 main**：由用户本人操作，本工作全程未 push / 未 merge。
- **任务 26 手动验证**（需运行环境，未自动化）：`npm run engine:build` 后 `./run.sh`，
  逐页操作、断网看降级提示。**改渲染层后重启前须清 Electron 缓存**
  （`rm -rf "$HOME/Library/Application Support/Mate Agent"/{Code Cache,GPUCache,DawnWebGPUCache,DawnGraphiteCache}`），
  否则加载旧脚本/样式。应用容器根 `$HOME/.cogseed/data/`，日志 `$HOME/.cogseed/data/logs/<date>.log`。
- 原型只读解包（如需对照）：`/tmp/meta-skill-proto-inspect/meta-skill-4版/`。

## 六、未做（有意排除）

- 原型的 `BackendAdmin` 页（SQL/路由调试页，对 Electron/JSON 架构不成立）。
- 原型的 `registry` 独立视图（已被技能列表覆盖）。
- 非像素级复刻原型 UI（Radix 动效等做不到，功能与观感已对齐）。
