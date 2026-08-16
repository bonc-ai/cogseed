---
name: ECS售前交流材料
description: 根据行业类型、客户场景和会议目的，确定 ECS 售前 PPT 各节内容框架、行业本体选型和核心场景的四 What 映射，输出可供业务团队直接填写的结构化交流材料。
---

# ECS售前交流材料生成 Skill

> 这不是幻灯片美化工具，而是把ECS产品叙事逻辑结构化后的内容生成引擎。
> 骨架是行业本体映射规则 + 场景叙事规则；LLM负责语言表达，不是内容来源。

---

## 1. 技能定位

把这个Skill想象成一位随时可调用的**ECS售前交流设计师**——

- 告诉它"制造业 + 财务审计 + 初次拜访"，它秒出PPT框架：哪节预填、哪节占位、行业本体用ISA-95还是别的；
- 告诉它"客户问财务审计场景怎么讲"，它给出四What完整映射：What=发现什么问题 / SoWhat=什么合规风险 / NowWhat=系统出什么建议 / LearnWhat=规则库怎么沉淀；
- 会议结束后，它记录哪张slide没讲清楚，下次同类客户更准。

**不处理的范围**：PPT美化排版、具体客户案例内容撰写、公司介绍段落生成（超出本Skill本体覆盖范围，内容填写由业务团队完成）。

---

## 2. 触发条件

```
PPT框架生成类：
- "帮我准备国能宁煤集团的ECS交流材料"
- "做一个工业企业版的ECS售前PPT框架"
- "制造业客户用什么本体，PPT怎么组织"

场景映射类：
- "财务审计场景怎么套四What框架"
- "合规审查场景的NowWhat层怎么写"
- "招采智能化场景和ECS怎么连"

叙事决策类：
- "这个客户是初次拜访，和老客户PPT有什么不同"
- "能源行业的行业标准本体是哪个"
- "客户更关心合规还是效率，叙事重点在哪"
```

---

## 3. 本体引用（Skill 的知识骨架）

### T-Box · ECS售前交流概念体系

```
ClientEngagement（客户交流）           ← 一次具体的拜访/演示/交流
  属性：meeting_type（首次拜访/跟进演示/POC汇报）
        client_name, client_industry, date
  关系：[涉及] → Industry
        [包含] → ClientScenario（一次交流可涉及多个场景）

Industry（行业）                       ← 客户所在行业
  属性：industry_type, industry_standard_ontology, key_pain_points[]
  关系：[对应] → IndustryOntologyLayer（决定四层架构的第二层内容）
  典型实例：
    制造/能源/煤炭/化工/汽车  → ISA-95 Core Enterprise Ontology
    电信/运营商              → TM Forum SID / Open Digital Architecture
    医疗/医院                → HL7 FHIR
    石油天然气               → ISO 15926 / OSDU
    金融/保险                → FIBO / ACTUS
    政务/央企通用            → NSEAP Meta Ontology（直接对接，无行业标准层）

IndustryOntologyLayer（行业本体四层架构）  ← ECS核心架构的具体化
  属性：
    layer1 = NSEAP Meta Ontology（固定不变）
             Agent / Skill / Memory / Event / Goal / Policy / Organization
    layer2 = IndustryStandard（按行业替换，由本Skill决定）
    layer3 = Industry Ontology Package（由Ontology Factory自动生成）
    layer4 = ECS Application Layer（具体任务场景）
  关系：[layer2替换] → IndustryStandard（核心决策点）

ClientScenario（客户场景）              ← 客户的具体业务诉求
  属性：scenario_name, scenario_type, primary_pain_point
  场景类型分类：
    合规审计型：财务审计 / 招采合规 / 安全合规 / 监管报送
    运营分析型：收入分析 / 成本归因 / 效率提升 / 异动监测
    流程自动化型：审批流程 / 合同处理 / 工单处理

FourWhatFrame（四What映射）            ← 将客户场景翻译为ECS价值叙事
  属性：
    what_layer：场景中"发生了什么"的描述（事实层，BI已有）
    so_what_layer：背后的因果/风险/影响（分析层）
    now_what_layer：系统给出的行动建议（处方层，Agent新增）
    learn_what_layer：规则/经验如何沉淀进本体（进化层，ECS独有）
  关系：[归属] → ClientScenario

SlideSection（幻灯片节）               ← PPT的内容分组单元
  属性：section_name, fill_type（预填/占位/半占位）, owner（谁来填）
         change_trigger（行业 / 客户 / 会议类型 / 固定不变）← 触发本页修改的维度
  关系：[需要] → ClientScenario（占位节依赖场景信息）
```

