# RC-T05 — 布局冒烟脚本固化

> 2026-08-26 · `scripts/run-center-layout-smoke.mjs` · `npm run smoke:run-center`

## 1. 为什么必须是脚本而不是单测

jsdom **不做 layout**：`getBoundingClientRect()` 恒为 0，
「completed 列在屏幕内」这类断言在那里**恒真**，等于没测。
而 RC-P0-06 / F-20 恰恰是纯布局缺陷 —— 1456px 下 8 张卡片完全在屏幕外、
且没有滚动条，看板读起来像「这功能没数据」。

本脚本用 CDP 驱动**真实应用**，对**真实矩形**断言。

## 2. 用法

```bash
# 1. 带调试端口启动
./node_modules/.bin/electron . --remote-debugging-port=9222

# 2. 跑冒烟
npm run smoke:run-center
#   或 node scripts/run-center-layout-smoke.mjs [--port 9222] [--json]
```

全部通过时退出码 0，任一失败为 1。Node 24 自带 WebSocket，**零依赖**。

## 3. 每档 16 项检查

四档 720 / 1050 / 1456 / 1920，每档：

**布局**
1. 四个看板列都在 DOM
2. **没有列的 `right` 超出 `.run-center-main`**（RC-P0-06 的核心断言）
3. 页面不产生横向滚动
4. 没有卡片溢出所属列

**控件可达**
5. tabs ≥ 3、search 可见、4 个 filter 可见
6. 看板上 4 个 filter 均可用

**无假能力**
7. 全页无 resume 按钮
8. 无 `data-run-center-open=""` 的空目标出口

**身份**
9. 每张卡片的 identity 两两不同

**Runs 视图**
10. filters 隐藏且 0 个可用（RC-P2-11）
11. 运行树 identity 两两不同
12. Runs 视图无 resume

**详情**
13. 出口文案含「conversation / 会话」且**不含 retry / resume / 重试 / 恢复**
14. 出口指向真实 cid
15. 会话已删除的任务**不同时出现说明与出口**（c2）
16. 详情区无 resume

## 4. 实测结果（2026-08-26）

**64 / 64 全部通过**，`failures: 0`。原始记录：[`rc-t05-smoke.json`](./rc-t05-smoke.json)。

| 宽度 | `mainRight` | 列裁切 | 卡片 | identity |
|---|---|---|---|---|
| 720px | 704 | 无 | 12 | 12 distinct |
| 1050px | 1023 | 无 | 12 | 12 distinct |
| 1456px | 1157 | 无 | 12 | 12 distinct |
| 1920px | 1511 | 无 | 12 | 12 distinct |

出口文案实测为「打开会话」（zh），符合 Phase 2→3 语义联动的要求。

**对比基线（`0c0b7907`，F-20）**：1456px 下 `completed=8 <CLIPPED>`，
列 `left=1152` == `.run-center-main` 的 `right=1152`，溢出 212px 且无滚动条。

## 5. CI 边界

**本脚本不进 CI，本轮也没有改动任何 CI 配置。**

- 新增：`scripts/run-center-layout-smoke.mjs`、`package.json` 的 `smoke:run-center`
- **未改动**：GitHub Actions workflow、required checks、release gate；未新增 CI 内的 Electron/CDP 运行

如果将来要接，最小接法是在一个**独立的、非必需(non-required)**的 workflow 中：
先以 `xvfb-run` 启动 `electron . --remote-debugging-port=9222`，
等待 `/json/list` 就绪后执行 `npm run smoke:run-center`。
这需要 CI 具备图形栈，属于基础设施决策，**未经确认不实施**。
