# Main Skill Baseline 实施规划（T2-S3-02 阶段 1）

| 项 | 值 |
|---|---|
| 所属任务 | T2-S3-02 · US-20 复杂项目交付 Workspace |
| 本阶段范围 | Main Skill 资产引用 + Baseline 冻结 + 哈希校验 |
| 上游依赖 | T2-S3-01（US-18/19 四类资产与统一元数据）— **未开工，本规划按方案 B 先定最小契约** |
| 相关 Gate | RG-S3-03（Workspace 上架）、RG-S3-16（KSTAR Gate A）、RG-S3-15（评价完整性，当前 REWORK） |
| 成文日期 | 2026-08-04 |

---

## 1. 需求原文校准

早先基于任务标题推断的两处结论已修正：

| 项 | 早先推断 | Backlog 原文 |
|---|---|---|
| Workspace 性质 | 用户进入的工作容器 | **复杂项目交付 Workspace，是要「上架」的可交付包**（RG-S3-03；Evidence 含 `WorkspacePackage`） |
| Baseline 含义 | 安全校验基线（指向 validation_id） | **方法版本基线：记录 Skill ID、版本、来源、Action Plan、Ontology Binding、Evaluation Contract 和哈希；Episode 期间不可变**（US-11 AC2/AC3） |

决定性约束（逐条对应原文）：

- **不复制资产**：Workspace 引用稳定资产 ID 和版本（US-20 AC3）
- **Baseline 不可变**：Episode 期间不可变；无 Baseline 不启动正式 KSTAR Episode（US-11 AC3/AC5）
- **用户确认才写入**：拒绝或 Evidence 不足时正式资产零变化（US-19 AC1/AC3）
- **Agent 不得直写正式资产**（RG-S3-13）
- **不得硬编码厂商**：Agent A/B 是运行时角色（US-20 AC5）
- **冻结先于执行**：EvaluationContract 与 ExpectedResultSnapshot 必须在 TaskRun 前冻结（RG-S3-15）
- **未达 Gate 不得展示空 Workspace**（T2-S3-02 Notes）

---

## 2. 最小资产引用契约（方案 B）

T2-S3-01 尚未定义资产存储层。本阶段以 Tech Lead 身份先定**最小引用契约**，T2-S3-01 后续按此扩展而非推翻。

```ts
/** Workspace 对个人能力资产的稳定引用。只存引用，不复制资产内容。 */
export interface AssetRef {
  asset_id: string;          // 稳定资产 ID，由资产层分配
  version: string;           // 资产版本
  content_hash: string;      // sha256-tree-v1，内容指纹
}
```

三字段是 US-19 完整字段集（`asset_id`/`type`/`owner`/`source_refs`/`version`/`scope`/`applicable_when`/`forbidden_when`/`maturity`/`sensitivity`/`control`）的**引用子集**：Workspace 侧只需要「指向谁 + 哪个版本 + 内容是否被改动」，其余治理元数据归资产层持有。

**移交约定**：T2-S3-01 落地后，`asset_id` 与 `version` 的取值规则以资产层为准；本契约的三字段名不变，避免 Workspace 侧返工。

---

## 3. Main Skill Baseline 数据模型

```ts
export type BaselineSource = 'workspace-builtin' | 'external-admitted' | 'session-draft-confirmed';

/** 冻结后不可变。任何字段变更必须新建 baseline，不得原地修改。 */
export interface MainSkillBaseline {
  baseline_id: string;
  skill_ref: AssetRef;                 // §2
  source: BaselineSource;              // US-11 AC1 三类来源
  action_plan_ref?: string;            // Action Plan 引用
  ontology_binding_ref?: string;       // Ontology Binding 引用
  evaluation_contract_ref?: string;    // Evaluation Contract 引用（RG-S3-15 前置）
  frozen_at: string;
  frozen_by: 'user';                   // Agent 不得直写（RG-S3-13）
}
```

`source` 三值直接对应 US-11 AC1：「Workspace/Role 内置、通过准入的外部 Skill、用户确认的 Session 提取 Draft」。不得新增第四类来源。

落盘位置（机器私有，随执行证据同域）：

```
<uid>/local/kstar/baselines/<baseline_id>.json
```

一文件一 baseline，理由同 `project_tasks.ts` 的一任务一文件：多设备并发写不同 baseline 不冲突，列举靠目录扫描，无聚合索引。

---

## 4. 哈希与冻结机制

### 4.1 复用既有哈希器，不新建

`src/main/util/marketplace-tree-hash.ts` 已提供目录级内容哈希：

```
marketplaceContentTreeHash(root) → 'sha256-tree-v1' 摘要
```

它已满足冻结校验的全部需要：

- 跨语言契约（与 Python 侧一致），codepoint 排序而非 `localeCompare`
- 自动跳过 `.DS_Store` / `__pycache__` / `_install.json` / 点开头文件等易变项
- 相对路径平台中立（Windows 上也用 `/`）
- 任一文件读失败返回空串（可判定为「无法冻结」）

**规范**：`content_hash` 必须由此函数产出，禁止另写哈希实现或改用 `sha256OfFile`（后者只哈希单文件，无法覆盖技能目录整体）。

### 4.2 冻结与校验时序

