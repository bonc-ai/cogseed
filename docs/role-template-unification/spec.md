# 角色模板运行时统一改造 Spec

| | |
|---|---|
| 状态 | Draft — 待实施 |
| 版本 | 1.0 |
| 基线 commit | `c1f2234b` |
| 依据 | 全文结论均来自当前仓库代码走查，逐条给出 `文件:行` |
| 适用范围 | `src/main/features/role_templates.ts` 及其全部运行时消费方 |

> 阅读顺序建议：第 1 章（现状）→ 第 3 章（原则层 schema）→ 第 4 章（注入链）→ 第 10 章（分阶段）→ 附录 C（实施顺序）。其余章节按需查阅。

---

## 1. 背景与问题定义

### 1.1 当前角色模板的真实状态

角色模板定义在 `src/main/features/role_templates.ts:53` 的 `BUILTIN_TEMPLATES`，共 9 个（student / scholar / fde / product_manager / project_manager / technical_writer / recruiter / software_engineer / ecommerce_ops）。类型契约见同文件 `:42-51`：

```ts
export interface RoleTemplate {
  template_id: string;
  name: string;
  description: string;
  version: string;
  preset_groups: PresetGroup[];
  bundle?: RoleTemplateBundle;   // { skill_ids: string[]; agent_ids: string[] }
}
```

逐字段核对其运行时效果：

| 字段 | 实际效果 | 依据 |
|---|---|---|
| `bundle.agent_ids` | **真影响运行时**。派生为空间有效 agent 集合，进而（a）过滤 commander 花名册（b）在 dispatch 时丢弃不在空间内的 recipient | `spaces.ts:229-247` `resolveSpaceResources` → `spaces.ts:1072` `resolveSpaceScope` → `bus.ts:3564` → `bus.ts:3861` `buildCommanderSystemPrompt(allowedAgentIds)`；dispatch 过滤在 `bus.ts:2205-2244` |
| `bundle.skill_ids` | **基本不影响模型实际执行**。`resolveSpaceScope` 解析出了 `scope.skills`，但运行时无人消费 | `bus.ts:3861` 只取 `turnSpaceScope?.agents`；`bus.ts:2211` 的 dispatch 过滤只用 `scope.agents`；`bus.ts:3888` 注释原文「skillList stays undefined for commander」；`bus.ts:4785` 注释原文「Skills are NOT project-scoped this round」。`runner.ts:252` 的 `projectAllowedSkillIds` 全仓库**零赋值点** |
| `description` | **创建时一次性复制**到 space instructions，之后与模板脱钩 | `workspace.js:1907` `_createInstruction = tpl ? (tpl.description \|\| '') : ''` → `workspace.js:1861` `spaces.create({ instructions })` → `space.json.instructions` → `spaces.ts:897` `formatSpaceInstructionsForSystemPrompt` |
| `preset_groups` | **画像结构，不是行为规则**。安装时物化成文件空坑；之后作为候选自动填坑的白名单 | 物化：`personal_ontology_template_files.ts:278`；白名单：`personal_ontology_candidates.ts:606-610`；declared 校验：`personal_ontology_template_files.ts:624-627` |
| `version` | **死字段**。`installed_version` 只在 `listTemplateStatus` 输出一次，渲染层零读取，无任何比较逻辑 | `personal_ontology_template_files.ts:1090`；`grep installed_version src/renderer` → 无命中 |
| `TemplateField.description` | 零使用（9 个模板 0 处填写） | `role_templates.ts:21` 声明；实例中 0 处 |
| `TemplateField.isRelation` | 零使用（0 个内置模板声明）。`ontology-rules.ts:19` 源码自述「template-level, currently unused by built-in templates」 | `grep 'isRelation: true' role_templates.ts` → 仅注释行 `:10` |
| `PresetGroup.description` | 零使用（9 个模板全为 `""`） | 实例中全空 |

### 1.2 约束来源是分散的

当前对「AI 在这个角色下应该怎么工作」这件事，有 4 个互不连通的来源：

1. **space instructions** — `spaces.ts:897`，每轮无条件注入，标注为 `configuration, not conversation content`。内容是创建时复制的 description 副本。
2. **role profile** — `spaces.ts:1091` `formatRoleProfileForSystemPrompt`，每轮注入，但只输出**已填字段的值**（`- 分节 · 字段: 值`），空坑不注入，全空则返回 `''`。
3. **Agent workflow** — `agent.json.workflow` 静态字符串，经 `bus.ts:6369` 原样填入 `chat_agent_in_group.md:151` 的 `$workflow`。**只有被 dispatch 到的那个 Agent 能看到**；commander 的 `chat_commander.md` 里没有任何 workflow 变量。
4. **Skill Gate** — `SKILL.md` 正文里的 `use_when` / `do_not_use_when` / 专属判断规则。**模型必须主动 `read_file(SKILL.md)` 才看得到**；system prompt 里每个技能只有 `name + 240 字压缩描述`（`skill-registry.ts:134` `MAX_COMPACT_SUMMARY = 240`，渲染在 `skill-registry.ts:285` `renderSkillLines`）。

### 1.3 已确认的结构性断裂

**断裂 A：commander 看不到 Agent workflow。**
`buildCommanderSystemPrompt`（`bus.ts:6091-6160`）的模板变量里没有 workflow；花名册 `buildAgentsIndexBlock` 只给 name/description。因此 commander 在决定「派给谁」时，不知道被派的 Agent 遵守什么停止规则。

**断裂 B：Skill 不读取角色画像。**
提示词侧：技能只渲染 name + 压缩描述。执行侧：`bin/run-skill.cjs` 只从环境拿到 `COGSEED_AGENT_ID`（`:263`）和 workspace root（`:113`），没有任何角色/画像通道。

**断裂 C：角色选择与画像安装是两条流程。**
`spaces.create`（`spaces.ts:564`）**从不调用** `installTemplateFile`。全仓库唯一调用点是 `ipc/index.ts:3111`，入口是「认知」页的手动安装按钮（`personal-ontology.js:770`）。onboarding 的 `spaces.create`（`onboarding.js:579`）同样不装。
后果：用户选了角色，`formatRoleProfileForSystemPrompt` 因为读不到 `<uid>/cloud/.personal_ontology_groups/<tid>.md` 而返回 `''`。这个语义已被测试固化 —— `test/main/features/role_profile_inject.test.ts:73`：「套模板空间但模板文件未安装 → 空串（降级不炸）」。

**断裂 D：template version 无迁移机制。**
`installTemplateFile`（`personal_ontology_template_files.ts:235`）只在**首次**建文件时按 `preset_groups` 铺空坑（`:278`）。之后改 `template.version` 对已装用户零影响：没有任何代码比较 `installed_version` 与 registry `version`。给现有模板新增字段，老用户永远填不进去 —— `appendFieldValueToRef` 会在 `:633` 返回 `'field not found'`，`appendExistingTemplateFieldValueToRef` 会被 `:624-627` 的 declared 校验挡掉。

**断裂 E：画像上限与角色数量不匹配。**
`MAX_INSTALLED_TEMPLATES = 3`（`personal_ontology_template_files.ts:59`）。9 个角色，画像同时最多存在 3 份。

### 1.4 核心问题陈述

> **当前核心问题不是「字段不够」，而是：角色定义没有统一的运行时语义来源。**

`description` 描述了角色的价值观（"不代劳、不虚构学习证据"、"坚持不虚构证据"、"数据不可得时不编造"），但这段文字：
- 不进 commander 的稳定注入位（只有创建时被复制一份到 instructions，用户随后可任意编辑或清空）
- 不进 Agent 的 system prompt
- 不进 Skill 的任何环节

而真正会影响行为的约束，散落在三个模型未必读得到、且互不引用的位置。

### 1.5 造成的后果

1. **同一角色在 commander / Agent / Skill 中表现不一致。**
   以 `software_engineer` 为例：技能 `a988c001dc65` 的判断规则是「症状消失不等于根因已证实」，写在 `SKILL.md` 正文；Agent `9099ea65848a` 的停止规则是「关键输入缺失且会改变结论…」，写在 workflow；commander 两者都看不到。三层对同一个角色各自持有一份互不知晓的约束。

2. **模板价值观只存在于描述文案，不能稳定影响每轮行为。**
   `description` 唯一进模型的路径依赖渲染层的一次拷贝（`workspace.js:1907`）。走 scenario 卡创建（`workspace.js:1928` `_createInstruction = ''`）或走 onboarding（`onboarding.js:579` 不传 instructions）时，这段文案根本不进模型。

3. **老 workspace 无法获得后续模板修正。**
   见断裂 D。description 的副本冻结在创建时刻，preset_groups 的空坑冻结在安装时刻。

4. **模板容易退化为「职业换皮」。**
   量化证据（第 8 章有完整数据）：student / scholar / software_engineer 三组共 9 个 Agent，**停止规则与失败行为逐字相同**；8 个专业模板的 `use_when` / `do_not_use_when` 是同一句式填空，真正的差异只有末尾「专属判断规则」一句 —— 而这一句恰好埋在模型默认读不到的位置。

---

## 2. 改造目标

### 2.1 目标定义

