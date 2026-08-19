# Output Template · 19 个领域统一分册结构

> 本模板定义每个独立分册的统一架构。各领域应分开成稿，但必须复用同一 Shared Upper Ontology、四层建模纪律、标准映射关系和质量门。

## 封面与前置部分

1. 分册序号、领域中英文名称；
2. `Ontology 分析与对标`；
3. 版本、研究时点、交付对象和范围；
4. 编制说明：区分材料已有内容、外部核实内容、分析建议；
5. 执行摘要；
6. Word 自动目录。

---

# 1. 任务定位、政策语境与研究边界

## 1.1 任务目标

说明本分册是“领域本体景观与对齐地图”，不是完整本体工程。

## 1.2 正式政策场景

至少列明：

- 文件全称；
- 发文机关；
- 文号；
- 发布和生效日期；
- 当前状态；
- 与本领域直接相关的场景范围；
- 治理、权限、人机协同和追溯要求。

## 1.3 纳入与排除范围

表格列出业务范围、语义范围、系统范围和暂不展开事项。

## 1.4 关键建模纪律

至少澄清：

```text
现实业务对象 ≠ 数据库/API/文件记录
观察或风险信号 ≠ 已确认事实
模型建议/匹配/评分 ≠ 正式决定
正式决定 ≠ 已授权执行动作
Agent 日志 ≠ 法定或专业权威记录
```

---

# 2. 方法框架：Shared Upper Ontology、四层模型与证据等级

## 2.1 Shared Upper Ontology

统一映射：

```text
Party
Role
Agent
Goal
Situation
Capability
Service / Product
Process / Case
Task / Action
Resource / Asset
Information Object
Event
Decision
Policy / Rule / Constraint
Agreement / Commitment
Observation / Evidence
Risk / Control
Outcome
Measure / KPI
Episode / Learning
System / Interface
```

## 2.2 四层建模

| 层 | 内容 |
|---|---|
| 领域现实 | 人、组织、设备、合同、患者、课程、事件等现实对象 |
| 运营语义 | 流程、案件、任务、决定、规则、事件、状态 |
| 系统表示 | 数据库行、API 资源、表单、消息、文件、URL |
| 认知语义 | 情境、目标、证据、预测、实际结果、学习 |

## 2.3 证据和成熟度

推荐标签：

- `C0 Candidate`：分析候选；
- `C1 Source-anchored`：有政策、标准或材料支持；
- `C1-L Local extension`：组织/项目局部扩展；
- `Reviewed`：完成架构或领域评审；
- `Approved`：由有权责任人批准。

## 2.4 网站检索与来源核验门禁

必须显示：

- Research Gate 状态；
- 检索查询数量；
- 已打开来源数量；
- 一手政策来源数量；
- 官方标准/规范来源数量；
- 关键声明绑定完成度；
- 日期/版本/边界冲突及解决情况；
- Research Gate 回执位置。

---

# 3. 领域边界与模块划分

建议 4—12 个模块。每个模块至少包括：

| 模块 | 核心问题 | 主要概念 | 与其他模块依赖 | 上层本体依赖 |
|---|---|---|---|---|

同时说明组织局部扩展、Agent 执行扩展和系统映射层的位置。

---

# 4. 关键参与方与角色

至少 6 类参与方。采用：

```text
Party playsRole Role
```

字段：

| Party/Organization | Role | 责任 | 权利 | 授权 | 约束 | 主要流程 |
|---|---|---|---|---|---|---|

不得把角色固化为互斥的人员类型。

---

# 5. 主要业务系统与 System of Record

至少 6 类系统。字段：

| 系统 | 缩写 | 主要对象 | 候选 SoR | 典型系统对象 | 接口/交换 | 治理提醒 |
|---|---|---|---|---|---|---|

另设“领域对象—系统表示—映射关系”表：

| 领域对象 | 系统表示 | 映射关系 | 注意事项 |
|---|---|---|---|

SoR 是承担权威记录责任的系统，不是“数据最多”或“Agent 最容易访问”的系统。

---

# 6. Canonical Concepts 基线

首轮 20—40 个，目标 40 个。每个概念一行：

| ID | 中文名称 | English | 模块 | Concept Type | Parent/Upper | 定义 | 关键关系 | SoR | 依据 | 成熟度 |
|---|---|---|---|---|---|---|---|---|---|---|

要求：

- 定义业务语义，不把字段名当定义；
- 至少包含主体、资产/资源、流程/案件、任务、信息对象、事件、决定、规则、证据、风险、结果和 Agent 扩展；
- 明确同义词、上下位、相近但不可合并的概念；
- T1/T2/T3 仅作为候选，未经专家确认不得用于硬规则。

---

# 7. 核心关系三元组

至少 30 条，目标约 50。格式：

| 主语 | Predicate | 宾语 | 约束/基数 | 来源 | 说明 |
|---|---|---|---|---|---|

优先复用：

```text
Party playsRole Role
Agent possessesCapability Capability
Situation triggers Process
Process pursues Goal
Process decomposesInto Task
Task uses Resource
Task performedBy Agent
Task governedBy Rule
Action produces Event / Information Object
Observation supports Decision
Decision authorizes Action
Process produces Outcome
Outcome measuredBy KPI
Episode captures Situation–Action–Result
Learning updates Skill / Ontology / Policy
```

---

# 8. 端到端核心流程

5—10 条，目标约 8。每条包含：

