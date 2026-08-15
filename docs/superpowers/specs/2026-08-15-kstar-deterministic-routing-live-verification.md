# KStar 确定性宿主路由实机验证场景（最终版）

> 日期：2026-08-15（00:22 重启）
> 实例：source Electron（Mate-Backend-Test，variant=cogseed，PID 1626）
> 数据根：`~/.cogseed/runtime-variants/cogseed/data`（uid 78967691）
> 代码：`9f20dfc2`（确定性宿主路由）+ 前序全部修复
> 基线：forecasts=0，task-states=21

## 核心变化（本次验证的要点）

**路由不再依赖模型**：任务形用户消息 → 宿主直接建任务 + 确认投影（Commander 开始前完成）。
模型唯一 KStar 职责 = `commit_forecast`（预测本身）。

## 场景：常规措辞审查任务（第 4 次实机）

**用户消息**（完全常规，新会话）：
> 审查一下 group_chat bus.ts 里的 `guardKstarPrivilegedDispatch` 是怎么实现拦截的，把审查结果整理成一份报告

### 预期（分确定性部分 + 模型部分）

| 环节 | 确定性（宿主） | 预期数据 |
|---|---|---|
| ① 任务创建 | ✅ **100%**（宿主 upsert_state） | task-states 21→22+ |
| ② 投影确认 | ✅ **100%**（宿主 request_projection） | 新正式投影（非 proj-auto），confirmed |
| ③ requirement 绑定 | ✅ **100%** | 新 requirement 带 projectionId |

| 环节 | 模型 | 预期数据 |
|---|---|---|
| ④ commit_forecast | ⚠️ 依赖模型 | forecasts 0→1（若成功）；requirement.forecastId |
| ⑤ 执行 | ✅ 派发/自执行 | episode 带 projectionId（无论 forecast 成败） |
| ⑥ 复盘 | ✅ 模型推理 | review: inferred, model；**有 forecast 时 actionDelta 存在** |
| ⑦ 沉淀 | ✅ 自动 | 新 aa-* 或明确判定（met_expected 无教训则无沉淀） |

### 判定标准

**成功标准（这次的定义）**：
1. task-states 新增 + 正式投影 confirmed —— **确定性，必须达成**
2. episode.projectionId 非空 —— 执行被治理
3. 无确认卡片、review 恒 inferred —— 自进化语义
4. **若 forecasts 0→1**：完整闭环达成（预测→执行→R̂ vs R 比较）
5. **若 forecasts 仍 0**：任务仍被跟踪+投影确认（比之前"完全没进治理线"进步），但预测环节需继续观察

## 数据核对清单

1. task-states/ 新增
2. requirements/ 新增，projectionId 非空
3. projections/ 新增正式投影（status=confirmed）
4. world-model-forecasts/ 数量（0→1?）
5. episodes/ 新增，projectionId 非空（forecastId 可选）
6. reviews/ inferred + model，actionDelta（若 forecast 存在）
7. ability-assets/ 新增（若沉淀）
8. 日志：无 kstar.control 连续失败；host routing 无 warn

## 说明

即使模型这轮又不提交 forecast，验证仍算**部分成功**：任务跟踪+投影+执行治理已确定达成。
后续只需解决 forecast 提交（模型单点），不再需要重测路由。
