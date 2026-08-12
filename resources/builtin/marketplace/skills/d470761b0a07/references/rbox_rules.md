# R-Box · ECS售前交流规则库
# 版本：v1.0 草稿 · 2026-06-29
# 确认状态说明：✅ 已验证（有A-Box案例支撑）/ ⏳ 待验证

---

## 一、行业本体选型规则

IF Industry.industry_type 包含 {制造业 / 能源 / 煤炭 / 化工 / 汽车 / 采矿 / 钢铁}
THEN IndustryStandard = ISA-95 Core Enterprise Ontology
REASON ISA-95定义了从现场层（Level 0）到企业层（Level 4）的完整制造企业语义模型；
       是IEC/ISO认可的国际标准；引用ISA-95可获得工业客户专业认同；
       且ECS四层架构的第二层与ISA-95对象模型（Equipment/Personnel/Material/Process Segment）
       高度对应，无需额外解释映射关系
确认状态：⏳ 待验证（首个工业案例为国能宁煤，会后补充）

IF Industry.industry_type 包含 {电信 / 运营商 / 移动 / 联通 / 电信集团}
THEN IndustryStandard = TM Forum SID / Open Digital Architecture
REASON 电信行业无ISA-95等效标准；TM Forum SID是运营商BSS/OSS的语义基础，
       ITU-T认可；用错本体会被专业技术团队立即识别，影响可信度
确认状态：✅ 联通软研院案例（CASE-PS-001）验证有效

IF Industry.industry_type 包含 {医疗 / 医院 / 卫生 / 健康}
THEN IndustryStandard = HL7 FHIR
REASON 国家卫健委互联互通强制标准；非FHIR方案会被判定为不合规
确认状态：⏳ 待验证

IF Industry.industry_type 包含 {石油 / 天然气 / 油气}
THEN IndustryStandard = ISO 15926 / OSDU
REASON ISO 15926是油气行业国际数据标准；OSDU是Open Subsurface Data Universe，
       国际石油公司（Shell/BP/Equinor等）已大规模采用
确认状态：⏳ 待验证

IF Industry.industry_type 包含 {金融 / 银行 / 保险}
THEN IndustryStandard = FIBO（金融行业本体）
REASON FIBO是OMG认可的金融领域语义标准，覆盖金融产品/合同/监管概念
确认状态：⏳ 待验证

IF Industry.industry_type 包含 {政务 / 央企通用} OR 无明确行业国际标准
THEN layer2 = 直接从NSEAP Meta Ontology扩展，不引用外部行业标准
REASON 政务领域无成熟行业语义标准，强行引用会增加解释成本；
       NSEAP Meta Ontology已包含Organization/Policy/Goal/Process等基础政务概念
确认状态：⏳ 待验证

---

## 二、会议类型规则

IF ClientEngagement.meeting_type = 首次拜访
THEN SlideSection[公司介绍] = 必填，位于议程第一节
     AND 公司介绍节须包含：公司简介 + 核心服务案例（至少2个与客户行业相关）
REASON 初次见面客户对公司无了解；跳过公司介绍直接讲ECS会导致可信度不足；
       客户的第一个问题一定是"你们是谁、服务过谁"，而非"ECS是什么"
确认状态：✅ 行业通用逻辑

IF ClientEngagement.meeting_type = 跟进演示
THEN SlideSection[公司介绍] = 可省略
     AND 重点放在：具体场景Demo + 实施路径 + 投入产出估算
REASON 跟进阶段客户已了解公司背景；重复公司介绍浪费沟通时间；
       客户关心的是"能为我们做什么、要花多少、多久见效"
确认状态：⏳ 待验证

---

## 三、场景叙事规则

IF ClientScenario.scenario_type = 合规审计（财务审计/招采合规/监管报送）
THEN 四What叙事重点：R-Box规则可追溯 + 审计依据来自本体而非大模型
     AND NowWhat层必须包含：合规判定依据引用 + 审计发现清单 + 可追溯路径
     AND 差异化强调：纯大模型输出无法通过审计，本体规则是唯一"可解释合规方案"
