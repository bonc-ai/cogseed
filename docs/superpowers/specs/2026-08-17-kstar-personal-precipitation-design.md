# 方案：KStar 线新增「关于我」（personal）沉淀能力

- 日期：2026-08-17
- 状态：设计稿（待评审）
- 关联：spec(3) 四视图「我的资产」→「关于我」；本方案补上 KStar 自进化线的 personal 通道

---

## 1. 背景与缺口（实机证据）

### 1.1 用户诉求

周报场景中用户明确表达"关于我"的信息：

```
"我以后的周报都要按这个格式：1.本周完成 2.数据指标（表格）3.风险与阻塞 4.下周计划"
"我是团队负责人"
"风险部分要：先说影响等级（高/中/低），再给应对措施。表格加一列「负责人」"
```

这些是 **long-term preference / identity**（spec 定义的 personal：关于用户身份的持久事实），应沉淀为「关于我」资产。

### 1.2 现状：KStar 线 personal 通道是断的

**代码证据**（`extraction-service.ts:42`）：

```ts
export function gapType(review) {
  if (review.attribution === 'knowledge_gap') return 'personal';  // ← 唯一入口
  if (review.attribution === 'rule_gap') return 'rule';
  if (review.attribution === 'template_gap') return 'template';
  if (review.attribution === 'skill_gap') return 'skill_method';
  return null;  // ← unclear 走这里
}
// 163 行：lesson 存在时 suggestedType = gapType(review) ?? 'rule'
```

- 成功任务（met_expected）的 attribution 几乎总是 `unclear` → `gapType` 返回 null → `?? 'rule'`
- "我是团队负责人/我以后周报都要这格式" 不是执行缺口 → attribution 不可能是 knowledge_gap
- **结论：KStar 线（lesson → 候选）永远产不出 personal**

**实机证据**：
- 资产池 personal 类型 = **0**（新旧两个数据根都验证过）
- capture 线（会话抽取）有 personal 判定，但 7 条 capture 产出 personal = 0——模型把"我的周报格式"判成 template/rule

### 1.3 capture 线的个人判定不可靠（模型自觉）

- prompt 定义了 personal（"What is durably true about this user"），但**没有硬区分规则**
- "我的周报格式" 同时命中 TEMPLATE_PATTERN（格式/结构）和 personal 语义 → 模型偏向 template
- STABLE_PREFERENCE_PATTERN 太窄（"我以后"匹配不到）

---

## 2. 设计目标

在 **KStar 复盘线**（review → lesson → 候选）增加 personal 通道：

```
任务执行 → review 推理（lesson + 是否关于用户）→ KStar 聚合
  → suggestedType = personal（而非 rule）
  → 沉淀为「关于我」资产
  → 后续任务注入时按用户画像召回
```

**核心原则**：personal 判定必须是**双闸**——模型提名 + 确定性校验，不能只靠模型自觉（否则"今天想写诗"这种一次性请求也会被沉淀成 personal）。

---

## 3. 设计

### 3.1 模型层：review 推理新增 `lessonPersonal` 字段

**`review-inference.ts`**：

1. **ParsedModelReview 加字段**：
```ts
/** lesson 是关于用户的持久偏好/身份（personal），而非任务通用经验 */
lessonPersonal?: boolean;
```

2. **allowed set 加 `'lessonPersonal'`**（line 161）：
```ts
const allowed = new Set([..., 'lesson', 'lessonPersonal']);
```

3. **提示词加 hard 区分规则**（inferenceSystemPrompt）：
```
'HARD RULE — personal: decide whether the lesson is about the USER (durable
identity, role, long-term preference, stable habit) or about the TASK (a
generic reusable method/pattern). "My weekly reports must follow this format"
is personal; "city profiles should include 概况/历史/现状" is a task rule.
When personal, set "lessonPersonal": true and write the lesson from the
user\'s perspective ("我以后的周报都…").',
```

4. **解析**：`...(record.lessonPersonal === true ? { lessonPersonal: true } : {})`

### 3.2 类型判定层：lessonPersonal → personal