---

### R-Box · 规则因果（★ Skill 的灵魂）

完整规则见 `references/rbox_rules.md`，此处列核心判断场景。

```markdown
## 行业本体选型规则

★ 最高频规则（工业企业场景必用）

IF Industry.industry_type 包含 {制造业 / 能源 / 煤炭 / 化工 / 汽车 / 采矿}
THEN IndustryStandard = ISA-95 Core Enterprise Ontology
REASON ISA-95定义了从现场层（Level 0）到企业层（Level 4）的完整制造企业语义模型，
       是IEC/ISO认可的国际标准；引用ISA-95可获得工业客户的专业认同，
       且ECS四层架构的第二层与ISA-95的对象模型（Equipment/Personnel/Material/Process）
       高度对应，无需额外解释

IF Industry.industry_type 包含 {电信 / 运营商 / 移动 / 联通 / 电信集团}
THEN IndustryStandard = TM Forum SID / Open Digital Architecture
REASON 电信行业无ISA-95等效标准；TM Forum SID是运营商BSS/OSS的语义基础，
       ITU-T认可，运营商技术团队熟悉；用错本体会立即被专业客户识别

IF Industry.industry_type 包含 {医疗 / 医院 / 卫生 / 健康}
THEN IndustryStandard = HL7 FHIR
REASON 国家卫健委强制要求医疗互联互通采用FHIR标准；非FHIR方案会被判定为不合规

IF Industry.industry_type 包含 {政务 / 央企通用 / 无明确行业标准}
THEN layer2 = 不单独引用行业标准，直接从NSEAP Meta Ontology扩展
REASON 此类客户无成熟行业语义标准，强行引用会增加解释成本；
       NSEAP Meta Ontology已包含Organization/Policy/Goal等政务基础概念，可直接扩展

## 会议类型规则

IF ClientEngagement.meeting_type = 首次拜访
THEN SlideSection[公司介绍] = 必填，位于议程第一节
     AND 公司介绍节必须包含：公司简介 + 核心案例（至少2个）
REASON 初次见面客户对公司无了解；跳过公司介绍直接讲ECS会导致可信度低，
       客户第一个问题一定是"你们是谁，服务过谁"而非"ECS是什么"

IF ClientEngagement.meeting_type = 跟进演示
THEN SlideSection[公司介绍] = 可省略，重点在场景Demo和ROI估算
REASON 跟进阶段客户已了解公司，重复公司介绍浪费宝贵时间，
       客户关心的是"你们能为我们做什么，花多少钱，多久见效"

## 场景叙事规则

IF ClientScenario.scenario_type = 合规审计
THEN 四What叙事重点：R-Box规则可追溯 + 审计依据来自本体规则而非大模型
     AND 特别强调：Now What层 = 系统输出审计发现 + 合规判定依据引用 + 处置建议
REASON 合规客户最关心的不是效率而是可解释性——"为什么这个判定是合规的"
       必须能从本体规则倒查；纯大模型输出无法通过审计要求，
       R-Box规则+本体是唯一能提供「可解释合规路径」的方案

IF ClientScenario.scenario_type = 运营分析
THEN 叙事起点：当前BI/报表停在What层 → ECS提供到NowWhat层
     AND 差异化重点：So What因果分析 + Now What行动处方
REASON 运营分析客户已有BI工具，核心痛点是"有数据没洞察，有洞察没行动"；
       叙事必须从客户已有能力出发，说明ECS补的是BI无法提供的因果推理和处方建议

IF ClientScenario.scenario_type = 流程自动化
THEN 叙事重点：Task Agent执行 + Companion Agent记忆 + KSTAR进化
     AND 强调：每次执行沉淀Episode，越用越准
REASON 流程自动化客户关心的是ROI和可靠性；
       KSTAR"越用越准"的叙事直接回应可靠性顾虑，且是竞品（纯RPA/普通Agent）无法提供的

## 行业痛点优先级规则

IF Industry.industry_type = 能源/煤炭 AND ClientScenario涉及审计/合规
THEN 痛点叙事优先级：合规风险 > 效率损失 > 数字化转型
REASON 能源央企合规压力来自国资委/行业主管部门，合规风险是一票否决项；
       效率和转型是加分项，合规是必答题
```

