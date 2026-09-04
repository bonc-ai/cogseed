# 插件前端设计（CogSeed 插件 UI v2：状态面板 + 对话驱动 + 确认卡片）

> 状态：已实现（develop 工作区本地实现，未推送） · 2026-08-30

## 1. 定位

插件 = 「装好即用」的对话能力包。三个面，职责分离：

| 面 | 位置 | 职责 |
|---|---|---|
| 状态面板 | 连接 › 插件 tab | 只回答状态：装没装、启没启用、版本、授权（席位）状态 |
| 对话驱动 | 对话（智能体） | 用户说需求，智能体调用插件技能（遥控器）操作平台 |
| 确认卡片 | 对话内（插件自带界面） | 关键写操作前渲染摘要，用户点「确认」才写入 |

设计红线（沿袭现有安全模型）：

- **密钥不进渲染层、不进提示词**。凭据存 `<uid>/local/packages/.secrets/<pkg>.json`
  （0600，机器私有），仅在 `bin/run-skill.cjs` 启动技能脚本前注入子进程环境；
  显式调用方 env 优先（EDUSEED_MOCK 冒烟/运维覆盖不被覆盖）。
- **插件界面是只读确认面**：`cogseed-plugin://<pkg>/<relpath>` 协议 + 沙箱 iframe
  （`allow-scripts allow-same-origin allow-forms`，永远接触不到 `window.cogseed`）；
  写入只能由对话里的智能体在用户确认后执行。
- **路径与命令双白名单**：served 路径强制落在包内 `uiRoot` 子树（symlink 解析后校验），
  扩展名白名单；运行时命令限制在包自身技能 + `manifest.ui.commands` 允许面。

## 2. 状态面板（renderer）

`连接 › 插件` tab（`modules/plugins.js`，lazy 包 `plugins`）：

- 列表卡片：manifest 中英文名、版本、类型、启用徽章、授权徽章、技能数、更新时间
- 授权徽章：`packages.ui.invoke` → 插件 runtime `license-check`（串行，逐插件）：
  未配置 / 检查中 / 已激活 / 未授权 / 检查失败
- 安装（本地目录/Git URL → 确认弹窗展示准确命令 → `packages.install`）、
  启用/停用/更新/移除（`packages.action`）
- 详情：manifest 富字段、技能清单、对话可用命令、平台配置表单
  （`packages.ui.save-config`，api_key 只写不回显）

## 3. 对话驱动（main）

- 技能执行唯一通道仍是 `bin/run-skill.cjs`（AGENTS.md 不变量）。
- `run-skill.cjs` 在 `locateSkillScript` 之后调用 `injectPackageRuntimeSecrets`：
  按 `_registry.json` 把技能目录反查到所属包，存在 `.secrets/<pkg>.json` 时
  注入 `EDUSEED_*`（仅补齐调用方未显式设置的变量）。
  - 覆盖两条执行路径：核心智能体的 run-skill 直通工具、bash 内的 run-skill 调用。
  - 密钥不会出现在 bash `env` 输出或任何工具结果中。

## 4. 确认卡片（插件自带界面 + artifact 中继）

协议（三层 postMessage）：

```
插件确认视图（cogseed-plugin://<pkg>/ui/confirm.html?op&payload）
  └─ {__cogseedPlugin:true, type:'confirm'|'cancel'|'resize'}
        确认卡片宿主（智能体经 create_artifact 放入对话；读 confirm-config.json
        → iframe 插件确认视图 → 中继消息）
  └─ {__cogseedArtifact:true, type:'submit', payload:{action:'plugin-confirm'|'plugin-cancel',...}}
        CogSeed 对话（作为用户消息回传给智能体）
```

智能体流程（写操作，SKILL.md 硬性步骤）：

1. 读命令（查重/详情/预检）→ 组装完整写入载荷
2. `create_artifact`：`index.html`（确认卡片宿主模板，SKILL.md 附录 A 原样使用）
   + `confirm-config.json`（`{"op":"submit-project|publish-challenge|submit-review","payload":{…}}`）
3. 用户点「确认」→ 对话收到 `plugin-confirm` 消息 → 智能体才执行写入命令
4. 「取消」/用户改口 → 停止写入

## 5. 零配置激活（whoami 身份识别）

用户只需要**平台地址 + API Key** 两样：

- 平台新增 `GET /api/agent/whoami`：凭 `x-api-key` 返回
  `{ok, agent_id, role, person_id}`（身份由 getAgentPrincipal 按 key 绑定，
  不可伪造；动态 agent 的 `student-companion-<id>` / `teacher-companion-<id>`
  前缀即角色与学号/工号）。
- `savePluginRuntimeConfig`：有 key 但缺角色/ID 时自动调 whoami 补全；
  解析失败则拒绝保存并提示检查地址/密钥（或手动填写角色与 ID）。
