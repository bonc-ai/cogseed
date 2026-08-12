# Human Resources Example · 人力资源缩略示例

> **用途**：展示如何在一个分册中同时处理企业人力资源和公共就业劳动保障。  
> **性质**：从已完成的第 13 项候选分册中压缩出的示例，不是完整法律、人社或企业 HR 本体。

## 1. 场景边界

本场景不能只按企业 HCM 建模，应拆为两个相互连接的子域：

```text
企业人力资源管理
├─ 劳动力规划
├─ 招聘与选拔
├─ 劳动合同与入职
├─ 学习发展
├─ 绩效与薪酬
└─ 人员异动与离职

公共就业与劳动保障
├─ 就业服务与援助
├─ 职业技能培养评价
├─ 社会保险
├─ 劳动关系公共服务
├─ 劳动争议仲裁
└─ 欠薪治理
```

两者共享 Person、Organization、Occupation、Skill、Credential 和 Evidence，但 Case、Decision、Authority 与 System of Record 必须分开。

## 2. 必须澄清的概念

```text
Position ≠ Job ≠ Occupation ≠ Job Posting

Skill ≠ Competency ≠ Qualification ≠ Credential

Candidate Match ≠ Talent Assessment ≠ Selection Decision

Wage Payment Obligation
≠ Payroll Record
≠ Payment Event
≠ Wage Arrears Incident
```

错误合并会使组织主数据、招聘网页、职业分类、算法排序、法律义务和支付事实相互污染。

## 3. 推荐模块

| 模块 | 核心对象 |
|---|---|
| 组织、岗位与劳动关系 | Person、Employer、Organizational Unit、Position、Employment Relationship、Contract |
| 职业、任务、技能与凭证 | Occupation、Job、Work Task、Skill、Competency、Qualification、Credential |
| 企业 HR | Workforce Plan、Job Posting、Application、Assessment、Selection Decision、Performance Objective |
| 公共就业 | Job Seeker、Employment Service Case、Assistance Plan、Referral、Employment Outcome |
| 社会保险 | Participation、Contribution、Benefit Claim、Benefit Decision、Payment |
| 劳动关系、仲裁与欠薪 | Dispute、Evidence、Hearing、Decision、Wage Obligation、Arrears Incident、Remedy |
| Agent 权益治理 | HR Agent、Authorization、Candidate Output、Fairness Review、Appeal、Audit Record |

## 4. Canonical Concepts 摘选

| 概念 | 上层映射 | 定义 |
|---|---|---|
| Person | Party | 作为劳动者、求职者、候选人或案件当事人参与活动的自然人；区别于员工记录或账号。 |
| Employer | Organization / Party | 承担用工、工资、社会保险和劳动保护义务的主体。 |
| Position | Resource / Organizational Construct | 组织批准的岗位载体，具有编制、职责、有效期和所属单元。 |
| Occupation | Classification / Information Object | 对相似工作及其任务、技能要求进行分类的语义对象。 |
| Job Posting | Information Object | 对可招聘机会的发布描述，不等同于 Position 或实际劳动关系。 |
| Candidate Match | Observation / Evidence | 基于条件和证据生成的相关性候选判断，不是录用决定。 |
| Selection Decision | Decision | 由有权主体作出的录用、拒绝或候补决定。 |
| Employment Relationship | Agreement / Situation | 劳动者与用人单位间具有法律和业务效力的关系。 |
| Credential | Information Object / Evidence | 对资格、技能、经历或成就的可验证声明。 |
| Employment Service Case | Process / Case | 围绕求职、援助、匹配、培训和就业结果开展的公共服务案件。 |
| Wage Payment Obligation | Agreement / Commitment | 用人单位在特定期间向劳动者支付工资的义务。 |
| Wage Arrears Incident | Situation / Case | 工资义务到期未履行并经核验形成的欠薪事件。 |

## 5. 关系摘选

