# 交接文档：侧栏「最近任务」ZCode 式双 Tab 布局改造

> 交接时间：2026-08-16 18:5x
> 交接人：Hermes（本窗口）
> 仓库：`~/cog-seed`（develop 分支，**运行中的 app 就是这份代码**；`/Users/zhanghao/mate-agent` 是 GitHub 个人镜像，本次未动）
> 状态：**代码已改完、typecheck 通过、真实环境验证通过**，未提交

## 一、需求背景

用户提供 ZCode 应用两张截图，要求 cogseed 左侧「最近任务」借鉴 ZCode 布局。用户原话：「注意他的是项目，我的是空间，只参考布局」。

ZCode 布局特征（从截图 OCR 解析）：
- 顶部「分组 | 项目」双 tab 切换
- 任务列表每行 = 任务名 + **相对时间**（58分 / 3小时 / 6小时）
- 「显示更多」展开按钮

映射到 cogseed：ZCode 的「项目」→ 我们的「空间」；「分组」→ 置顶+最近任务。

## 二、改了什么（11 个文件，+229/-89）

### 核心改动
| 文件 | 改动 |
|---|---|
| `src/renderer/index.html` | 侧栏会话区顶部加双 tab 容器 `#sidebar-conv-tabs`（空间 \| 最近任务），移除原「Conversations」标题 |
| `src/renderer/modules/conversation.js` | ① 新增 `_sidebarConvTab` 状态（localStorage 持久化 `chat.sidebar.convTab.v1`）+ `_setSidebarConvTab` / `_syncSidebarConvTabUI`；② `renderConversationList()` 改为按 tab 分支渲染：spaces tab 只渲染空间分组，recent tab 只渲染置顶+最近任务；③ `_renderConversationSidebarItem` 行尾新增相对时间 `conv-item-time`；④ 新增 `_renderConversationRelativeTime` / `_conversationAbsoluteTime` |
| `src/renderer/modules/state.js` | `bindStaticHandlers` 绑定 tab 点击事件 |
| `src/renderer/style.css` | 新增 `.sidebar-conv-tabs` / `.sidebar-conv-tab` 胶囊 tab 样式 + `.conv-item-time` 相对时间样式 |
| `src/renderer/locales/{zh,en,pt,ja}.json` | 新增 5 个 `sidebar.time_*` key（刚刚/N 分钟前/N 小时前/N 天前/更早） |
| `test/renderer/conversation-sidebar.test.ts` | 测试 `t()` stub 补 `sidebar.time_*` + tab 文案 key |

### 设计决策（按用户「只参考布局」）
- **双 tab 是核心**：空间 tab 显空间分组列表（ZCode 分组列表形态），最近任务 tab 显置顶+平铺任务
- **相对时间是核心**：平铺列表无时间桶标题，行尾相对时间承担「新近度」信号
- **未照搬** ZCode 的「视图切换（按项目/时间线）」「排序方式（更新时间/创建时间）」两个控件区——用户说只参考布局，且 cogseed 侧栏宽度有限
- **保留** 原有全部交互：置顶区、分区折叠、空间组折叠、内联新建任务、加载更多、⋯ 菜单

## 三、验证情况

- ✅ `npm run typecheck` 通过
- ✅ 单测 `npx vitest run test/renderer/conversation-sidebar.test.ts`：65 passed / 1 failed
- ✅ 真实环境验证（`./scripts/restart-cogseed.sh restart` 后）：
  - 双 tab 渲染正常
  - 点「空间」tab → 显示空间分组列表（`123454567`、`示例·产品设计空间` 等带会话数）
  - 点「最近任务」tab → 显示置顶+任务列表，行尾相对时间正常（7分钟前/8小时前/1天前）
  - 无 JS 报错（18:58 重启后日志无 uncaught error）

### ⚠️ 已知遗留
1. **`Project task 11` 单测失败是 develop 预存问题**（stash 全部改动后复现，与本改动无关）。若需修复：`test/renderer/conversation-sidebar.test.ts:337` 断言项目分页加载后渲染 `Project task 11`，失败原因是项目分页 mock 的二次 fetch 未渲染进 `projectsContainer`，与本改动无直接关系，怀疑是并行开发分支合并引入。
2. **曾踩坑（已修复，勿回退）**：`_renderConversationRelativeTime` 内曾用 `const t = new Date(iso)`，**遮蔽了全局 `t()` i18n 函数**，导致渲染侧栏即报 `TypeError: t is not a function`。已改名 `dt`。若再遇此错先查这个。
3. 运行中的 app 曾报错是因为**改代码后未重启**，用户看到的「UI 有了但功能不能用」是旧运行时。重启后正常。

## 四、未做/待确认

- **未提交、未 push**。开发在 `~/cog-seed` develop 分支（工作区还有用户之前的未提交改动：`workspace.js`、`workspace.css`、`style.css` 的部分改动是用户原有的，注意区分）。下一步：确认布局满意后 commit + 合入（按 GitLab MR 流程，develop 受保护）。
- **未做「视图切换/排序方式」控件**——若用户想要 ZCode 的完整控件区，需在 tab 行下加一个工具条。
- **pt/ja 文案**是直译，可让用户校对。
- tab 高亮用 `is-active` class + `aria-selected`，CSS 是胶囊式；若用户想要 ZCode 的下划线式 tab，改 `.sidebar-conv-tab` 样式即可。

## 五、复现/继续步骤

```bash
cd ~/cog-seed
npm run typecheck
npx vitest run test/renderer/conversation-sidebar.test.ts
./scripts/restart-cogseed.sh restart   # 重启运行中的 app
# 日志：~/.cogseed/runtime-variants/cogseed/data/logs/2026-08-16.log
# 验证：截图 + OCR 看侧栏双 tab / 相对时间；点击坐标参考窗口 (0,33) 1512x889
```

## 六、ZCode 参考图要点（留给新窗口）

- 图1（完整侧栏）：顶部导航「自动化/技能/分组/项目」；「分组|项目」双 tab；视图切换（按项目/时间线）；排序方式（更新时间/创建时间）；任务列表（开发1 3小时、契约 3小时、开发方案对比分析 6小时）+「显示更多」；分组列表（Hub、mate-agent-dev...、Opensource-P3...、ZCode）；底部「任务」tab + 用户信息
- 图2（tab 特写）：「#分组 | □项目」双 tab + 下面「项目」「任务」区块
- 用户强调：ZCode 用「项目」概念，cogseed 用「空间」概念，**只参考布局**不照搬功能