```
Role Template = Profile Schema + Runtime Principles + Agent Bundle + Skill Bundle + Lifecycle Metadata
```

| 组成 | 回答什么问题 | 落点 | 是否进每轮 prompt |
|---|---|---|---|
| **Profile Schema** | 用户/项目**是什么** | `preset_groups`（现有）→ 物化为 `.personal_ontology_groups/<tid>.md` | 仅「已填的值」进（现状不变） |
| **Runtime Principles** | 这个角色**应该怎么工作** | 新增 `principles`（第 3 章） | **无条件进**（新增） |
| **Agent Bundle** | 不同工作阶段**由谁负责** | `bundle.agent_ids`（现有） | 花名册 + dispatch 过滤（现状不变） |
| **Skill Bundle** | 具体**执行能力** | `bundle.skill_ids`（现有） | Phase 4 起进作用域（现状：不生效） |
| **Lifecycle Metadata** | 版本、迁移、兼容 | 新增 `profile_schema_version` + 复用 `version` | 不进 prompt |

### 2.2 硬性区分

本次改造要求在类型层面把两件事彻底分开：

| | Profile Schema | Runtime Principles |
|---|---|---|
| 语义 | **关于用户/项目的事实** | **AI 应如何工作** |
| 来源 | 用户填写、候选确认、认知资产投影 | 模板作者定义 |
| 可变性 | 用户可增删改 | 用户不可改（模板级常量） |
| 存储 | 用户目录下的模板文件（per-user） | 代码内注册表（per-build） |
| 升级 | 需迁移，**绝不能覆盖用户值** | **直读 registry，无需迁移** |
| 注入 | 有值才注入 | 无条件注入 |
| 载体 | `preset_groups[].fields[]` | `principles` |

**禁止**继续把「角色应该怎么工作」塞进 `preset_fields` 或 `description`。

### 2.3 非目标边界

见第 12 章。

---

## 3. 统一角色原则层设计

### 3.1 Schema

在 `src/main/features/role_templates.ts` 新增（放在 `RoleTemplateBundle` 之后、`RoleTemplate` 之前，保持既有注释密度与中文风格）：

```ts
/**
 * 角色运行时原则（Runtime Principles）—— 「这个角色应该怎么工作」。
 *
 * 与 preset_groups 的分工是硬边界：
 * - preset_groups = 关于用户/项目的事实（A-box 值由用户填写，有值才注入）
 * - principles    = AI 的工作方式（模板级常量，每轮无条件注入）
 *
 * 每条写成一句可判定的陈述句，不写成段落。全部条目直接进 system prompt，
 * 因此总量受 token 预算约束（见 PRINCIPLES_BUDGET）。
 */
export interface RolePrinciples {
  /** 长期坚持的价值/工作原则。陈述句，正面表述。例：「结论必须由可定位的证据支撑」。 */
  core: string[];
  /** 冲突判断规则。写成「X 优先于 Y」或「遇到 A 时按 B 处理」。 */
  decision_rules: string[];
  /** 明确禁止的工作方式。否定式表述。例：「不得凭记忆补全题目、DOI 或结果」。 */
  anti_patterns: string[];
  /**
   * 何时停下来：补证据 / 询问用户 / 交回 commander。
   * 缺省 = 继承 DEFAULT_ESCALATION_RULES（本文件常量），不必每个模板重复。
   */
  escalation_rules?: string[];
}
```

`RoleTemplate` 增加必填字段：

```ts
export interface RoleTemplate {
  template_id: string;
  name: string;
  description: string;          // 保留：仅用于 UI 展示与 space_builder 候选清单
  version: string;
  /** Profile Schema 结构版本；仅在 preset_groups 增删字段/分组时 bump（见第 7 章）。 */
  profile_schema_version: number;
  /** 角色运行时原则；每轮无条件注入。v1.0 起必填。 */
  principles: RolePrinciples;
  preset_groups: PresetGroup[];
  bundle?: RoleTemplateBundle;
}
```

### 3.2 每类字段的职责

| 字段 | 职责 | 写法约束 | 数量建议 |
|---|---|---|---|
| `core` | 角色长期坚持的价值 / 工作原则。回答「这个角色如何看问题」 | 正面陈述句；不含条件分支；每条 ≤ 40 字 | 3–5 |
| `decision_rules` | 面对冲突时如何判断。回答「这个角色如何推进工作」 | 必须是可判定的二元或优先级表述（「X 优先于 Y」/「A 时按 B」）；不写「应该考虑…」 | 3–6 |
| `anti_patterns` | 明确禁止的错误工作方式 | 否定式；必须指向一个具体可观察的行为，不写「不要不专业」 | 3–6 |
| `escalation_rules` | 何时停下来、补证据、询问用户、切换 Agent | 触发条件 + 动作两段式；缺省继承默认集 | 0–4（可省略） |

### 3.3 默认升级规则常量

当前 9 个模板的 27 个 Agent 中，学生/学者/软件工程师三组的停止规则**逐字相同**。这套公共文本应上提为常量，而不是继续在每个 `agent.json` 里复制：

```ts
/** 全角色公共升级规则；模板未声明 escalation_rules 时继承。 */
export const DEFAULT_ESCALATION_RULES: readonly string[] = [
  '关键输入缺失且会改变结论时停下并说明缺什么',
  '证据无法定位或来源版本冲突时停下，不用推断补齐',
  '需要越权读取/写入时停下并请求授权',
  '预算耗尽或用户叫停时返回已完成与未完成部分',
];
```

### 3.4 强制要求

1. 原则**不得**依赖模型主动 `read_file(SKILL.md)` 才可见。
2. 原则**不得**只存在于 `agent.json.workflow`（commander 看不到，见断裂 A）。
3. 原则**不得**只存在于创建时复制的 `description`（走 scenario / onboarding 路径时不进模型，见 1.5.2）。
4. 原则**不得**要求用户先安装画像文件才生效 —— 它读的是 registry，不是用户目录。

### 3.5 Token 预算

新增常量，写在 `role_templates.ts`：

```ts
/** 单个模板 principles 全部条目的字符上限（中文按字计）。超限 CI 失败。 */
export const PRINCIPLES_CHAR_BUDGET = 900;
```

依据：`SPACE_INSTRUCTIONS_CHAR_LIMIT = 4000`（`spaces.ts:867`）是同层级用户配置的既有上限；principles 是主+副最多 3 个模板叠加注入（`spaces.ts:1104-1110` 的主+副遍历逻辑），900 × 3 ≈ 2700 字，与 instructions 单条上限同量级，可接受。

---

## 4. 统一运行时注入方案

### 4.1 改造前调用链（现状）

```
Role Template Registry (role_templates.ts:53)
  │
  ├── description ──► workspace.js:1907  _createInstruction = tpl.description
  │                     └─► spaces.create({instructions})  workspace.js:1861
  │                           └─► space.json.instructions
  │                                 └─► runner.ts:1020 formatSpaceInstructionsForSystemPrompt
  │                                       └─► "## Space instructions"   ✅ 每轮注入（但已与模板脱钩）
  │        （scenario 卡 / onboarding 路径：workspace.js:1928 / onboarding.js:579 → 不传 → ❌ 不进模型）
  │
  ├── bundle.agent_ids ──► spaces.ts:229 resolveSpaceResources
  │                          └─► spaces.ts:1072 resolveSpaceScope
  │                                ├─► bus.ts:3861 buildCommanderSystemPrompt(scope.agents) ✅ 花名册
  │                                └─► bus.ts:2211 dispatch recipient 过滤            ✅
  │
  ├── bundle.skill_ids ──► scope.skills ──► ❌ 无人消费（bus.ts:4785 注释确认）
  │
  ├── preset_groups ──► [需手动安装] ipc:3111 installTemplateFile
  │                       └─► <uid>/cloud/.personal_ontology_groups/<tid>.md（空坑）
  │                             └─► 用户填值 / 候选确认 / 认知资产投影
  │                                   └─► runner.ts:1050 formatRoleProfileForSystemPrompt
  │                                         └─► "## 当前角色画像"   ⚠️ 未安装或全空坑 → ''
  │
  └── [角色原则] ──► 散落在：
        ├── agent.json.workflow ──► bus.ts:6369 ──► chat_agent_in_group.md:151 $workflow  ⚠️ 仅该 Agent 可见
        └── SKILL.md 正文 ────────► 模型需主动 read_file                                 ⚠️ 默认不可见
```

### 4.2 改造后调用链（目标）

