# CogSeed 一级信息架构收敛实施计划

> **日期：** 2026-08-15
> **状态：** 待实施
> **依据：** `CogSeed_60秒Aha一级导航与认知资产交互规范_doc-v0.2_Review.md` §3、§7、§10
> **范围：** 仅一级信息架构（一级导航 + 入口/子入口重组）。60秒Aha路由、Token平台/额度后端、多Agent会话、低负担确认的深层交互**不在本期**，只以依赖和backlog形式标注。
> **应用：** 真实应用 `cogseed-agent/`（renderer 为 vanilla HTML/CSS/JS classic scripts）。

---

## 1. 目标

将一级导航收敛为 6 个固定入口，把「AI团队、技能库、个人本体、MCP、模型和Token、指挥官」从一级平铺中移出，改为二级入口或上下文呈现。**后端 IPC、数据层、既有面板 DOM/渲染逻辑全部保留**，本期是 renderer 导航与入口的重新组织。

## 2. 现状盘点（真实应用）

### 2.1 侧边栏按钮（`src/renderer/index.html:30-39`）

| id | 当前文案 | 新 IA 归属 |
|---|---|---|
| `new-chat-btn` | 新建会话（指挥官） | → **首页** |
| `auto-btn` | 自动化 | → **自动化**（保留） |
| `agents-btn` | AI团队 | → 移除一级；进入 **连接 > Agent** |
| `skills-btn` | 技能库 | → 移除一级；进入 **认知资产 > 我的能力** |
| `recall-btn` | 认知资产 | → **认知资产**（保留，改内部结构） |
| `connectors-btn` | 连接器 | → **连接** |
| `personal-ontology-btn` | 个人本体 | → 移除一级；进入 **认知资产 > 关于我** |
| `spaces-btn` | 工作空间 | → **工作空间**（保留） |
| `settings-btn`（footer） | 设置 | → **设置**（保留） |

### 2.2 面板与视图映射（`src/renderer/index.html` + `modules/boot.js:377-391`）

| view | panel | 文件位置 |
|---|---|---|
| `new-chat` | `#panel-new-chat` | index.html:76 |
| `recall` | `#panel-recall` | index.html:430 |
| `skills` | `#panel-skills` | index.html:472 |
| `agents` | `#panel-agents` | index.html:579 |
| `connectors` | `#panel-connectors` | index.html:989 |
| `contexts` | `#panel-contexts` | index.html:1022 |
| `auto` | `#panel-auto` | index.html:1074 |
| `personal-ontology` | `#panel-personal-ontology` | index.html:1094 |
| `spaces` | `#panel-spaces` | index.html:1144 |
| `settings` | `#panel-settings` | index.html:1185 |
| `memory` | `#panel-memory` | index.html:1553 |

### 2.3 依赖入口的硬引用（本期需同步处理）

| 位置 | 引用 | 风险 |
|---|---|---|
| `modules/state.js:315-316,319` | `agents-btn`/`skills-btn`/`personal-ontology-btn` click 绑定（无 `?.`，删除按钮会抛错） | 必须删行 |
| `modules/boot.js:397` | `skills-btn` active 切换（无 `?.`） | 必须 `?.` 或删行 |
| `modules/boot.js:396,400` | `agents-btn`/`personal-ontology-btn` active 切换（有 `?.`） | 可删 |
| `modules/interactive-tour.js:74,84` | 引导 step 的 `#agents-btn`/`#skills-btn` target | 引导会断，需重指 |
| `test/renderer/settings-open.test.ts:56-58` | 断言 panel 列表 | 需同步 |
| `test/renderer/skills-cognition-layout.test.ts:96,117` | 断言 `panel-skills`/`view==='skills'` 映射 | 保留（view 不删） |

### 2.4 保留与移动（关键决策，用户已拍板）

