# KSTAR 论文架构与当前实现一致性审计

- 审计日期：2026-07-26
- 论文：`KSTAR: A Retrieval-First Neuro-Symbolic Cognitive Architecture for Adaptive Planning, Learning, and Human-AI Symbiotic Intelligence`
- 论文文件：`/Users/sudai/Desktop/KSTAR_LaTeX_Project_ArXiv/KSTAR_Retrieval_First_Cognitive_Architecture_ArXiv.pdf`
- 实现范围：当前工作树中的 `src/main/features/p3394/`、group chat、KB/contexts、Core Agent 工具层，以及 `userWorkSpace/meta-skill-engine-package/`
- 注意：本审计包含当前尚未提交的 Commander 单次 KSTAR 验证改动。

## 一、执行结论

**总体结论：部分一致（Partial / C 级），不能按论文严格定义宣称为完整的 retrieval-first KSTAR 实现。**

当前实现不是只有 KSTAR 名称：它已经具备真实的执行追踪、预期/实际记录、Agent 身份、工具证据、终态 Episode、Commander 协作验证、外部归因引擎、补丁候选和经验知识库沉淀，并且 Mate Agent 的 IPC、权限、路径沙箱、Wake 审批、终止和数据隔离为论文的 execution harness 提供了较扎实的工程底座。

但是，论文的核心定义不是“任务结束后记录 KSTAR”，而是：

1. 先形成类型化 Situation / Task；
2. 在不受约束生成之前查询 K_R；
3. 按类型、权限、来源和适用性过滤；
4. 对检索资产进行显式适配；
5. 只有覆盖不足或新颖性高时才启动 K_G 生成；
6. 对候选动作和结果进行联合预测、验证与选择；
7. 执行后关闭 Episode，再经过 replay / review / canary / scoped release 更新知识。

当前主路径基本从“Commander/Agent 直接生成与执行”开始，KSTAR 在 Agent 结束后才采集证据，在会话终态后才由 Commander 验证。因此它更准确的定位是：

> **KSTAR-inspired post-hoc evidence, attribution, and learning-governance subsystem，运行在一个较成熟的 Agent execution harness 上。**

而不是论文 Definition 3.7 所称的 retrieval-first cognitive control loop。

## 二、论文的最低一致性标准

论文第 3.4 节 Definition 3.7 给出了严格判据。一个系统只有在每个非紧急、存在可访问记忆的任务中满足以下条件，才是 retrieval-first：

- 在无限制生成前查询 K_R；
- 将检索来源暴露给后续推理；
- 估计适用性或适配成本；
- 通过明确的覆盖度、新颖性或验证标准决定是否启动生成回退。

论文 Algorithm 1 的关键顺序是：

```text
Interpret S/T
→ BuildQuery
→ Retrieve K_R
→ FilterByTypeAuthorityProvenance
→ Adapt with K_A
→ Validate hard constraints
→ Coverage/Novelty/Conflict
→ Generate missing structure with K_G only if needed
→ Forecast Â/R̂/uncertainty
→ Evaluate and select/escalate
→ Execute and observe A/R
→ Diagnose ΔA/ΔR
→ Close Episode
→ Propose typed updates
→ Replay/Review/Canary
→ Commit or retain locally
```

当前实现只较完整地覆盖了后半部分中的执行证据、Episode、归因、经验沉淀和部分审批。

## 三、逐项一致性矩阵

