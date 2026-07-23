# P3394 Team2 Route B 今日任务卡

> 来源：`P3394_Team2_RouteB_任务梳理.docx`、当前 Mate Agent 开发进度、远程协作现实情况。  
> 目标：把未完成任务拆成今天可以直接执行、可以验收、可以进入 Gate 证据链的任务卡。  
> 协作前提：牛宝康远程工作，因此所有远程任务必须通过录屏、截图、日志、文档异步验收。

## 0. 今日总目标

今天只抓一条主线：

```text
统一Schema
→ 反假调度
→ 项目导入
→ 项目理解
→ 执行前确认
→ 真实Agent运行
→ Evidence审查
```

不先做大而全，不先做美化，不先做泛化能力。先把 Route B 的可信 Golden Path 跑出来。

---

# A. 牛宝康任务卡：远程入口与确认层

## A1｜US-01｜Mac端快速启动证据补齐

**负责人**：牛宝康  
**协作方式**：远程异步  
**优先级**：P0  
**截止建议**：今天中午前

### 任务目标

证明 Mate Agent 能在远程 Mac 环境从零启动，并能看到真实桌面入口。

### 输入

- 当前仓库 README / 启动说明
- 当前 Mate Agent 代码包

### 需要做什么

1. 按 README 或现有启动步骤从零启动。
2. 录屏记录启动过程。
3. 记录环境信息：
   - macOS 版本
   - 芯片类型：Intel / Apple Silicon
   - Node 版本
   - npm 版本
   - 是否遇到 Python/runtime 下载问题
4. 整理 Known Issues。

### 交付物

- 启动录屏
- 环境记录
- Known Issues

### 验收标准

- 录屏能看到 Mate Agent 桌面应用打开。
- 不是浏览器页面冒充。
- 有清楚的环境记录。
- 如果失败，也必须有失败日志和失败截图。

---

## A2｜US-02｜固定项目导入与 ReferenceManifest

**负责人**：牛宝康  
**协作方式**：远程异步  
**优先级**：P0  
**前置依赖**：A1，EN-01字段草案  
**截止建议**：今天下午

### 任务目标

完成一次固定 Repo / 固定 Commit 的导入，并说明系统读了什么、没读什么、为什么跳过。

### 输入

- 固定测试 Repo 地址
- 固定 Commit ID
- EN-01 ReferenceManifest 字段草案

### 需要做什么

1. 使用同一个公开 Repo 和 Commit。
2. 执行导入。
3. 记录导入过程截图或录屏。
4. 生成 ReferenceManifest，至少包含：
   - repo_url
   - commit
   - included_files
   - skipped_files
   - skip_reason
   - sensitive_boundary
   - read_time
5. 记录导入失败时的错误提示。

### 交付物

- 导入截图 / 录屏
- ReferenceManifest 样例
- 读取日志
- 失败或跳过文件说明

### 验收标准

- 能看到固定 Repo / 固定 Commit。
- 能看到读了哪些文件、跳过哪些文件。
- 敏感文件边界有说明。
- 不是只写一句“已导入成功”。

---

## A3｜US-04｜TaskContract 执行前确认

**负责人**：牛宝康  
**协作方式**：远程异步  
**优先级**：P0  
**前置依赖**：A2、B2  
**截止建议**：今天傍晚

### 任务目标

Agent 运行前必须先展示任务契约，用户确认后才能执行。

### TaskContract 最小字段

```json
{
  "goal": "",
  "success_criteria": [],
  "context_refs": [],
  "plan": [],
  "risks": [],
  "requires_user_confirmation": true,
  "confirmed_by": "",
  "confirmed_at": ""
}
```

### 需要做什么

1. 基于导入项目和 ProjectContext 写一份 TaskContract。
2. 展示 Goal、Success Criteria、Context、计划、风险。
3. 记录用户确认动作。
4. 如果未确认，明确标记 Agent 不得启动。

### 交付物

- TaskContract 样例
- 用户确认记录
- 截图 / 录屏

