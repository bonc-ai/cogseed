# Education Example · 教育教学缩略示例

> **用途**：帮助使用者理解本 Skill 的输出颗粒度和组织方式。  
> **性质**：从已完成的第 11 项教育教学候选分册中抽取并压缩的示例，不是完整报告，也不能替代官方网站核实和领域专家评审。

## 1. 场景边界

纳入：

- 教学设计与课件生成；
- 作业/挑战发布、提交和评价；
- 学情分析、个性化学习与智能导学；
- 答疑、虚拟助教、反馈与反思；
- 能力、学习证据、成就、凭证和终身学习记录；
- 教育智能体、授权、审计和 Human-in-the-loop。

暂不展开：

- 学校财务、采购、后勤和科研管理；
- 全学科知识图谱；
- 完整教育法规则库；
- 特定厂商系统部署。

关键纪律：

```text
Learner ≠ SIS student record
Course ≠ LMS course object
Artifact ≠ GitHub URL
Learning Credential ≠ PDF file
AI Initial Assessment ≠ Final Grade
Learning Profile ≠ 固定人格标签
```

## 2. 推荐模块

| 模块 | 核心对象 |
|---|---|
| 主体与组织 | Learner、Educator、Guardian、Institution、Cohort、Role |
| 教学设计与知识能力 | Program、Course、Curriculum、Syllabus、Learning Objective、Competency、Knowledge Point |
| 学习活动与评价 | Learning Activity、Assignment、Challenge、Submission、Artifact、Assessment、Rubric、Evidence、Feedback |
| 学习状态与凭证 | Learning Profile、Mastery State、Learning Plan、Outcome、Credential、Portfolio |
| 教育智能体治理 | Education Agent、Companion Agent、Task Agent、Skill、Authorization、Audit Record |
| 系统与接口 | SIS、LMS/LXP、LRS、Assessment Platform、Credential Platform、Agent Runtime |

## 3. Canonical Concepts 摘选

| ID | 概念 | 上层映射 | 定义 | 成熟度 |
|---|---|---|---|---|
| EDU-C001 | 学习者 / Learner | Party | 参与学习过程、拥有学习目标并形成学习结果的个人；区别于用户账号或学生记录。 | C1 |
| EDU-C007 | 课程 / Course | Service / Information Object | 围绕学习目标组织内容、活动、评价和资源的教学单元；与 LMS 容器分开。 | C1 |
| EDU-C010 | 学习目标 / Learning Objective | Goal | 对学习后可观察知识、能力或表现的预期描述。 | C1 |
| EDU-C011 | 胜任力 / Competency | Capability-related Domain Concept | 在特定情境中综合运用知识、技能和态度完成任务的能力。 | C1 |
| EDU-C014 | 学习活动 / Learning Activity | Task / Process | 学习者为实现目标而执行的可观察活动。 | C1 |
| EDU-C016 | 挑战任务 / Challenge | Task / Local Extension | 以真实问题或微型产品交付为中心的项目式活动，是 Assignment/Learning Activity 的特化。 | C1-L |
| EDU-C018 | 学习产物 / Artifact | Information Object | 学习活动产生、可版本化和评价的业务产物；存储 URL 只是其系统表示。 | C1 |
| EDU-C020 | 评价 / Assessment | Process / Decision Support | 依据评价方法、量规和证据形成判断的过程，不自动等同于最终成绩。 | C1 |
| EDU-C022 | 学习证据 / Learning Evidence | Observation / Evidence | 支持学习结果、掌握状态或成就判断的可追溯证据。 | C1 |
| EDU-C034 | 教育智能体 / Education Agent | Agent | 在授权和审计约束下执行教育任务的软件智能体。 | C1 |

## 4. 关键关系摘选

```text
Learner playsRole Student
Institution offers Course
Course pursues Learning Objective
Learning Objective alignedTo Competency
Course contains Learning Activity
Assignment specializes Learning Activity
Challenge specializes Project-Based Learning Activity
Challenge targets Knowledge Point
Learning Activity produces Artifact
Artifact provides Learning Evidence
Assessment uses Rubric
Learning Evidence supports Assessment Decision
Assessment generates Feedback
Feedback updates Learning Plan
Credential asserts Learning Outcome
Education Agent possessesCapability tutoring / drafting / evidence extraction
Agent Action governedBy Authorization
High-impact Assessment Decision requires Human Approval
Episode captures Challenge–Action–Artifact–Assessment–Reflection
Learning updates Skill / Memory / Ontology Candidate
```

## 5. 三条流程示例

### P1 作业发布—提交—智能批改

```text
Assignment Created
→ Learner accepts Task
→ Submission / Artifact produced
→ Agent checks completeness and extracts evidence
→ Assessment Candidate generated
→ Educator reviews exceptions/high-impact judgment
→ Feedback and Grade Decision recorded
→ Learner may request review
→ Learning Plan updated
```

### P2 学情分析与个性化学习

```text
Learning Events + Evidence
→ Evidence Quality Check
→ Mastery State Candidate
→ Teacher/Rule Review
→ Learning Plan Decision
→ Resource/Activity Recommendation
→ Outcome Observation
→ Episode and Rule Candidate Update
```

### P3 挑战式项目学习

```text
Challenge
→ Context Pack
→ Task Agent invokes Skills
→ Artifact
→ Self Assessment + Agent Assessment
→ Human Feedback
→ AAR / Reflection
→ Portfolio Evidence
→ Memory and Skill Candidate Update
```

## 6. 标准对标示例

| 标准/资产 | 角色 | 适合复用 | 不应误用 |
|---|---|---|---|
| 1EdTech CASE | semantic_backbone | Competency、Learning Objective、Rubric、Framework Alignment | 不能代替完整课程运行和学习事件模型 |
| OneRoster | exchange_format | 学生、班级、课程开设、注册和成绩交换 | 交换对象不等于完整教育本体 |
| LTI | exchange_format | 学习工具与平台上下文、角色和启动交互 | 不作为学习结果语义主干 |
| QTI | exchange_format | 题目、试卷、作答和评价交换 | 不覆盖所有项目式学习证据 |
| Caliper | event_telemetry | Learning Event、Assessment Event、Tool Use Event | 事件不直接证明掌握或成就 |
| Open Badges / CLR / VC | provenance_credential | 成就、技能、经历和学习记录凭证 | Credential 不等于当前 Competency 本身 |
| PROV-O | provenance_credential | 证据、产物、Agent 行动和衍生关系 | 不提供教育专业判断规则 |

## 7. Agent 治理示例

```text
Education Agent
→ Capability
→ Skill
→ Authorized Tool
→ Candidate Output
→ Evidence/Quality Gate
→ Educator Approval when required
→ Action / Feedback
→ Audit Record
→ Review / Appeal
→ Episode / Learning
```

必须人工最终决定的候选事项包括：

- 正式成绩和高影响评价；
- 凭证签发、撤销；
- 纪律和学术诚信结论；
- 涉及未成年人权益或敏感画像的处理；
- 改变课程要求、资格或完成状态的决定。

## 8. 完整闭环示例

```text
Situation：学习者在某知识点连续出现高质量错误证据
Goal：改善理解，而不是简单提高推荐点击率
Process：学习诊断与干预
Task：汇集证据、核验事件、生成掌握状态候选
Decision：教师确认是否调整学习方案
Evidence：作答、Artifact、反馈、历史事件
Outcome：后续评价表现和学习目标达成变化
KPI：掌握改善、反馈时效、申诉率、教师采纳率
Episode/Learning：记录预测、实际、偏差和策略更新候选
```
