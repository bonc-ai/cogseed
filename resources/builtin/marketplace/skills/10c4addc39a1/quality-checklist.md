# Quality Checklist · 本体分析与对标质量清单

> 用法：执行 Agent 自检一次，领域/架构评审人独立复核一次。  
> 任何“硬阻断项”未通过，不得生成或交付“完整研究已完成”的 Word 分册。
> 结构完整性（schemas.json / skill-spec.yaml / evals.json / agents 配置等是否齐全）
> 由平台质量链在技能安装与复查时自动执行，无需本 Skill 自带校验脚本。

## A. 硬阻断项

### A1. 政策与网站研究

- [ ] 找到至少一个正式政策或主管机关一手来源；
- [ ] 所选来源已实际打开和阅读，不能只看搜索摘要；
- [ ] 文件全称、文号、发布机关、发布日期、生效日期和当前状态已核实；
- [ ] 场景原文和领域边界已绑定正式来源；
- [ ] 当前事实均有一手来源；
- [ ] 每个外部标准均有官方机构来源；
- [ ] 每个标准均记录研究版本或研究时日期；
- [ ] 报告中的所有来源 ID 可在 Research Ledger 解析；
- [ ] 政策日期、版本和领域边界冲突均已登记并解决；
- [ ] `research-gate.json` 由脚本计算为 `passed`，不是人工写入。

任一项失败：

```text
RESEARCH_GATE_FAILURE
→ 不生成完整 Word
→ 返回缺失证据和下一步
```

### A2. 内容完整性

- [ ] 领域模块不少于 4 个；
- [ ] 参与方不少于 6 类；
- [ ] 系统/SoR 不少于 6 类；
- [ ] Canonical Concepts 为 20—40 个；
- [ ] 关系三元组不少于 30 条；
- [ ] 端到端流程为 5—10 条；
- [ ] 外部标准/语义资产不少于 8 项；
- [ ] 完整闭环示例不少于 3 个；
- [ ] 21 类 Shared Upper Ontology 均已检查；
- [ ] Agent、授权、HITL、审计和 KSTAR 均有独立章节。

---

## B. 事实与来源质量

- [ ] 清楚区分“上传材料已有内容”“外部研究核实”“分析建议/推断”；
- [ ] 不用模型记忆代替当前官网事实；
- [ ] 不把二手转载作为关键结论的唯一来源；
- [ ] 对 PDF 中的表格、图、扫描页已查看页面图像；
- [ ] 来源名称、发行机构、版本和 URL 相互一致；
- [ ] 关键结论有最小充分的来源绑定；
- [ ] 引用不夸大来源支持范围；
- [ ] 合成/人工/桩证据已标注，不宣称真实业务效果；
- [ ] 内部材料的作者、版本、适用范围和局限已记录；
- [ ] 未被材料支持的内容明确标为分析建议。

---

## C. Ontology 质量

### C1. 四层分离

- [ ] 领域现实、运营语义、系统表示、认知语义已分开；
- [ ] Person/Organization/Asset 等现实对象不等同于数据库行；
- [ ] Document/API Object/URL 被建模为 Information Object 或 System Representation；
- [ ] Process、Task、Decision、Event、State 没有全部降成名词标签；
- [ ] Situation、Goal、Evidence、Expected Result、Actual Result、Learning 已显式表达。

### C2. 概念质量

- [ ] 每个 Canonical Concept 有清晰、可区分的业务定义；
- [ ] 概念有生命周期、属性和关系，或明确作为事件/过程/规则；
- [ ] 动作没有误建为长期实体；
- [ ] 同名异义和异名同义已经处理；
- [ ] 相近概念未被错误合并；
- [ ] 行业核心、组织局部扩展、Agent 扩展和系统对象已分层；
- [ ] T1/T2/T3 状态和确认责任清楚；
- [ ] 无实证或专家确认的 T1 只标为候选。

### C3. 关系与流程

- [ ] 每个核心概念至少参与一条关系或流程；
- [ ] 关系方向明确；
- [ ] 关系谓词可复用、不是自然语言长句；
- [ ] 重要关系记录条件、基数或状态；
- [ ] 流程包含触发、目标、任务、决定、事件、证据、结果和异常；
- [ ] 决策与执行动作分开；
- [ ] 资源请求、承诺、部署、到达等状态没有混成一个概念；
- [ ] 流程可映射到 System of Record 和审计事件。

### C4. 必须避免的错误等同

- [ ] Observation / Signal ≠ Confirmed Fact；
- [ ] Score / Match / Recommendation ≠ Formal Decision；
- [ ] Formal Decision ≠ Authorized Action；
- [ ] Credential ≠ Competency/Qualification 本身；
- [ ] Agent Output ≠ 专业或法定结论；
- [ ] Account / ID / Record ≠ Person；
- [ ] File / URL ≠ Business Artifact；
- [ ] Event Telemetry ≠ Outcome；
- [ ] 数据湖/Agent 平台 ≠ 所有事实的 SoR。