完整规则（12条）见：`references/rbox_rules.md`

---

### A-Box · 历史交流案例库

存放真实客户交流案例，每条包含：交流背景 / 选用本体 / 四What映射 / 会后δR记录。

**当前案例（2条，持续积累）**：

| 案例ID | 行业 | 场景 | 选用本体 | 核心δR |
|--------|------|------|---------|--------|
| CASE-PS-001 | 电信 | 全场景（联通软研院） | TM Forum SID | 首版无四层架构图，客户不理解本体复用逻辑→补入关键页后客户提问质量明显提升 |
| CASE-PS-002 | 能源/煤炭 | 财务审计（国能宁煤） | ISA-95 | 进行中，待会后填写 |

详细内容：`data/cases.json`

---

## 4. 执行流程（产出物生成型 Pipeline）

```
用户输入（行业 + 客户 + 场景 + 会议类型）
  ↓
Step 1 · 输入确认
  ├── 行业类型是否明确？→ 若不明确，追问后触发行业本体选型规则
  ├── 场景是否明确？→ 若只有模糊描述（如"想了解ECS"），追问具体业务痛点
  ├── 是否首次拜访？→ 决定是否包含公司介绍节
  └── 是否基于已有版本修改？（如：联通软研院V3.4）
        → 是：记录源版本，启动差量模式，Step 4 后输出修改任务单
        → 否：走完整生成流程（输出完整 PPT 结构清单）
  ↓
Step 2 · 行业本体确定
  应用 R-Box 行业本体选型规则 → 确定 IndustryStandard
  输出：四层架构中第二层的具体内容（名称 + 3-5个核心概念）
  ↓
Step 3 · 场景→四What映射
  应用 R-Box 场景叙事规则 → 生成该场景的四What框架
  What  = 场景中"发生了什么"（事实描述）
  SoWhat = 背后的风险/影响/因果（分析）
  NowWhat = ECS/Agent给出的建议/处方（行动）
  LearnWhat = 规则/经验如何进本体持续进化（ECS独有价值）
  ↓
Step 4 · PPT结构生成
  输出各节幻灯片清单：
    ├── 预填节（ECS框架叙事，不需填写）
    ├── 占位节（业务团队填写，给出具体填写指导）
    └── 半占位节（框架预填+行业/场景内容占位）
  ↓
Step 4.5 · 修改任务单输出（差量模式，有源版本时执行）
  应用 R-Box 页面变动规则（R-SLIDE-INDUSTRY-01 / R-SLIDE-CLIENT-01 / R-SLIDE-MEETING-01）
  → 输出本次需改页面清单 + 每页改什么 + ☐ 待勾 Checklist
  → 固定不动的页面单独列出，明确标注"无需修改"
  格式见下方"修改任务单"输出格式
  ↓
Step 5 · 填写指导输出
  对每个占位节：给出"需要什么信息 + 从哪里获取 + 格式要求"
  ↓
Step 6 · Forecast记录（发出前）
  预测：哪些slide客户可能会提问 / 会议后是否会约下一步
```

**子流程 · 场景未明确时**

