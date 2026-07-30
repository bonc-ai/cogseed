# Output Contract

本技能的输出是**待确认的候选**，不是已生效的记忆。用户必须在 App 的候选审阅面板里逐条确认或驳回，确认后才会被写入 USER.md（个人画像）或 MEMORY.md（共享记忆）。

## 输出位置

```
候选池：$ORKAS_WORKSPACE_ROOT/$ORKAS_UID/local/ontology_candidates/candidates.md
阻断项：$ORKAS_WORKSPACE_ROOT/$ORKAS_UID/local/ontology_candidates/blocked_items.md
```

两个环境变量在执行环境里已经存在，直接用；不要写死某个具体路径。目录不存在时先创建。

**追加，不要覆盖**：写之前先读一遍 candidates.md，把新识别的候选追加进去，保留用户还没处理的旧候选，同时避免生成重复的 candidate_id（建议用 `cand-` + 短随机串，或 `cand-` + 语义简写 + 序号）。

## candidates.md 格式

一个候选一个三级标题块：

```markdown
### cand-comm-style-01
- 类型: preference
- 置信度: high
- 摘要: 喜欢先讲原理再举例子，最后才给代码，不要堆术语
- 记忆去向: user
- 记忆文本: 沟通风格：先讲原理，再用例子带入，最后才给代码，不堆术语
- 来源: conv-93a8b4198ec4-turn-12
```

字段说明：

| 字段 | 说明 |
|---|---|
| 标题（`### cand-xxx`） | candidate_id，全局唯一 |
| 类型 | `preference` \| `instance` \| `property` \| `relation` \| `rule` |
| 置信度 | `low` \| `medium` \| `high` —— 只表示证据强弱，**不代表可以跳过确认** |
| 摘要 | 一句人话，直接显示在审阅卡片上，用户一看就懂 |
| 记忆去向 | `user`（→ USER.md，个人画像/偏好）或 `shared`（→ MEMORY.md，更泛化的共享事实） |
| 记忆文本 | 确认后**真正写入** USER.md/MEMORY.md 的文本；要精炼，不要把大段配置 JSON 或长段原文整段塞进去 |
| 路径（可选） | 定位提示，比如 `Personal/Preferences/CommunicationStyle`，非必需 |
| 差异（可选） | 如果这条候选是对已有记忆的更新，说明改动了什么 |
| 来源 | 逗号分隔的来源引用（对话 id / turn id），方便用户回溯 |

## 候选类型判断指南

- **preference（偏好）**：最常见、应优先识别的一类。信号词："我更喜欢……""我习惯……""不要……""每次都……""从来不……"；或者观察到重复出现的行为模式（即使用户没有明说"我喜欢"）。只提过一次的内容用 `confidence: low/medium`，反复出现多次的用 `confidence: high`。
- **instance（实例）**：值得记住的人、项目、工具、地点等实体。
- **property（属性）**：某个实体的具体特征、设置。避免把整段原始配置照抄进 `记忆文本`，提炼成一句话。
- **relation（关系）**：实体之间的关联，比如"常用某工具做某件事"。
- **rule（规则）**：摸索出的经验法则、踩坑教训，通常是条件 → 动作结构。

## memory_scope 判断指南

- `user`：跟用户本人强相关、长期稳定——沟通风格、工具偏好、身份信息、个人习惯。USER.md 容量小（约 1500 字/16 条），必须精炼，不要塞长文本。
- `shared`：更泛化、可能跨场景复用的事实/规则/项目信息。MEMORY.md 容量稍大（约 2500 字/16 条）。

## blocked_items.md 格式

```markdown
### mem-with-api-key
- 原因: 内容包含未脱敏的 API Key
- 修复建议: 移除或替换 API Key 后再重新提炼
```

标题是来源引用（source_ref），字段是"原因"和"修复建议"。

## 安全边界

- 内容包含密钥、密码、令牌，或未授权的他人隐私信息 → 直接进 `blocked_items`，不生成候选、不要脱敏后硬造一条候选。
- 无法确认是否已脱敏时，按"未脱敏"处理，进 `blocked_items`。
- 涉及他人的内容（不是用户本人）如果只是背景信息，可以作为 `relation`/`instance` 记录（比如"用户和某人是同事关系"），但不要把第三方的私密偏好当成候选写进用户自己的 USER.md。

## Non-Claims

- 候选池里的内容不是已生效的记忆，用户确认前对 AI 的行为没有任何影响。
- 本技能不会绕过用户确认直接写入 USER.md/MEMORY.md——这两个文件只由 App 后端在用户点击确认后写入。
- 本技能不做企业级角色路由（不区分部门/岗位/客户/组织本体），只服务用户个人。