**功能全部保留，面板 DOM 整体搬进 tab（真内嵌，无跳转）：**
- `view === 'skills'`、`view === 'agents'`、`view === 'personal-ontology'`、`view === 'contexts'` 的**面板路由与懒加载全部保留**（`boot.js` + `lazy-features.js`）。它们仍被搜索、会话芯片、recall 内链、创建/导入后跳转调用，删 view 会破坏这些深链。
- `#panel-skills` → 认知资产「我的能力」tab；`#panel-personal-ontology` → 认知资产「关于我」tab；`#panel-agents` → 连接「Agent」tab；`#panel-contexts` → 连接「数据源」tab。均**整体搬移 DOM**，保留全部内部 id。
- 深链 `setView('skills')` 等改为打开宿主面板 + 激活对应 tab。

**连接器（connectors）特例 —— 内容搬移，不留多余面板：**
- `#panel-connections` 的 MCP 与工具页签真嵌入 connectors 网格；旧 `#panel-connectors` 移除。
- 触点（messaging/touchpoint）从设置迁入连接「触点」tab，设置 messaging tab 删除。

**模型与额度：** 暂保留入口卡（用户未定，不搬）。

---

## 3. 目标一级信息架构

```text
搜索 (Cmd/Ctrl+K)
─────────────
首页          ← 新任务 / 继续任务 / 最近空间 / 待处理提醒 / 运行状态
工作空间      ← Baseline / 角色切片 / 能力引用 / Agent / 工具 / 任务与Artifact
认知资产      ← 待我处理 / 我的资产 / 使用与证明 / 版本与治理
自动化        ← 定时任务 / 事件触发 / 运行记录 / 失败和重试
连接          ← Agent / MCP与工具 / 数据源 / 飞书等外部触点 / 模型与额度
─────────────
设置          ← 本地身份 / 可选Hub账号 / 额度明细 / 通知 / 权限 / 数据和语言
```

- **不再占一级入口：** AI团队（→连接>Agent，任务内参与者/进度）、技能库（→认知资产>我的能力）、个人本体（→认知资产>关于我）、MCP（→连接>MCP与工具）、模型和Token（→连接>模型与额度 + 设置>账号与用量）、指挥官（不作为用户入口）。
- **i18n 文案统一用用户语言**：识别/角色/偏好/关系/边界（关于我）、能完成什么/适用场景/步骤/工具/模板/结果评价/来源/版本/使用证明（我的能力）。

---

## 4. 实施步骤

### Step 1：认知资产并入（技能库 + 个人本体 → 二级，真内嵌）

> 已实施。技能库与个人本体 DOM **整体搬入** recall 的 tab pane，不再走入口卡跳转。

1. **`index.html` `#panel-recall`**：在 `#skills-cognition-tabs` 新增「我的能力」「关于我」两个 tab。
2. **DOM 源级搬移**：`#panel-skills` 搬入 `my-abilities` pane，`#panel-personal-ontology` 搬入 `about-me` pane；保留全部内部 id（`#skills-grid`、`#personal-onto-nav` 等），渲染函数照常工作。旧独立 `<section class="panel">` 删除。
3. **内嵌面板常显**：`.skills-embedded-panel { display:flex }`，tab pane 的 `[hidden]` 控制显隐。
4. **深链路由**：`view === 'skills'` / `'personal-ontology'` 改指向 `panel-recall` + 对应 tab（`boot.js`），`switchSkillsCognitionPage('my-abilities'/'about-me')` 切换。
5. **Escape 处理**：`skills-bindings.js` 的 Esc 返回改为检查 `#skills-cognition-my-abilities` pane 可见性。
6. **侧边栏**：删 `skills-btn`、`personal-ontology-btn`；同步清理 `state.js`/`boot.js` 硬引用。
7. **i18n**：新增 `cognition.my_abilities` / `cognition.about_me`（四语）。

**验收：** 认知资产内可切换 我的能力 / 关于我，内容直接内嵌展示（无跳转）；技能详情、个人本体候选审查、回滚/版本功能不回归；搜索和会话芯片的 skill 深链直接落到「我的能力」tab。

### Step 2：连接合并（Agent + MCP + 数据源 + 触点 + 模型与额度，真内嵌）

> 已实施。新增 `#panel-connections` tabbed 面板，五个 tab 中 Agent / MCP / 数据源 / 触点 全部真内嵌，仅模型与额度保留入口卡（用户暂定不动）。