### 验收标准

- 未确认不得进入 US-05。
- 确认记录可追溯。
- 成功标准不是空泛描述。

---

## A4｜US-10｜Personal Ontology 使用确认

**负责人**：牛宝康  
**协作方式**：远程异步  
**优先级**：P1，但必须在最终 Gate 前补齐  
**前置依赖**：EN-01字段草案

### 任务目标

展示系统本次任务引用了哪些个人信息，并让用户确认或修订。

### PersonalOntologyRef 最小字段

```json
{
  "owner": "",
  "role": "",
  "preferences": [],
  "projects": [],
  "inbox_sources": [],
  "source": "",
  "scope": "temporary_context_only",
  "confirmed": false
}
```

### 交付物

- PersonalOntologyRef 样例
- 确认/修订记录
- 正式资产未被写入的说明

### 验收标准

- 未经确认只能作为临时上下文。
- 不得直接更新正式 Ontology / Memory。

---

# B. 吴嘉宇任务卡：理解、运行、评估层

## B1｜EN-01｜统一 KSTAR / Evidence Schema

**负责人**：吴嘉宇  
**协作方式**：本地推进，远程同步给全员  
**优先级**：P0  
**截止建议**：今天最先完成

### 任务目标

先定统一字段，避免后面每个人各写各的证据。

### 必须覆盖的 10 个对象

1. PersonalOntologyRef
2. AgentManifestRef
3. SkillManifestRef
4. TaskContract
5. SkillRun
6. RunEvent
7. Artifact
8. Evidence
9. EvaluationRecord
10. PermissionDecision

### 交付物

- `schema.md`
- 每个对象一个最小 JSON 样例
- Evidence 目录结构建议

### 验收标准

- 牛宝康、冯静雯能直接按这个字段产出材料。
- 字段不追求完美，但必须够今天 Golden Path 使用。

---

## B2｜US-03｜ProjectContext 校准

**负责人**：吴嘉宇  
**优先级**：P0  
**前置依赖**：A2  
**截止建议**：今天下午

### 任务目标

把导入项目转成系统理解，并允许用户修正偏差。

### ProjectContext 最小字段

```json
{
  "project_goal": "",
  "tech_stack": [],
  "key_files": [],
  "sources": [],
  "uncertainties": [],
  "review_decisions": []
}
```

### 需要做什么

1. 根据 ReferenceManifest 形成项目理解。
2. 明确写出不确定项。
3. 至少做一处用户修正。
4. 保留修正前后 diff。

### 交付物

- ProjectContext
- ReviewDecision
- diff 截图或文本

### 验收标准

- 不能假装全知道。
- 必须有来源和不确定项。
- 必须有至少一条修正记录。

---

## B3｜US-05 前置｜反假调度 / 失败可见

**负责人**：吴嘉宇  
**协同**：张照航  
**优先级**：P0  
**截止建议**：US-05 前必须完成

### 任务目标

禁止指挥官在没有真实 dispatch / worker 结果的情况下说“已调度、稍等”。

### 需要做什么

1. 检查 Commander 输出链路。
2. 增加调度状态记录：
   - dispatch_requested
   - dispatch_started
   - dispatch_completed
   - dispatch_failed
   - dispatch_timeout
3. 如果没有真实调度事件，不允许生成“已调度”类回复。
4. 失败时必须显示失败原因。

### 交付物

- 代码修改或流程说明
- 测试/验证记录
- 失败场景截图或日志

### 验收标准

- 用户不会再看到无结果的“已调度，稍等”。
- 失败、超时、未授权都可见。
- 不能绕过 Wake Gate。

---

## B4｜US-05｜真实 AgentRun 与 RunEvent

**负责人**：吴嘉宇  
**协同**：张照航  
**优先级**：P0  
**前置依赖**：A3、B3、C2  
**截止建议**：今天晚间

### 任务目标

跑一次真实 Agent 任务，并留下可审查运行记录。

### 需要做什么

