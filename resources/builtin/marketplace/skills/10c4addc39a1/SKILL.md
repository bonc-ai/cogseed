---
name: 本体分析对标
description: 对指定行业/领域做本体景观与标准对标分析：强制官网检索与来源核验门禁、规范概念建模、共享上层本体映射、Agent/HITL 治理与 KSTAR/ECS 闭环，产出经完整校验渲染的 Word 领域本体分册（候选版，staged 封顶）。
---


# Ontology Analysis Skill

> **Distribution status: v0.1 Candidate／候选版**  
> **Automatic lifecycle ceiling: staged**  
> **Human-facing entry points:** `README.md`, `input-template.md`, `output-template.md`, `quality-checklist.md`, `examples/`.


## 1. Identity and boundary

**ProductionProcessSkill · Skill-L5 · Asset-L2 · master_task_skill · interpreted**

```yaml
skill_class: ProductionProcessSkill
is_skill_of_skill: false
level: L5
risk_route: Full
session_role: master_task_skill
owns_session: true
form: interpreted
promotion_ceiling: staged
production_release_allowed: false
```

This skill produces a **staged candidate** domain report and a reproducible research-data bundle. It does not build a complete production ontology/knowledge graph, issue professional approvals, publish automatically, or claim external-standard certification.

The task is a **domain ontology landscape and alignment map**, not a complete OWL/RDF implementation.

### v0.1 Candidate profile

This candidate distribution adds a colleague-facing README, input template, output template, quality checklist, and two abbreviated examples while retaining the executable research, validation, Word-generation, and QA layer.

Website research is a hard prerequisite rather than a prose instruction:

```text
Research Plan
→ Web Search Query Log
→ Open/Read Selected Official Sources
→ Claim and Version Bindings
→ Conflict Resolution
→ Computed Research Gate
→ Report-Data Validation
→ Word Generation
```

The Python scripts do **not** browse the internet. The executing Agent performs web research with its approved web tools, records the evidence bundle, and then the deterministic validator decides whether the report pipeline may continue.

## 2. use_when

- “按 11–14 的架构继续做第 15/16/19 分册并输出完整版 Word。”
- “对某行业做 Ontology 分析与标准对标，形成可交给总体架构负责人汇总的独立分册。”
- “先查政府和标准组织官网，再形成 20–40 个概念、流程、关系、Agent 治理、KSTAR/ECS 和 Word 报告。”
- “已有 report-data.json 和网站检索台账，按统一版式校验并生成完整 DOCX。”

## 3. do_not_use_when

- 只解释本体概念、只总结文件、只抽 T-Box/R-Box/A-Box；
- 只改 Word 排版或只做 PPT/Excel；
- 要求直接建设/部署生产知识图谱、Agent Runtime 或数据库；
- 要求绕过网站检索、来源核验、HITL、审计、逐页渲染检查或 staged 上限；
- 要求把搜索摘要、模型记忆、二手转载、风险信号或建议写成正式事实或决定；
- 当前政策/标准事实需要核实时，执行环境没有 Web 工具，却仍要求声称“已完成完整研究”。

## 4. Required input

```json
{
  "task_id": "TASK-001",
  "owner_context": {
    "owner_id": "injected-by-agent-layer",
    "role": "ontology_analyst",
    "authorization_scope": [
      "read_materials",
      "web_research",
      "write_research_ledger",
      "write_sandbox_artifacts"
    ]
  },
  "domain_payload": {
    "volume_number": "15",
    "domain_name_cn": "政务服务",
    "domain_name_en": "Government Services",
    "research_date": "YYYY-MM-DD",
    "policy_urls": [],
    "materials": [],
    "research_bundle_dir": "research",
    "output_basename": "15_政务服务应用场景_Ontology分析与对标_v0.1"
  }
}
```

For a full run, the executing Agent must prepare:

```text
report-data.json
research/research-plan.json
research/web-research-ledger.json
```

`research/research-gate.json` is computed by the symbolic validator. It must not be manually marked `passed`.

## 5. Output