```text
Person playsRole Worker / Job Seeker / Candidate / Employee
Employer contains Organizational Unit
Organizational Unit owns Position
Position classifiedBy Occupation
Job Posting describes Position
Application submittedFor Job Posting
Candidate supplies Credential / Evidence
Candidate Match supportedBy Evidence
Assessment observes Competency
Selection Decision considers Assessment and Match
Selection Decision authorizes Offer
Offer acceptance triggers Employment Relationship
Employment Relationship governedBy Contract and Policy
Worker performs Work Task
Training produces Learning Evidence
Qualification supportedBy Assessment
Credential asserts Qualification or Achievement
Unemployment Situation triggers Employment Service Case
Employment Service Case pursues Employment Outcome
Benefit Claim supportedBy Evidence
Authority issues Benefit Decision
Wage Obligation dueAt Date
Missing Payment Event raises Arrears Candidate
Verified Arrears Incident triggers Remedy / Enforcement Process
HR Agent Recommendation requires Fairness Review and Human Approval
```

## 6. 流程示例

### P1 技能型招聘与公平匹配

```text
Workforce Demand Approved
→ Position Opened
→ Job Posting Published
→ Application Submitted
→ Credential/Evidence Verification
→ Match Candidate
→ Assessment
→ Fairness and Accommodation Check
→ Human Selection Decision
→ Explanation / Appeal
→ Offer and Employment Start
```

### P2 公共就业服务

```text
Job Seeker Need
→ Employment Service Case Opened
→ Profile and Evidence Verified
→ Skill/Occupation Gap Analysis
→ Assistance Plan
→ Referral / Training
→ Employment Outcome Verified
→ Follow-up
→ Episode / Policy Candidate
```

### P3 欠薪风险预警与处置

```text
Wage Obligation Due
→ Payment Evidence Missing
→ Risk Signal
→ Cross-system Verification
→ Arrears Candidate
→ Human/Authority Confirmation
→ Remedy / Escalation
→ Payment or Enforcement Event
→ Worker Outcome
→ Review and Learning
```

## 7. 标准分层示例

| 资产 | 角色 | 用途 |
|---|---|---|
| 国内职业分类大典 | code_system / semantic backbone | 职业分类和统计主干 |
| 国家职业技能标准 | semantic backbone / governance reference | 职业任务、技能要求和评价依据 |
| ISCO / ESCO / O*NET | code_system / crosswalk | 国际职业、技能和任务参照；需本地映射 |
| HR Open Standards | exchange_format | HR 系统对象和交易交换 |
| ISO 30405/30409/30414/30415 等 | governance_reference | 招聘、劳动力规划、指标、公平和治理 |
| CASE | semantic_backbone / local mapping | 能力框架与教育第 11 项接口 |
| Open Badges / CLR / VC | provenance_credential | 技能、资格、经历和成就凭证 |
| PROV-O | provenance_credential | 证据、推荐、决定和衍生链追溯 |
| DPV | governance_reference | 个人数据用途、权利、风险和处理语义 |

## 8. Agent 治理示例

```text
HR Agent
→ Evidence Extraction / Matching / Risk Detection Capability
→ Authorized Skill and Tool
→ Candidate Match / Risk Signal / Draft
→ Data Quality and Fairness Gate
→ Human or Authority Decision
→ Explanation / Appeal
→ Controlled Action
→ Audit Record
→ Outcome Monitoring
```

默认必须人工最终决定：

- 录用、拒绝、解聘、晋升、调薪和纪律；
- 社会保险待遇决定；
- 仲裁裁决；
- 欠薪事实和责任确认；
- 执法、处罚或权益重大影响事项。

## 9. KSTAR 闭环示例

```text
Situation：求职者需要公共就业援助
Goal：形成可解释、可申诉且有实际就业结果的服务方案
K_C：身份、角色、技能、职业偏好、约束和服务资格
K_R：类似案例、职业分类、岗位、培训和服务规则
K_A：适配地区、权限、合理便利和资源
K_G：生成 Assistance Plan 候选
K_F：预测就业概率、时间、风险和成本
Human Decision：经办人员确认方案
Outcome：转介、培训、就业和后续稳定性
K_L：比较预期与实际，形成规则/映射/Skill 更新候选
```
