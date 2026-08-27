---
name: personal-ontology-candidate-builder
description: Use when the assistant needs to extract structured Personal Ontology candidates — preferences, habits, facts, relationships, rules — from a user's conversation history, memory episodes, or manual "remember this" notes, while enforcing local_only storage and requiring explicit user confirmation before anything is written to durable memory.
---

# 个人本体候选构建器

本技能从你和 AI 的对话历史里，识别出值得长期记住的内容——**偏好、习惯、事实、关系、经验规则**——整理成结构化候选，等你确认后才真正写入长期记忆。

它不会偷偷把东西塞进记忆里。每一条提炼出来的内容都先进"候选池"，你在候选审阅面板里逐条看、逐条点确认或驳回。只有你点了确认，这条内容才会真正写进设置里的"记忆"（个人画像 USER.md 或共享记忆 MEMORY.md），从这之后 AI 才会在每次对话里"记得"它。

如果输入材料、原稿、草图、批注或待优化文档里已经有你自己的修改痕迹，默认优先保护，不擅自覆盖、重写或顺手清理任务范围外内容；只有你明确要求，才可以改动这些痕迹。

## 它能识别什么

- **偏好**（最常见的一类）：喜欢/不喜欢什么，习惯用什么方式做事，沟通风格，工具偏好，生活习惯。信号词比如"我更喜欢……""我习惯……""不要……""每次都……""从来不……"，或者观察到你反复做同一类选择（即使你没有明说"我喜欢"）。
- **实例**：值得记住的人、项目、工具、地点等实体。
- **属性**：某个实体的具体特征或设置。
- **关系**：实体之间的关联，比如"你常用某个工具做某件事"。
- **规则**：你摸索出来的经验法则，比如"遇到 X 情况时，我会怎么做"。

## 什么时候用

use_when:

- 你想让 AI 把某段对话、某条笔记、某次"记住这个"的交代，提炼成可以长期记住的候选。
- 你想清理/审阅一下最近的对话，看看有没有值得沉淀成长期记忆的偏好或规则。
- 你想知道某条信息该不该被 AI 长期记住，还是只是这次任务里的临时事实。

do_not_use_when:

- 你希望不经确认就直接把内容写进记忆——这个技能设计上做不到，任何输出都必须先进候选池等你确认。
- 内容涉及他人隐私、未授权的敏感信息（比如密码、密钥、他人的身份信息）——这类内容会被直接拦在候选之外，进入阻断项。

negative_examples:

- "候选不用确认，直接生效。"
- "把这段包含 API Key 的内容也存进我的偏好里。"

## 工作流

1. 判断触发类型：这是一次主动的"帮我整理记忆"请求，还是对话里自然出现的"记住这个"信号。
2. 扫描最近的对话/记忆材料，识别偏好、实例、属性、关系、规则五类候选。识别偏好时优先看重复出现的模式（同类偏好被提及多次，说明是稳定习惯，不是一次性吐槽）。
3. **读全本体（强制门禁，不可跳过）**：提炼前必须先完整读取本技能本体 `ontology/personal_ontology/` 下**全部五份 yaml**——`scene_package.yaml`（包元数据/启用项）、`scene_tbox.yaml`（候选类型/来源/去向概念定义）、`scene_rbox.yaml`（确认制/边界/提炼规则）、`scene_abox.yaml`（fewshot 示例）、`scene_mapping.yaml`（候选/确认/分组字段映射）。候选的分类、置信度、去向、字段映射全部以 yaml 为准，**不得跳步、不得凭印象拍脑袋**；本体规则与本文件硬边界一致，冲突时以本文件为准。
4. 调用 `personal_ontology_fields` 工具拿到已安装角色模板的可填字段清单，作为 `建议字段` 的候选池。判断这条候选的值语义与哪个字段匹配（如"沟通风格""学习目标"），匹配明确就把工具给出的**字段名**原样填进 `建议字段`，拿不准就不填。**不要**自己去读个人本体的目录或文件来推断字段——字段清单只有这个工具说了算；工具返回空清单就是「用户没装角色模板」，此时一律不填建议字段。
5. 对每条候选，先检查是否涉及未脱敏的敏感信息（密钥、密码、他人隐私）——有问题的直接进 `blocked_items`，不要悄悄丢弃、也不要生成候选。
6. 判断候选该进哪本记忆：跟"这个人本身"强相关的（沟通风格、工具偏好、身份信息）归 `memory_scope: user`；更泛化的事实/规则/项目信息归 `memory_scope: shared`。
7. 给每条候选写一句**人话摘要**（`summary`），要具体、口语化，让用户一看就懂是什么内容；同时准备好确认后要写进记忆的**精炼文本**（`memory_text`，通常和 summary 一致或更简练）。
8. **查重门禁（强制，不可跳过）**：写候选池之前，先 read 当前候选池 `candidates.md`，并逐条对照已生效记忆 `$COGSEED_WORKSPACE_ROOT/$COGSEED_UID/cloud/memory/USER.md`（user 去向）和 `$COGSEED_WORKSPACE_ROOT/$COGSEED_UID/cloud/memory/MEMORY.md`（shared 去向）：
   - 与已生效记忆**完全重复**的事实 → **不进候选池**（已生效事实不得再次进池；候选 ID 池内也禁止重复）；
   - 与已生效记忆同源但类型/表述不同（如"事实"vs"推断偏好"）→ 可进池，但必须在第 10 步汇报里向用户说明与已有记忆的重叠关系；
   - 拿不准是否重复时，先查再写，不要默认当成新候选。