1. **`#panel-connections` tabbed 面板**，一级侧边栏 `connectors-btn` 改名「连接」并指向它。旧 `#panel-connectors` 移除。
2. **tab 结构**（`.connections-tab-pane` + `connections.js` tab 切换）：
   - **Agent**：`#panel-agents` DOM 搬入 agents pane
   - **MCP与工具**：connectors 网格搬入 mcp pane
   - **数据源**：`#panel-contexts`（资料库）搬入 sources pane
   - **触点**：原设置 messaging/touchpoint 内容搬入 touchpoints pane，**设置 messaging tab 删除**
   - **模型与额度**：保留入口卡（跳转设置 Model Providers）
3. **深链路由**：`view === 'agents'` → `panel-connections` + agents tab；`view === 'contexts'` → `panel-connections` + sources tab；`view === 'connectors'` → mcp tab。
4. **触底渲染**：`activateConnectionsTab` 在切到 agents/sources/mcp/touchpoints 时按需 `loadAgents`/`loadContexts`/`loadConnectors`/`initTouchpointSettings`。
5. **引导**：`interactive-tour.js` agents step 重指到「连接 > Agent」。

**验收：** 连接面板各 tab 内容直接展示；Agent 创建/编辑、MCP 连接、资料库、飞书授权、模型授权流程全部照旧；设置无残留触点；旧深链落到对应 tab。
6. **i18n**：`sidebar.connections`、tab 名（`connections.tab.*`）；`sidebar.connectors` 保留兼容或移除。

**验收：** 连接面板五类子页均可打开且交互不回归；Agent 创建/编辑、MCP 连接、资料库打开、飞书授权、模型授权流程全部照旧；旧连接器面板不再存在、无多余面板；`connectors` 旧深链仍能打开 MCP 页签。

### Step 3：首页仪表盘

1. **改造 `#panel-new-chat`**：保留问候 + composer（新任务），在原有场景 chips 之外聚合：
   - **继续任务**：复用 `continue-work.js` 的接续入口
   - **最近空间**：spaces 列表最近 N 项（`spaces.js` 已有列表数据）
   - **待处理提醒**：recall 候选待确认计数（`skills.js:1070` 已有 pending 过滤）+ 任务通知状态
   - **运行状态**：`commander-running-chip`（现 `index.html:31`）已有运行态数据
2. **侧边栏**：`new-chat-btn` 文案改「首页」，`sidebar.new_chat` → 新增 `sidebar.home`（`new_chat` 保留兼容）。
3. **视图**：view 仍为 `new-chat`，面板仍为 `#panel-new-chat`，仅内容聚合；不新增 view，避免影响 `_restoreLastView`。

**验收：** 首页可见四类聚合块；点击继续任务/最近空间跳转正确；运行中状态真实显示；无历史数据时各块显示空态。

### Step 4：设置微调与额度占位

1. **设置 tab 结构**：`#panel-settings`（:1185）现 tab 为 数据/Model Providers/消息平台/账号/通用。按 v0.2：
   - 新增「账号与用量」tab（或并入「账号」）：**额度明细前端占位**。
   - `settings.tab.credentials`/`messaging` 内容**不删除**，但「模型与额度」「触点」以占位卡片标注：`此处配置已移至 连接 > 模型与额度 / 连接 > 触点`，点击跳转 `setView('connections')`。
2. **额度占位（hosted-only）**：
   - 前端渲染「体验额度 / 运行额度」状态卡，数据源用可配置空态：`{ available: null, source: 'local', degraded: true }`。
   - **不接 Token 平台、不写额度账本、不扣减**。所有相关调用走 `window.cogseed.invoke('quota.*')` 抽象，开源构建 strip 后为占位；文案标注「当前为占位展示，额度规则待后端确认」（v0.2 §6.3 明确数值未冻结，不得硬编码为发布承诺）。
3. **i18n**：新增 `settings.tab.usage`（账号与用量）、`quota.*` 占位文案。

**验收：** 设置可打开账号与用量看到额度占位卡；模型/触点卡片点击跳转连接面板；开源构建无 hosted 依赖、无额度错误。

### Step 5：清理与回归

