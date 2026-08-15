# KStar 路由提升实机验证场景

> 日期：2026-08-14
> 实例：source Electron（Mate-Backend-Test worktree，variant=cogseed，重启后 PID 92661）
> 数据根：`~/.cogseed/runtime-variants/cogseed/data`（uid 78967691）
> 基线提交：`373e93a9`（路由提升层 1 + 层 2）
> 目的：验证**常规用户措辞**也能进入 KStar 治理线（投影 + 预测 + R̂/R 比较 + 沉淀）

## 背景（为什么需要这次验证）

2026-08-14 首次实机验证发现：常规措辞"审查一下 X"被 Commander 默认 `kstar:skip`
跳过 → 任务直接执行 → 无 projection/forecast → 复盘只有"任务文本 vs 实际"（模型判定
met_expected），**预测 vs 实际的真实比较从未触发** → 无沉淀。

修复（`373e93a9`）：
- **层 1**：宿主任务意图检测 → Commander prompt 注入 `## Host routing hint`（advisory）
- **层 2**：派发即任务——`dispatch_to`/`hand_off_to`/具名 `run_worker` 无任务时
  宿主自动建任务 + 自动确认投影，该次派发放行（`allowHostAutoTracked`）

## 场景 A：常规措辞的正式审查任务（核心验证）

**用户消息**（完全常规，无任何"正式任务"措辞）：
> 审查一下 group_chat bus.ts 里的 `guardKstarPrivilegedDispatch` 是怎么实现拦截的，把审查结果整理成一份报告

### 预期链路与验证点

| 节点 | 预期行为 | 数据验证点 |
|---|---|---|
| ① 层 1 意图检测 | 消息含"审查/实现/整理"信号 + 长度足够 → 非寒暄 → 检测为任务 | 日志/注入可见 `Host routing hint`（可查会话注入，若不方便可跳过） |
| ② 层 2 派发即任务 | Commander 调 dispatch_to 派 Agent 时，宿主发现无任务 → 自动 upsert_state + request_projection（confirmed） | `cloud/kstar/task-states/` 新增 state；`requirements/` 新增 requirement；`projections/` 新增 confirmed 投影（purpose 非 conversation_reply） |
| ③ 预测 | Commander 收到层 1 提示/层 2 状态后补 commit_forecast（2–4 候选） | requirement 有 `forecastId`；`world-model-forecasts/` 新增记录 |
| ④ 执行 | 派发放行（allowHostAutoTracked）→ Agent 执行 → completed | episode 有 `forecastId` 指向该预测 |
| ⑤ 复盘 R̂ vs R | `reconcileWorldModel(forecast, episode)`：真实比较预测工具/计划/验收 vs 实际 | review 的 `inferenceMethod: 'model'`（有 forecast 走模型推理）；`actionDelta`/`resultDelta` 存在；若结果符合预期则 deltaR≈0 + 无 lesson（正确），若有偏离则 lesson |
| ⑥ 沉淀 | 若 review 有偏离（deltaR 非 0 或 gap）→ 直接入能力资产；若 met_expected → 不沉淀（正确） | 新 `aa-*` 或明确无沉淀原因 |

### 关键验收（区别于上次失败）

1. **requirement 有 forecastId** ← 上次 `forecastId: None`，这次必须有
2. **episode 有 forecastId** ← 证明"预测先有、实际后有、比较真实发生"
3. **投影是正式投影**（非 `proj-auto-*`/`conversation_reply`），由层 2 自动创建
4. review 的 `actionDelta` 字段存在（预测 vs 实际的工具/步骤对比）

## 场景 B（可选）：寒暄零写入不回归

**用户消息**：
> 你好

**预期**：不产生任何 KStar 写入（无 task-state/requirement/投影变化）、无 `Host routing hint`、无沉淀。验证层 1 检测不会误伤寒暄。

## 数据核对清单（验证后）

1. `cloud/kstar/task-states/` — 新增（层 2 自动创建）
2. `cloud/kstar/requirements/` — 新增，`forecastId` 非空 ← 核心
3. `cloud/recall/records/projections/` — 新增非 auto 投影，status=confirmed
4. `cloud/kstar/episodes/` — 新增，`forecastId` 非空
5. `cloud/kstar/reviews/` — 新增，`inferenceMethod`、`actionDelta`、`lesson`
6. `cloud/recall/records/ability-assets/` — 新增（若沉淀发生）
7. 日志 — 无 ERROR；`kstar.control` 记录 upsert_state/request_projection 成功

## 风险与判定

| 情况 | 判定 |
|---|---|
| requirement 无 forecastId | 层 1 提示未生效或 Commander 仍 skip → 记录，考虑层 3（反转默认） |
| 层 2 自动建任务但 Commander 未补 forecast | 派发已放行执行（设计如此），复盘退化为无预测比较 → 记录 |
| review 为 model + actionDelta 存在 | **核心目标达成**：预测 vs 实际真实比较发生 |
| review met_expected + 无 lesson | 正确（无偏离无沉淀），不算失败 |
| 出现 aa-* 新资产 | 沉淀生产侧验证完成 |
