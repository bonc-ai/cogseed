# Ontology Analysis Skill

**版本：v0.1 Candidate／候选版**  
**类型：ProductionProcessSkill**  
**自动晋级上限：staged（暂存候选），不等于发布或生产就绪**

本资产包用于按统一架构完成某一应用场景或行业的：

- 官方政策与标准网站检索、来源核验和版本记录；
- 领域范围、参与方、权威系统和 System of Record 分析；
- Canonical Concepts、关系三元组和端到端流程建模；
- 事件、决策、规则、证据、风险、控制、结果和 KPI 分析；
- 国内外本体、词汇表、编码体系、交换格式、事件遥测和治理标准对标；
- Shared Upper Ontology 映射；
- Agent、Capability、Authorization、HITL、Audit 与 KSTAR 扩展；
- 完整 Word 分册生成、结构校验、逐页渲染和质量检查。

本 Skill 的目标是形成 **domain ontology landscape and alignment map（领域本体景观与对齐地图）**，不是一次性构建完整 OWL/RDF 本体、知识图谱或生产规则库。

---

## 1. 为什么不是一段 Prompt

顶层的 `SKILL.md` 定义 Agent 执行流程；`README.md`、输入模板、输出模板、质量清单和示例便于同事理解和复用。与此同时，资产包保留了机器可执行的：

- 输入/输出契约；
- 本体切片、策略和状态机；
- 官方网站研究门禁；
- JSON Schema；
- Word 生成和验证脚本；
- 评测、回放和负向回归用例；
- 治理边界和审计回执。

因此，本包同时具备“**人能看懂**”和“**Agent 能完整执行**”两层结构。

---

## 2. 目录结构

```text
ontology-analysis-skill-v0.1/
├── SKILL.md                         # Agent 主执行流程
├── README.md                        # 同事使用说明
├── input-template.md                # 人工收案与输入模板
├── output-template.md               # 19 个领域统一报告结构
├── quality-checklist.md             # 事实、来源、本体、治理和 Word 质量门
├── examples/
│   ├── education-example.md         # 教育教学缩略示例
│   └── human-resources-example.md   # 人力资源缩略示例
├── changelog.md
├── QUICKSTART.md
├── agents/                          # 运行时 Agent 画像与权限
├── config/                          # 报告颗粒度和阈值
├── ontology/                        # Skill 自身本体、策略、状态机
├── references/                      # 输入输出、研究、治理、映射等契约
├── schemas/                         # JSON Schema
├── templates/                       # 研究与报告结构化模板
├── scripts/                         # 研究门、校验、Word、渲染与 QA 工具
├── evals/                           # 正例、反例、边界、回放和回归
├── fixtures/                        # 仅用于测试的合成样例
├── tests/
├── requirements.txt
├── manifest.txt
└── manifest.sha256
```

---

## 3. 适用场景

适用于：

- “继续做第 1—19 项中某个分册，并与已完成分册保持同一架构。”
- “对某行业做本体分析与标准对标，并输出完整版 Word。”
- “先查官方政策和标准网站，再形成可交给总体架构负责人汇总的成果。”
- “已有结构化研究数据，需要生成、验证并渲染 Word。”

不适用于：

- 只解释什么是本体；
- 只从单份文件抽取 T-Box/R-Box/A-Box；
- 只改 Word 排版；
- 直接建设生产知识图谱、数据库或 Agent Runtime；
- 在没有官方来源核验时声称已完成当前政策与标准研究；
- 让智能体自主作出高影响专业决定或绕过人工审批。

---

## 4. 开始前需要提供什么

最少提供：

1. 分册序号和中英文领域名；
2. 任务目标和交付对象；
3. 正式政策入口或场景清单；
4. 已有内部材料、同事成果和参考分册；
5. 已知的领域边界、子场景和排除范围；
6. 输出文件名和研究时点；
7. 对网站检索、文件读取和制品写入的授权；
8. 可联系的领域专家或待确认责任人。