- full `.docx` report;
- validated `report-data.json` with injected `research_assurance`;
- `research-plan.json`;
- `web-research-ledger.json`;
- computed `research-gate.json`;
- research validation report;
- report-data validation report;
- DOCX structural verification report;
- page PNGs and optional PDF for internal QA;
- accessibility audit;
- run manifest and visual-QA receipt.

Top-level output always contains `actions`, `result`, `trace`, and `audit_refs`. Automatic success status is at most `staged`.

---

# 6. Execution workflow

## 6.0 Intake and placement

1. Confirm volume number, Chinese/English domain name, research date, policy scope, supplied files, benchmark reports, and output name.
2. Set `ProductionProcessSkill / L5 / Full / staged` and create an audit trace.
3. Use existing 11–14 reports only as **architecture, depth, and style benchmarks**; do not copy their domain facts into another volume.
4. Create a working directory containing `report-data.json` and `research/`.

## 6.1 Retrieve and inventory source materials

1. Read all user files before drafting. If a named prior file is not attached, search the user’s file library.
2. Build a material register: title, type, date/version, author/issuer, authority, coverage, limitations, and treatment.
3. For image-only or scanned pages, inspect page images and verify critical document names, numbers, dates, diagrams, and tables.
4. Preserve source terminology and framing. Do not silently replace an internal model with generic knowledge.
5. Mark internal material as `I`, explicit expert decisions as `E`, and analyst synthesis as `A`.

## 6.2 Create the mandatory research plan

Copy and complete:

```bash
cp templates/research-plan.template.json research/research-plan.json
```

The plan must contain at least four critical questions:

1. official policy wording, issuer, document number, issue/effective date, and current status;
2. applicable domestic official standards, classifications, data specifications, or policy semantic assets;
3. applicable international standards, ontologies, vocabularies, and reference models;
4. researched version/date, coverage, role, strengths, gaps, and local-extension needs for every external asset.

The plan must declare:

- search snippets are not evidence;
- selected sources must be opened and read;
- current facts require primary sources;
- secondary sources are discovery-only;
- date, version, and scope conflicts must be resolved before generation.

## 6.3 Mandatory website research and source verification

The executing Agent—not the Python renderer—must perform this stage.

### Search sequence

1. Search for the current official holder of the policy/specification, not a remembered name or stale mirror.
2. Search official government, standards-body, international-organization, or official specification sites.
3. Use secondary sources only to discover primary sources.
4. Open every selected source. Search-result snippets do not count as evidence.
5. For PDFs, open the PDF; when a table, figure, diagram, or scanned page matters, inspect the relevant page image.
6. Record query text, purpose, execution time, selected result IDs, page/section, retrieval method, access time, version/date, and a SHA-256 content fingerprint.
7. Bind each load-bearing claim to one or more opened sources.
8. Bind every report standard row by exact standard name to an official source and researched version/date.
9. Record conflicts and their resolutions, preferring the issuing authority or official standards body.

### Required source classes

- `P`: official policy/government source;
- `S`: official standard/specification/international organization;
- `R`: secondary discovery source, never the sole support for a critical claim;
- `I`: user-provided internal material;
- `E`: explicit expert decision;
- `A`: analyst synthesis/recommendation.

### Web-unavailable behavior

When current policy or standard facts are required but Web access is unavailable:

```text
Do not substitute model memory.
Do not mark the research gate passed.
Do not generate a report claiming complete external verification.
Return RESEARCH_GATE_FAILURE and identify missing evidence.
```

## 6.4 Populate the web research ledger

Copy and complete:

```bash
cp templates/web-research-ledger.template.json research/web-research-ledger.json
```

The ledger must contain:

- policy-scope verification;
- executed query log;
- opened-source records;
- claim-to-source bindings;
- research-question resolutions;
- one explicit version-verification record for every report standard;
- conflict register;
- completion record.

A source record is not complete unless it includes:

```text
source_id + report_source_id + title + issuer + URL
+ source_type + primary_source + official_domain
+ opened_and_read + retrieval_depth + retrieval_method
+ accessed_at + version_or_date + verification_status
+ temporal_status + content_hash + query_ids + claim_ids
```

## 6.5 Run the hard research gate

The gate must run **before** report-data validation or Word generation:

