# 能力资产前端验收记录

## 对照范围

- 用户参考图：`/var/folders/_y/f9qczk352m9282gltr0pbm8m0000gn/T/codex-clipboard-b790971f-0d7c-457d-8e09-79c5536dc707.png`
  - 原始尺寸：`3024 x 1786`
- 验证视口：`1301 x 768`
- 实现截图：
  - `design-qa-assets/capability-assets-personal-ontology.jpeg`（`1301 x 768`）
  - `design-qa-assets/capability-assets-comparison.jpg`（左侧参考、右侧实现，`2602 x 768`）

## 本次验证场景

- “已入库资产”已改为“能力资产”，并同步到能力资产页、流程提示、搜索框、空状态与多语言文案。
- “关于我”分类下，个人本体模板工作区出现在能力资产页内，正式沉淀信息位于其下方。
- 模板编辑器在桌面视口高度受限为 `clamp(420px, calc(100dvh - 300px), 580px)`，内容在工作区内部滚动，不再把整页无限撑长。
- 模板库弹窗受 `min(720px, calc(100dvh - 48px))` 限制，模板列表独立滚动。
- 模板导航、模板正文、能力资产列表、能力资产详情以及展开的执行与评估记录分别保留独立滚动，并设置 `min-width/min-height: 0`、`overscroll-behavior: auto` 与稳定滚动条槽；内层到边界后把滚轮交回主页面。
- 认知资产主内容区恢复为唯一的页面级纵向滚动容器；页面 pane 和能力资产 pane 不再额外拦截滚轮，避免外层 `overflow: hidden` 与内层 `overflow: auto` 互相抢滚动。
- 个人本体左侧导航、模板正文、能力资产列表和详情面板都明确开启纵向滚动；内层滚动到边界后使用自然滚动接力，继续上下浏览整页。
- 主内容窗口强制保留页面级滚动条和键盘焦点；Electron 未自动接力滚轮时，动态检查事件目标的所有祖先滚动容器并兜底推进主页面，确保任意嵌套模块都能继续浏览下方内容。
- 窄屏下模板工作区和资产列表/详情使用独立高度上限，列表切换与详情滚动不改变外层页面布局。

## 代码与交互证据

- `src/renderer/index.html` 使用“能力资产”标签，并为内嵌个人本体工作区补充 `recall-personal-ontology-frame` 容器类。
- `src/renderer/modules/skills.js` 将候选池、能力资产入口和个人本体渲染保持在同一流程内，并恢复列表滚动位置。
- `src/renderer/recall-local.css` 为个人本体、模板库、能力资产列表和详情面板提供视口边界及独立滚动规则。
- 渲染回归断言覆盖能力资产命名、模板高度限制、模板库列表滚动、列表/详情独立滚动与窄屏约束。

## 验证结果

- `npm run typecheck`：通过。
- `npx vitest run test/renderer/skills-cognition-layout.test.ts test/renderer/recall-cognition-flow.test.ts`：通过，`81` 个测试通过。
- 已通过 Electron 实际窗口验证：个人本体左侧区域没有可滚余量时，滚轮会继续推进主页面到“已沉淀信息”；右侧有内容的面板仍在内部滚动。
- 未发现可复现的 P0/P1/P2 视觉问题。

## 残余风险

- `npm test` 全量执行仍有 `35` 个既有失败，集中在安全扫描器、模型配置、内置 manifest、locale contract 等与本次前端布局改动无关的工作区改动；不作为本次验收失败依据。

## 清单

- [x] “已入库资产”更名为“能力资产”。
- [x] 模板工作区限制在视口内，避免页面过长。
- [x] 模板库、模板正文、资产列表和详情面板独立滚动。
- [x] 桌面与窄屏布局加入高度、宽度和 overscroll 约束。
- [x] 渲染回归测试、类型检查和 Electron 实际窗口验证完成。

final result: passed