| 论文要求 | 当前实现证据 | 状态 | 审计判断 |
|---|---|---:|---|
| 持久连续性 | JSON/JSONL 会话、contexts、KSTAR state、Agent/Skill 状态、KB 向量库 | 较强一致 | 状态跨模型和会话保存，符合论文设计目标 |
| 类型化 Situation `S=<x,o,c,rho,tau,upsilon>` | KSTAR expectation 只有字符串 `situation`；权限、时间、证据、 uncertainty 分散在其他模块 | 部分 | 没有一个可验证的 Situation schema |
| 类型化 Task `T=<G,H,P,B,E,U>` | collaboration objective/steps 和 KSTAR task/result_hat；没有统一 goals/hard constraints/preferences/budget/evaluation/stakeholders schema | 部分偏弱 | 任务可结构化调度，但不是论文 Task 模型 |
| 六类知识 `K_C,K_R,K_A,K_G,K_F,K_L` | 多个模块可功能映射，但没有统一版本化知识快照和组件责任接口 | 部分 | 功能存在，架构边界未显式化 |
| CognitiveAsset：schema、约束、provenance、适用性、风险、authority | Skills/Agents 有 spec，KB 有文档/chunk，工具有 schema；缺统一 asset envelope | 较弱 | 当前资产不能统一做适用性过滤和组合 |
| 检索先于生成 | `kb_search` 是模型可选工具；KSTAR experience 写入 KB，但没有强制执行前检索 | **缺失/核心冲突** | 主路径仍是 generate-first/tool-choice-first |
| 混合检索和 applicability score | KB 主要做向量相似度；没有类型、authority、时间、负例、适配成本联合评分 | 缺失 | 接近 RAG，不是论文 K_R |
| 显式适配 K_A | 有 Skill 参数化、工具替代、计划恢复、补丁候选；没有通用 Adapt 阶段或适配结果 | 较弱 | 多为运行时临场生成，不是可追踪适配资产 |
| 覆盖/新颖性/冲突决定生成回退 | collaboration 有上下文冲突；没有 retrieval coverage/novelty gate | 缺失 | 不满足 Definition 3.7(iv) |
| 候选集、去重、多样化 | Agent/worker 可并行，provider 可轮换；没有 KSTAR candidate portfolio | 部分偏弱 | 多 Agent 不是论文候选计划评估 |
| 联合预测 `Â,R̂,Σ` | action_hat/result_hat 字符串存在；没有 assumptions、uncertainty、failure modes 和候选级 forecast | 部分偏弱 | 形式字段存在，预测模型不存在 |
| Hard validator + soft evaluator | 路径沙箱、权限、Wake、人类确认、测试存在；未作为统一候选选择器 | 部分 | execution 层强，cognitive selection 层弱 |
| 受控执行和实际 Action trace | IPC、工具事件、Agent run、tool cycle、abort、Wake exact-once、process events | **较强一致** | 当前最符合论文的区域之一 |
| 预期/实际和 `ΔA/ΔR` | PC 保存预期与实际；外部引擎计算 Delta | 部分但算法过弱 | Delta 不是类型化度量，当前多为字符串是否相等 |
| Closed Episode | Commander 汇总 Agent contributions，生成一个终态 KSTAR run | 较强一致 | 近期改动显著改善协作级闭环 |
| End-to-end provenance | 有 uid/cid/agent/turn/message/tool/evidence id；缺知识版本、模型版本、检索资产、环境版本和完整人工干预链 | 部分 | 可审计但未达到论文最小 Episode schema |
| Retain locally before promotion | 本机 `local/p3394/kstar-state.json` 保存证据 | 一致 | 符合 retention 与 promotion 分离方向 |
| Typed patch proposal | patch candidate 有类型、目标、理由、来源 run | 部分一致 | 但外部归因常产生泛化 `Skill` 目标 |
| Replay / regression / canary | 外部包有 GovernanceGates 类，但 PC 主调用链没有调用 propose_patch/run_governance/human_review | **缺失/核心冲突** | 论文第 3.8 节的知识发布条件没有落地 |
| Version/scoped release/rollback | 外部包有 registry/rollback 字段；PC 当前经验自动写入 KB，补丁仅审核状态 | 较弱 | 数据结构存在，真实发布闭环未接通 |
| Invalidation/forgetting | contexts 可删除，未建立来源撤回到依赖 Episode/Skill 的反向索引 | 缺失 | 不满足论文 7.7 的 provenance invalidation |
| Model portfolio | hosted profile、provider rotation、Core Agent、local CLI Agent、MCP 工具 | 较强一致 | 但路由不使用论文质量/成本/延迟/隐私联合目标 |
| Identity/authority | 用户隔离、Agent ID、IPC allow-list、path sandbox、Wake approval、secret store | 较强一致 | 尚缺统一 capability token、期限、revocation 和 delegation record |
| Human symbiosis | 用户表单、Wake、人类确认、可编辑 memory、补丁审核 | 较强 | Commander-only 自动验证不应覆盖高风险独立/人工评估 |
| Security/privacy/resilience | 本地/云数据域、加密 secrets、路径沙箱、日志脱敏、abort、降级 | 较强一致 | Retrieved content 的信任分级和 learning quarantine 仍不足 |
| H1-H6 与消融评估 | 有大量工程测试，但没有论文定义的序列任务 benchmark/ablation/statistical design | 缺失 | 不能据此声称论文假设已验证 |

