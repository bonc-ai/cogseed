---
name: nseap-meta-skill-engine
description: NSEAP Meta-Skill Engine — 企业智能体能力进化控制面。读取本体、采集交互、通过 KSTAR 方法论进化技能库和本体库。当需要分析 Agent 交互效果、提出技能/本体改进、创建新技能时使用。
when_to_use:
  - "分析用户与 Agent 的交互效果"
  - "根据交互数据改进现有技能"
  - "发现本体缺陷并提出补丁"
  - "创建新的 SkillPackage"
  - "运行 KSTAR 进化循环"
disable-model-invocation: false
allowed-tools: [Bash, Read, Write, Edit, Grep, Glob, TodoWrite]
---

# NSEAP Meta-Skill Engine

## Identity Contract (Meta-Skill Standard Book 2)

```yaml
skill_class: meta_skill
is_skill_of_skill: true
operates_on: [Skill, OntologySlice, EvalCase, Workflow, Policy, MetaSkill]
promotion_ceiling: staged
production_release_allowed: false
```

## Purpose

将 Agent 执行证据、专家纠正、业务反馈和本体约束转化为可复用、可验证、可治理、可迁移的能力资产。

核心目标链：`执行 → 证据 → 经验 → 归因 → 改进 → 回放 → 评审 → 晋升 → 复用`

## Trigger Semantics

**Use when:**
- 需要读取或分析 Ontology（TBox/RBox/ABox）
- 需要采集用户与 Agent 的交互并生成 KSTAR Episode
- 需要分析交互偏差（DeltaR/DeltaA）并归因
- 需要提出 Skill Patch 或 Ontology Patch
- 需要创建新的 SkillPackage
- 需要运行三闸治理流程

**Do NOT use when:**
- 只是执行普通任务（不需要进化分析）
- 修改受保护表面（形式规则、HITL 要求、审计机制）
- 试图自动发布到生产（promotion_ceiling: staged）

## Architecture

### 10 模块（`src/modules/`）

| # | 模块 | 职责 |
|---|------|------|
| 1 | ontology-reader | 本体读取（TBox/RBox/ABox/实例） |
| 2 | ontology-writer | 本体写入（Patch 落地） |
| 3 | evidence-collector | 证据采集 + KSTAR Episode |
| 4 | attribution-engine | DeltaR/DeltaA 归因 + 聚合 + 路由 |
| 5 | evolution-orchestrator | KSTAR 进化编排 |
| 6 | patch-generator | Patch 生成（有界编辑） |
| 7 | governance-gates | 三闸治理 |
| 8 | skill-creator | Skill-Creator（双通道 + 评估迭代） |
| 9 | registry-manager | 注册表管理 |
| 10 | llm-port | LLM 端口（回退 + 类型） |

### 对外接口（26 个 MCP Tools）

| 类别 | 工具 |
|------|------|
| **引擎** | get_engine_info |
| **本体** | read_ontology, list_ontologies, extract_ontology_slice |
| **证据** | capture_interaction, query_episodes |
| **归因** | analyze_attribution, analyze_no_match, route_recommendation |
| **补丁** | propose_patch, run_governance, human_review |
| **创建** | create_skill, create_skill_auto, capture_intent |
| **评估** | generate_eval_cases, run_eval, grade_eval, grade_eval_llm, benchmark_skill, improve_skill, generate_eval_viewer, optimize_description |
| **注册表** | register_skill, list_registry |
| **配置** | get_engine_config |

### 双入口加载路径

- `dist/index.js` — MCP stdio 服务器入口，宿主作为子进程拉起。
- `dist/engine.js` — 纯库入口，宿主进程内 `loadEngine` 加载，不启服务器。

## KSTAR Evolution Discipline (7 Rules)

1. **信号定义**: DeltaR = 实际-预测结果, DeltaA = 预测-实际动作
2. **DeltaA 门控 DeltaR**: 执行偏差时 DeltaR 不可信（先正身，后正心）
3. **单一证据单一信号**: 一条证据 → 一条学习记录 → 至多一个假设
4. **符号聚合**: 按稳定符号键聚合，>=2 独立证据才能成为提案
5. **有界补丁**: 编辑预算 <=2 操作，只能改可变表面
6. **三闸提交**: Validation → Governance → Canary
7. **Meta-Skill 自进化**: 只产生元知识层暂存候选

## Governance Boundaries

### Protected Surfaces (NEVER patchable)
- 形式规则结构
- HITL 要求
- 审计机制

### Non-Claims
- 不自动进化到生产
- 评估通过 ≠ 业务价值验证
- 合成证据 ≠ 客户价值

### Hard Inequalities
- `Candidate ≠ Staged ≠ Release_Ready ≠ Production_Release`
- `DeltaR ≠ Release_Command`

## References

- `references/ontology-mapping.md` — 本体映射规范
- `references/kstar-evolution.md` — KSTAR 进化详细流程
- `references/governance-boundaries.md` — 治理边界详情