```
Role Template Registry (role_templates.ts)
  │   template_id → { principles, preset_groups, bundle, profile_schema_version }
  │
  ├── [新增] spaces.ts::resolveActiveRole(uid, spaceId)
  │      读 space.json → { primary_template_id, secondary_template_ids }
  │      → 返回 { primary: RoleTemplate, secondary: RoleTemplate[] }
  │      失败 → null（静默降级，与 resolveSpaceScope 的 S1 语义一致）
  │
  ├── [新增] spaces.ts::formatRolePrinciplesForSystemPrompt(uid, spaceId): Promise<string>
  │      纯 registry 读取，不依赖任何用户文件
  │      主角色 core/decision_rules/anti_patterns/escalation_rules 全量
  │      副角色只取 core + anti_patterns（避免决策规则打架，见 §4.6）
  │      → "## 角色工作原则（角色模板定义，非对话内容）"
  │      │
  │      └─► runner.ts（新增注入点，紧邻 :1050 之前）
  │            gate 与 roleProfileBlock 完全一致：`uid && memoryAgentScope && params.spaceId`
  │            │
  │            ├─► commander 会话（sessionId kind = gconv）
  │            │     memoryScopeForSession → 'commander'（session-store.ts:103）  ✅ 注入
  │            │
  │            └─► Agent / Worker 会话（kind = gmember / gworker）
  │                  memoryScopeForSession → agentId（session-store.ts:104）      ✅ 注入
  │                  spaceId 由 bus.ts:4749 `...(turnSpaceId ? { spaceId } : {})` 透传
  │
  ├── bundle.agent_ids ──► 现状不变（已生效）
  │
  ├── bundle.skill_ids ──► [Phase 4] scope.skills
  │                          → bus.ts 传入 runner `projectAllowedSkillIds`
  │                          → runner.ts:466 _intersectRenderAllowlist
  │                          → skill-registry.ts:982 getSystemPromptBlock({allowlist})
  │
  ├── preset_groups ──► [Phase 2] spaces.create 后自动 installTemplateFile
  │                       → 其余链路不变（画像仍然只有值才注入）
  │
  └── Skill 执行侧 ──► [Phase 4] bin/run-skill.cjs 新增 COGSEED_ROLE_TEMPLATE_ID 环境变量
                        （由 kernel/tools/skill-tools.ts 传入）
```

### 4.3 每轮无条件注入的是哪一层

**只有 `formatRolePrinciplesForSystemPrompt` 是无条件的**（只要会话挂了空间且空间有主模板）。其余保持现状条件：

| 块 | 条件 | 注入函数 |
|---|---|---|
| `## 角色工作原则` | 空间有 `primary_template_id` | `spaces.ts` 新增（本 spec） |
| `## Space instructions` | `space.json.instructions` 非空 | `spaces.ts:897` |
| `## 当前角色画像` | 画像文件已装**且**至少一个字段有值 | `spaces.ts:1091` |
| `## Available skills` | 恒有 | `skill-registry.ts:982` |

注入顺序（在 `runner.ts` 的 `parts` 数组里）建议：
`... → projectContextPolicyBlock(:1013) → projectInstructionsBlock(:1020) → **rolePrinciplesBlock(新增)** → memoryBlock(:1044) → roleProfileBlock(:1050)`

理由：原则是低频变更的配置，紧贴 instructions 放，能与它一起留在稳定缓存前缀内（`runner.ts:1019` 注释：「low-churn configuration, so it stays in the stable cache prefix」）。画像随候选确认变更更频繁，保持在后。

### 4.4 commander 如何拿到原则

**不需要改 `buildCommanderSystemPrompt`。** commander 走的是同一个 `runner.ts` 注入点：`bus.ts:4749` 已经把 `turnSpaceId` 作为 `spaceId` 透传给 runner，`memoryScopeForSession('gconv-…')` 返回 `'commander'`（`session-store.ts:103`），gate 成立。

这是本方案的关键收益：**一个注入点同时覆盖 commander 与 Agent**，不需要在 `chat_commander.md` 和 `chat_agent_in_group.md` 各加一份变量、也不会两边漂移。

### 4.5 dispatch 后的 Agent 如何继承同一套原则

同上 —— Agent worker 也走 `runner.ts`，`memoryScopeForSession` 对 `gmember` / `gworker` 返回 `agentId`（`session-store.ts:104`），`spaceId` 同样由 `bus.ts:4749` 透传。因此**同一个 `formatRolePrinciplesForSystemPrompt` 的输出会逐字出现在 commander 和每个 Agent 的 system prompt 里**，天然一致。

**已知不覆盖的路径**：CLI agent（`_runCliAgentTurn`，`bus.ts:4647`）是外部进程，不经过 `runner.ts` 的 system prompt 组装。本次不处理，列入第 12 章非目标。

### 4.6 主/副角色叠加规则

`spaces.ts:1104-1110` 现有的画像逻辑是「主角色优先，副角色字段排后」。原则层沿用同样的主次关系，但**收窄副角色的贡献**：

- 主角色：`core` + `decision_rules` + `anti_patterns` + `escalation_rules` 全量
- 副角色：只取 `core` + `anti_patterns`

理由：`decision_rules` 是优先级裁决（「X 优先于 Y」），两个角色的裁决规则同时全量注入会直接冲突（例：product_manager 的「先排序问题再评估方案」与 software_engineer 的「先搜索后读取，保持 Context 最小」在同一轮里争夺开场动作）。`core` 与 `anti_patterns` 是可叠加的约束，不产生裁决冲突。

块内必须标注归属，让模型知道哪条来自哪个角色：

```
## 角色工作原则（角色模板定义，非对话内容）
本空间的角色由角色模板定义。以下原则适用于本空间的每一轮工作，除非用户在对话中明确要求例外。

### 主角色「软件工程师」
坚持：
- ...
判断：
- ...
禁止：
- ...
停下来：
- ...

### 副角色「产品经理」（补充约束）
坚持：
- ...
禁止：
- ...
```

### 4.7 role profile 与 principles 如何并列而不混用

两个块**物理分离、语义分离、失败模式分离**：

| | `## 角色工作原则` | `## 当前角色画像` |
|---|---|---|
| 数据源 | `role_templates.ts` registry（进程内常量） | `<uid>/cloud/.personal_ontology_groups/<tid>.md` |
| 空值行为 | 模板必填 → 永不为空 | 未安装/全空坑 → `''` |
| 用户可改 | 否 | 是 |
| 版本升级 | 直读最新，立即生效 | 需迁移，不覆盖用户值 |
| 块头声明 | 「角色模板定义，非对话内容」 | 「已记录的个人画像（随候选确认更新）」（现有文案，`spaces.ts:1133`） |

**禁止**在 `principles` 里写任何指向具体用户/项目事实的内容（那是画像的职责），也**禁止**在 `preset_groups` 里新增诸如「工作原则」「判断标准」这类字段名（那是原则的职责）。

### 4.8 各文件在改造后的职责

| 文件 | 当前职责 | 改造后职责 |
|---|---|---|
| `src/main/features/role_templates.ts` | 模板常量注册表 + 场景常量 + 两个查询函数 | **唯一角色语义源**。新增 `RolePrinciples` 类型、`DEFAULT_ESCALATION_RULES`、`PRINCIPLES_CHAR_BUDGET`；保持纯常量、零 IO、零 import 业务模块 |
| `src/main/features/spaces.ts` | 空间 CRUD + 资源派生 + 3 个 prompt formatter | 新增 `resolveActiveRole` + `formatRolePrinciplesForSystemPrompt`。**唯一** 把「空间 → 角色 → 原则文本」串起来的地方 |
| `src/main/model/core-agent/runner.ts` | system prompt 装配 + 工具注入 | 新增一个注入点（`parts.push`）。**不承载任何角色语义**，只负责位置与 gate |
| `src/main/features/group_chat/bus.ts` | 会话调度 + prompt 构建 | 保持不变（Phase 1）。Phase 4 起负责把 `turnSpaceScope.skills` 传成 `projectAllowedSkillIds` |
| `src/main/model/core-agent/skill-registry.ts` | 技能发现/渲染/allowlist | 保持「哑渲染」。**不要**让它感知角色；Phase 4 只是让它收到一个已存在的 allowlist 参数 |
| `bin/run-skill.cjs` | 技能脚本 spawn | Phase 4 新增读取 `COGSEED_ROLE_TEMPLATE_ID`（只读透传，不解析语义） |
| `src/main/features/recall/personal-profile-sync.ts` | 认知资产 → 画像字段 + USER.md 投影 | 保持不变。它只碰 Profile Schema，**不得**触碰 principles |
| `src/main/features/personal_ontology_template_files.ts` | 画像文件安装/读写/迁移 | Phase 2 暴露幂等安装供 `spaces.create` 调用；Phase 3 新增 schema 迁移（第 7 章） |

---

## 5. commander / Agent / Skill 三层统一规则

### 5.1 职责边界

| | commander | Agent | Skill |
|---|---|---|---|
| 持有完整角色原则 | ✅ 全量 | ✅ 全量（同一块，逐字相同） | ❌ 不持有 |
| 任务理解与拆解 | ✅ | ❌ | ❌ |
| 是否 dispatch | ✅ | ❌ | ❌ |
| 阶段方法论 | ❌ | ✅ | ❌ |
| 原子执行能力 | ❌ | ❌ | ✅ |
| 适用性判断 | 选 Agent | 选 Skill | Gate 自检 |

### 5.2 commander

**负责：**
- 始终持有完整角色原则（由 §4.4 保证，无需 prompt 改动）
- 任务理解、拆解、是否 dispatch
- 调度不得与角色原则冲突

**在 `chat_commander.md` 需要新增的唯一一句约束**（放在 `## Routing-first algorithm`，`chat_commander.md:61` 段内）：