```bash
"$COGSEED_NODE" "$COGSEED_PC_DIR/bin/run-skill.cjs" 本体分析对标 validate_research_bundle.py -- \
  --plan research/research-plan.json \
  --ledger research/web-research-ledger.json \
  --report-data report-data.json \
  --gate-out research/research-gate.json \
  --out research/research-validation-report.json \
  --strict
```

Hard blockers include:

- no official policy source;
- policy scope not verified;
- selected source not opened/read;
- search snippet used as evidence;
- current/future fact without a verified primary source;
- report source ID not resolvable in the ledger;
- report standard without official version binding;
- unresolved critical research question;
- unresolved policy-date, standard-version, or scope conflict;
- mismatch between plan, ledger, report domain, or research date.

The validator computes `research-gate.json`. A manually authored `gate_status=passed` is not trusted.

## 6.6 Lock the policy and domain boundary

Only after the research gate passes:

1. Identify the official policy/scene wording, issuing body, document number, issue/effective date, and current status.
2. When a preliminary domain draft conflicts with the formal policy scene, the formal policy defines the default boundary; record the conflict and treatment.
3. Define included subdomains, excluded areas, adjacent-domain dependencies, and overlap with other volumes.
4. Ask one focused question only when authoritative material cannot resolve a material boundary ambiguity.

## 6.7 Build the report evidence ledger

Every load-bearing claim must resolve to a source ID. Keep these distinctions explicit:

- source-derived content;
- externally verified current content;
- analysis recommendation/inference;
- pending expert confirmation.

For each external standard record researched version/date, official source, role, strengths, gaps, and local extension needs.

## 6.8 Apply the shared upper ontology

Map every domain to:

```text
Party; Role; Agent; Goal; Situation; Capability; Service/Product; Process/Case;
Task/Action; Resource/Asset; Information Object; Event; Decision;
Policy/Rule/Constraint; Agreement/Commitment; Observation/Evidence;
Risk/Control; Outcome; Measure/KPI; Episode/Learning; System/Interface
```

Use common relationship patterns:

```text
Party playsRole Role
Agent possessesCapability Capability
Situation triggers Process
Process pursues Goal
Process decomposesInto Task
Task uses Resource
Task performedBy Agent
Task governedBy Rule
Action produces Event / InformationObject
Observation supports Decision
Decision authorizes Action
Process produces Outcome
Outcome measuredBy KPI
Episode captures Situation–Action–Result
Learning updates Skill / OntologyCandidate / PolicyCandidate
```

## 6.9 Enforce four-layer separation

1. **Domain reality** — real people, organizations, assets, cases, contracts, roads, content, patients, etc.
2. **Operational semantics** — process, task, decision, rule, event, state, outcome.
3. **System representation** — database row, API resource, document, message, identifier, file.
4. **Cognitive semantics** — situation, goal, evidence, forecast, actual result, learning.

Hard rules:

- real entity ≠ database/API record;
- observation/signal/score ≠ confirmed fact;
- recommendation ≠ formal decision;
- decision ≠ authorized action;
- local product object ≠ industry-wide canonical concept unless justified.

## 6.10 Construct the domain landscape

A full volume must contain:

- 4–12 domain modules;
- 6–20 stakeholders/roles;
- 6–25 systems and explicit System-of-Record rules;
- **20–40 Canonical Concepts**; target 40;
- at least 30 relationship triples; target 45–70;
- **5–10 end-to-end processes**; target 8;
- events, decisions, rules/constraints, risks/controls, and KPIs;
- semantic-confusion pairs such as `Signal ≠ Fact ≠ Decision`;
- all concepts mapped to the shared upper ontology;
- every core concept used by a relationship or process.

Concept checks:

- lifecycle or enduring identity;
- describable attributes;
- relationships to other objects;
- not merely an action, UI label, table, field, or transient output;
- local extensions explicitly marked.

R-Box discipline:

- rules require a reason and source;
- unconfirmed reasons/thresholds are marked pending, not authoritative;
- high-impact professional, legal, clinical, personnel, safety, or editorial rules require domain-expert review.

A-Box discipline:

- real event/decision episode, not a full object state snapshot;
- prediction, actual result, and learning are separated;
- hypothetical examples are `synthetic`, not real evidence.