**`extraction-service.ts`（episode 级）**：

```ts
// 163 行附近
suggestedType: lessonPersonal(review)
  ? 'personal'
  : (gapType(review) ?? 'rule'),
```

**`task-level-precipitation.ts`（requirement 级）**：同样处理 strongest / gapReview 的 lesson 分支。

**scope 处理**：personal 候选的 `suggestedScope` 用 `'personal'`（与 capture 线 personal 资产一致），`ruleBoundary` 不适用（personal 不需要 applicableWhen）。

### 3.3 确定性校验层（双闸的第二闸）

**`extraction-service.ts` 加 `lessonPersonal()` 校验**——即使模型标了 personal，也要确认用户消息里有长期偏好证据：

```ts
const LONG_TERM_EVIDENCE = /(?:我以后|以后(?:都|要|就|会)|我的[^，。]{0,12}(?:都要|习惯|偏好)|我(?:的)?(?:风格|习惯|偏好|身份|角色)|长期|一直|向来|通常|总是|每次都|我希望|我喜欢|我是)/;
```

**判定规则**（三级）：
| 模型 lessonPersonal | 用户消息长期证据 | 结果 |
|---|---|---|
| true | 命中 | **personal**（沉淀「关于我」）|
| true | 未命中 | **降级为 rule**（模型误判，无证据）|
| false | — | 保持原类型（rule/template/...）|

证据来源：episode 的 evidenceRefs / 对话消息（review 推理时已带 `messages`，可复用）。

### 3.4 晋升层：personal 的准入门槛（复用 capture 已有规则）

**`capture-value-screening.ts` 的 personal 校验**（promotion 时会跑）：
- `personal_is_project_fact`：项目事实 + 无长期标记 → 阻断（已存在）
- `personal_not_stable`：无长期标记 → advisory（已存在）

KStar personal 候选带着 `LONG_TERM_EVIDENCE` 命中（"我以后周报都要…"），能通过这两道闸。

**注意**：KStar 线晋升走 `promoteRecallCandidate`（不经过 capture 的 screening）。需要确认 personal 校验在哪触发——查 promotion 链路的 `assessRecallCandidateClassification` 是否覆盖 personal（见 3.5）。

### 3.5 分类校验对齐

`assessRecallCandidateClassification`（capture-value-screening.ts:400）已处理 personal：
- 模型标 personal + 无长期标记 + 是项目事实 → block
- 模型标 personal + 无长期标记 → advisory（可晋升，留给用户确认）

**KStar 线需要复用这套校验**：在 `promoteRecallCandidate` 的 `validatePromotionByAssetType` 已调用 `assessRecallCandidateClassification`（之前确认过）——所以 KStar personal 候选自动过这套闸。**无需新代码**，只要 3.2 的类型判定正确。

### 3.6 注入侧：personal 资产如何被召回

**现状**：投影的 scope 匹配 `scopeIncludes(asset.scope, purpose)`——purpose='review' 时 personal scope 不匹配（general 通配已加，personal 没有）。

**方案**：personal 资产应**按用户画像语义召回**——与任务 purpose 无关（"关于我"的信息对任何任务都可能有用）。两个选择：

- **A（最小）**：`scopeIncludes` 对 `'personal'` scope 返回 true（类似 general 通配）——personal 资产对所有任务可召回。风险：注入噪音（用户的偏好可能与本任务无关）。
- **B（语义匹配）**：personal 资产照常走语义排序（0.40 阈值），但 scope 校验放行。即投影时 personal 资产不因 scope 被排除，但匹配分不够就不注入。

**推荐 B**：personal 资产参与语义排序，靠 0.40 阈值自然过滤无关偏好——"周报格式偏好"对"写周报"任务匹配分高，对"写代码"任务分低。

---

## 4. 数据流（完整链路）