```
IF 用户只说了行业，未说具体场景
THEN 追问：
  "这次交流客户最关心的是（选一个）：
   A. 合规审计（规则可追溯、审计报告生成）
   B. 运营分析（数据洞察、根因诊断、行动建议）
   C. 流程自动化（审批、合同、工单等流程处理）
   D. 还没确定，先做通用版"
  根据答案应用对应场景叙事规则
REASON 场景类型决定四What重点和R-Box强调哪些规则；
       通用版会失去叙事焦点，客户记不住ECS的差异化
```

---

## 5. 输出格式

### PPT结构清单输出

```
【行业】[industry_type]
【行业标准本体】[IndustryStandard] — [3-5个核心概念]
【核心场景】[scenario_name]
【会议类型】[meeting_type]

幻灯片结构（共X张）：

节1 导入（填写方：业务团队）
  S01 封面          ▎占位 → 填：客户名称 / 交流日期
  S02 关于我们      ▎占位 → 填：公司简介段落（建议让袁芯蕊提供标准版本）
  S03 核心案例      ▎占位 → 填：2个行业相关案例（参考：[相关A-Box案例]）

节2 行业洞察（填写方：业务团队）
  S04 行业挑战      ▎占位 → 填：[行业]当前3-5个核心痛点
  S05 客户现状      ▎占位 → 填：客户现有系统和主要卡点

节3 ECS核心理念（预填，禁止修改）
  S06 三时代转型    ✅ 预填
  S07 ECS定义       ✅ 预填
  S08 四What框架    ✅ 预填
  S09 KSTAR闭环     ✅ 预填

节4 本体驱动架构（预填，禁止修改）
  S10 为什么本体驱动  ✅ 预填
  S11 ★四层架构图    ✅ 预填（含[IndustryStandard]标注）
  S12 Ontology Factory ✅ 预填

节5 行业落地（半占位）
  S13 本行业本体层  ▎半占位 → 填：[IndustryStandard]的3-5个核心概念
  S14 场景四What映射 ▎半占位 → 见下方四What映射输出

节6 产品与实施（预填）
  S17-S19            ✅ 预填

节7 合作建议（填写方：业务团队）
  S20-S22            ▎占位 → 填：参考案例 / 建议起点 / 下一步
```

---

### 四What映射输出（核心场景专用）

```
【场景】[scenario_name]
【场景类型】[scenario_type]

What（事实描述层·BI已能提供）：
  [该场景中，系统当前能看到什么数据/现象]
  示例：合规审计场景 → "发现合同金额异常/审批流程跳级/供应商关系违规"

So What（因果分析层·高级分析有部分）：
  [为什么发生，背后的风险和影响是什么]
  示例：合规审计场景 → "跳级审批违反内控规定，财务损失风险/审计追责风险"

Now What（行动处方层·Agent新增）：
  [ECS/Agent给出什么建议，依据是哪条本体规则]
  示例：合规审计场景 → "输出合规判定报告 + 审计发现清单 + 整改建议，规则来源可追溯至R-Box"

LearnWhat（认知进化层·ECS独有）：
  [新的合规规则/判例如何进入本体，下次判断更准]
  示例：合规审计场景 → "每次人工复核结果作为A-Box实例，更新R-Box规则，合规判定精度持续提升"

---
⚠️ 叙事注意：[该场景类型对应的叙事重点提示]
```

---

### 修改任务单输出（差量模式专用）

当用户提供源版本时，在 PPT 结构清单之后输出：

```
【源版本】[source_version]（如：联通软研院V3.4）
【目标行业】[target_industry]  →  【源行业】[source_industry]
【目标客户】[target_client]
【目标会议类型】[target_meeting_type]

本次需改页面（共 X 页）：

▸ 行业差异页（R-SLIDE-INDUSTRY-01）
  ☐ S04 行业挑战    替换为 [target_industry] 核心痛点 3-5 条
  ☐ S11 四层架构图  Layer2：[source_standard] → [target_standard]
  ☐ S13 本行业本体层 替换为 [target_standard] 的 3-5 个核心概念
  ☐ S14 场景四What  按 [scenario_type] 叙事规则重写

▸ 客户差异页（R-SLIDE-CLIENT-01）
  ☐ S01 封面        客户名称：[target_client] / 日期：[date]
  ☐ S02 关于我们    更新行业相关案例引用
  ☐ S03 核心案例    换 [target_industry] 行业案例 2 个
  ☐ S05 客户现状    填写 [target_client] 现有系统描述
  ☐ S20 参考案例    换最相关案例详情
  ☐ S21 建议起点    更新 POC 场景建议
  ☐ S22 下一步行动  更新联系人 / 日期 / 约定事项

▸ 固定不动（无需修改）
  ✅ S06 S07 S08 S09 S10 S12 S17 S18 S19（共 9 页，预填内容与行业无关）

⚠️ 出稿前所有 ☐ 确认打勾后方可发送
```