> 当 `## 角色工作原则` 块存在时，它约束你自己的每一步，也约束你派出去的每一次 dispatch。不要把一个会违反 anti_patterns 的任务派给任何 Agent。

**不负责：** 复述原则、把原则转写进 dispatch 的任务描述里（Agent 自己会收到同一块，重复只是浪费 token）。

### 5.3 Agent

**负责：**
- 在角色原则**之上**执行某阶段 workflow
- 只描述：输入 / 目标 / 工作流程 / 输出 / 停止条件

**不负责：** 重复抄写完整角色原则。

这是本次改造对现有资源的最大清理面。当前 `agent.json.workflow` 的尾部三段（「停止规则」「失败行为」「输出必须包含」）在 student / scholar / software_engineer 三组共 9 个 Agent 里**逐字相同** —— 这三段属于角色级或全局级约束，不该在每个 Agent 里复制：

| workflow 现有段落 | 改造后归属 |
|---|---|
| 「你是 XX Agent。<一句职责>」 | **保留在 Agent** |
| 「工作流程：1..5」 | **保留在 Agent** |
| 「停止规则：…」 | 通用条目 → `DEFAULT_ESCALATION_RULES`；角色特有条目 → 模板 `escalation_rules`；Agent 只保留**阶段特有**的（如 PRD Agent 的「达到 50 条高信号发现后汇总溢出项」） |
| 「失败行为：never_invent_missing_evidence；…」 | → 模板 `anti_patterns`（全 27 个 Agent 几乎相同，纯冗余） |
| 「输出必须包含：deliverable、evidence、…」 | → 全局共享规则 `chat_shared_rules.md`（27 个 Agent 逐字相同，与角色无关） |

**迁移必须是保内容的**：Phase 5 之前不删除 Agent 里的这些段落，只做「新增 principles」；Phase 5 才做去重清理，且需逐条确认已在 principles 中有对应表述。

### 5.4 Skill

**负责：**
- 执行原子能力
- Gate 自检任务是否适用（`use_when` / `do_not_use_when`）

**不负责：** 承载整个角色人格。

关键设计判断：**Skill 不应该也不需要读取完整角色原则**。原因是 system prompt 里角色原则块已经在技能块之前（§4.3 的顺序），模型在 `read_file(SKILL.md)` 时上下文中已经带着原则。让 Skill 再复制一份原则，等于制造第二个会漂移的副本。

Skill 需要的是**角色标识**，不是角色原则：
- 提示词侧：不改（技能仍只渲染 name + 压缩描述）
- 执行侧：Phase 4 通过 `COGSEED_ROLE_TEMPLATE_ID` 环境变量让脚本类技能知道自己在哪个角色下跑（用于产出物落点/格式选择，不用于行为约束）
- Gate 侧：`SKILL.md` 的「专属判断规则」**保留**，但它的定位从「角色的坚持」下降为「本技能的适用性边界」。角色级的坚持上移到 `principles`。

### 5.5 「规则放哪一层」决策表

未来新增任何一条约束时，按此表定位，避免重复配置：

| 约束的性质 | 放这里 |
|---|---|
| 所有角色、所有任务都适用（如「输出必须包含 evidence」） | `chat_shared_rules.md` |
| 这个角色的所有工作都适用（如「结论必须由可定位证据支撑」） | 模板 `principles.core` |
| 这个角色遇到冲突时的裁决（如「覆盖率优先于通过率」） | 模板 `principles.decision_rules` |
| 这个角色明令禁止的行为（如「不得凭记忆补全 DOI」） | 模板 `principles.anti_patterns` |
| 这个角色何时该停（如「伦理审批未确认时停」） | 模板 `principles.escalation_rules` |
| 某个工作阶段特有的步骤/停止条件 | `agent.json.workflow` |
| 某个原子能力的适用性边界 | `SKILL.md` 的 `use_when` / `do_not_use_when` |
| 关于这个用户/这个项目的事实 | `preset_groups` 字段 → 画像文件 |
| 这个空间独有、用户自己定的规矩 | `space.json.instructions`（用户手写） |

---

## 6. 画像系统与角色系统统一

### 6.1 问题复述

角色选择（`spaces.create` → `space.json.primary_template_id`）与画像安装（`ipc:3111 installTemplateFile` → `.personal_ontology_groups/<tid>.md`）是两条断裂流程（断裂 C）。

### 6.2 决策

**D1：用户选择模板时自动安装对应 Profile Schema —— 是。**

在 `spaces.ts::createSpace`（`:564`）成功写盘后，对 `primary` 与每个 `secondary` 调用 `installTemplateFile`。

约束：
- **best-effort，不阻断建空间**。安装失败只记 warn，`createSpace` 仍返回 `ok: true`（与 `spaces.ts:620` 的 `syncSpaceDirName` 同样的容错姿态，那里注释写明「失败保持旧命名，不影响读写」）
- `restoreData` 传 `false`（自动安装不做归档恢复；归档恢复必须是用户显式动作，见 `personal-ontology.js:770` 的现有交互）
- 调用方式必须是动态 import（`spaces.ts:1101` 已有先例：`await import('./personal_ontology_template_files')`），避免与 `personal_ontology_template_files.ts:23` 反向 import `role_templates` 形成静态循环

**D2：已安装模板再次选择 —— 幂等，无副作用。**

`installTemplateFile` 已经是幂等的：`personal_ontology_template_files.ts:251` 命中同 `template_id` 直接返回 `{ ok: true, already_installed: true }`，**不覆盖文件**。无需额外处理。

**D3：3 个已安装模板的上限 —— 保留，但改为「软失败」。**

`MAX_INSTALLED_TEMPLATES = 3`（`:59`）保留（它约束的是画像面板的认知负载，是产品规则）。但自动安装触发时若超限（`:256-258` 返回 `template_limit_reached`），必须：
- 不阻断建空间
- 记 warn，并在空间详情页给出可操作提示（「本空间的角色画像未安装：已达 3 个上限，可在认知页卸载不用的角色」）
- **不自动卸载任何已装模板**

关键：这个上限**只影响画像（事实层）**。角色原则（`principles`）不受此限制 —— 它读 registry，不占安装名额。这正是第 2.2 节职责分离的直接收益：超限时用户失去的是「AI 知道我是谁」，不是「AI 知道该怎么工作」。

**D4：一个 workspace 只能有一个 active role —— 是（primary）。**

现状已经如此：`space.json.primary_template_id` 单值，`secondary_template_ids` 最多 2 个（`spaces.ts:595` `.slice(0, 2)`）。改造后明确语义：

- **active role = primary**：贡献全量 principles + 花名册 + 画像
- **secondary = 补充角色**：贡献 `core` + `anti_patterns`（§4.6）+ bundle 并入有效集（`spaces.ts:236-249` 现状）+ 画像并列注入（`spaces.ts:1104` 现状）

**D5：多 role profile 与 active role 的区分 —— 画像按模板名分节，原则按主/副分节。**

画像侧现状已经正确：`spaces.ts:1126` 输出 `### 角色「{tplName}」` 分节头，多个模板并列不混淆。原则侧沿用同样的分节形式（§4.6 的块结构）。

### 6.3 语义红线

> **角色画像是「关于用户/项目的事实」，角色原则是「AI 应如何工作」。两者不能互相替代。**

具体禁止：
- 画像文件为空 → **不得**降级为「角色不生效」。原则照常注入。
- 原则里 → **不得**出现任何具体的用户/项目事实。
- 画像字段名 → **不得**新增「工作原则」「判断标准」「禁止事项」这类字段。
- `personal-profile-sync.ts` → **不得**把认知资产投影进 principles（它只碰 `appendExistingTemplateFieldValueToRef`，`:16`，保持现状）。

---

## 7. template version 与迁移机制

### 7.1 现状

| 事实 | 依据 |
|---|---|
| 安装时把 registry `version` 存进台账 `template_version` | `personal_ontology_template_files.ts:311` |
| `listTemplateStatus` 输出 `installed_version` | `:1090` |
| **无任何代码比较 installed_version 与 registry version** | 全仓库 grep 仅 2 处命中，均为写入/输出 |
| 渲染层不读 `installed_version` | `grep installed_version src/renderer` → 无命中 |
| 已装用户的文件在安装后冻结 | `:251` 幂等分支直接返回，不重铺空坑 |
| 新增字段老用户填不进 | `:624-627` declared 校验 + `:633` `'field not found'` |
| description 副本在创建后冻结 | `workspace.js:1907` 一次性拷贝 |

### 7.2 版本模型

引入**两个独立版本号**，因为两类内容的升级语义完全不同：

| 版本号 | 位置 | 语义 | 升级方式 |
|---|---|---|---|
| `version` | `RoleTemplate.version`（现有） | 模板整体版本（含 principles / description / bundle） | **不落盘、不比较**。运行时永远直读 registry |
| `profile_schema_version` | `RoleTemplate.profile_schema_version`（新增，`number`） | **仅** `preset_groups` 的结构版本；只在增删字段/分组时 +1 | 落盘为 `GroupMeta.profile_schema_version`，启动时比较并迁移 |

台账类型（`personal_ontology_groups.ts:71` 附近）新增：

