# 认知资产页面不可交互 — 修复说明

> 基线 develop `f4e6177f` · 2026-08-15 · 工作区改动，未提交
>
> 这份文档给要和这批改动对接的人。只写**根因**、**契约**和**验证方式**，实现细节在源码注释和测试里。
>
> 上一批「认知继承与复用链」的对接说明已合入 develop，内容保留在 `git show d4f8b7f5:spec.md`。

---

## 1. 现象

进入「认知资产」页后，界面完全点不动：切 tab 没反应，「关于我」是一片空白，页面上可见的内容和当前选中的 tab 对不上。

不是偶发，不是数据为空，也不是权限问题 —— 是两个互相独立的渲染层缺陷叠在一起。

## 2. 排查方式（不靠读代码猜）

静态审查只能给出嫌疑，无法判定 CSS 层叠的最终结果。这次用 Chrome DevTools Protocol 直接连进运行中的渲染进程实测：

```bash
# 带调试端口启动
ORKAS_RUNTIME_VARIANT=cogseed open -n node_modules/electron/dist/CogSeed.app \
  --args "$PWD" --orkas-runtime-variant=cogseed --remote-debugging-port=9222
# 再用 Runtime.evaluate 读 getComputedStyle / getBoundingClientRect
```

关键量测（修复前，视口 1280×768）：

| pane | hidden | y | height | 是否在视口内 |
|---|---|---|---|---|
| overview | true | 96 | 672 | 是（但语义上应隐藏） |
| sources | true | 768 | 672 | 否 |
| captures | true | 1440 | 672 | 否 |
| **assets** | **false** | **2112** | 672 | **否 ← 当前 tab 在视口外** |
| my-abilities | true | 2784 | 672 | 否 |
| about-me | true | 3456 | 672 | 否 |

容器 `.skills-cognition-main`：`clientHeight=672`、`scrollHeight=4032`、`overflow-y: hidden`、`scrollTop=0`。

结论一眼可见：六个 pane 谁都没被隐藏，在一个不可滚动的 672px 容器里竖排了 4032px，用户永远只看得到第一屏。

## 3. 根因一：`[hidden]` 被类选择器的 `display` 覆盖

tab 切换只翻 `hidden` 属性：

```js
// src/renderer/modules/skills.js:173
function _cognitionSetPageVisibility(page) {
  document.querySelectorAll('[data-cognition-page-body]').forEach((el) => {
    el.hidden = el.dataset.cognitionPageBody !== page;   // 只改属性，不改 class
  });
  ...
}
```

而样式给这个类设了 display：

```css
/* src/renderer/style.css:19255 */
.skills-cognition-page { min-height: 100%; ...; display: flex; flex-direction: column; }
```

浏览器的 `[hidden] { display: none }` 来自 **UA 样式表**，任何作者样式表里的 `display` 都会赢。于是 `hidden` 退化成一个纯语义属性，不再产生任何布局效果。

这条 `display: flex` 由 `1f136a9f`（2026-08-10，*fix: keep Recall content visible while expanding reuse proof inline*）引入，早于本次合并，属于既有缺陷。同文件里 `.touchpoint-view` 就写对了（`style.css:22882` 有 `.touchpoint-view[hidden] { display: none; }`），可见团队里已有正确范式，只是没覆盖到这个类。

**修复**：

```css
/* src/renderer/style.css:19260 */
.skills-cognition-page[hidden] { display: none; }
```

`.skills-cognition-page[hidden]` 特异度 (0,2,0) 高于 `.skills-cognition-page` (0,1,0)，与 `recall-local.css` 里的同名类规则的先后顺序无关，稳定生效。

## 4. 根因二：个人本体骨架有两份，重复 id 让渲染落进隐藏的那份

`index.html` 里有 **8 个重复 element id**，整套个人本体 DOM 存在两份：

| | 位置 | 来源 |
|---|---|---|
| A 份 | 「能力资产」页内，默认 `hidden` | `7d451b70` `dev/historical-auto-recall` |
| B 份 | 「关于我」tab 内，真正要显示的那份 | `044ec33c` 一级导航收敛（面板真内嵌） |

重复 id：`personal-onto-sidebar` / `-nav` / `-main-header` / `-main-body` / `-template-library-modal` / `-list` / `-close` / `-cancel`。

`personal-ontology.js` 全程用 `getElementById` 定位（`:588`、`:623`、`:644`、`:646`、`:669`、`:822`、`:823`），而 `getElementById` 返回**文档序靠前**的那一个 —— 即隐藏的 A 份。结果：点「关于我」→ `_renderAboutMePane()`（`skills.js:219`）→ `renderPersonalOntology()` 老老实实渲染进了看不见的壳，B 份永远是空的死壳。

更糟的是 `personal-onto-sidebar-actions` 只有 B 份有，于是导航写进 A、按钮区写进 B，渲染被劈成两半。

判定保留 B 份的依据（三处一致）：