1. 全局检索残留的 `agents-btn`/`skills-btn`/`personal-ontology-btn` 引用（renderer + test），确保无空引用抛错。
2. 更新测试：
   - `test/renderer/settings-open.test.ts:56-58` panel 列表断言
   - 新增：一级导航按钮与 view 映射测试、认知资产 tab 切换测试、连接 tab 测试
3. 更新 `interactive-tour.js` 全部引导 step target。
4. 运行：`npm run typecheck` + `npm test`；`./run.sh` 重启验证真实窗口。

---

## 5. 验收矩阵（对齐 v0.2 §11，仅导航相关）

| Gate | 本期验收 | 说明 |
|---|---|---|
| G10 导航 | 一级入口严格为 首页/工作空间/认知资产/自动化/连接/设置 | 旧入口不并行保留两套心智；`agents/skills/personal-ontology` 一级按钮删除 |
| G1 身份 | 设置 > 账号与用量 显示本地身份 + 可选 Hub 账号（既有 hub-account 卡） | 不新增后端 |
| G5 接续准备 | 首页 继续任务 块复用 continue-work 入口 | 60秒Aha 计时与 Action Plan 确认不在本期 |
| G7 结果证明 | 认知资产 我的资产/使用与证明/版本与治理 保持既有能力 | 复用 recall 能力，无新增 |

## 6. 非目标（本期不做）

 - 60秒Aha 路由、四象限、授权 Gate 前端流（v0.2 §4）
 - Token 平台、初始额度下发/扣减/账本、用尽恢复路径（v0.2 §6）——前端仅占位
 - 单/多 Agent 会话区域重构（v0.2 §9）
 - Workspace Baseline/角色切片/能力引用的新交互（v0.2 §10）——现有 spaces 能力沿用
 - 低负担确认的四种呈现强度（v0.2 §8）

## 6a. 四步引导 → 三步引导（隐形匹配工作空间）

> 与一级 IA 收敛同步落地：去掉 Step 3「角色模板选择」，改为隐形匹配工作空间。

1. **Step 3 面板**：从角色卡片选择改为「隐形匹配中」过渡页（spinner，仅过渡）。
2. **三选一统一入口**：继续项目 / 选其他会话 / 从零开始 三路都进入隐形匹配，不再要求选角色。
3. **隐形匹配**：有后端建议模板（`recommendStartingPoint.suggestedTemplate`）→ 复用/新建该模板工作空间，把导入会话绑定到其下「导入的会话」项目；无建议 → 自动建「临时空间」。
4. **无确认页**：匹配完成**直接进入主界面**（`_csFinish` 收尾：持久化、移除 shell、刷新会话列表），不展示「工作空间已就绪 / 开始使用」确认页，不要求用户手动点击。
5. **不暴露工作空间概念**：过渡页与 toast 文案统一用中性说法（「正在为你整理」「正在准备你接下来要用到的东西」），不在引导早期向用户提及「工作空间」。
6. **步骤指示**：4 步 → 3 步。

**验收：** 四步引导变为三步；三选一后无角色选择、无确认页，匹配完自动进入主界面；有建议模板时会话自动落入对应工作空间，无建议时落入「临时空间」；过渡文案不出现「工作空间」。

## 7. 风险与处理

| 风险 | 处理 |
|---|---|
| 删按钮导致 `boot.js:397`/`state.js:316` 空引用抛错 | Step 1/2 先清理再删按钮 |
| 引导 step 断链 | Step 1/2 同步重指 target |
| `#panel-connectors` 移除后旧深链进入空面板 | `view === 'connectors'` 路由改为落到 `#panel-connections` 的 MCP 页签 |
| 连接合并后 skills/agents 深链失效 | 保留各 view/bundle 与独立面板，仅移入口 |
| 额度占位被误当真实数据 | 空态 `degraded:true` + i18n 标注占位 |
| 测试断言过期 | Step 5 集中更新 |

## 8. Backlog（后续期，来自 v0.2）

- 60秒Aha 计时与十一种可验收情境
- Token 平台 / 初始额度 / 用尽恢复（G4）
- 授权 Gate（G3）
- 多 Agent 会话协作（G9）
- Workspace Baseline 直接开工（G10 后的能力层）