```ts
export interface GroupMeta {
  // ... 现有字段
  template_version?: string;          // 保留（诊断用，不参与判断）
  /** 安装时的 Profile Schema 结构版本；与 registry 不等则触发迁移。 */
  profile_schema_version?: number;
}
```

### 7.3 三类内容的升级规则

| 内容 | 能否自动升级 | 机制 |
|---|---|---|
| **principles** | ✅ **自动、实时、无需迁移** | `formatRolePrinciplesForSystemPrompt` 每轮直读 registry。改了代码，老 workspace 下一轮就生效 |
| **description** | ✅ 展示侧自动（UI 直读 registry） | 已复制进 `instructions` 的副本**不动**（那是用户数据了）。改造后 description 不再承担运行时职责，冻结副本无害 |
| **bundle** | ✅ 自动 | `resolveSpaceResources`（`spaces.ts:229`）每次派生时直读 registry，失效引用进 `invalid_refs` |
| **preset_groups 新增字段/分组** | ⚠️ **必须迁移** | §7.4 |
| **preset_groups 重命名字段** | ⚠️ **必须迁移，且必须搬值** | §7.4 |
| **preset_groups 删除字段** | ❌ **绝不自动删** | §7.5 |
| **用户填写的字段值** | ❌ **绝不覆盖** | §7.5 |

### 7.4 Schema 迁移（最小可行方案）

新增函数 `personal_ontology_template_files.ts::migrateTemplateSchema(uid, templateId)`：

```
1. 读台账 GroupMeta；installed = meta.profile_schema_version ?? 0
2. registry = getRoleTemplate(templateId).profile_schema_version
3. installed >= registry → no-op 返回
4. 读模板文件 → parseTemplateContent
5. 分组补齐：registry 有、文件没有的 title → 追加空分节（保序：按 registry 顺序插入）
6. 字段补齐：registry 有、文件对应分节没有的 field.name → 追加空坑
7. 字段改名：按 renamed_fields 映射，把旧字段的 values 原样搬到新字段名下，删除旧字段名
8. 删除字段：不做。registry 已删但文件里还有且有值的字段 → 保留，标记 isCustom（listFieldsByRef :893 的现有逻辑天然会这么标）
9. 写回（writeTextAtomicSync，与 :278 同一原子写路径）
10. meta.profile_schema_version = registry；writeGroups
```

改名映射写在模板上（可选字段，只在需要时出现）：

```ts
export interface RoleTemplate {
  // ...
  /** Profile Schema 字段改名映射；迁移时按此搬运用户已填的值。 */
  renamed_fields?: ReadonlyArray<{ from: string; to: string; since: number }>;
}
```

**触发时机**：复用现有的启动期幂等迁移注册点 —— `personal_ontology_template_files.ts:1100` 的 `registerDeferred('personal-ontology-template-migrate', …)`，在 `migrateLegacyTemplateGroups` 之后追加对每个已装模板的 `migrateTemplateSchema` 调用。同一个 deferred，同样的 `'serial'` / `resourceClass: 'disk'` 语义，不新增 boot 任务。

### 7.5 数据安全红线

绝不能做的三件事：

1. **绝不覆盖用户填写的字段值。** 迁移只做「加空坑」和「按 `renamed_fields` 搬值」，任何情况下不写入非空值、不清空已有值。
2. **绝不删除用户数据。** registry 里删掉的字段，文件里保留（自动降级为 `isCustom` 字段，用户可自行删）。分节同理。
3. **绝不因迁移失败阻断读取。** 迁移抛错 → 记 warn，模板文件保持原样，`formatRoleProfileForSystemPrompt` 继续按旧结构工作（它读的是文件实际内容，不依赖 registry 结构）。

### 7.6 迁移的可逆性

迁移前不做整文件备份 —— 因为操作是纯增量（加空坑 / 搬值），且 `uninstallTemplateFile`（`:342`）的归档机制已存在。若未来出现破坏性迁移需求（本 spec 范围内没有），再引入备份。

---

## 8. Agent / Skill 资源统一规范

### 8.1 现状数据

| 指标 | 数值 | 依据 |
|---|---|---|
| bundle 覆盖的 distinct Skill | 46 | 9 模板 × 5 + product_manager 多 1 个 |
| bundle 覆盖的 distinct Agent | 27 | 9 × 3 |
| **跨模板复用率** | **0%** | 无任何 skill_id / agent_id 出现在两个模板的 bundle 里 |
| workflow 损坏的 Agent | 3 | `0fdb4da8a080` / `7c3138523589` / `8dcba242d360`，均属 product_manager |
| 停止规则逐字相同的 Agent 组 | student / scholar / software_engineer 共 9 个 | 见 §1.5.4 |
| Gate 为同构生成的 Skill | 8 个专业模板下全部 41 个 | 句式：`需要"{X}"，并具备完成"{A}"与"{B}"所需的授权材料、环境和范围` |
| 无「专属判断规则」的 Skill | ecommerce_ops 全部 5 个 | 手写自由格式，与其余 41 个不同源 |

### 8.2 Agent workflow 规范

新增或修改 `agent.json.workflow` 时，必须包含全部 6 段，缺一不可：

```
你是<角色名>Agent。<一句阶段职责>

输入：<这个阶段需要什么才能开始>
目标：<这个阶段的完成态是什么>

工作流程：
1. <动作>
2. <动作>
3. <动作>
4. <动作>
5. <动作>

输出：<交付物形态>

停止规则：<本阶段特有的停止条件>        ← 通用条件不写，已在模板 escalation_rules
失败行为：<本阶段特有的失败处理>        ← 通用行为不写，已在模板 anti_patterns
```

注：`输入` / `目标` / `输出` 三段是本 spec 新增要求；现有 27 个 Agent 只有「职责 + 工作流程 + 停止规则 + 失败行为 + 输出必须包含」五段。Phase 5 补齐。

### 8.3 自动校验（CI）

新增静态测试 `test/static/role-template-resources.test.ts`（放 `test/static/` 层，与 `task-runtime-scope-boundary.test.ts` 同级 —— 该层已用于跨资源结构断言）。

**Agent 侧断言 —— 出现以下任一，测试必须失败：**

| 检查 | 触发条件 |
|---|---|
| `None.None` | workflow 匹配 `/None\.\s*None/` |
| 空 workflow | `workflow.trim() === ''` 或缺字段 |
| 模板占位符残留 | 匹配 `/\{\{|\$\{|<TODO>|待填|TBD/i` |
| 缺必需段落 | 不含「工作流程：」/「停止规则：」/「失败行为：」/「输出」任一 |
| 工作流程步骤数不足 | 「工作流程：」后有效步骤行 < 3 |
| bundle 引用不存在 | `bundle.agent_ids` 里的 id 在 `resources/builtin/marketplace/agents/` 下无目录 |

**Skill 侧断言：**

| 检查 | 触发条件 |
|---|---|
| 缺 `use_when` | SKILL.md 无 `use_when`（`quality/rules/skill-shape.ts:81` 已有同款正则，复用） |
| 缺 `do_not_use_when` | 无 `do_not_use_when` 且无 `negative_examples`（同上，`:82`） |
| 空判断规则 | 出现「专属判断规则""」或规则内容为空 |
| bundle 引用不存在 | `bundle.skill_ids` 里的 id 在 `resources/builtin/marketplace/skills/` 下无目录 |

**Template 侧断言：**

| 检查 | 触发条件 |
|---|---|
| 缺 principles | 任一模板 `principles` 缺失，或 `core`/`decision_rules`/`anti_patterns` 任一为空数组 |
| 超预算 | 单模板 principles 全部条目字符数 > `PRINCIPLES_CHAR_BUDGET` |
| 原则重复 | 同一模板内 `core` 与 `anti_patterns` 出现语义重复的同文本条目（精确匹配即可） |
| i18n 缺失 | `ws.role_template.<id>.name` / `.description` 在 `zh.json` 或 `en.json` 缺失 |

注：`quality/rules/skill-shape.ts` 现有规则走的是 `skill_reverify` / `custom-skill-admission` 的运行时校验路径（`custom-skill-admission.ts:79`），**不覆盖内置 marketplace 资源**。本测试是补这块。

### 8.4 Skill 复用规范

现状 0% 复用是异常值，不是设计意图。规范：

- **真正可复用的能力，允许并鼓励跨角色复用**，即在多个模板的 `bundle.skill_ids` 里写同一个 id，而不是复制一份新资源目录。
- 判定标准：`use_when` 中不含角色专有名词，且 `do_not_use_when` 不排斥其他角色的典型任务。
- 复用后行为不会因角色不同而变（当前机制：技能渲染只有 name + 240 字压缩描述，无角色变量）。这是**可接受的**：角色差异由 principles 承担，不由技能承担。
- 但**本次不做存量合并**（第 12 章非目标）。规范只约束新增。

---

## 9. 当前已发现问题修复清单

### P0 — 阻塞统一改造，必须先修

**P0-1 产品经理 3 个 Agent workflow 损坏**

