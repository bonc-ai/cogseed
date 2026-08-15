# KStar 混合路由 + 用户行为闭环 实机验证场景

> 日期：2026-08-15（14:03 重启，PID 23991）
> 代码：`4324c5dd`（混合路由：确定性过滤 + 模型判断）
> 数据根：`~/.cogseed/runtime-variants/cogseed/data`（uid 78967691）
> 基线：forecasts=3，task-states=23

## 验证目标

1. **混合路由生效**：明显寒暄零调用零写入；任务形消息（含弱动词）被模型识别并建任务
2. **用户行为闭环**：发新需求 → 旧任务自动 finish 收尾 + requirement 级沉淀 → 建新任务
3. **延续不闭环**：发修改意见 → 任务保持 open，episode 累积

## 场景（三步对话）

### 步骤 1：开一个任务（新会话）

**用户消息**：
> 帮我审查一下 group_chat bus.ts 里的 guardKstarPrivilegedDispatch 是怎么实现拦截的，输出一份报告

**预期**：
- 模型判断 is_task=true → 建任务 + 确认投影
- 任务执行 → episode → 复盘（Commander 上下文 review）

### 步骤 2：发新需求（验证闭环沉淀）

**用户消息**：
> 帮我写一个 Python 脚本，把 data/logs 下的所有 .log 文件按日期归档到子目录

**预期**：
- 模型判断 continuation=false（新任务）→ **旧任务自动 finish + requirement 沉淀**
- 新任务建立 + 执行
- 旧 requirement 的 episode/review → 聚合沉淀资产（若有教训）

### 步骤 3：发寒暄（验证零写入）

**用户消息**：
> 谢谢，辛苦了

**预期**：
- `isObviouslyTrivial` 命中 → **零模型调用、零 KStar 写入**
- task-states / requirements 数量不变

## 数据核对清单

1. 步骤 1 后：task-states 24+，新 requirement + 投影
2. 步骤 2 后：
   - 旧 requirement status=waiting_review（被 finish）
   - 旧任务 status=closing
   - **ability-assets 新增**（若有教训；met_expected 无教训则无新资产，但 review 有记录）
   - 新 task-state + 新 requirement
3. 步骤 3 后：task-states/requirements 数量不变
4. 日志：无 kstar.control 连续失败；judge 无死锁（每次用户消息不卡 20s）

## 判定

| 结果 | 判定 |
|---|---|
| 步骤 2 旧任务 closing + waiting_review | ✅ 用户行为闭环生效 |
| 步骤 3 数量不变 | ✅ 寒暄零写入 |
| judge 每次 <2s（无 20s 超时） | ✅ 无死锁 |
| 新资产产生 | ✅ 完整闭环（沉淀） |
