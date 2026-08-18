# KStar 自进化闭环实机验证场景（无确认版）

> 日期：2026-08-14（23:43 重启）
> 实例：source Electron（CogSeed-Backend-Test，variant=cogseed，PID 96127）
> 数据根：`~/.cogseed/runtime-variants/cogseed/data`（uid 78967691）
> 代码：`76b42dde`（取消复盘确认）+ `5ab8d4ce`（kstar_control 调用示例）+ `5674d0d9`（ONCE 修复）+ `373e93a9`（路由提升）
> 目的：验证**零用户确认**的完整自进化闭环（常规措辞 → 治理线 → 预测 → 执行 → 自动复盘 → 自动沉淀）

## 背景

前几轮实机验证的累积修复：
- 常规措辞被默认 skip → 层 1 提示 + 层 2 派发即任务（`373e93a9`）
- Commander 不会用 kstar_control → prompt + schema 加调用示例（`5ab8d4ce`）
- hand_off_to 可绕过 forecast 门禁 → ONCE 语义修复（`5674d0d9`）
- 用户无法核对预期/实际 → 复盘确认取消，自进化自动沉淀（`76b42dde`）

## 场景：常规措辞审查任务（零用户确认）

**用户消息**（完全常规）：
> 审查一下 group_chat bus.ts 里的 `guardKstarPrivilegedDispatch` 是怎么实现拦截的，把审查结果整理成一份报告

### 预期链路（全自动，无任何用户确认步骤）

| 节点 | 预期 | 验证点 |
|---|---|---|
| ① 层 1 | 意图检测命中 → Commander prompt 有 routing hint | 日志/行为 |
| ② 路由 | Commander 正确调用 kstar_control（**不再 4 次失败**） | 日志 `kstar.control` 无 invalid_input 错误 |
| ③ 建任务 | upsert_state 成功（task + requirement） | task-states/requirements 新增 |
| ④ 投影 | request_projection 成功（confirmed） | projections 新增正式投影 |
| ⑤ 预测 | commit_forecast 成功（2–4 候选） | **forecasts 从 0 → 1+**；requirement.forecastId 非空 |
| ⑥ 执行 | 派发 → Agent 执行 → completed | episode.forecastId 非空 |
| ⑦ 复盘 | 模型推理归因（有 forecast → 模型路径） | review: inferenceMethod=model, actionDelta 存在 |
| ⑧ 沉淀 | **无任何确认** → 自动沉淀或明确判定 | 新 aa-* 资产（若 ΔR/gap 达标）；review 恒 inferred |

### 关键验收（本次新增）

1. **全程无确认卡片**——用户只发消息、看结果，不会被"请确认 KSTAR…"打断
2. **Commander 一次成功**——kstar_control 不再 invalid_input
3. **forecast 从 0 → 1**——预测环节首次实机成功
4. **review 恒为 inferred**（无 needs_confirmation 等待）
5. review 有 actionDelta（真实 R̂ vs R 比较）

## 数据核对清单

1. `cloud/kstar/task-states/` — 新增
2. `cloud/kstar/requirements/` — 新增，forecastId 非空
3. `cloud/recall/records/projections/` — 新增正式投影
4. `cloud/recall/records/world-model-forecasts/` — **从 0 变非 0**
5. `cloud/kstar/episodes/` — 新增，forecastId 非空
6. `cloud/kstar/reviews/` — inferenceMethod=model, actionDelta, 无 needs_confirmation
7. `cloud/recall/records/ability-assets/` — 新增（若沉淀）
8. 日志 — `kstar.control` 无连续失败

## 判定

| 情况 | 判定 |
|---|---|
| forecasts 0→N + review 有 actionDelta | **核心目标达成**：预测→执行→真实比较→自进化 |
| 无确认卡片出现 | 自进化语义达成 |
| kstar_control 仍失败 | prompt 示例不足 → 继续修 |
| 无沉淀（met_expected） | 正确（无偏离无教训），不算失败 |