- **现状**：`resources/builtin/marketplace/agents/{0fdb4da8a080,7c3138523589,8dcba242d360}/agent.json` 的 `workflow` 字段，「工作流程：」之后是 6 行 `None. None`。全库 31 个 agent 只有这 3 个中招，正好是 product_manager 模板 bundle 的全部。
- **风险**：这段字符串原样进 `chat_agent_in_group.md:151` 的 `$workflow`。选了产品经理角色的用户，dispatch 出去的 3 个 Agent 全部没有工作流程。
- **建议修改位置**：三个 `agent.json`；同时补 §8.3 的 CI 断言防复发。
- **是否阻塞**：是。第 11 章的验收标准 10（commander 与 Agent 原则一致）无法在损坏数据上验证。

**P0-2 角色原则没有统一注入**

- **现状**：见第 1 章全部。
- **风险**：本 spec 要解决的核心问题。
- **建议修改位置**：`role_templates.ts`（schema）+ `spaces.ts`（formatter）+ `runner.ts`（注入点）。
- **是否阻塞**：是。这是改造本体。

### P1 — 不阻塞 Phase 1，但必须在本轮改造内完成

**P1-1 角色选择与画像安装断裂**

- **现状**：`spaces.create` 不调 `installTemplateFile`（断裂 C）。
- **风险**：角色画像默认为空；`formatRoleProfileForSystemPrompt` 常年返回 `''`。用户以为选了角色就有画像。
- **建议修改位置**：`spaces.ts::createSpace`（`:564`）成功写盘后 best-effort 安装（§6.2 D1）。
- **是否阻塞**：否。principles 不依赖画像文件，Phase 1 可先行。

**P1-2 template version 无迁移**

- **现状**：断裂 D。
- **风险**：模板一旦发布就冻结。本次给 9 个模板加 principles 不受影响（直读 registry），但**后续任何 preset_groups 变更都会静默失效**。
- **建议修改位置**：`personal_ontology_template_files.ts` 新增 `migrateTemplateSchema` + `registerDeferred`（`:1100`）追加调用。
- **是否阻塞**：否。但不做则第 11 章验收标准 6/7 无法达成。

### P2 — 独立小修，可并行

**P2-1 `scene_tbox.yaml` 漏电商运营**

- **现状**：`resources/builtin/system/skills/personal-ontology-candidate-builder/ontology/personal_ontology/scene_tbox.yaml` 的 `cognitive_governance.purpose` 与 `scope.included` 两处硬列模板名单，均为 8 个（学生/学者/FDE/产品经理/项目经理/技术写作/招聘专员/软件工程师），漏 ecommerce_ops。
- **风险**：候选提炼 Agent 在电商角色下缺少概念依据，字段「对号入座」命中率下降。
- **建议修改位置**：该 yaml 两处名单。更好的做法是改成不列举（写「已安装的角色模板」），避免下次再漏 —— `role_templates.ts:15` 的文件头注释已明确要求「修改字段清单需同步 candidate-builder」，这次正是没同步。
- **是否阻塞**：否。

**P2-2 `projectAllowedSkillIds` 定义存在但零赋值**

- **现状**：类型链路完整（`model/client.ts:172` → `core-agent/client.ts:954/1313` → `runner.ts:252` → `runner.ts:466` `_intersectRenderAllowlist` → `skill-registry.ts:982`），但全仓库无任何赋值点。
- **风险**：一条已建好的通道空转；读代码的人会误以为技能已被空间作用域约束。
- **建议修改位置**：Phase 4 在 `bus.ts` 用 `turnSpaceScope.skills` 赋值；或明确删除以消除误导。**二选一，不要继续留着**。
- **是否阻塞**：否。

**P2-3 `bundle.skill_ids` 当前纯展示 / P2-4 Skill scope 未真正消费**

- **现状**：同一件事的两面。`resolveSpaceScope` 返回 `{skills, agents}`，`skills` 只被 `ipc:1409 spaces.scope.resolve`（@ 选择器 UI）和 `welcome-message.ts:95`（欢迎语列名）消费，不进模型。
- **风险**：模板作者以为「配了 5 个技能 = 角色只用这 5 个」，实际 commander 看得到全部技能。角色的能力边界是假的。
- **建议修改位置**：Phase 4，与 P2-2 同一处改动。
- **是否阻塞**：否。且**必须放在最后** —— 它会真实收窄模型可见技能集，是唯一有行为回归风险的改动（见附录 B）。

---

## 10. 实施阶段

### Phase 1 — 统一 principles + commander/Agent 注入

**改：**
- `src/main/features/role_templates.ts`：新增 `RolePrinciples` 类型、`DEFAULT_ESCALATION_RULES`、`PRINCIPLES_CHAR_BUDGET`；为 9 个模板补 `principles`（内容来源：现有 description 的价值观句 + 各 Skill 的「专属判断规则」上提 + Agent 停止规则去重）
- `src/main/features/spaces.ts`：新增 `resolveActiveRole` + `formatRolePrinciplesForSystemPrompt`
- `src/main/model/core-agent/runner.ts`：`:1020` 之后、`:1044` 之前新增一次 `parts.push`
- `src/main/prompts/chat_commander.md`：`## Routing-first algorithm` 段加一句 dispatch 约束（§5.2）
- `test/main/features/role_principles_inject.test.ts`（新建）

**不改：**
- `agent.json` / `SKILL.md` 任何内容（去重留到 Phase 5）
- `chat_agent_in_group.md`（Agent 自动继承，无需模板变量）
- 渲染层（UI 不展示 principles）
- `description` 及其创建时复制逻辑（保持双轨，Phase 5 再评估）

**风险：** prompt token 增长（见附录 B-1）。

**测试：** 验收标准 1 / 2 / 3 / 5 / 10。

### Phase 2 — 角色选择 → profile 自动安装

**改：**
- `src/main/features/spaces.ts::createSpace`：成功写盘后 best-effort 安装主+副模板画像（动态 import，§6.2 D1）
- 超限提示文案：`zh.json` / `en.json` 新增一条
- `test/main/features/role_profile_inject.test.ts`：新增自动安装用例

**不改：**
- `MAX_INSTALLED_TEMPLATES` 的值
- `installTemplateFile` 的幂等语义与归档恢复逻辑
- 「认知」页的手动安装/卸载入口

**风险：** 建空间路径新增一次磁盘写；超限时静默。

**测试：** 验收标准 6 的前置。

### Phase 3 — template version / migration

**改：**
- `role_templates.ts`：9 个模板补 `profile_schema_version: 1`；类型加 `renamed_fields?`
- `personal_ontology_groups.ts`：`GroupMeta` 加 `profile_schema_version?`（读写台账两处，`:310` 附近解析 + `:329` 附近序列化）
- `personal_ontology_template_files.ts`：新增 `migrateTemplateSchema`；`:1100` 的 deferred 追加调用
- `test/main/features/template_schema_migrate.test.ts`（新建）

**不改：**
- `version` 字段语义（仍不参与运行时判断）
- `migrateLegacyTemplateGroups`（旧式组迁移，与本次正交）
- 已有画像文件里 registry 已删除的字段

**风险：** 迁移触碰用户数据（见附录 B-6）。

**测试：** 验收标准 6 / 7。

### Phase 4 — Skill context / scope 真正生效

**改：**
- `bus.ts`：把 `turnSpaceScope?.skills` 传成 runner 的 `projectAllowedSkillIds`（P2-2 / P2-3 / P2-4 一并解决）
- `cogseed_runtime/kernel/tools/skill-tools.ts` + `bin/run-skill.cjs`：新增 `COGSEED_ROLE_TEMPLATE_ID` 透传
- `test/main/features/space_skill_scope.test.ts`（新建）

**不改：**
- `skill-registry.ts` 的渲染逻辑（它只是收到一个已有参数）
- `SKILL.md` 内容
- 空配置/全失效 → `scope=null` → 全局可见 的 S1 降级语义（`spaces.ts:1078`）

**风险：** **本阶段是唯一有真实行为回归风险的改动**（见附录 B-5）。

**测试：** 验收标准 9。

### Phase 5 — 清理旧模板与职业换皮资源

**改：**
- 修 P0-1（3 个损坏 workflow）
- 27 个 `agent.json`：按 §5.3 去重（删除已上提到 principles 的通用停止规则/失败行为段）
- 补 §8.2 要求的 `输入` / `目标` / `输出` 三段
- P2-1（`scene_tbox.yaml`）
- 新增 `test/static/role-template-resources.test.ts`（§8.3 全部断言）
- 重写「职业换皮」模板的 principles：student / project_manager / technical_writer / recruiter / fde

**不改：**
- 不删除任何 Skill / Agent 资源目录
- 不做跨角色 Skill 合并
- 不改 `preset_groups`（改了就要走 Phase 3 的迁移，本阶段不叠加）

**风险：** 去重时误删角色特有的停止条件。缓解：逐条 diff，先补 principles 再删 workflow 段，两步分开提交。

**测试：** 验收标准 8 + 全量回归。

---

## 11. 测试与验收标准

### 11.1 验收标准