- `boot.js:522` 注释：「个人本体已内嵌为「关于我」tab」
- `personal-ontology.js` 文件头：「嵌入"认知资产 -> 记忆内容 -> 关于我"」
- 只有 B 份带渲染代码需要的 `personal-onto-sidebar-header` / `-actions`

**修复**：删除 A 份骨架与其重复的角色模板库弹窗，`index.html` 现存唯一一份在 `:593` 的「关于我」tab 内（`:595` `panel-personal-ontology`，`:603` `personal-onto-nav`）。同步移除 `skills.js` 中指向已删 id 的分支。

## 5. 改动清单

```
 src/renderer/index.html                       | 40 +++-----------------
 src/renderer/modules/skills.js                | 13 +++-----
 src/renderer/style.css                        |  5 +++
 test/renderer/recall-cognition-flow.test.ts   | 10 +++---
 test/renderer/skills-cognition-layout.test.ts | 30 ++++++++++++++
```

| 文件 | 改动 |
|---|---|
| `src/renderer/style.css:19256-19260` | 新增 `.skills-cognition-page[hidden] { display: none; }` 及说明注释 |
| `src/renderer/index.html:467-473` | 删除「能力资产」页内的 `recall-personal-ontology-section` 骨架与重复弹窗，留注释说明为何不能再放第二份 |
| `src/renderer/modules/skills.js:1604` | `renderSkillsCognitionAssets` 移除 `personalOntologyHost` 分支，该页只负责「已沉淀信息」小标题显隐 |
| `test/renderer/skills-cognition-layout.test.ts` | +3 条回归 |
| `test/renderer/recall-cognition-flow.test.ts` | 原测试断言的是重复 DOM 的旧行为，改为断言资产页不渲染个人本体 |

## 6. 新增契约（后续开发者必须遵守）

三条都由测试守住，违反会红：

1. **`.skills-cognition-page` 的 `[hidden]` 守卫必须存在且在顶层**
   任何给 pane 类加 `display` 的改动，都必须同时保留这条守卫。
2. **`index.html` 全文件 element id 唯一**
   认知资产页把技能库、个人本体整体内嵌，合并时极易两份骨架同时保留。重复 id 不会报错，只会让被内嵌的 tab 静默变成死壳。
3. **个人本体骨架只能出现在「关于我」tab 内**
   `personal-onto-nav` / `-main-body` / `-template-library-modal` 三个 id 各只能出现一次，且位置必须在 `skills-cognition-about-me` 之后。

推论性规则（未写成测试，但同类风险）：**凡是靠 `el.hidden = ...` 控制显隐的元素，其 class 若在任何作者样式表里被赋予 `display`，就必须配一条 `[hidden]` 守卫。**

## 7. 验证

**功能验证**（CDP 实测，修复后重启）：

| tab | pane y | 在视口内 | 可点元素数 |
|---|---|---|---|
| captures | 96 | 是 | 13 |
| assets | 96 | 是 | 5 |
| my-abilities | 96 | 是 | 260 |
| about-me | 96 | 是 | 51 |
| sources | 96 | 是 | 18 |

非当前 pane 一律 `display: none`、`height: 0`。「关于我」的 `personal-onto-nav` 实测 `y=137 h=604`，`main-body` `y=163 h=577`；点击「角色模板库」弹窗正常打开并列出 9 个模板 —— 交互链路确认可用。

**连带排查**（全视图扫描，确认无同类残留）：

- 遍历 memory / spaces / contexts / auto / marketplace / connections / settings / recall 八个视图 + 认知资产六个 tab，扫描 `el.hidden === true && getComputedStyle(el).display !== 'none'`：**0 命中**（全页 59 个 hidden 元素）。
- 运行期重复 id：**0**。
- `overflow: hidden` 且内容被裁切的容器：仅 `.ability-asset-row-summary`（`clientH 17 / scrollH 104`），是列表行摘要的单行截断，符合预期。

**测试**：

- `personal-ontology` / `skills-cognition-layout` / `recall-cognition-flow` 三个文件 **80 passed**。
- 全量 `npm run test:js`：**8488 passed / 32 failed**。失败项与改动前完全相同，全部在本次改动之外（guardrail 安全扫描、builtin 资源与签名 gate、hub-account 分支带来的 `lazy-features` 与 `skills.secpanel_nseap*` 漂移），非本批引入。
- `npm run typecheck` 通过。

## 8. 遗留项

- `cognition.personal_ontology_section` / `_hint` 两个文案键随 A 份骨架删除后不再被任何 markup 引用，四语言里仍保留，`skills-cognition-layout.test.ts` 仍断言其存在。无害，但属于死键，后续可清。
- 「能力资产」页选中「关于我」分类时不再内嵌本体，改由独立 tab 承载。若产品希望恢复"在资产页里直接看本体"的形态，正确做法是**移动**唯一那份骨架，而不是再复制一份。
