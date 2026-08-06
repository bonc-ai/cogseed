# Validation Contract（校验契约）

Skill: `personal-ontology-candidate-builder`  ·  Level: `L3`  ·  Owner: `Mate Agent Team`

## 静态检查（Static Checks）

- `SKILL.md` 存在，frontmatter 含 `name` 和 `description`。
- `schemas.json` 是合法 JSON，含 `candidates_md_format` 和 `blocked_items_md_format`（App 候选审阅面板依赖）。
- `references/output-contract.md` 存在（candidates.md 格式契约，与 `personal_ontology_candidates.ts` 解析器同步）。
- 本体文件存在：`ontology/personal_ontology/scene_package.yaml` / `scene_tbox.yaml` / `scene_rbox.yaml` / `scene_abox.yaml` / `scene_mapping.yaml`。
- `references/ontology-mapping.md` 引用 TBox/RBox/ABox 文件（链接完整）。
- `references/skill-spec.yaml` 存在且 YAML 可解析。

## 触发检查（Trigger Checks）

正向（positive）:

- 对话/记忆 → 候选提炼。
- "记住这个"手工交代 → 候选提炼。
- 清理/审阅最近对话 → 候选沉淀。

负向（negative）:

- 不经确认直接写入记忆。
- 把敏感信息（密钥/他人隐私）存进候选。

边界（boundary）:

- 未脱敏或未知敏感内容 → 阻断（blocked_items）。
- 来源支撑弱 → 低置信候选或阻断。
- 过度泛化的规则 → 标记风险。

## 执行检查（Execution Checks）

- 无未经确认的本体写入。
- 所有候选带 `source_memory_refs`。
- 所有候选 `sync_policy=local_only`。
- 输出为**人读 markdown**（candidates.md / blocked_items.md），非 JSON。
- 路径用 `$ORKAS_WORKSPACE_ROOT/$ORKAS_UID` 环境变量拼，不写死具体用户路径。

## 结果指标（Outcome Metrics）

- candidate_precision：候选类型判定准确率。
- source_trace_completeness：来源引用完整度。
- masking_block_recall：敏感信息拦截召回率。
- confirmation_load：用户确认负担（候选过多/过碎=负担重）。

## 验证方式

- 技能执行后 `cat` 核对 candidates.md 实际落盘（不凭 LLM 自报）。
- 候选池解析：App 候选审阅面板能读出全部待确认候选。
- blocked_items.md 解析：阻断项在面板可见（格式漂移会导致静默不可见）。