```
周报任务（用户："我以后的周报都要按这个格式…"）
  → review 推理：lesson="我以后的周报都按四段模板+表格+负责人列组织"
    lessonPersonal=true（模型）
  → 确定性校验：LONG_TERM_EVIDENCE 命中（"我以后…都要"）✅
  → KStar 聚合：suggestedType='personal'，scope='personal'
  → 候选池（pending_review）
  → 用户确认（「待我处理」→「确认并限域」）或系统自动
  → 晋升：personal 校验过闸（长期标记命中）→ 「关于我」资产
  → 注入：后续"写周报"任务，personal 资产参与语义排序（方案 B）→ 召回
  → 复用/证明/升档（同现有链路）
```

---

## 5. 边界与防误判

| 场景 | 处理 |
|---|---|
| "今天帮我写诗"（一次性请求） | 无长期标记 + 是任务事实 → `personal_is_project_fact` 阻断 |
| "我以后周报都要这格式"（真偏好） | 长期标记命中 → personal ✅ |
| 模型标 personal 但无证据 | 降级 rule（3.3 二级）|
| "我的代码都用 tab 缩进"（技术偏好） | 长期标记命中 → personal（关于用户的编码习惯）|
| "我是团队负责人"（身份） | 长期/身份标记 → personal |

**语言硬闸兼容**：personal lesson 同样过 `lessonLanguageMismatches`（中文任务产中文 personal）。

---

## 6. 实施步骤

| 步骤 | 文件 | 改动 |
|---|---|---|
| 1 | `review-inference.ts` | allowed set + `lessonPersonal` 解析 + 提示词 hard 规则 |
| 2 | `extraction-service.ts` | `lessonPersonal()` 校验函数 + `proposeKstarCandidates` 类型判定 |
| 3 | `task-level-precipitation.ts` | `aggregateRequirementProposals` 类型判定 |
| 4 | `scope-policy.ts` | personal scope 召回（方案 B：放行 scope，靠语义阈值）|
| 5 | 测试 | review-inference personal 字段、聚合 personal 类型、防误判（一次性请求→rule）、注入召回 |

## 7. 测试计划

1. **单元**：`lessonPersonal` 解析（合法/未知字段拒绝）、`lessonPersonal()` 校验三级判定
2. **聚合**：周报偏好 → personal 候选；"今天写诗" → 不产 personal
3. **端到端**（复用「越用越聪明」场景）：第 2 轮"我以后周报都要这格式" → 候选类型 personal → 确认 → 资产 type=personal → 第 5 轮注入召回
4. **回归**：非 personal lesson 仍按 rule/template 沉淀（不破坏现有行为）

## 8. 风险

- **注入噪音**：personal 资产召回过宽 → 方案 B 的 0.40 阈值兜底；必要时加 personal 单独阈值（0.45）
- **模型误标**：双闸（模型+确定性）已兜底；误标降级 rule 不丢内容
- **与 capture 线 personal 冲突**：同一偏好两条线各产 personal → 语义查重（0.85）合并，无需额外处理

## 9. 验收

- [ ] 周报场景"我以后周报都要这格式"沉淀为 **personal** 候选（非 template/rule）
- [ ] 用户确认后资产 type=personal，出现在「我的资产 → 关于我」
- [ ] "今天写诗"不产 personal（防误判）
- [ ] 后续周报任务注入该 personal 资产
- [ ] 现有 rule/template 沉淀行为无回归

---

## 更新（2026-08-17 19:02）：方案收敛决策

**方案 B 已回退**（revert `3daa7049` → `08ade5ea`），理由：与方案 C 重复——同一偏好
会同时写入 USER.md（B）和 personal 候选（C），造成存储/注入/治理/展示四重重复。

**最终形态：只保留方案 C**（`a438f86c`）：
- 「关于我」唯一载体 = personal 正式资产（确定性扫描用户消息 → 候选 → 待我处理
  确认 → 四视图管理）
- USER.md 保持**用户手动**管理（记忆功能），KStar 不自动写
- 注入走 personal 资产语义召回
- capture 线保留其既有 personal 抽取（语义查重 0.85 与 C 合并，无双写）

**已删除**：`personal-profile-sync.ts` + 其测试 + review-inference/types 的
lessonPersonal 字段（模型提名机制不再需要——C 是纯确定性，不依赖模型）。
