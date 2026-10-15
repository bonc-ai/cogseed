# 本体映射（ontology mapping）

本文件把 experiment-report-checker 的检查对象固定为一组显式的本体切片。没有这层切片，本 Skill 就只是
一个提示词，而不是可复用、可复核的能力。检查与输出中的每个术语都应能在本节找到定义。

三个层级的关系：tbox 定义"有哪些类型"，rbox 定义"类型之间必须成立的关系"，abox 记录"本次实际出现的
实例"。

## 1. TBox：概念与属性

| 概念 | 含义 | 关键属性 |
|---|---|---|
| Requirement | 用户给出的实验要求 | r_id、text、source（用户原文位置） |
| ReportSection | 报告草稿中的一个小节 | title、order、text_span |
| DataSource | 可定位的数值来源 | ds_type（raw_record / summary / table / figure / none）、locator、values |
| Analysis | 连接数据与结论的推理步骤 | a_id、statement、uses_datasource |
| Conclusion | 报告给出的结论 | c_id、statement、evidence_strength |
| Defect | 一条被发现的缺陷 | kind、locator、description、impact |
| Fix | 一条建议动作 | priority、locator、action、reason |
| HumanReviewItem | 需人工或专业人士判断的事项 | reason、handoff_target |

枚举取值：

- `DataSource.ds_type`：`raw_record`、`summary`、`table`、`figure`、`none`
- `Conclusion.evidence_strength`：`provided`、`partial`、`missing`
- `Requirement.match_state`：`matched`、`unmatched`、`unverifiable`
- `Defect.kind`：`missing`、`contradiction`、`insufficient`
- `Fix.priority`：`P0`、`P1`、`P2`

## 2. RBox：必须成立的关系与推理规则

| 规则 | 形式 | 检查含义 |
|---|---|---|
| R-REQ-COVER | 每个 Requirement 至多对应一组 ReportSection | 未对应时 `match_state = unmatched` |
| R-REQ-EVIDENCE | 任一 `matched` 的 Requirement 必须存在非 `none` 的 DataSource | 只有落点没有证据时降为 `unmatched` 并记 `insufficient` 缺陷 |
| R-CONC-DATA | 若 `evidence_strength = provided`，则该 Conclusion 必须关联至少一个非 `none` 的 DataSource | 违反时记 `unsupported` |
| R-WEAK-SUMMARY | 若 DataSource 为 `summary`，则其支撑的 Conclusion 的 `evidence_strength` 不得为 `provided` | 违反时降为 `partial` 并记 `insufficient` |
| R-NO-ORPHAN-DATA | 关键 DataSource 应至少支撑一条 Analysis 或 Conclusion | 违反时记 `insufficient`（孤立数据） |
| R-NUM-CONSIST | 同一量在报告内的两次出现必须数值一致 | 违反时记 `contradiction` |
| R-DIR-CONSIST | 趋势描述的方向必须与数据方向一致 | 违反时记 `contradiction` |
| R-UNCERTAINTY | 声称与公认值或其他参照一致的 Conclusion 必须带不确定度或误差范围 | 违反时记 `insufficient` 且该结论不得判为 supported |
| R-N-DECLARED | 以多次测量为基础的 Conclusion 必须声明样本量或重复次数 | 违反时记 `insufficient` |
| R-SAFETY-HANDOFF | 涉及安全、风险或伦理的判断一律不产生 Conclusion，只产生 HumanReviewItem | 违反即触犯边界红线 |
| R-NO-INVENTION | 输出中任何数值必须能回查到用户的输入材料 | 回查失败即删除该条判断；唯一例外是带 `对账推算` 标记、仅由输入数值组成的对照算式，且不得据此给出更正值 |

## 3. ABox：本次实例的落点

以正向完整案例（自由落体测定重力加速度）为例，各概念的实际实例：

| 概念 | 实例 |
|---|---|
| Requirement | R1 写明实验原理与计算公式；R2 说明仪器与测量条件；R3 记录实验步骤与重复次数；R4 给出原始数据表；R5 做数据处理与不确定度评定并与公认值比较 |
| ReportSection | 一、实验原理；二、仪器与条件；三、实验步骤；四、原始数据；五、数据处理与不确定度；六、结论 |
| DataSource | 时间间隔读数表（ds_type = raw_record，10 个值，均值 450.89 ms）；落距 h = 1.000 m（raw_record）；计时器分辨力 0.1 ms（raw_record） |
| Analysis | 由均值算 t = 0.45089 s；由 g = 2h/t^2 得 g = 9.837 m/s^2；A 类与 B 类不确定度合成 |
| Conclusion | c1 实验值 g = 9.837 m/s^2；c2 与公认值 9.79 m/s^2 的相对偏差约 0.48%，一致性结论 |
| Defect | 该案例报出 4 条 `contradiction`（P0：U 与合成相对标准不确定度不相容、两节不确定度口径冲突、B 类分量取值与其算式不符、偏差大于自报区间半宽）与 2 条 `insufficient`（1 条 P1 缺合成分量表、1 条 P2 释放对准），`Conclusion.c1` 的 `可支撑性` 为 `weakly_supported`、`c2` 为 `unsupported`。该案例数据与公式齐备，因此两条 `Conclusion` 的 `evidence_strength` 均为 `provided`；结论被判不成立只降低 `可支撑性`，**不降低** `evidence_strength` |

对照案例（缺原始数据）的实际实例：`DataSource` 仅存在 `ds_type = none`（用户未提供），因此
R-CONC-DATA 无法满足，`Conclusion.evidence_strength` 一律为 `missing`；此时停止的是**判断动作**
（不核对数值、不评价充分性、不裁决结论），而每条依赖数据的 `Conclusion` 仍按 R-CONC-DATA 登记为
`可支撑性 = unsupported` 并注明"因数据缺失，已停止核对"，另产出 HumanReviewItem（要求补充原始记录）。
对照案例（数据已给但结论被反驳，如杨氏模量与密度两例）：`DataSource` 存在（`ds_type = summary`），
因此 `evidence_strength` 记 `partial` 而非 `missing`，只把 `可支撑性` 判为 `unsupported`
——两个维度分别对应"数据有没有给"与"给的数据能不能撑住结论"，不得互相顶替。

## 4. source_refs

| 引用 | 来源 |
|---|---|
| 检查对象与三项必需输入 | 上游 Issue 的"目标"与"输入"两节 |
| 五类预期产出 | 上游 Issue 的"预期产出"五条 |
| 红线四条 | 上游 Issue 的"必须拒绝或停止"四条 |
| evidence_strength 三分类 | 本 Skill 为落实"不得补造实验结果"而设的内部机制 |
| Defect.kind 三分类 | 上游 Issue 预期产出第 3 条的"缺失、矛盾或明显不足" |
| Fix.priority 三级 | 上游 Issue 预期产出第 4 条的"按优先级排列" |
| 输出七节结构 | 本 Skill 的输出契约，覆盖上述五条产出并补齐审计与降级声明 |