| # | 标准 | 验证方式 | 测试文件 | 层级 |
|---|---|---|---|---|
| 1 | 创建某角色 workspace 后，commander 每轮都能看到该角色 principles | 建 space（`primary_template_id: 'software_engineer'`）→ 调 `formatRolePrinciplesForSystemPrompt` → 断言含 `## 角色工作原则` 与该模板 `core[0]` 原文 | `test/main/features/role_principles_inject.test.ts` | main/features |
| 2 | dispatch 任意 Agent，Agent 同时看到 role principles + 自己 workflow | 断言 `gworker-*` sessionId 的 `memoryScopeForSession` 非 null，且同一 `spaceId` 下 formatter 输出与 commander **逐字相同** | 同上 | main/features |
| 3 | 切换到其他角色，principles 随 active role 改变 | `updateSpace({primary_template_id})` 后重调 formatter，断言旧模板 `core` 文本消失、新模板出现 | 同上 | main/features |
| 4 | 修改模板 description 不再影响运行时人格 | 断言 `formatRolePrinciplesForSystemPrompt` 的输出不包含 `template.description` 的任何片段 | 同上 | main/features |
| 5 | 模板 principles 升级，老 workspace 下一轮自动生效 | 建 space → 用 `vi.spyOn` 改 registry 返回的 principles → 不重建 space、不重装画像，重调 formatter → 断言新文本出现 | 同上 | main/features |
| 6 | Profile Schema 新增字段，老用户不丢已有值 | 装模板 → 填 2 个值 → 提升 `profile_schema_version` 并加一个字段 → 跑 `migrateTemplateSchema` → 断言旧值原样存在、新字段为空坑 | `test/main/features/template_schema_migrate.test.ts` | main/features |
| 7 | 用户自定义画像，版本升级不得覆盖 | 同上场景，额外写一个 T-box 外的自定义字段 + 一条流水 → 迁移后断言均保留，且自定义字段仍标 `isCustom` | 同上 | main/features |
| 8 | Agent workflow 出现 None / 空值，CI 必须失败 | 扫 `resources/builtin/marketplace/agents/*/agent.json`，对 §8.3 全部规则断言 | `test/static/role-template-resources.test.ts` | static |
| 9 | Skill 不在角色允许范围时的行为 | **当前期望（Phase 4 前）**：技能仍全局可见 —— 断言 `scope.skills` 非空但 `getSystemPromptBlock` 未收到 allowlist。**Phase 4 后期望**：断言渲染集 ⊆ `scope.skills ∪ agent.skill_list` | `test/main/features/space_skill_scope.test.ts` | main/features |
| 10 | commander 与 Agent 对同一角色原则不冲突 | 同一 `uid + spaceId`，分别以 commander gate 与 agent gate 调 formatter，断言两次输出 `toBe` 严格相等 | `test/main/features/role_principles_inject.test.ts` | main/features |

### 11.2 补充测试

| 测试 | 目的 | 文件 |
|---|---|---|
| principles 预算 | 9 个模板全部 ≤ `PRINCIPLES_CHAR_BUDGET` | `test/static/role-template-resources.test.ts` |
| 主/副叠加 | 副角色只贡献 `core` + `anti_patterns`，`decision_rules` 不出现 | `role_principles_inject.test.ts` |
| 无模板降级 | 空间无 `primary_template_id` → formatter 返回 `''`（与 `role_profile_inject.test.ts:61` 同款） | 同上 |
| 自动安装幂等 | 同一模板建两个 space，第二次返回 `already_installed`，文件不被覆盖 | `role_profile_inject.test.ts` |
| 自动安装超限 | 已装 3 个后建第 4 个角色的 space → `createSpace` 仍 `ok: true` | 同上 |
| i18n 覆盖 | 每个模板的 `.name` / `.description` 在 zh/en 均存在 | `test/static/role-template-resources.test.ts` |

### 11.3 门禁

`npm run typecheck` + `npm test`（`package.json:20`，含 `test:js` 与 `test:resources`）必须全绿。新增的 `test/static/role-template-resources.test.ts` 由 `test:js` 覆盖（`scripts/run-tests.mjs`）。

---

## 12. 非目标

本次**不做**以下事项。交接人不得扩大范围：

1. **不重写全部 9 个角色模板的 preset_groups。** 字段清单是产品拍板契约（`role_templates.ts:15` 明示）。本次只加 `principles`，不动字段。
2. **不重新设计 UI。** 渲染层不展示 principles，创建弹窗/空间详情页不改版式。
3. **不重构整个 cognition 系统。** `recall/` 下的资产、规则引擎（`rule-engine.ts`）、`personal-profile-sync.ts` 保持现状。
4. **不一次性把所有 soft rule 改成 hard gate。** principles 是提示词层约束，本次不引入任何拦截器/校验器来阻断违反原则的模型输出。
5. **不强制现在就实现跨角色 Skill 复用。** §8.4 的规范只约束新增资源，46 个存量技能不做合并。
6. **不覆盖 CLI agent 路径。** `_runCliAgentTurn`（`bus.ts:4647`）是外部进程，不经 `runner.ts` 的 system prompt 装配，本次不注入 principles。作为已知缺口记录。
7. **不改 `description` 到 `instructions` 的创建时复制。** Phase 1–4 保持双轨；是否退役该行为留待 Phase 5 后评估（见附录 B-2）。
8. **不改 `MAX_INSTALLED_TEMPLATES` 的值。**
9. **不新增 npm 依赖。**（`AGENTS.md` 硬约束：新依赖需事先讨论。）
10. **不新增角色模板。** 存量 9 个之外的新角色，等本次统一完成、规范落地后再加。

---

## 13. Definition of Done

只有以下 **7 条全部成立**，才能认为角色模板体系完成「统一」：

| # | 条件 | 可验证方式 |
|---|---|---|
| 1 | 角色有唯一、明确的 Runtime Principles 来源 | `principles` 是 `RoleTemplate` 的必填字段；除 `formatRolePrinciplesForSystemPrompt` 外无第二个函数把它转成 prompt 文本 |
| 2 | commander 和 Agent 每轮稳定获得原则 | 验收标准 1 / 2 / 10 通过 |
| 3 | Profile Schema 与 Runtime Principles 职责分离 | 类型层分离；`principles` 里 0 处用户/项目事实；`preset_groups` 里 0 个规则类字段名；`personal-profile-sync.ts` 不触碰 principles |
| 4 | 模板升级不会再完全与老 workspace 脱钩 | 验收标准 5（principles 实时）+ 6 / 7（schema 迁移）通过 |
| 5 | Agent workflow 有完整自动校验 | `test/static/role-template-resources.test.ts` 存在且 §8.3 全部规则生效；故意注入 `None. None` 能让 CI 红 |
| 6 | 当前已知损坏数据被修复 | P0-1 修复；P2-1 修复；P2-2 二选一处理完毕 |
| 7 | 新角色模板可按统一规范新增，而不再靠复制旧模板 | 存在一份「新增角色模板 checklist」（本 spec §8.2 + §8.3 + §3.2 即为该 checklist）；新增模板不通过校验则 CI 失败 |

---

## 附录 A：推荐文件改动清单

| 文件 | 当前职责 | 建议改动 | 必须改 | 阶段 |
|---|---|---|---|---|
| `src/main/features/role_templates.ts` | 模板常量注册表（964 行，纯常量 + 4 个查询函数） | 新增 `RolePrinciples` / `DEFAULT_ESCALATION_RULES` / `PRINCIPLES_CHAR_BUDGET` / `profile_schema_version` / `renamed_fields?`；9 个模板补 `principles` | ✅ | 1, 3 |
| `src/main/features/spaces.ts` | 空间 CRUD + 资源派生 + 3 个 prompt formatter | 新增 `resolveActiveRole` + `formatRolePrinciplesForSystemPrompt`；`createSpace` 后 best-effort 装画像 | ✅ | 1, 2 |
| `src/main/model/core-agent/runner.ts` | system prompt 装配（`:1005-1053` 是 parts 组装区） | `:1020` 之后新增一次 `parts.push(rolePrinciplesBlock)`，gate 同 `:1050` | ✅ | 1 |
| `src/main/prompts/chat_commander.md` | commander 提示词 | `## Routing-first algorithm`（`:61`）加一句 dispatch 与原则一致性约束 | ✅ | 1 |
| `src/main/features/personal_ontology_template_files.ts` | 画像文件安装/读写/迁移（1117 行） | 新增 `migrateTemplateSchema`；`:1100` deferred 追加调用 | ✅ | 3 |
| `src/main/features/personal_ontology_groups.ts` | 台账读写 + 组内容 | `GroupMeta` 加 `profile_schema_version?`；`:310` 解析 / `:329` 序列化两处 | ✅ | 3 |
| `resources/builtin/marketplace/agents/0fdb4da8a080/agent.json` | PRD一致性检查Agent | 修复 `None. None` workflow | ✅ | 5 |
| `resources/builtin/marketplace/agents/7c3138523589/agent.json` | 竞品研究Agent | 同上 | ✅ | 5 |
| `resources/builtin/marketplace/agents/8dcba242d360/agent.json` | 客户需求评估Agent | 同上 | ✅ | 5 |
| `test/static/role-template-resources.test.ts` | — | 新建（§8.3 全部断言） | ✅ | 5 |
| `test/main/features/role_principles_inject.test.ts` | — | 新建（验收 1/2/3/4/5/10） | ✅ | 1 |
| `test/main/features/template_schema_migrate.test.ts` | — | 新建（验收 6/7） | ✅ | 3 |
| `test/main/features/role_profile_inject.test.ts` | 画像注入测试（现有） | 新增自动安装 / 幂等 / 超限用例 | ✅ | 2 |
| `src/main/features/group_chat/bus.ts` | 会话调度 + prompt 构建（万行级） | Phase 4：`turnSpaceScope.skills` → `projectAllowedSkillIds` | ⚠️ Phase 4 | 4 |
| `src/main/features/cogseed_runtime/kernel/tools/skill-tools.ts` | 技能脚本执行 choke point | Phase 4：透传 `COGSEED_ROLE_TEMPLATE_ID` | ⚠️ Phase 4 | 4 |
| `bin/run-skill.cjs` | 技能脚本 spawn | Phase 4：读取该环境变量 | ⚠️ Phase 4 | 4 |
| `test/main/features/space_skill_scope.test.ts` | — | 新建（验收 9） | ⚠️ Phase 4 | 4 |
| `resources/builtin/system/skills/personal-ontology-candidate-builder/ontology/personal_ontology/scene_tbox.yaml` | 候选提炼本体 TBox | 两处模板名单改为不列举 | ⚠️ P2 | 5 |
| `resources/builtin/marketplace/agents/*/agent.json`（27 个） | Agent 定义 | 按 §5.3 去重 + §8.2 补段 | ⚠️ Phase 5 | 5 |
| `src/renderer/locales/{zh,en}.json` | i18n | 新增画像超限提示文案 | ⚠️ Phase 2 | 2 |
| `src/main/model/client.ts` / `core-agent/client.ts` | 模型调用参数链路 | 无需改（`projectAllowedSkillIds` 已贯通） | ❌ | — |
| `src/main/model/core-agent/skill-registry.ts` | 技能渲染 | 无需改（已支持 allowlist 参数） | ❌ | — |
| `src/main/features/recall/personal-profile-sync.ts` | 认知资产 → 画像投影 | **明确不改** | ❌ | — |
| `src/renderer/modules/workspace.js` | 空间 UI | Phase 1–4 不改 | ❌ | — |