可直接复制填写 [`input-template.md`](input-template.md)。

---

## 5. 完整执行顺序

```text
收案与材料盘点
→ 建立 Research Plan
→ 搜索官方网站
→ 打开并阅读政策/标准原文
→ 建立 Web Research Ledger
→ 绑定关键声明与标准版本
→ 解决日期、版本和边界冲突
→ 机器计算 Research Gate
→ 领域本体景观分析
→ 标准逐项对标
→ Agent/HITL/KSTAR 建模
→ 填充 report-data.json
→ 严格数据校验
→ 生成 Word
→ Word 结构检查
→ PDF/PNG 渲染
→ 无障碍检查
→ 逐页视觉 QA
→ 输出 staged 候选稿与审计回执
```

Python 脚本不会自行联网。网站搜索、页面打开和阅读由具备 Web 工具的执行 Agent 完成；确定性脚本只验证检索证据和来源绑定是否满足门禁。

---

## 6. 快速运行

安装依赖：

```bash
python -m pip install -r requirements.txt
```

使用合成测试数据验证工具链：

```bash
bash tests/test_pipeline.sh
bash tests/test_research_gate_failures.sh
```

合成 fixture 仅用于证明工具链可运行，使用的是放宽的最小来源数量；真实任务必须遵守 `templates/research-plan.template.json` 和 `config/report-profile.yaml` 中的正式阈值。

真实分册在准备好以下文件后运行：

```text
report-data.json
research/research-plan.json
research/web-research-ledger.json
```

执行：

```bash
python scripts/run_skill.py \
  --input report-data.json \
  --research-dir research \
  --output-dir out \
  --strict \
  --render
```

只有 Research Gate 为 `passed`，才会生成 Word。

完成自动检查后，必须人工逐页查看：

```text
out/render/page-1.png
out/render/page-2.png
...
```

记录视觉检查：

```bash
python scripts/record_visual_qa.py \
  --render-dir out/render \
  --reviewer "reviewer-id" \
  --status passed
```

---

## 7. 统一的首轮颗粒度

默认质量目标：

| 对象 | 首轮要求 |
|---|---:|
| 领域模块 | 4—12 |
| 参与方/角色 | 至少 6 类 |
| 主要系统/SoR | 至少 6 类 |
| Canonical Concepts | 20—40 个，目标 40 |
| 关系三元组 | 至少 30 条，目标约 50 |
| 端到端流程 | 5—10 条，目标约 8 |
| 外部标准/语义资产 | 至少 8 项 |
| 完整闭环示例 | 至少 3 个 |
| Shared Upper Ontology | 21 类共同构造全部检查 |
| 网站检索 | 至少 4 个查询 |
| 已打开的一手来源 | 至少 6 项 |
| 正式政策来源 | 至少 1 项 |
| 正式标准/规范来源 | 至少 5 项 |

不同领域可以增加内容，但不得通过减少证据、跳过治理或混淆概念来追求篇幅一致。

---

## 8. 三类内容必须分开标识

报告中应明确区分：

1. **材料已有内容**：上传文件或内部方案直接支持；
2. **外部研究核实内容**：政府、标准组织和国际组织一手来源支持；
3. **分析建议/推断**：本次研究提出，尚待总体架构或领域专家确认。

R-Box 的 REASON、阈值和高影响规则未经专家确认，只能保留为候选；合成示例不得表述为真实业务价值。

---

## 9. 交付结果

标准输出包括：

- 完整 DOCX 分册；
- 经过研究门注入的 `report-data.validated.json`；
- Research Plan、Web Research Ledger、Research Gate；
- 研究、报告和 Word 校验报告；
- 渲染页图和无障碍报告；
- `skill-output.json`、运行清单和视觉 QA 回执。

最终自动状态最高为 `staged`。正式发布、行业定稿、专业签署和生产使用均需独立人工决定。