1. 基于已确认 TaskContract 启动 Agent。
2. 记录 AgentRun。
3. 持续记录 RunEvent。
4. 明确状态：Running / Completed / Failed。
5. 如果失败，展示失败原因，不吞掉。

### 交付物

- AgentRun JSON
- RunEvent JSONL
- 真实运行日志
- 状态截图 / 录屏

### 验收标准

- 至少一个真实 Agent 执行固定任务。
- 不是静态文本演示。
- 失败状态真实可见。

---

## B5｜US-11｜Skill 展示与评价基线

**负责人**：吴嘉宇  
**协同**：冯静雯  
**优先级**：P1  
**前置依赖**：B1、B4

### 任务目标

说明本次任务调用了什么 Skill，输入输出是什么，如何评价。

### 交付物

- SkillManifestRef
- SkillRun
- EvaluationRecord

### 验收标准

- Skill ID、版本、输入输出、评价标准都可见。
- EvaluationRecord 能和 TaskContract / Evidence 关联。

---

# C. 冯静雯任务卡：审查、安全、扩展契约层

## C1｜NFR-01｜Trust Boundary 与 HITL 规则

**负责人**：冯静雯  
**优先级**：P0  
**截止建议**：今天下午

### 任务目标

定义本次 Golden Path 的安全边界和人工确认规则。

### 需要做什么

1. 定义敏感信息边界。
2. 定义哪些动作需要 HITL。
3. 定义失败时不得写入正式资产。
4. 定义审计记录最小字段。

### PermissionDecision 最小字段

```json
{
  "action": "",
  "risk_level": "low|medium|high",
  "decision": "allowed|denied|requires_human_confirmation",
  "reason": "",
  "decided_by": "system|user",
  "decided_at": ""
}
```

### 交付物

- Trust Boundary 文档
- PermissionDecision 样例
- 脱敏规则
- 审计日志样例

### 验收标准

- 高风险动作必须触发 HITL 或明确说明本次没有高风险动作。
- 失败不得修改正式 Ontology / Memory / Skill。

---

## C2｜US-07｜AgentManifest 扩展契约

**负责人**：冯静雯  
**协同**：吴嘉宇  
**优先级**：P1，但 US-05 需要最小契约  
**截止建议**：今天傍晚前给最小版

### AgentManifest 最小字段

```json
{
  "agent_id": "",
  "capabilities": [],
  "inputs": [],
  "outputs": [],
  "permissions": [],
  "runtime": "",
  "lifecycle": [],
  "failure_behavior": ""
}
```

### 交付物

- AgentManifest 最小契约
- 一个最小扩展示例或验证点

### 验收标准

- 字段够通用，不只适配一个 Agent。
- 能被 US-05 引用。

---

## C3｜US-06｜Artifact + Evidence 审查

**负责人**：冯静雯  
**协同**：吴嘉宇  
**优先级**：P0  
**前置依赖**：B4  
**截止建议**：明天上午前，今晚可先出模板

### 任务目标

Agent 跑完后，把结果和证据关联起来审查。

### 交付物

- Artifact
- Evidence 包
- 审查记录
- PermissionDecision 引用

### 验收标准

- Artifact 能打开。
- Evidence 能追溯到动作、日志、来源。
- 没有 Evidence 的 Artifact 不算完成。

---

# D. 张照航任务卡：协调、集成、Gate

## D1｜依赖看板与收口

**负责人**：张照航  
**优先级**：P0  
**持续进行**

### 任务目标

保证每个人不是各做各的，而是能拼成同一条 Golden Path。

### 需要盯住的阻塞

1. EN-01 不出，所有证据会乱。
2. 反假调度不做，US-05 不可信。
3. US-02 不出，US-03 没来源。
4. US-04 不出，US-05 不能启动。
5. US-06 不出，DISC-B01 没证据。

### 交付物

- 每日进度表
- 阻塞清单
- 证据收集目录

---

## D2｜DISC-B01｜Route B Golden Path