---

## 附录 B：风险清单

**B-1 prompt token 增长**
- 风险：principles 每轮无条件注入，主+副最多 3 个模板叠加。
- 量化：`PRINCIPLES_CHAR_BUDGET = 900` × 主 1 + 副 2（副只取 `core` + `anti_patterns`，约占 50%）≈ 1800 字 ≈ 1200–1500 token。
- 缓解：注入位置紧邻 `projectInstructionsBlock`（`runner.ts:1020`），落在稳定缓存前缀内，跨轮命中 prompt cache，边际成本接近零；CI 强制预算上限。
- 残余：首轮成本真实存在。可接受。

**B-2 principles 与 instructions 冲突**
- 风险：老 workspace 的 `instructions` 里躺着一份 description 副本，与新的 principles 块内容重叠甚至表述冲突（用户可能已改过那份副本）。
- 缓解：两块的块头声明不同 —— instructions 是「user-authored…follow them unless the user overrides them」（`spaces.ts:909`），principles 是「角色模板定义，非对话内容」。优先级需在 principles 块头显式声明：**用户在 Space instructions 或对话中的明确要求，优先于角色原则**。
- 残余：重复内容浪费 token。Phase 5 后可评估退役创建时复制（`workspace.js:1907`），但那会改变用户可编辑性，需产品确认。

**B-3 老 workspace 兼容**
- 风险：存量 space.json 只有 `template_id`（旧字段）没有 `primary_template_id`。
- 缓解：`spaces.ts:294` 的 `_normaliseSpace` 已做归一化（`primary_template_id || template_id`），`formatRoleProfileForSystemPrompt:1096` 也已按同样方式取值。新 formatter 必须复用同一归一化路径，**不得**自己读 `raw.primary_template_id`。
- 残余：低。

**B-4 多角色画像冲突**
- 风险：主+副角色的画像字段同名（如「常用工具」在多个模板里都有），注入后模型分不清哪条属于哪个角色。
- 缓解：现状已按 `### 角色「{name}」` 分节（`spaces.ts:1126`），原则块沿用同结构。
- 残余：同名字段在不同角色下语义不同时仍可能误读。本次不解决（字段清单不动，见第 12 章）。

**B-5 Skill scope 行为改变（Phase 4）**
- 风险：**这是全 spec 唯一有真实行为回归风险的改动。** 一旦 `scope.skills` 生效，commander 从「看得到全部技能」变为「只看得到 bundle 5 个 + extra」。用户过去能用的技能会突然消失。
- 缓解：
  - `resolveSpaceScope` 的 S1 语义已内置降级（空配置/全失效 → `null` → 全局可见，`spaces.ts:1078`），必须严格保留
  - `runner.ts:466` `_intersectRenderAllowlist` 是交集语义，Agent 自己的 `skill_list` 仍生效
  - `skill_search` 工具（`bus.ts:3988` `buildSkillSearchTool`）不受 allowlist 约束，模型仍可主动搜到范围外技能 —— 这是重要的逃生舱
  - 建议：Phase 4 先加 feature flag / 环境变量灰度，观察一个版本
- 残余：中。**这是把 Phase 4 排在最后的唯一原因。**

**B-6 version migration 数据安全**
- 风险：迁移直接改写用户的 `.personal_ontology_groups/<tid>.md`。
- 缓解：
  - 迁移只做加空坑 + 按 `renamed_fields` 搬值，**绝不写非空值、绝不清空、绝不删字段**（§7.5）
  - 复用 `writeTextAtomicSync`（与 `:278` 同一原子写路径）
  - 迁移抛错 → warn 并保持文件原样，读侧不受影响
  - `uninstallTemplateFile`（`:342`）的归档机制已存在，是最后的兜底
- 残余：低，但验收标准 6/7 必须逐条跑通才允许合入。

**B-7 principles 内容质量**
- 风险：为 9 个模板补 principles 时，如果只是把 description 拆成 bullet，会得到一堆不可判定的空话，改造收益归零。
- 缓解：内容来源必须是**已存在的、具体的**约束 —— 各 Skill 的「专属判断规则」（41 条，均已具体可判定，如「症状消失不等于根因已证实」）+ Agent 的角色特有停止规则。§3.2 的写法约束（必须可判定、必须指向可观察行为）由 review 把关。
- 残余：中。这是本次改造成败的实际决定因素，比任何代码改动都重要。

---

## 附录 C：交接人实施顺序

按此顺序执行，无需重新理解整个问题：

1. **读三个文件建立地基**：`src/main/features/role_templates.ts`（全文，964 行）、`src/main/features/spaces.ts:1091-1136`（现有画像 formatter，新 formatter 的模仿对象）、`src/main/model/core-agent/runner.ts:1005-1053`（parts 组装区，新注入点所在）。
2. **跑通现有测试建立信心**：`npx vitest run test/main/features/role_profile_inject.test.ts test/main/features/role_templates.test.ts`。特别注意 `role_profile_inject.test.ts:73` 那条 case —— 它固化了断裂 C。
3. **写 `RolePrinciples` 类型 + 一个模板的 principles**。只做 `software_engineer`（它的 5 条判断规则质量最高，最容易改写成 principles）。其余 8 个先留空数组，让 typecheck 通过。
4. **写 `formatRolePrinciplesForSystemPrompt`**，照抄 `spaces.ts:1091` 的结构（try/catch 静默降级、主+副遍历、`_readSpace` 归一化）。
5. **写 `test/main/features/role_principles_inject.test.ts`**，照抄 `role_profile_inject.test.ts` 的 fixture 骨架（`COGSEED_WORKSPACE_ROOT` 临时目录 + `activateUser`）。先让验收标准 1 / 3 / 10 通过。
6. **接 `runner.ts` 注入点**，一行 `parts.push`。用验收标准 2 验证 Agent 侧也拿到（断言 commander 与 agent 两次调用 `toBe` 相等）。
7. **补齐其余 8 个模板的 principles**。内容来源见附录 B-7。这一步是体力活但决定成败，不要图快。
8. **加 CI 校验**（`test/static/role-template-resources.test.ts`），先只开 template 侧断言（principles 非空 + 预算 + i18n）。
9. → **Phase 1 完成，可合入。**
10. **Phase 2**：`createSpace` 加 best-effort 安装。改动 < 20 行，但要补 3 个测试用例（自动装 / 幂等 / 超限）。
11. **Phase 3**：`profile_schema_version` + `migrateTemplateSchema`。先写测试（验收 6/7）再写实现 —— 这是唯一会改写用户数据的改动。
12. **Phase 5 的 P0 部分**：修 3 个损坏 workflow，同时打开 CI 的 Agent 侧断言。
13. **Phase 5 的清理部分**：27 个 agent.json 去重。分两次提交：先补 principles 确认覆盖，再删 workflow 冗余段。
14. **Phase 4 放最后**：Skill scope。带 flag 灰度，观察一个版本再默认开启。理由见附录 B-5。

---

*本 spec 的全部现状描述均可通过文中给出的 `文件:行` 在基线 commit `c1f2234b` 上复核。若复核不一致，以代码为准并更新本文档。*