- 渲染层配置表单：角色默认「自动识别（推荐）」、ID 留空自动识别；
  保存成功 toast 回显识别结果（如「教师 · 2023108600138」）。
- 插件运行时（runtime.js）无需改动：补全后的 student_id/role 照旧经
  secrets 注入。
- 手册（student/teacher guide）：`/companion` 只复制 key 即可，JSON 配置文件
  退居兼容旧路径的选项。

## 6. 新增/改动面（相对 develop 基线）

| 文件 | 内容 |
|---|---|
| `src/main/features/plugin_ui.ts`（新） | bridge 脚本、UI 路径解析、invoke 面（get-info/runtime/save-config）、secrets 读写 |
| `src/main/features/packages.ts` | manifest 读取（白名单字段）、`listPackageSkills`、GUI install、`PackageUiRow` 扩展 |
| `src/main/ipc/index.ts` | `packages.install` / `packages.ui.info` / `packages.ui.invoke` / `packages.ui.save-config` |
| `src/main/index.ts` | `cogseed-plugin` scheme 注册 + 协议处理器（bridge 虚拟路径、路径白名单、CORS） |
| `src/main/paths.ts` | `userPackageSecretsDir` |
| `bin/run-skill.cjs` | `injectPackageRuntimeSecrets`（对话驱动密钥注入） |
| `src/renderer/modules/plugins.js`（新） | 状态面板（列表/授权徽章/安装/详情/配置） |
| `src/renderer/modules/connections.js` | `plugins` tab 接线 |
| `src/renderer/index.html` / `plugins.css` / `lazy-features.js` / `icons.js`（puzzle） | 壳/样式/懒加载/图标 |
| `src/renderer/locales/zh+en.json` | `connections.tab.plugins` + `plugins.*` |
| `test/main/features/plugin_ui.test.ts`（新） | 8 用例：UI 解析/路径与 symlink 拦截/配置合并与掩码/安装输入校验 |

## 6. 验证

- `npm run typecheck` 干净；新增 8 测试全过；renderer 布局契约测试 34/34
- 真实链路：secrets 写入 → `run-skill.cjs license-check`（无任何 EDUSEED env）
  → `licensed:true, seat_kind:teacher-seat`（对话驱动链路）
- 真机：开发版 CogSeed（`cogseed-dev` 工作区，`scripts/restart-cogseed.sh` 重启验证）
- 已知既有失败（与本次无关）：develop 基线 builtin 清单测试（kb-mindmap 缺 frontmatter，
  #112 引入）+ 全量并行跑时嵌入库偶发抖动

## 7. 插件侧约定（aix-course-elite20 v0.4.x）

- `manifest.json`：`ui.entry="ui/confirm.html"`，`ui.commands` 允许面 13 命令
- `ui/`：`confirm.html` + `confirm.js`（确认视图，只读摘要）、`confirm-host.html`
  （确认卡片宿主模板）、`styles.css`
- SKILL.md（学生/教师）：写操作前的确认卡片流程 + 宿主模板附录

## 8. 安全审查（2026-08-30 攻击者视角全量审查）

威胁模型四类：恶意插件（供应链）、恶意插件 UI、外部网络攻击、智能体误操作。

**已实施的防线**：

- 协议面：路径穿越/symlink/扩展名白名单、%00 与编码斜杠、userinfo host、
  大写包名规范解析、bridge 虚拟路径、无 CORS（跨插件跨源读取默认阻断）
- 沙箱面：iframe 无 popup/顶层导航、无 window.cogseed、origin 按包隔离
  （cogseed-plugin://<pkg>，localStorage 互不相通）
- 密钥面：0600/0700 机器私有；只写不回显；不进渲染层/提示词/日志；
  run-skill 注入仅补齐未显式设置的变量、仅技能运行期生效
- 命令面：技能∈包内 + manifest.ui.commands 允许面 + JSON 参数校验 + spawn 数组无 shell
- whoami：server_url 白名单校验（http/https、无内嵌凭据、无查询参数）、平台侧限流 30/min
- 确认卡片：artifact 同会话校验 + 消息来源校验；渲染层全部动态内容转义

**模型内已接受风险（记录在案）**：

1. 同 OS 用户可读 0600 文件（单机单用户模型固有）
2. 多 CogSeed 账号同机 + 恶意插件：子进程可覆盖 COGSEED_UID 读他人 .secrets
   （与现有技能系统用户域模型一致，未引入新缺口）
3. 安装 source 可为任意 http(s) URL（内网 SSRF 面）——有人工确认弹窗展示准确命令，
   与 CLI 安装路径同等风险
4. 恶意插件可伪造"确认"消息或直接拿注入的 key 写平台——确认卡片防的是
   智能体误操作，不防插件作者作恶（插件安装已有安全扫描+同意面兜底）

**本轮修复**：server_url 校验（防 key 被导向恶意地址）、移除协议 CORS *。