## 四、六类知识组件映射

### K_C：概念、约束和权威知识

现有映射：

- Agent / Skill spec 和工具 schema；
- tool catalog；
- path sandbox；
- Wake/权限确认；
- 外部引擎 ontology reader；
- group-chat workflow contracts。

差距：

- 没有统一的 K_C snapshot/version；
- Task hard constraints 没有在候选生成前统一执行；
- ontology、工具约束、用户权限、Agent 能力没有进入同一个可查询约束模型。

### K_R：检索和情景知识

现有映射：

- cloud contexts 源文件；
- 本地 KB vector store；
- `kb_search` / `kb_read`；
- chats、sessions、KSTAR experiences；
- 成功/失败工具周期。

差距：

- `kb_search` 是可选工具，不是强制控制阶段；
- KSTAR experience 没有自动进入 BuildQuery/Retrieve/Filter/Adapt；
- 检索主要按语义向量，缺 authority、time、negative evidence、applicability、adaptation cost；
- 没有记录每次任务实际检索过哪些资产及其分数。

### K_A：适配和修复知识

现有映射：

- Skill 参数绑定和执行；
- plan retry/resume；
- context conflict resolution；
- patch candidate；
- 工具/Agent 路由和 fallback。

差距：

- 没有 `Adapt(asset,S,T)` 的标准输入输出；
- 没有 schema mapping、precondition repair、tool substitution 的显式可复用记录；
- LLM 临场改写与真正 K_A 资产没有区分。

### K_G：生成和搜索知识

现有映射：

- Core Agent；
- model/provider portfolio；
- named Agents / anonymous workers；
- local CLI Agents；
- tool calling；
- workflow/plan executor。

这是当前较成熟的部分，但它在控制流中常常先于 K_R/K_A 被使用。因此组件本身存在，顺序不符合 retrieval-first。

### K_F：预测和评价知识

现有映射：

- KSTAR expectation：action_hat/result_hat；
- Commander result marker；
- tool result heuristics；
- tests、forms、human confirmation；
- Agent output status。

差距：

- action_hat/result_hat 主要是自由文本；
- `Σ` uncertainty/assumptions/failure modes 缺失；
- 没有候选级 prospect evaluator；
- `delta_a` 与 `delta_r` 的算法不能支持可靠归因。

### K_L：学习与治理知识

现有映射：

- Agent contribution retention；
- Commander terminal validation；
- KSTAR engine capture/analyze/route；
- experience candidate；
- KB promotion；
- patch review center；
- 外部包中的 patch generator、governance gates 和 registry manager。

主要冲突：

- PC 实际只调用 `capture_interaction → analyze_attribution → route_recommendation`；
- 没有调用外部包已经提供的 patch generation、validation/governance/canary/human-review pipeline；
- Commander 验证成功后会直接批准 experience 并写入 KB，没有 protected replay set；
- 这与论文“任何更新不得在缺少适当 replay/review 的情况下超出证据范围推广”不一致。

## 五、当前实现最强的部分

### 1. Execution harness 很接近论文要求

当前系统明确区分：

- Commander 计划/派发；
- Agent 实际执行；
- 工具事件与错误；
- Wake 审批；
- abort/cancel；
- process trace；
- actual action/result；
- 用户、Agent、conversation、turn 和 workflow step 身份。

路径工具执行前经过 realpath containment，能够阻止 symlink escape。IPC 是唯一 Renderer/Main 通信路径，外部 Agent 和 MCP 也有唯一 spawn choke point。这些是论文 bounded action、identity、authority、observable result 和 operational resilience 的真实实现。

### 2. Commander 协作级 Episode 比逐 Agent 卡片更接近论文

新实现让 Agent 只贡献 evidence，由 Commander 在真正终态聚合：

- 多个 Agent 的期待、实际动作和结果；
- tool cycles；
- outcome status；
- Wake/表单/ledger 是否结束；
- collaboration 是否完成。

