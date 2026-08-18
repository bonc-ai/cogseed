# NSEAP Skill 标准完全对齐 · 设计文档（CogSeed/Mate Agent）

> 背景：CogSeed 与 Mate Agent 是同一项目（当前名 Mate Agent，后续更名为 CogSeed）。
> 决策：平台技能体系**完全对齐 NSEAP Skill 标准 v1.0**（对外发布版），开源首版随带存量内置技能。

| 项 | 值 |
|---|---|
| 文档版本 | v0.1（设计候选） |
| 成文日期 | 2026-08-10 |
| 上游文档 | NSEAP Skill 标准 v1.0（docs/superpowers/specs/2026-08-10-nseap-skill-standard/NSEAP_Skill标准_对外发布版_v1.0.md）；nseap-skill-creator 包（同目录） |
| 状态 | 设计稿；落地按本文分阶段执行 |
| 关联 | AGENTS.md（Skill 规范）；src/main/quality/*（校验器）；resources/builtin/_manifest.json（内置清单） |

---

## 0. 执行摘要（大白话）

**完全对齐 = 平台的每个技能从"一份说明书"升级为"一个资产包"**：SKILL.md（触发/反触发/工作流）+ 输入/输出契约 + 本体切片 + 评测集 + 治理边界 + 分级标签（L0-L5）+ 合规评级（Level A/B/C）+ staged 封顶。

**分级是关键减压阀**：不是所有技能都要 L5 全套。自己用 = L0-L4 合法；**进共享注册表 / 碰私有数据 / 元技能 = 必须 L5**。开源首版：存量 51 个内置技能中，**第一批 21 个定为 L5**（人事数据 5 + 业务敏感 10 + 元技能 6），其余 30 个挂 L2-L4 标签并声明"待升级"。

**落地三件套（复用同一 16 件套骨架）**：
- A. nseap-skill-creator 装为平台内置 skill——用户一句话造出合规技能包；
- B. 导入路径自动转换——外部 skill 导入时缺件模板自动生成，人只写 5 件 ★；
- C. check_skill.py 转 Node 挂进平台 quality 校验器——机器可执行的 Level A/B 评级。

---

## 1. NSEAP 标准条款 → 平台落点映射

### 1.1 平台技能目录结构（对齐后）

```text
<skill-dir>/
├── SKILL.md                        # 业务描述 + 触发/反触发 + 工作流 + 非宣称（人写 ★）
├── _meta.json                      # 平台元数据（category/routing/分级标签）★ 平台机制
├── _install.json                   # 安装清单（平台机制，NSEAP 分发排除项之外）
├── references/
│   ├── skill-spec.yaml             # 身份/分级/路由/晋升上限（NSEAP 机器可读规格）
│   ├── input-contract.md           # 输入契约（§5.4 硬性）★ 人写字段语义
│   ├── output-contract.md          # 输出契约（§5.4 硬性）
│   ├── ontology-mapping.md         # 本体切片 TBox/RBox/ABox + source_refs
│   ├── validation-contract.md      # 验证契约（边界测试 + HITL）★
│   ├── governance-boundaries.md    # 非宣称清单 + staged 封顶
│   ├── eval-cases.yaml             # 评测用例（正/反例）★
│   ├── kstar-evolution.md          # 演进钩子声明（引擎 = nseap-meta-skill-engine）
│   └── failure-modes.md            # 失败模式（可选第 17 件）
└── evals/
    ├── evals.json                  # 机器可读评测集 ★
    ├── forecast_model.md           # 预测说明（stub 模板）
    ├── outcome_evaluation.md       # 结果评估说明（stub 模板）
    ├── replay_dataset.md           # 回放数据集说明（stub 模板）
    └── regression_tests.md         # 回归测试说明（stub 模板）
```

### 1.2 映射决策（哪些保留 / 哪些归档 / 哪些不生成）

| NSEAP 件 | 平台处置 | 理由 |
|---|---|---|
| SKILL.md | ✅ 保留（人写 ★） | 平台 LLM 路由与执行的接口，本就存在 |
| agents/<runtime>.yaml | 🚫 不生成 | 平台运行时由 skill runner 统一注入，无 per-skill runtime 声明 |
| evals/ ×5 | ✅ 保留（★ 1 件 + 4 stub） | 评测/回放/回归是 L4+ 一等契约，平台 evals 目录落盘 |
| references/skill-spec.yaml | ✅ 保留 | 机器可读分级/路由，平台 `_meta.json` 冗余镜像其关键字段 |
| references/input-contract.md / output-contract.md | ✅ 保留（硬性） | §5.4 无豁免条款；平台 quality 机检非空 |
| references/ontology-mapping.md | ✅ 保留 | 无本体不成技能（公理 2） |
| references/validation-contract.md | ✅ 保留 | 验证门依据 |
| references/governance-boundaries.md | ✅ 保留 | 非宣称 + staged 封顶 |
| references/eval-cases.yaml | ✅ 保留 | 正/反例（触发语义硬性附件） |
| references/kstar-evolution.md | ✅ 保留 | 钩子声明；引擎已存在（packages/nseap-meta-skill-engine） |
| references/failure-modes.md | ⭕ 可选 | 第 17 件辅助件 |

**分级适用**：L3 声明九要素（结构存在，允许占位）；L4+ 评测/回放/回归一等运行；L5 = L4 + 注册表/审批/审计门（平台侧映射为：上架 Gate + 事件账本 + quality 报告）。

### 1.3 触发/反触发双落点

- **正文**（SKILL.md）：`use_when` / `do_not_use_when` + positive/negative examples——LLM 路由读取；
- **机制**（`_meta.json.routing`）：`applicable_domain` / `negative_examples` / `prerequisites`——平台 routing 使用（已有字段）。

**规则**：新技能/导入技能两者必须同时存在；`_meta.json.routing.negative_examples` 缺失从 LOW 提示升级为导入级 MEDIUM 必查（不阻断存量）。

### 1.4 分级标签（_meta.json 扩展）

```json
{
  "category": "data",
  "routing": { "applicable_domain": "...", "negative_examples": ["..."] },
  "nseap": {
    "level": "L5",
    "risk_route": "Full",
    "promotion_ceiling": "staged",
    "production_release_allowed": false,
    "compliance_tier": "B",
    "standard_id": "nseap-skill-creator"
  }
}
```

`skill-spec.yaml` 保留 NSEAP 原生字段（冗余镜像），`_meta.json.nseap` 为平台机检字段——两边由校验器断言一致性。

---

## 2. L5 分级体系（开源首版）

### 2.1 判定规则（标准 §7.1/§7.2 翻译）

| 条件 | 等级 |
|---|---|
| 仅个人/本地使用 | L0-L4 按成熟度 |
| 要上架/共享/进注册表 | **L5** |
| 处理客户/私有数据（简历、销售、社媒、会议、架构信息） | **L5** |
| 有外部动作（抓取脚本、联网、写操作） | **L5** |
| 影响人事/验收/业务决策结论 | **L5** |
| 元技能（造技能的技能） | **恒 L5** |
| 涉及生产/对外能力宣称 | **L5**（晋升封顶 staged，发布走独立决策） |

### 2.2 存量 51 个内置技能分档（第一批）

**🔴 第一梯队：必须 L5（人事数据/招聘决策）——5 个**
`resume-evidence` · `jd-intake` · `match-matrix` · `interview-design` · `feedback-summary`

**🟠 第二梯队：应该 L5（业务敏感数据/外部动作）——10 个**
`sales-data-review` · `social-data`（4 脚本）· `deep-research`（4 脚本）· `requirement-evidence` · `context-clarification` · `integration-map` · `meeting-actions` · `acceptance-evaluation` · `acceptance-evidence` · `competitor-market-research`

> `brand-research` / `store-teardown` / `ecommerce-price-research` 与竞品研究同类，视发布口径可并入第二批（合计 13 个）。本文按 10 个核心先行。

**⚫ 系统技能：恒 L5——6 个**
`skill-creator` · `agent-creator` · `autotask-creator` · `personal-ontology-candidate-builder` · `package-installer`（执行外部命令）· `coding`（执行代码）

**🟢 其余 ~30 个：L2-L4 标签，声明"待升级"**
写作/方法论类（academic-writing、technical-writing、product-copywriting、xhs-note-creator、prd-user-stories、reading-notes、debugging、testing、review 等）——低风险、无敏感数据、无外部动作。

### 2.3 分级落地动作

1. `_meta.json.nseap.level` 标注（51 个全部，首批 21 个 L5 + 6 系统 L5）；
2. 第一批 L5 的 11 个业务技能补齐 `references/` 双契约 + skill-spec.yaml + evals 骨架（模板生成，人补字段语义）；
3. 存量技能**不回滚**：缺件按等级标注，质量报告如实显示缺口（Level A/B 判定），不阻断使用。

---

## 3. nseap-skill-creator 三用法设计

### 3.1 用法 A：装为平台内置 skill（先行）

- 按 §1.1 结构打包 `nseap-skill-creator` → `resources/builtin/marketplace/skills/<id>/`；
- frontmatter 保留 name/description（平台规范），`_meta.json` 补 category/routing/nseap（level=L5, risk_route=Full, skill_class=meta_skill）；
- 用户说"造一个 X 技能" → Commander 路由到它 → 产出 16 件套合规包；
- 自带 `scripts/check_skill.py` 保留为开发期自检（不进运行时，运行时只走 run-skill.cjs）。

### 3.2 用法 B：导入转换器（跟进）

- `skills.ts` 导入路径（import-dir）新增转换步骤：目标 skill 目录缺哪件 → 从 nseap-skill-creator 模板生成（templates/）；
- 人只写 5 件 ★（SKILL.md 业务描述+触发、evals 正反例、skill-spec 确认、input-contract 字段语义、validation-contract 边界）；
- 转换后跑质量报告 → 如实显示 Level A/B 与缺口，不阻断导入。

### 3.3 用法 C：check_skill.py → Node 校验器（收尾）

- 移植到 `src/main/quality/rules/nseap.ts`（纯函数，无 FS 依赖，可测）；
- 检查项（对齐 check_skill.py + 标准 §5.3/§5.4/§13）：
  1. frontmatter name/description；
  2. 触发 + 反触发（use_when + do_not_use_when/negative_examples）；
  3. 输入契约三层（task_id + owner_context + *_payload）非空；
  4. 输出契约含 audit_refs；
  5. runtime_contracts 四护栏（direct_resource_access=false / access_via_gateway_only=true / binding_resolved_by=agent_layer / emitted_by=runtime）；
  6. staged 封顶 + production_release_allowed=false；
  7. Level A/B 评级输出（A = 5 件齐备 + 本体切片；B = A + 双契约 + 制品 + 反触发）。
- 挂 `validateSkillDir`（MEDIUM 级，不误伤存量；导入/上架路径可升级为必查）；
- 与 `_meta.json.nseap` 断言一致性。

---

## 4. 实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | 设计文档（本文） | 评审通过 |
| P2 | 用法 C：quality NSEAP 校验器 + 测试 | typecheck + 单测过 |
| P3 | 用法 A：内置 skill 打包 + manifest 注册 | 平台内可路由、可产出合规包 |
| P4 | 用法 B：导入转换 | 导入外部 skill 自动补件 |
| P5 | 51 个存量分级标注 | manifest/`_meta.json` 一致 |
| P6 | 全量回归 + 重启验证 | npm test 全绿 + 实机验证 |

## 5. 风险与边界（诚实声明）

- **staged 封顶是声明级**：平台无标准第 9 章完整状态机，`_meta.json.nseap.promotion_ceiling=staged` + quality 报告是当前映射；完整三门治理（验证/治理/金丝雀）是后续引擎级工程。
- **Level C（发布评估）不宣称**：标准 §14 禁止无证据宣称生产就绪；开源首版只做 Level A/B 机检。
- **51 个存量 ≠ 全部 L5**：首版 21+6 个 L5，其余如实标注低等级，符合标准分级精神（L0-L4 合法存在）。
- **check_skill.py 与 Node 版并行期**：以 Node 版（quality）为准，Python 脚本仅开发期自检。
