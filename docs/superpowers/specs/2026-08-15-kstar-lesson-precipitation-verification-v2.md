# KStar 教训沉淀实机验证场景 v2（真实缺口版）

> 日期：2026-08-15（09:54 重启，合并 develop 后）
> 实例：source Electron（CogSeed-Backend-Test，variant=cogseed，PID 7379）
> 代码：`0fadcce5`（合并 develop 48 提交）+ 前序全部修复
> 目的：验证**带推理教训的新资产沉淀**——这是从"能运行"跨到"高质量"的关键实证

## 为什么用"真实缺口"设计

前几轮实机都是"完美完成任务"（met_expected）→ 阈值门正确不沉淀 → 无法检验 lesson 质量。
要验证教训沉淀，任务必须让 Agent 遇到**真实缺口**（不是伪造错误）——最好的方式：
让它审查**我们刚合并、确实有潜在问题的代码**（合并引入的类型断言、行为变化），
Agent 若发现真实问题 → review 产生 gap/偏离 → 沉淀带教训的资产。

## 场景：审查合并引入的 custom_providers 行为变化

**用户消息**：
> 审查一下合并 develop 后 custom_providers.ts 的 storeActiveCliConfig 行为变化：重点看类型断言处（as { error: string }）是否可能掩盖运行时错误，以及 active CLI 配置存储的幂等性有没有问题，输出一份审查报告

**为什么容易产生教训**：
- 我们刚在 `ipc/index.ts` 用 `as { error: string }` 绕过 TS 窄化——**这本身是代码异味**（合并冲突修复），Agent 很可能指出它掩盖了运行时错误 → 真实 gap
- 合并 48 个提交后 custom_providers 重构过（develop 版）——行为变化需要验证 → 可能发现不一致
- 幂等性审查（重复存储是否重复建 provider）——有真实逻辑可查
- 产出报告 → artifact_file 证据

## 预期链路

| 环节 | 预期 |
|---|---|
| ① 宿主路由 | 确定性建任务 + 投影（不依赖模型） |
| ② 预测 | commit_forecast（2–4 候选） |
| ③ 执行 | Agent 读 custom_providers.ts + ipc/index.ts，分析行为 |
| ④ 复盘 | 模型推理归因；**若发现 gap → lesson**（如"合并冲突的类型断言会掩盖错误，应改为显式判别"） |
| ⑤ 沉淀 | **新 aa-* 资产**：statement = 推理教训 + 五类证据 |

## 验收

**成功**：
- 新资产产生，statement 含实质教训（非模板句）
- lesson 持久化生效（`f99d59ea` 修复后首次实机验证）
- evidenceRefs 含 artifact_file + conversation

**部分成功**：
- 无新资产但 review 有完整记录（Agent 没发现缺口）——有效数据

## 数据核对

1. task-states/ requirements/ projections/ 新增（确定性）
2. forecasts +1
3. episodes/ + projectionId/forecastId
4. reviews/ **lesson 字段**（核心）
5. ability-assets/ 新增（若沉淀）——statement 实质 + 五类证据
6. 日志无 kstar.control 连续失败