---

## D. R-Box 与 A-Box 质量

- [ ] 每条规则都有 IF、THEN、REASON、来源和确认状态；
- [ ] 不确定的 REASON 写“待专家确认”，不编造；
- [ ] 阈值规则标注 `question_type=threshold`；
- [ ] 双人确认规则标注 `dual_confirm`；
- [ ] 触发条件完整性问题标注 `trigger_condition`；
- [ ] 未确认规则不驱动高影响 Agent 决策；
- [ ] A-Box 只收真实发生的事件/案件，不收假设示例；
- [ ] A-Box 不是对象全量状态快照；
- [ ] 完整案例含执行前预测、实际结果和学习；
- [ ] incomplete 案例不参与规则有效性验证。

---

## E. 标准和本体对标质量

- [ ] 每项标准有官方来源和版本；
- [ ] 明确其角色：语义主干/编码/交换/事件/来源/治理/局部映射；
- [ ] 没有把交换格式误作完整业务本体；
- [ ] 没有把编码体系误作流程或决策模型；
- [ ] 没有把事件遥测误作权威业务结果；
- [ ] 使用 `exact / narrower / broader / related / local extension`；
- [ ] 列出可复用概念；
- [ ] 列出优势；
- [ ] 列出缺口和限制；
- [ ] 列出组织/中国本地扩展；
- [ ] 多个标准重叠时说明主干和从属关系；
- [ ] 国内标准和国际标准的接口策略明确。

---

## F. Agent 与治理质量

- [ ] Agent、Capability、Skill、Tool、Interface 分开；
- [ ] Capability 同时表达“能做”和“被授权做”；
- [ ] 授权范围包含主体、对象、动作、时间和条件；
- [ ] 候选输出先经过 Safety/Quality Gate；
- [ ] 高影响事项有明确 Human Final Decision Maker；
- [ ] 用户知情、解释、异议、申诉和退出权已考虑；
- [ ] Agent 行为可追溯到输入、模型/规则版本、工具、责任人和证据；
- [ ] 有审计记录和回滚策略；
- [ ] 不允许 Agent 静默扩权；
- [ ] A0—A4 自主性分级与场景风险相符；
- [ ] 具身智能体的物理动作有额外安全围栏；
- [ ] 专业、法定或权益重大决定未被自动化越权。

---

## G. KSTAR 质量

- [ ] 至少 3 个完整闭环；
- [ ] K_C 输入包括 Situation、Party、Role、Goal、State；
- [ ] K_R 检索 Episode、Rule、Template、Skill；
- [ ] K_A 绑定 Constraint、Resource、Authorization；
- [ ] K_G 产生 Plan/Artifact/Recommendation/Task；
- [ ] K_F 记录预期结果、风险、成本和 KPI；
- [ ] K_L 记录实际结果、ΔA、ΔR、归因和候选更新；
- [ ] ΔA 不为 0 时，不直接用 ΔR 更新知识；
- [ ] 单条证据不直接触发知识提交；
- [ ] 更新只产生候选或 staged 资产；
- [ ] HITL、审计和形式化规则结构属于保护面。

---

## H. Word 和制品质量

- [ ] 封面、执行摘要、目录、14 章和 3 个附录齐全；
- [ ] 表格标题和列宽可读；
- [ ] 图、表和章节无孤页、截断和重叠；
- [ ] Word 结构校验通过；
- [ ] 无障碍检查通过或问题已说明；
- [ ] 每页已渲染为 PNG；
- [ ] 每页在 100% 缩放下人工查看；
- [ ] 页眉、页脚、页码和目录正常；
- [ ] 源文件、验证报告和审计回执一并保留；
- [ ] ZIP Manifest 与 SHA-256 可验证。

---

## I. 宣称与状态质量

- [ ] 版本明确写 `v0.1 Candidate／候选版`；
- [ ] 自动状态不高于 `staged`；
- [ ] 不声称生产就绪、已投产或行业定稿；
- [ ] 不声称通过外部标准认证；
- [ ] 不将回放通过等同于业务价值已验证；
- [ ] 不将合成测试结果表述为客户价值；
- [ ] 生产发布、正式批准和专业签署由独立人工流程完成。

---

## J. 评审结论

```text
Research Gate：通过 / 阻断
Ontology Quality：通过 / 有条件通过 / 退回
Standards Alignment：通过 / 有条件通过 / 退回
Agent Governance：通过 / 有条件通过 / 退回
Word QA：通过 / 退回
最终状态：candidate / staged / blocked / rejected
主要问题：
整改责任人：
复核日期：
```