---

## 6. KSTAR 闭环说明

```
每次客户交流 = 一次完整KSTAR学习循环：

  Situation  → 客户行业 + 场景描述 + 会议类型
  Task       → 确定PPT结构、本体选型、四What映射
  Action     → 输出PPT框架 + 填写指导
  Result     → 会议后评估：客户提了哪些问题，是否约了下一步
  δR         → 预测 vs 实际的差距：哪张slide没讲清，哪个映射让客户困惑
  Learn      → 更新R-Box规则（哪种叙事有效），补充A-Box（本次交流进案例库）
```

**δR记录格式**（会后填写到cases.json）：

| 测试问题/预测 | 实际发生 | δR描述 | 涉及规则 | 修正动作 |
|------------|---------|--------|---------|---------|
| 客户会对四层架构图提问 | 客户问"ISA-95和我们现有ERP有什么关系" | 需要补充"行业标准本体与企业现有系统的映射"说明 | R-ISA-01 | S13增加"与ERP关系"说明 |
| 会议后会约下一步 | 待填写 | 待填写 | — | — |

**δR归因三问**（每次交流后必问）：
1. 哪张slide客户明显没听懂？→ 检查对应的R-Box叙事规则是否表达有误 → 修 `rbox_rules.md`
2. 缺了哪个概念或映射？→ 补 T-Box 或 四What映射
3. 本次交流有没有新的典型问答？→ 进 A-Box `cases.json`

---

## 7. 目录结构

```
ecs-presales-agent/
├── SKILL.md                     ← 本文件（Skill定义，执行入口）
├── references/
│   └── rbox_rules.md            ← R-Box 12条判定规则（草稿，持续迭代）
└── data/
    └── cases.json               ← A-Box 历史交流案例（持续积累）
```

---

> 使用前自查：
> - [ ] T-Box：6个实体已确认，IndustryOntologyLayer四层关系清晰
> - [ ] R-Box：12条规则已加载，行业本体选型规则覆盖制造/电信/医疗/能源
> - [ ] A-Box：国能宁煤案例会后补入（CASE-PS-002）
> - [ ] 执行流程：给定行业+场景+会议类型，能无歧义输出PPT结构
> - [ ] 输出格式：三种输出（PPT结构清单 / 四What映射 / 填写指导）均可推导

<!-- NSEAP-GATE:BEGIN -->
## NSEAP Gate 契约

- `use_when`：需要准备 ECS 售前交流材料：按行业类型（制造/能源/电信/医疗/金融/政务）、客户场景（合规审计/运营分析/流程自动化）和会议目的（首次拜访/跟进演示/POC 汇报）确定 PPT 框架、行业本体选型（ISA-95/TM Forum/HL7 FHIR/FIBO/NSEAP Meta）与四 What 映射。
- `do_not_use_when`：PPT 美化排版、具体客户案例内容撰写、公司介绍段落生成；用户未提供行业/场景/会议目的时直接出框架；把四 What 叙事当事实数据；超越本体覆盖范围编造行业标准。
- `positive_examples`：`制造业+财务审计+初次拜访，给我 ECS 售前 PPT 框架和行业本体选型。`；`合规审查场景的四 What 映射怎么写？`
- `negative_examples`：`直接帮我写好这份 PPT 的美化排版。`；`我还没说行业和场景，你先出个通用框架。`

本 Skill 是 `execution · L5 · Full · sub_skill · interpreted` 的共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。
<!-- NSEAP-GATE:END -->
