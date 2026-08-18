# KStar 教训沉淀实机验证场景（高质量跨门槛）

> 日期：2026-08-15
> 实例：source Electron（CogSeed-Backend-Test，variant=cogseed）
> 代码：`f99d59ea`（statement 富化 + lesson 持久化）
> 目的：验证**带教训的沉淀**——一次真实任务让 Agent 遇到缺口 → review 产生偏离/gap → 沉淀的资产是"推理出的教训"（非模板句、五类证据、可直接复用）

## 设计原则

要产生教训，任务必须满足：
1. **Agent 没有现成资产覆盖**（检索不到完全匹配的 → 需要探索）
2. **有一定复杂性**（多步骤、需要判断，不是简单问答）
3. **有真实缺口可能**（某个环节 Agent 可能做得不完整/不理想）
4. **产生产物**（报告/文件 → artifact_file 证据）

## 场景：审查一个跨模块的权限链路（无现成资产）

**用户消息**：
> 审查一下本地 Agent 运行时的权限控制链路：从 IPC 调用入口到 tool 执行的 path-sandbox 检查，梳理出完整的权限校验链，评估有没有绕过 path-sandbox 的路径，输出一份权限审计报告

**为什么这个任务容易产生教训**：
- 跨 3+ 模块（ipc → features → util/path-sandbox）——Agent 需要自己找链路
- 涉及安全判断（"有没有绕过路径"）——需要严谨验证，容易有判断缺口
- 无现成资产覆盖（现有 6 个资产都是 group-chat 审查类）
- 产出报告 → artifact_file 证据

## 预期链路

| 环节 | 预期 |
|---|---|
| ① 宿主路由 | 确定性建任务 + 投影（已有测试保障） |
| ② 预测 | commit_forecast（2–4 候选） |
| ③ 执行 | Agent 探索 3+ 模块，读文件、找链路 |
| ④ 复盘 | 模型推理归因；**若发现缺口/偏离 → lesson** |
| ⑤ 沉淀 | **新 aa-* 资产**：statement = 推理教训（非模板句）+ 五类证据 |

## 验收标准

**成功（教训沉淀）**：
- 新资产产生，statement 含实质内容（不是"该审查方法可复用"式空话）
- statement 含 lesson 内容（模型推理的教训）
- evidenceRefs 含 artifact_file（报告）+ conversation + execution_evaluation
- 资产可被检索（下次相关任务命中）

**部分成功（无教训但链路对）**：
- 无新资产（review 判定 met_expected 或 gap 不足 0.15）——但 review 有完整记录
- 这本身是有效数据：说明任务没有暴露缺口

**失败**：
- 任务没进治理线（task-state 无新增）——不应发生（宿主路由确定）

## 数据核对

1. task-states/ requirements/ projections/ 新增（确定性）
2. world-model-forecasts/ +1
3. episodes/ 新增 + projectionId/forecastId
4. reviews/ lesson 字段存在（若模型产出）
5. **ability-assets/ 新增资产**（核心看点）
   - statement 是否实质
   - evidenceRefs 五类来源
6. usage-records matchScore（沉淀后下次检索的数据基础）