这比每个 Agent 单独弹一张验收卡更符合“Episode 是系统级闭环”和人机协作整体评价，但仍需要独立 evaluator 和风险分层。

### 3. 数据分层与持久化较成熟

- 原始/同步知识存 cloud；
- KSTAR 工作状态和向量索引存 local；
- experience 通过 contexts 进入可同步知识；
- secrets、日志、artifact、attachments 各自有边界。

该结构支持论文的 persistent continuity 和 model portability。

## 六、直接不一致与风险

### P0-1：KSTAR 不在执行前主控制路径

代码的 KSTAR 入口发生在 Agent turn 结束后：Bus 对输出应用 guard，然后调用 `recordAgentContribution`。终态后才调用 Commander validation 和外部 KSTAR engine。

这意味着 KSTAR 当前回答的是：

> “刚才执行得怎么样、是否值得沉淀？”

而不是论文核心问题：

> “开始执行前，已有哪种认知资产可以复用、如何适配、是否还需要生成？”

这是最大的结构性差距。

### P0-2：当前 KB 是能力，但不是 retrieval-first policy

`kb_search` 本身是有效的向量检索工具，但调用权交给 LLM。系统没有保证：

- 每个相关任务先搜索经验；
- 检索 provenance 进入后续决策；
- 计算 applicability/adaptation cost；
- coverage gate 决定是否调用生成模型。

因此当前属于“具备 RAG/KB 工具的 Agent”，不是论文 Definition 3.7 的 retrieval-first system。

### P0-3：知识 promotion 缺 replay/canary

当前 Commander 验证通过后会自动：

```text
create approved ExperienceCandidate
→ run external attribution engine
→ promote to cloud contexts/kstar-experiences
```

这缺少论文明确要求的：

- protected replay set；
- recent failure replay；
- safety/counterfactual tests；
- evidence scope；
- canary；
- monitoring；
- rollback pointer。

外部引擎包虽然实现了 `GovernanceGates`，但 PC 集成没有调用它。

### P0-4：Delta 算法不足以支持论文级归因

外部 evidence collector 当前逻辑是：

- 数字可解析时做数值差；
- 否则 predicted 与 actual 完全相等为 0，不相等为 1；
- action 也使用字符串完全相等；
- `delta_a != 0` 就归因为 Skill execution deviation。

由于 predicted action 与真实执行摘要几乎不可能字符串完全相等，大量正常运行会被判成 execution deviation，继而产生通用“Skill 需要修复”候选。这正是此前多个重复 KSTAR 卡片的根本原因之一。

论文要求 Delta 是 typed metric：trace edit distance、rubric vector、proper scoring rule、goal violation set 等。当前算法只能视为占位实现。

### P0-5：Episode provenance 不完整

当前保留 uid/cid/Agent/turn/message/tool/evidence，但没有完整保存：

- `v(K_t)` 各知识组件版本；
- 构建 S/T 的原始 observation set；
- retrieved asset set Z_t、rank、applicability 和 provenance；
- candidate plans 和被拒绝原因；
- model/provider/version；
- tool version / environment version；
- authority profile；
- assumptions/uncertainty；
- human interventions；
- learning proposal 的最终 disposition；
- artifact content hash。

因此现有 Episode 可用于日志归因，但不足以复现论文定义的认知决策。

### P1-1：Commander-only validation 需要风险分层

Commander 拥有完整协作上下文，适合作为低风险任务的主 evaluator。但论文明确强调：

- independent evaluation；
- evaluator capture 风险；
- high-impact task 的 human/independent review；
- “No human evaluative closure” 是一项核心消融。

所以合理策略应是：

```text
低风险、可逆任务：Commander 自动 closure
中风险：Commander + 独立 critic/replay
高风险：Commander + 独立 validator + 用户/责任人批准
```

当前所有成功协作都由 Commander 自动通过并沉淀，不能视为完整符合论文。

### P1-2：外部引擎状态不是长期认知存储

外部引擎的 EvidenceCollector、AttributionEngine、RegistryManager 主要把数据保存在进程内数组/Map。PC 每个 KSTAR run 新建 stdio MCP 连接，完成后关闭。单次 capture→analyze→route 可工作，但跨 Episode 的 aggregate、版本历史和长期模式不能依赖该进程内状态。