```
用户确认主技能
   ↓
freezeBaseline()  ← 计算 content_hash，写入 baseline 文件
   ↓                RG-S3-15：必须在 TaskRun 之前
verifyBaseline()  ← 每次 Episode/TaskRun 启动前重算并比对
   ↓
hash 一致 → 放行；不一致 → 拒绝启动，返回 drift
```

**硬性规范**：

- `freezeBaseline` 必须先于任何 TaskRun 创建（RG-S3-15 当前状态为 REWORK，就是因为时序污染）
- `verifyBaseline` 检出 drift 时**拒绝启动 Episode**，不得自动重新冻结
- Baseline 文件写入后不得原地修改（对应 US-11 AC3「Episode 期间不可变」）；变更即新建
- 空串哈希（读取失败）视为**不可冻结**，等同无 Baseline

### 4.3 API 形态

```ts
// features/workbench/main-skill-baseline.ts
export async function freezeBaseline(
  userId: string,
  input: FreezeBaselineInput,
): Promise<MainSkillBaseline>;

export async function readBaseline(
  userId: string, baselineId: string,
): Promise<MainSkillBaseline>;

export async function verifyBaseline(
  userId: string, baselineId: string, skillDir: string,
): Promise<{ ok: true } | { ok: false; reason: 'drift' | 'unreadable' | 'not_found' }>;

export async function listBaselines(userId: string): Promise<MainSkillBaseline[]>;
```

`userId` 为第一参（AGENTS.md：用户私有数据函数约定）。写入走 `fileEditLock`，与 `context-reuse-receipt.ts` / `execution-records.ts` 同构。

---

## 5. 与既有模块的关系

| 模块 | 关系 |
|---|---|
| `util/marketplace-tree-hash.ts` | **复用**，产出 `content_hash` |
| `util/locks.ts::fileEditLock` | **复用**，写入串行化 |
| `util/path-sandbox.ts::isPathAllowed` | **必须调用**，`skillDir` 入口校验 |
| `execution-records.ts` | Task Run 阶段关联；`ExecutionRecord` 已带 `receiptId`，baseline 关联在 Run 创建时传入 |
| `p3394/skill-validation-run.ts` | 独立维度。安全校验 ≠ 方法基线，两者都进 Gate 判据但字段不合并 |
| `projects.ts::ProjectBindings` | **不改**。早先方案拟在 bindings 加 `main_skill_id`，与「不复制资产、引用稳定 ID」的原文冲突，已废弃该做法 |

**重要修正**：早先规划把 Main Skill 做成 `bindings.json` 的一个 id 字段。US-20 AC3 明确 Workspace 引用资产 ID + 版本，而 bindings 是「项目内可见的严格作用域」，语义不同。Main Skill Baseline 独立成模块，不侵入 bindings。

---

## 6. 测试规范

覆盖不变量与失败路径，不测类型包装：

- **冻结不可变**：已冻结的 baseline 再次写入必须失败
- **drift 检出**：技能目录任一文件内容变化后 `verifyBaseline` 必须返回 `drift`
- **跳过项不影响哈希**：在技能目录新增 `.DS_Store` / `_install.json` 后哈希不变
- **不可读判定**：技能目录缺失时返回 `unreadable`，不得静默通过
- **来源枚举封闭**：`source` 传第四类值必须拒绝
- **沙箱**：`skillDir` 越界必须拒绝
- **时序**：无 baseline 时启动 Episode 必须被拒（US-11 AC5）

```bash
npm test          # 勿用 npx vitest
npm run typecheck
```

---

## 7. 待确认事项

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| 1 | `asset_id` / `version` 取值规则归属 T2-S3-01，该任务未开工、DRI 未定 | 本阶段用最小契约占位 | 你以 Tech Lead 身份把 §2 三字段定为移交基线，通知 T2-S3-01 按此扩展 |
| 2 | `action_plan_ref` / `ontology_binding_ref` / `evaluation_contract_ref` 的目标载体尚不存在 | 字段设为可选，先留引用位 | 与 T2-S3-03（US-21/22）对齐后填实 |
| 3 | Workspace Gate 与 P3394 Wake Gate 语义重叠（`wake-service.ts` 已有准入体系） | 阶段 3 阻塞项 | 需你决策：独立门禁 or Wake Gate 上层视图 |
| 4 | `ExecutionKind` 现值为 `core-agent`/`codex`/`local-agent`/`openclaw`，是厂商名 | 与 US-20 AC5「不硬编码厂商」冲突 | Task Run 阶段需引入运行时角色层（Agent A/B）与厂商解耦，不改 `ExecutionKind` 本身 |
| 5 | RG-S3-15 状态为 REWORK，`EVID-S3-T2-01` 受影响样本需重跑 | 影响 Task Run 验收 | 本阶段只需保证冻结先于执行；重跑属 T2-S3-03 范围 |

---

## 8. 硬性禁止

- 新写哈希实现，或用 `sha256OfFile` 替代 `marketplaceContentTreeHash`
- 原地修改已冻结的 baseline
- drift 检出后自动重新冻结
- 把 Main Skill 塞进 `bindings.json`（违反「引用而非复制」）
- 让 Agent 写入 baseline（`frozen_by` 只能是 `user`）
- 在 TaskRun 之后补冻结（RG-S3-15 污染判定）
- 把安全校验 `validation_id` 与方法基线字段合并
- 把资产内容复制进 Workspace 存储