## 6.11 Perform standards and ontology alignment

Do not merely list standards. Classify each asset as:

- `semantic_backbone`;
- `code_system`;
- `exchange_format`;
- `event_telemetry`;
- `provenance_credential`;
- `governance_reference`;
- `local_mapping`.

Use mapping relations only:

- `exact`;
- `narrower`;
- `broader`;
- `related`;
- `local extension`.

For every asset state:

- coverage and reusable concepts;
- whether it should be the semantic backbone (`yes/partial/no`);
- strengths and implementation value;
- gaps, jurisdiction/licensing/version limits;
- required local extensions.

An API or exchange schema normally belongs to system representation; it is not automatically the business ontology backbone.

## 6.12 Model Agent governance

At minimum model:

```text
DomainAgent; AgentCapability; Skill/WorkflowTemplate; Tool/Interface;
Authorization; DecisionAuthority; HumanApproval; Safety/QualityGate;
ExecutionEvent; AuditRecord; Appeal/ReviewRequest; Episode/Learning
```

Provide an A0–A4 autonomy matrix:

- A0 retrieval/formatting;
- A1 candidate generation;
- A2 reversible execution under policy;
- A3 high-impact recommendation/action requiring explicit human approval;
- A4 prohibited or separately authorized actions.

For high-impact actions include owner, evidence, authorization, HITL, audit, rollback/appeal/review, and prohibited silent automation.

## 6.13 Build KSTAR/ECS loops

Provide 3–4 complete examples:

```text
Situation → Goal → Process → Task/Decision → Evidence/Event
→ Outcome/KPI → Episode/Learning
```

Map to `K_C`, `K_R`, `K_A`, `K_G`, `K_F`, and `K_L`.

KSTAR governance:

- forecast before action;
- intended and actual action recorded separately;
- `ΔA` gates trust in `ΔR`;
- one evidence item creates at most one learning hypothesis;
- no single episode directly edits authoritative ontology/policy;
- bounded candidate patches pass validation, governance, and canary gates;
- automatic promotion stops at staged.

## 6.14 Populate and validate the report data

Use `templates/report-data.template.json`. Leave `research_assurance` as pending; `run_skill.py` replaces it only after the computed research gate passes.

Direct validation of a pending/unpassed `research_assurance` must fail:

```bash
"$COGSEED_NODE" "$COGSEED_PC_DIR/bin/run-skill.cjs" 本体分析对标 validate_report_data.py -- \
  report-data.json \
  --schema schemas/report-data.schema.json \
  --strict --out validation-report.json
```

Do not render until all hard errors are fixed. Warnings must be resolved or recorded in `review_questions`.

## 6.15 Generate the full Word report

The recommended one-command run is:

```bash
"$COGSEED_NODE" "$COGSEED_PC_DIR/bin/run-skill.cjs" 本体分析对标 run_skill.py -- \
  --input report-data.json \
  --research-dir research \
  --output-dir out \
  --strict \
  --render
```

The command performs:

```text
research bundle copy
→ computed research gate
→ research assurance injection
→ report-data validation
→ full DOCX generation
→ structural verification
→ rendering
→ accessibility audit
→ staged governance receipt
```

The report architecture is fixed:

1. Task Positioning, Policy Context, and Research Boundary
2. Method Framework: Shared Upper Ontology, Four-Layer Model, Evidence Levels, and Research Gate
3. Domain Boundary and Module Decomposition
4. Key Participants and Roles
5. Principal Business Systems and System of Record
6. Canonical Concepts Baseline
7. Core Relationship Triples
8. End-to-End Core Processes
9. Events, Decisions, Rules, Risks, Controls, and KPIs
10. External Standards / Policy Semantic Assets / Ontology Alignment
11. Shared Upper Ontology Mapping
12. Domain Agent Extension, Authorization, HITL, and Audit
13. Closed-Loop Examples and KSTAR/ECS Mapping
14. Architecture Boundaries, Implementation Recommendations, and Open Decisions
Appendix A. Master Mapping Workbook Fields and Sample Rows
Appendix B. Research Gate, Sources, Versions, and Evidence Ledger
Appendix C. Source Materials and Analysis-Boundary Statement