**负责人**：张照航  
**协同**：全员  
**优先级**：P0  
**前置依赖**：A1~A3、B1~B4、C1~C3

### 任务目标

把 Route B 跑成一条可演示、可解释、可决策的证据链。

### Golden Path 最小结构

```text
1. 场景说明
2. 用户启动 Mate Agent
3. 导入固定项目
4. 系统生成 ProjectContext
5. 用户校准理解
6. 展示 TaskContract
7. 用户确认
8. Agent 真实运行
9. 产生 Artifact
10. Evidence 审查
11. 风险和价值分析
12. Gate 评分建议
```

### 交付物

- Golden Path 文档
- 演示脚本
- 证据索引
- 风险清单
- Decision Log 候选
- Gate 评分材料

---

# 8. 今日验收表

| 编号 | 任务 | 负责人 | 今日必须有的证据 | 状态 |
|---|---|---|---|---|
| A1 | Mac启动证据 | 牛宝康 | 录屏 + 环境记录 | 待交付 |
| A2 | 项目导入 | 牛宝康 | ReferenceManifest + 截图/日志 | 待交付 |
| A3 | TaskContract确认 | 牛宝康 | 契约样例 + 确认记录 | 待交付 |
| B1 | EN-01 Schema | 吴嘉宇 | 10对象字段 + JSON样例 | 待交付 |
| B2 | ProjectContext | 吴嘉宇 | 项目理解 + 不确定项 + diff | 待交付 |
| B3 | 反假调度 | 吴嘉宇 | 状态记录 + 失败可见验证 | 待交付 |
| B4 | 真实AgentRun | 吴嘉宇 | AgentRun + RunEvent + 日志 | 待交付 |
| C1 | Trust Boundary | 冯静雯 | PermissionDecision + HITL规则 | 待交付 |
| C2 | AgentManifest | 冯静雯 | 最小契约 + 示例 | 待交付 |
| C3 | Evidence审查 | 冯静雯 | Evidence包模板/审查记录 | 待交付 |
| D1 | 集成看板 | 张照航 | 阻塞清单 + 证据索引 | 待交付 |
| D2 | Golden Path | 张照航 | 演示脚本草案 | 待交付 |

# 9. 发给远程成员的简短任务消息

## 发给牛宝康

```text
宝康，你现在远程，所以你这边任务按异步交付来做，不要求线下同场。

今天优先做三件事：
1. US-01：Mac端从零启动录屏 + 环境记录 + Known Issues。
2. US-02：固定Repo/Commit导入，输出ReferenceManifest，说明读了哪些文件、跳过哪些文件、敏感边界是什么。
3. US-04：基于导入结果写TaskContract，包含Goal、Success Criteria、Context、Plan、Risk，并保留确认记录。

如果有时间再补US-10：PersonalOntologyRef展示和确认记录。

每个任务交付都用：录屏/截图 + 日志 + 文档，不依赖口头说明。
```

## 发给吴嘉宇

```text
嘉宇，你这边是主链路：Schema、项目理解、真实Agent运行。

今天优先顺序：
1. EN-01：先定10个核心对象字段和JSON样例。
2. US-03：根据ReferenceManifest生成ProjectContext，必须有来源、不确定项、至少一条用户修正diff。
3. US-05前置：补反假调度，不能再出现“已调度，稍等”但没有真实结果。
4. US-05：跑一次真实AgentRun，留下RunEvent和日志。
5. US-11：补SkillManifestRef、SkillRun、EvaluationRecord。
```

## 发给冯静雯

```text
静雯，你这边负责证据、安全和扩展契约。

今天优先做：
1. NFR-01：Trust Boundary，定义敏感边界、HITL规则、PermissionDecision、审计日志样例。
2. US-07：AgentManifest最小契约，字段包括ID、能力、输入输出、权限、运行方式、生命周期、失败行为。
3. US-06：先准备Evidence审查模板，等AgentRun出来后立刻补Artifact和Evidence包。

你的目标是把“能不能信”这件事收口。
```
