# Phase 6 — 最终验收索引

> 2026-08-26 · 分支 `feat/run-center-v1-hardening`

| 文档 | 内容 |
|---|---|
| [`RC-T06-final-acceptance.md`](./RC-T06-final-acceptance.md) | **主文档**：Debt Gate、回归矩阵、Phase 6 发现的真实 bug、RC-DONE 逐项证据、架构债务最终复审 |
| [`RC-T02-T03-coverage-audit.md`](./RC-T02-T03-coverage-audit.md) | 主链与 invariant 的覆盖审计（逐条 DoD → 测试位置 → 条数） |
| [`RC-T04-e2e.md`](./RC-T04-e2e.md) | 跨层闭环 E2E 的 8 个场景与两处 fixture 教训 |
| [`RC-T05-layout-smoke.md`](./RC-T05-layout-smoke.md) | 布局冒烟脚本用法、16 项检查、CI 边界说明 |
| [`rc-t05-smoke.json`](./rc-t05-smoke.json) | 冒烟原始记录（四档 64 项，failures 0） |

## 一句话结论

- **Debt Gate**：GO —— D-1 / D-2 / D-3 / D-9 均不会让 Phase 6 出现假通过或非确定性
- **测试**：RC-T02/T03 115 · RC-T04 8 · RC-T05 64 checks · baseline 266/7 · full 9606 passed / 24 failed（已知集）
- **真实 bug**：1 个（`sessionProjection` 清空 native 幸存任务详情），已修并三向钉死
- **架构债务**：四条全部保持 open，未被错误清零
- **RC-DONE**：可以关闭
- **两项如实记录的例外**：① 全量覆盖率报告在本环境不产出，阈值未测得（既有状况，非本轮引入）；② 全量下 PDF/附件家族有一条时序敏感用例偶发失败，每次不同，隔离均通过

## 复现方式

```bash
npm run test:js                    # 全量（官方入口，勿用裸 npx vitest run）
node scripts/run-tests.mjs run test/renderer/run-center-e2e.test.ts   # RC-T04

# RC-T05 需要先起应用
./node_modules/.bin/electron . --remote-debugging-port=9222 &
npm run smoke:run-center
```

## 下一阶段

RC-DONE 之后的全部遗留项 → **[`../../post-v1-followups.md`](../../post-v1-followups.md)**。
P1 两条：**FU-1**（`waiting_user` 使会话长期显示「处理中」）、**TI-1**（CI 实际没有 coverage 门禁）。