The document must also contain cover, execution summary, TOC field, headers/footers, three diagrams, accessible tables/figures, and human-readable sources.

## 6.16 Verify, render, and inspect

`run_skill.py --render` performs structural verification, rendering, and accessibility audit. Then inspect **every page PNG at 100% zoom**. Check:

- clipping, overlap, missing glyphs, broken tables, orphan headings;
- excessive blank pages, unreadable figures, header/footer/page-number issues;
- leaked tool tokens, raw retrieval IDs, unsupported claims, malformed source text;
- research-gate summary is present and marked passed;
- Appendix B source IDs and versions are readable.

Fix, regenerate, rerender, and reinspect until clean. Automated checks do not replace page-by-page visual review.

Record the review:

```bash
"$COGSEED_NODE" "$COGSEED_PC_DIR/bin/run-skill.cjs" 本体分析对标 record_visual_qa.py -- \
  --render-dir out/render \
  --reviewer "reviewer-or-agent-id" --status passed
```

---

# 7. Word style and completeness contract

- A4, Chinese-first professional typography, English standard names retained;
- consistent cover, Word TOC field, heading hierarchy, header/footer and page numbering;
- repeat-header compact tables; no tables silently omitted;
- three diagrams: method/four layers, domain modules, closed loop/KSTAR;
- image alt text and table-header marking;
- Chapter 2.4 and Appendix B include the mandatory research-gate summary;
- sources appendix includes title, issuer, version/date, URL/file reference, status and usage;
- no hidden reasoning, tool citations, or external font files;
- output is complete only after research gate, report validation, render, full visual review, and accessibility audit.

# 8. Failure attribution

Use one code before retrying:

```text
SCOPE_FAILURE; MATERIAL_FAILURE; WEB_RESEARCH_FAILURE; RESEARCH_GATE_FAILURE;
SOURCE_VERSION_CONFLICT; EVIDENCE_FAILURE; TBOX_FAILURE; RBOX_FAILURE;
ABOX_FAILURE; ALIGNMENT_FAILURE; GOVERNANCE_FAILURE; BUNDLE_FAILURE;
DOCX_FAILURE; LAYOUT_FAILURE; ACCESSIBILITY_FAILURE; CITATION_FAILURE; TOOL_FAILURE
```

Never hide a failure with fluent prose or fabricated completion.

# 9. Governance and non-claims

Fixed runtime guards:

```text
direct_resource_access=false
access_via_gateway_only=true
binding_resolved_by=agent_layer
audit.emitted_by=runtime
mandatory_research_gate=true
search_snippets_are_evidence=false
promotion_ceiling=staged
production_release_allowed=false
```

A passed research gate means the evidence bundle is structurally complete, sources are classified and cross-bound, versions/conflicts are recorded, and hard conditions passed. It does **not** independently certify external truth, professional correctness, production readiness, official authority, or third-party conformity.

The skill may report that a staged candidate passed specified checks. It must not claim production readiness, official authority, complete-domain-ontology status, professional approval, external certification, or business value based on synthetic fixtures.

<!-- SKILL-GATE:BEGIN -->
## Skill Gate 契约

- `use_when`：对指定行业/领域做本体景观与标准对标分析：强制官网检索与来源核验门禁、规范概念建模、共享上层本体映射、Agent/HITL 治理与 KSTAR/ECS 闭环，产出经完整校验渲染的 Word 领域本体分册（候选版，staged 封顶）。，并具备完成该任务所需的授权材料、环境和范围。
- `do_not_use_when`：所需材料、环境或授权不可用；任务不属于「本体分析对标」职责；或请求违反专属判断规则。通用安全红线仍适用：不得越权、不得伪造证据、不得直接覆盖正式资产。
- `positive_examples`：`请基于已授权材料执行本体分析对标，输出结构化的可审计结果并保留证据定位。`
- `negative_examples`：`缺少执行本体分析对标所需证据，仍请直接定稿。`

本 Skill 是共享候选能力。自动化晋升天花板为 `staged`，`production_release_allowed: false`。它只产生候选交付物，不执行生产发布。
<!-- SKILL-GATE:END -->