PC 自己的 JSON state 保留了结果，但外部引擎的跨 Episode aggregation 和 registry 能力没有真正持久化或重建。

### P1-3：补丁目标和实际可应用对象不稳定

外部归因使用通用类别 `Skill/TBox/RBox/ABox`，PC patch candidate 再把 skill patch 默认映射到 `run.agent_id`。现在 run owner 是 Commander，可能生成“修改 Commander custom skill”的候选，但 Commander 并不是普通 custom skill。这表明论文的 component-specific diagnosis 尚未与产品的真实资产模型对齐。

## 七、理论主张不能外推到当前实现

当前实现不能声称已经获得论文中的：

- completeness preservation；
- conservative soundness；
- expected computational advantage；
- replay-set non-degradation；
- semiring-valued candidate selection；
- category-theoretic compositional consistency。

原因不是这些理论错误，而是其前提在当前代码中没有实现或验证，例如：

- 明确的 admissible plan set；
- 受约束 generator fallback；
- complete fallback planner；
- protected replay set；
- monotone acceptance rule；
- typed valuations；
- component morphism/contracts。

## 八、建议的落地顺序

### Phase 1：把 KSTAR 前移到派发前（最高优先级）

建立统一的 `KStarTaskContext`：

```text
Situation:
  observed_state
  evidence_refs
  context_refs
  authority_profile
  temporal_context
  uncertainty/provenance

Task:
  goals
  hard_constraints
  preferences
  budget
  evaluation_contract
  stakeholders
```

在 Commander dispatch 前运行：

```text
interpret_task
→ retrieve_cognitive_assets
→ filter_by_type_authority_provenance
→ estimate_applicability_and_adaptation_cost
→ adapt_assets
→ coverage_novelty_conflict_gate
→ only then dispatch/generate
```

### Phase 2：建立统一 CognitiveAsset registry

Skill、Agent、Episode、plan、test、ontology、prompt、solver model 都需要统一 envelope：

```text
id/version/type
input_schema/output_schema
preconditions/hard_constraints
content_ref
parameters
provenance
applicability stats
quality/risk/authority
negative cases
dependencies/tests
```

### Phase 3：补全候选预测和 typed Delta

- 候选级 `Â/R̂/Σ`；
- 结构化 evaluation contract；
- tool trace / workflow trace distance；
- rubric vector；
- hard-goal violation set；
- uncertainty/calibration；
- 区分 planning、permission、tool、environment、evaluation failure。

### Phase 4：接通真实 K_L 治理链

把外部引擎已有但未调用的能力接入：

```text
propose typed patch
→ replay fixed + recent + negative cases
→ governance invariant check
→ canary
→ risk-based independent/human review
→ versioned scoped release
→ monitor
→ rollback/invalidate
```

经验本身可以立即本地 retention，但推广成共享 KB 或 Skill 更新必须经过风险适配的 replay/review。

### Phase 5：建立论文 H1-H6 benchmark

至少实现 Table 6 的核心消融：

- no retrieval；
- text-only retrieval；
- no adaptation；
- no DeltaA separation；
- no symbolic validator；
- no negative cases；
- ungoverned learning；
- single model；
- no human closure。

否则只能说明工程测试通过，不能说明 KSTAR 架构主张成立。

## 九、最终判定

### 可以声称的

- 当前系统实现了 KSTAR 风格的预期/实际记录、Agent/工具执行证据、协作 Episode closure、归因和经验治理原型；
- Mate Agent 的执行与权限底座与论文 reference architecture 多项设计目标一致；
- 当前实现适合作为 KSTAR 的后半段原型和进一步研究平台。

### 不应声称的

- 当前已经实现完整 retrieval-first KSTAR cognitive architecture；
- 当前 KSTAR 已经在生成前系统性复用知识；
- 当前 Delta 归因可可靠定位根因；
- 当前知识更新满足 replay/canary/rollback；
- 论文的完整性、安全性或非退化结论已经适用于当前产品。

### 一句话结论

> **当前实现与论文在目标、执行底座和 Episode/治理方向上真实相关，但核心控制顺序仍是“生成/执行后 KSTAR”，而论文要求“检索/适配/预测后再生成和执行”。因此它是有价值的部分实现，不是严格一致的完整实现。**