9. **追加候选池（强制）**：把候选追加进候选池文件（见下方"输出位置"），**不要覆盖已有的待确认候选**，只追加新的。

   **禁止改写个人本体的任何文件**：不要 cat / Edit / Write `.personal_ontology_groups/` 下的 `groups.md` 或 `<template_id>.md`，也不要往字段值上打 `[候选池: ...]` / `[已生效]` 之类的标记。角色模板文件的写入只能由用户在确认面板里触发，走 App 的正式写入通道（带文件锁、原子写、台账更新与索引通知）；技能绕过它写，会与并发写入互相覆盖，写出的标记也不在合法来源枚举里。候选进没进池以候选池文件为准，已生效与否以记忆文件为准，不需要第三处标记。
10. **落盘核验（强制）**：追加完成后用 cat 核对实际落盘内容（候选条数、候选 ID、字段是否齐全、标记是否同步），再向用户汇报；**禁止凭记忆或上次的汇报复述候选数量**。最后用一两句话跟用户说明本次提炼了几条候选、大致是什么内容，请用户去候选审阅面板确认或驳回；不要在对话里罗列全部候选细节。

## 输出位置（必须严格遵守）

候选池和阻断项存在用户数据目录下，**不是**普通的工作区文件，也不是写死的某个人的 Documents 路径。执行 bash 时用环境变量拼出真实路径：

```
候选池：   $COGSEED_WORKSPACE_ROOT/$COGSEED_UID/local/ontology_candidates/candidates.md
阻断项：   $COGSEED_WORKSPACE_ROOT/$COGSEED_UID/local/ontology_candidates/blocked_items.md
```

`COGSEED_WORKSPACE_ROOT` 和 `COGSEED_UID` 已经在执行环境的环境变量里，直接用，不要猜测或写死路径。目录不存在时自动创建。

两个文件都是**人读 markdown**，不是 JSON。格式和字段定义见 `references/output-contract.md`，写之前务必核对格式；格式不对，App 里的候选审阅面板读不出来。

追加候选时用 `read` 先看当前候选池内容，避免生成重复的候选 id，也避免覆盖掉用户还没处理的旧候选。

## 硬边界

- 任何候选都不能跳过用户确认直接生效——这是本技能存在的核心前提，不是可选项。
- 候选内容强制本地存储（`local_only`），不离开用户本机，不进入任何团队/组织共享的存储。
- 候选去向由用户在 App 确认面板决定：全局记忆（`memory_scope: user` → USER.md 或 `memory_scope: shared` → MEMORY.md）、分组字段区（对号入座填坑）、分组流水区（不填坑）。本技能只提供建议（`建议字段` 预选、`memory_scope` 建议），**不指定具体分组、不决定最终去向**——用户在审阅面板里逐条确认时选择。
- **本技能只写候选池与阻断项两个文件。** 个人本体的角色模板文件与分组台账（`.personal_ontology_groups/` 下的 `groups.md`、`<template_id>.md`）一律**只能通过 `personal_ontology_fields` 工具读取，不得直接读写**——它们的写入由 App 的正式通道负责（文件锁 + 原子写 + 台账更新 + 索引通知），技能绕过去写会与并发写入互相覆盖。不存在"组织本体""业务本体"这类第三方层级——这个技能只服务用户个人，不做企业级**组织**路由；支持个人角色模板（内置角色模板：学生/学者/FDE/产品经理/项目经理/技术写作/招聘专员/软件工程师）的字段建议。
- 客户/他人隐私标识、密钥、密码等敏感信息必须先脱敏；无法确认已脱敏时，直接进 `blocked_items`，不生成候选。
- `confidence=high` 只代表证据充分、值得优先请用户看一眼，不代表可以跳过确认。
- 每条候选必须带 `source_memory_refs`（来源引用），方便用户在审阅时回溯这条候选是从哪段对话/记忆来的。
- 追加候选前必须对照已生效记忆（USER.md/MEMORY.md）逐条查重：**已生效事实不得再次进池**；运行结束前必须 cat 核验实际落盘内容再汇报。历史教训：曾虚报"已写入候选池"、写错文件名、已生效事实重复进池，三类偏差都源于跳步。

## 参考

- `schemas.json`
- `references/skill-spec.yaml` — 技能规范（ProductionProcessSkill 元数据/成熟度/契约）
- `references/ontology-mapping.md` — 三层本体入口（TBox/RBox/ABox 链接）
- `references/validation-contract.md` — 静态/触发/执行检查清单
- `references/kstar-evolution.md` — KSTAR 进化记录（A_hat/R_hat/DeltaA/DeltaR）
- `ontology/personal_ontology/` — 本技能的个人本体候选构建本体（scene 规范 YAML，v1.0.0）：
  - `scene_package.yaml` — 包清单与元数据
  - `scene_tbox.yaml` — 概念层（候选五类/角色模板/来源/去向/脱敏）
  - `scene_rbox.yaml` — 规则层（确认制/local_only/敏感拦截/追加不覆盖/双区路由）
  - `scene_abox.yaml` — 实例层（内置角色场景 fewshot 示例）
  - `scene_mapping.yaml` — 映射层（候选/确认/分组/模板到物理数据源）
  - 本体规则与本文件硬边界一致；运行时输出契约以本文件 + `references/output-contract.md` 为准
- `references/output-contract.md`
- `references/input-contract.md`
- `references/examples.md`
- `references/failure-modes.md`
- `references/governance-boundaries.md`
- `evals/` — 评测套件（eval-cases.yaml / evals.json）
- `agents/openai.yaml` — 平台技能接口声明