REASON 合规客户最关心的是可解释性而非效率——"为什么这个判定是合规的"
       必须能从本体规则倒查，否则审计部门不敢用；
       这是ECS vs 普通AI工具在合规场景的核心差异点
确认状态：⏳ 待国能宁煤交流后验证

IF ClientScenario.scenario_type = 运营分析（收入分析/成本归因/效率提升）
THEN 叙事起点：客户当前BI/报表停在What层
     AND 差异化叙事：ECS = What→SoWhat（因果推理） + SoWhat→NowWhat（行动处方）
     AND 不要从头讲ECS概念，要从"你们现在的BI做到了什么"开始
REASON 运营分析客户已有BI工具；核心痛点是"有数据没洞察，有洞察没行动"；
       叙事必须从客户已有能力出发，说明ECS补的是BI不能提供的部分；
       否则客户会认为ECS就是另一套BI
确认状态：⏳ 待验证

IF ClientScenario.scenario_type = 流程自动化（审批/合同/工单处理）
THEN 叙事重点：Task Agent执行效率 + Companion Agent记忆积累 + KSTAR越用越准
     AND 重点强调：每次执行沉淀Episode，Agent自我进化，区别于固定规则RPA
REASON 流程自动化客户已了解RPA；核心区别在于"RPA规则写死，ECS的Agent会学习"；
       "越用越准"直接回应可靠性顾虑
确认状态：⏳ 待验证

---

## 四、痛点叙事优先级规则

IF Industry.industry_type 包含 {能源/煤炭/央企}
AND ClientScenario涉及 {审计/合规/监管}
THEN 痛点叙事优先级：合规风险(P0) > 效率损失(P1) > 数字化转型(P2)
REASON 能源央企合规压力来自国资委/行业主管部门，合规是一票否决项；
       效率和转型是加分项，合规是前提条件；
       叙事顺序错误会导致客户认为我们不了解他们的优先级
确认状态：⏳ 待国能宁煤交流后验证

IF Client规模 = 大型国企/央企
THEN 叙事中必须提及：AI主权/认知资产自有/不依赖单一模型
REASON 国企对"数据主权"和"不被厂商锁定"高度敏感；
       "模型可以租用，认知必须自有"这句话对这类客户有直接击中感
确认状态：✅ 基于Richard战略判断，待客户交流验证

---

## 五、页面变动规则（差量模式）

IF 目标行业 ≠ 源版本行业
THEN 必须更新：S04（行业挑战）/ S11（四层架构图 Layer2）/ S13（本行业本体层）/ S14（场景四What映射）
     固定不动：S06 S07 S08 S09 S10 S12 S17 S18 S19（共 9 页，预填内容与行业无关）
REASON 这 4 页是行业语义的直接承载页，行业切换时内容不再适用；
       其余预填页描述 ECS 通用理念和架构，与行业无关，修改它们是浪费且会引入不一致
确认状态：✅ 联通软研院→国能宁煤切换场景推导验证（2026-06-29）

IF 目标客户 ≠ 源版本客户
THEN 必须更新：S01 / S02 / S03 / S05 / S20 / S21 / S22（共 7 页）
REASON 这 7 页承载客户信息、案例参考和合作建议，每次拜访不同客户内容完全不同；
       混用上次客户信息会直接导致交流失效，且客户会感知到材料不是专门准备的
确认状态：✅ 行业通用逻辑

IF 目标会议类型 = 跟进演示
THEN S02（关于我们）/ S03（核心案例）可省略
     建议在 S21 合作建议后新增 ROI 估算页
REASON 跟进阶段客户已了解公司背景，重复公司介绍浪费沟通时间；
       ROI 估算是跟进阶段客户最关心的问题（"花多少、多久见效"），首次拜访不适合谈
确认状态：⏳ 待跟进演示案例验证