```text
触发 Situation
→ Goal
→ 主流程阶段
→ 关键 Task
→ Decision Point
→ Evidence / Event
→ Outcome
→ KPI
→ Exception / Escalation
→ Episode / Learning
```

表格：

| Process ID | 流程名称 | 触发 | 阶段 | 关键决定 | SoR | 输出 | 异常/升级 |
|---|---|---|---|---|---|---|---|

---

# 9. 事件、决策、规则、风险、控制与 KPI

至少分别给出：

- 关键事件；
- 决策分层；
- 候选规则/约束；
- 风险—控制基线；
- 结果和 KPI。

R-Box 候选格式：

```text
IF 条件
AND 可选条件
THEN 候选结论
REASON 因果说明
来源
确认状态：待专家确认 / 自确认 / 专家已确认
question_type：threshold / dual_confirm / trigger_condition
```

未经专家确认的 REASON 不得作为正式业务规则。

---

# 10. 外部标准、本体和政策语义资产对标

## 10.1 标准角色

每项必须定位为以下一种或多种：

```text
semantic_backbone
code_system
exchange_format
event_telemetry
provenance_credential
governance_reference
local_mapping
```

## 10.2 对标矩阵

| 标准/资产 | 官方机构 | 研究版本/日期 | 作用定位 | 覆盖范围 | 可复用概念 | 映射关系 | 优势 | 缺口 | 本地扩展 |
|---|---|---|---|---|---|---|---|---|---|

允许的映射关系：

```text
exact
narrower
broader
related
local extension
```

禁止只罗列标准名称而不说明用途和缺口。

---

# 11. Shared Upper Ontology 映射

逐项说明领域概念如何映射 21 类共同构造：

| Shared Construct | 领域概念 | 关系/流程中的作用 | 差异化约束 |
|---|---|---|---|

指出哪些可跨领域复用，哪些必须保留领域特化。

---

# 12. Agent、授权、HITL 与审计

统一治理链：

```text
Domain Agent
→ Agent Capability
→ Skill / Workflow
→ Tool / Interface
→ Authorization
→ Candidate Output
→ Safety / Quality Gate
→ Human Approval
→ Action
→ Audit Record
→ Review / Appeal
→ Episode / Learning
```

至少包括：

- Agent 类型与能力；
- Tool/Interface；
- 数据和权限范围；
- A0—A4 自主性分级；
- 必须人工最终决定的事项；
- 禁止静默自动化事项；
- 解释、异议、申诉、回滚和审计；
- Agent Manifest 建议字段。

---

# 13. 完整闭环示例与 KSTAR 映射

至少 3 个真实业务类型的结构化示例；如为合成情境，必须明确标注，不能进入 A-Box。

闭环：

```text
Situation
→ Goal
→ Process
→ Task / Decision
→ Evidence / Event
→ Outcome / KPI
→ Episode / Learning
```

KSTAR：

| 阶段 | 本体输入 | 执行/推理 | 本体输出 |
|---|---|---|---|
| K_C | Situation、Party、Role、Goal、State | 构建上下文 | Context |
| K_R | Episode、Rule、Template、Skill | 检索 | Candidate |
| K_A | Constraint、Resource、Authorization | 适配 | Bound Plan |
| K_G | Task、Tool、Evidence Requirement | 生成 | Plan/Artifact/Recommendation |
| K_F | Risk、KPI、Resource | 预测 | Expected Outcome |
| K_L | Actual Outcome、Audit、Feedback | 学习 | Episode/Mapping/Rule Candidate |

---

# 14. 架构边界、实施建议与待确认问题

至少包括：

- 模块边界和依赖；
- 与 Shared Upper Ontology 的接口；
- 与其他分册的 cross-domain 接口；
- 组织扩展和系统映射策略；
- 分阶段实施优先级；
- 专家确认清单；
- 总体架构需要决策的问题；
- 不属于本分册的内容。

---

# 附录 A. Master Mapping Workbook

建议字段：

```text
Domain
Subdomain
Concept ID
Canonical Concept CN
Canonical Concept EN
Definition
Concept Type
Parent Concept
Synonyms
Relationships
Process Stage
Party / Role
Source System
Source Object
System of Record
External Standard
External Concept
Mapping Relation
Sensitivity / Authority
Evidence / Provenance
Agent Usage
KSTAR Usage
Owner
Maturity
Version
Status
```

# 附录 B. 来源、版本与研究门

列明：

- Research Plan；
- Web Research Ledger；
- Research Gate；
- 政策、法律、标准和规范来源；
- 内部材料来源；
- 版本、发布日期、访问日期；
- 关键声明与来源绑定；
- 已解决冲突。

# 附录 C. 来源材料处理与分析边界

逐份说明：

- 吸收了什么；
- 排除了什么；
- 属于行业核心、组织扩展、Agent 扩展还是系统表示；
- 哪些内容仍需领域专家确认。

---

# 完成定义

只有同时满足以下条件，才可标为“完整版候选分册”：

- [ ] 政策和标准研究门通过；
- [ ] 20—40 个 Canonical Concepts；
- [ ] 至少 30 条关系和 5 条流程；
- [ ] 标准逐项定位、映射和缺口分析；
- [ ] Agent/HITL/审计/KSTAR 完整；
- [ ] Word 结构校验通过；
- [ ] 每页渲染并人工检查；
- [ ] 明确标注 Candidate/staged，不宣称生产就绪。
