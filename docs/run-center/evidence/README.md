# Run Center v1 — 实机验证证据与工具

本目录保存 2026-08-26 审查 `0c0b7907` 时的**实机验证工具与产物**。
它们是 spec 中 F-11 / F-19 / F-20 三条事实的原始证据，也是 `RC-T05`（布局冒烟脚本）的起点。

## 环境前提

```bash
# 1. 切到被审查的 commit（或后续的 hardening 分支）
git switch --detach 0c0b7907

# 2. 带远程调试端口启动（关键：普通 npm start 不开这个端口）
./node_modules/.bin/electron . --remote-debugging-port=9222 > /tmp/cogseed-run.log 2>&1 &

# 3. 等窗口起来（日志出现 renderer/conversation 即可）
```

> Node 24 自带 WebSocket，脚本无需任何依赖。
> 注意：`curl` 在部分沙箱下被拒，脚本用 `node:http` 访问 CDP。

## 工具

### `cdp-eval.mjs` — 在页面里执行表达式 / 截图

```bash
# 执行表达式并打印返回值
node docs/run-center/evidence/cdp-eval.mjs eval "document.querySelectorAll('.dashboard-board-card').length"

# 先执行表达式，等 N 毫秒，再截图
node docs/run-center/evidence/cdp-eval.mjs shot /tmp/out.png "document.getElementById('run-center-btn').click()" 2500
```

### `cdp-capture.mjs` — 指定视口宽度下导航到 Run Center 并截图

```bash
node docs/run-center/evidence/cdp-capture.mjs /tmp/out.png 1456 900
```

会自动：设置视口 → 点击「运行中心」→ 切到「看板」tab → 截图 → 打印各列的
`column=count` 与是否 `<CLIPPED>`（即该列右边界是否超出 `.run-center-main`）。

**这是 `RC-T05` 的直接原型。** RC-T05 要做的是把它固化成 720/1050/1456/1920 四档断言。

## 已保存的产物

> **截图说明**：所有看板截图都裁掉了左侧栏（视口 x < 260px）。侧栏渲染的是本机真实会话列表，与被验证的看板布局无关。裁剪只去掉左侧 260px，右侧边界与列宽均未改动，`<CLIPPED>` 判定不受影响。

| 文件 | 证明什么 |
|---|---|
| `board-1456px-completed-column-CLIPPED.png` | **F-20**。标准 MacBook 宽度下看板三列全显示「暂无任务」，而「已完成」列有 8 张卡片被完全裁在屏幕外。用户第一眼看到的是「这功能没数据」 |
| `board-1980px-completed-column-visible.png` | 同一份数据在 1980px 下的正确形态：已完成列 8 张卡片，父卡片带「进度 2/2」进度条 |

对应实测输出：

```
1456px: ["pending=0","running=0","attention=0","completed=8 <CLIPPED>"]
1980px: ["pending=0","running=0","attention=0","completed=8"]

已完成列 left = 1152px  ==  .run-center-main right = 1152px
board 需要 820px / 中间栏仅 608px / 溢出 212px / 无滚动条
```

## 另外两条事实的复现方法（脚本未保存，方法记录在此）

### F-19 —「打开任务」按钮不可达

```js
// 在 Run Center 选中任意任务后执行
JSON.stringify({
  hasOpenBtn: !!document.querySelector('[data-run-center-open]'),
  btns: [...document.querySelectorAll('.run-center-detail-actions button')].map(b => b.textContent.trim()),
})
// 实测结果：{ hasOpenBtn: false, btns: [] }
```

### F-11 — Refresh 不刷新 detail / timeline / collaboration

用 MutationObserver 捕捉 `select()` 必然产生的 `state.detail = null` 中间态
（该中间态会让面板瞬间渲染出「正在加载详情…」）：

```js
const loadingText = t('run_center.loading_detail');   // 「正在加载详情…」
const seen = [];
new MutationObserver(() => {
  const main = document.querySelector('.run-center-main');
  if (main && main.textContent.includes(loadingText)) seen.push('LOADING_DETAIL');
}).observe(document.getElementById('run-center-root'), { childList: true, subtree: true });

document.querySelector('[data-run-center-refresh]').click();
// 2.5s 后检查 seen
// 实测结果：seen 中无 LOADING_DETAIL，且刷新前后 .run-center-main 内容逐字相同
```

> 注意：**无法用 hook `window.cogseed.invoke` 的方式验证** ——
> 实测 `Object.getOwnPropertyDescriptor(window,'cogseed')` 为
> `{writable:false, configurable:false, frozen:true}`（contextBridge 冻结），
> 运行时覆盖会静默失败。这也是 `RC-T01` 必须在加载 `run-center.js` **之前**
> 注入 mock 的原因。
