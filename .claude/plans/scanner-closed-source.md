# 安全扫描器闭源改造方案

## 目标

`resources/guardrail/skill-sentry`（30 个文件，2430 行 Python）含闭源资产，不随开源仓库分发。改造后：

- 开源仓库看不到扫描规则、评分权重、引擎实现
- 判定性质不变：符号层裁决，Agent 只做调度
- 篡改检测、receipt、缓存全部保留

## 现状（已核实）

| 事实 | 证据 |
|---|---|
| 扫描走本地子进程，无模型调用 | `sentry-adapter.ts` 用 `spawn`，全文无 LLM 调用 |
| 30 个文件已在版本库，已推内网 | `git ls-files` + `46cfa1e`，已在 `origin/wujy` |
| 无公开远端 | `git remote -v` 仅内网 + 本地 |
| 耦合面极小 | 仅 `paths.ts` 与 `sentry-adapter.ts` 引用 |
| 路径硬编码，无环境变量入口 | `enginePath()` = `packagedGuardrailDir()/skill-sentry` |
| 扫描器本就是标准技能包 | 自带 `SKILL.md`，声明 `requires_toolsets: [terminal]` |
| 缺失扫描器时已能降级 | 实测：移走目录后返回 `unknown/engine_missing` |
| 本地红线独立于闭源部分 | `localRedLines()` 走 TS 侧 `validateSkillDir` |
| 红线在扫描器缺失时仍生效 | 实测：外泄载荷仍 `blocked`，命中 2 条红线 |

### 两个必须先解决的结构问题

**一、递归**。`run_skill` 执行前会调 `isSkillTrustedForLoadDeep`，而它最终调 `scanSkillDir`。若扫描改走 `run_skill`：
```
扫描技能A → run_skill(skill-sentry) → 校验 skill-sentry 可信
          → 扫描 skill-sentry → run_skill(...) → 无限递归
```
已定方案：内置扫描器免扫，改用哈希校验。

**二、`unknown` 等于拒绝安装**。`skills.ts:1949/2025` 把 `unknown` 与 `blocked` 同等对待。单纯删掉扫描器会导致开源版**任何技能都装不了**。这是本方案最关键的一处设计。

> 注：`trusted-component-manifest.ts` 有一份 path/bytes/sha256 清单，形状正合适，但**无任何消费者**（死代码）。借鉴其形状，不复用其代码。

## 方案

### 第 1 步：扫描器路径可配置 + 存在性探测

`sentry-adapter.ts` 新增 `scannerAvailability()`，区分三种状态：

| 状态 | 含义 | 判据 |
|---|---|---|
| `present` | 扫描器在场 | 引擎 + gate 脚本齐备 |
| `absent_by_build` | 开源版本无此组件 | 构建标记声明不含扫描器 |
| `broken` | 应该在但坏了 | 标记说有，实际找不到 |

`enginePath()` 改为读 `COGSEED_GUARDRAIL_DIR`（缺省仍是 `packagedGuardrailDir()`），让私有扫描器可装在仓库外。

关键区分：`absent_by_build` 是**已知的产品形态**，`broken` 是**故障**。二者当前都落到 `engine_missing`，但应有不同后果——把故障当正常形态会掩盖真实问题。

### 第 2 步：新增 `scanner_absent` 结果档位

不复用 `unknown`。`unknown` 的语义是"扫描本应跑但没跑成"，导入路径据此拒绝安装，这是对的。开源版需要第四种语义：

```
pass | restricted | blocked | unknown | scanner_absent
```

`scanner_absent` 的处置：
- **不拒绝安装**（否则开源版不可用）
- 本地红线**仍无条件先跑**，命中即 `blocked`（已实测有效）
- receipt 记 `scanner: 'local'`，界面已有文案"仅本地规则，覆盖较弱"并降级配色（上一轮已做）
- `boundary` 语义与 AC-12 一致：如实标注强度，不冒充完整扫描

### 第 3 步：Agent 调度层（`security-scan` 工作流）

新增 `src/main/features/security/scan-orchestrator.ts`：

```
安装/导入触发
  → scanOrchestrator.scan(skillDir, source)
      ├─ 扫描器 present → 直接跑（现有路径，79ms，保持不变）
      └─ 扫描器 absent  → Agent 调度路径
            ├─ Agent 用 run_skill 调私有 skill-sentry 技能
            ├─ 技能输出结构化 JSON（现有 report-schema.json 契约）
            └─ 符号层解析 JSON → 裁决 pass/blocked ← 裁决权在此，不在模型
```

三条纪律：

1. **Agent 不给判定**。它只负责"把扫描任务走完"，返回扫描器的原始 JSON。裁决由 `outcomeFrom()` 等确定性代码做出——现有函数，不改语义。
2. **Agent 返回不可解析即 `unknown`**，绝不默认 `pass`。现有代码已有此纪律（`outcomeFrom` 注释明确写了"新 outcome 字符串不得静默解析为 pass"）。
3. **本地红线独立于 Agent 路径**，无条件先跑。Agent 失败、超时、被注入，红线都仍生效。

### 第 4 步：扫描器自身免扫 + 哈希校验

新增 `trusted-scanner-manifest.ts`：发布时固化 `path/bytes/sha256`（形状照 `trusted-component-manifest.ts`，但**要有消费者**）。

- `run_skill` 对内置扫描器跳过 `isSkillTrustedForLoadDeep` → 断开递归
- 改为比对 manifest 哈希 → 篡改仍能检测
- 豁免范围**仅限内置扫描器一个 id**，硬编码白名单，不接受配置——可配置的豁免就是可利用的豁免

### 第 5 步：仓库与历史清理

- `resources/guardrail/skill-sentry/` 移出仓库 → 独立私有仓库
- `.gitignore` 加该路径，防误提交
- 开源仓库保留 `scan_gate.py`（驱动脚本，不含规则）与一份**示例规则集**，让机制可验证、资产不泄露
- 历史清理：这 30 个文件已在内网历史里。开源前需 `git filter-repo` 重写，或开干净新仓库

### 第 6 步：测试

3 个测试文件依赖真实扫描器（`sentry-adapter` 23 条、`matrix` 40 条、`scan-gate` 24 条断言）。处理：

- 加 `describe.skipIf(!scannerPresent)`——私有环境跑全量，开源环境自动跳过
- **新增**开源形态专项测试：
  - 扫描器缺失时干净技能可正常安装（当前会被拒）
  - 扫描器缺失时红线载荷仍被拦
  - receipt 记 `scanner: 'local'` 且界面降级
  - Agent 返回垃圾 JSON 时判定为 `unknown` 而非 `pass`
  - 内置扫描器免扫不触发递归
  - manifest 哈希不符时能检出

## 代价与风险

**性能**：Agent 路径会把导入从 79ms 拉到数秒级。开源版才走此路，私有部署保持原速。

**安全性下降**（你已表示有其他解法，此处仅如实记录）：
- Agent 路径引入提示注入面——扫描对象是攻击者可控内容
- 缓解：符号层裁决 + 红线独立先跑，即使 Agent 被完全操纵，红线仍拦

**开源版覆盖变弱**：只有本地红线 + 结构校验。界面如实标注，不冒充完整扫描。

**历史清理**：改写已推送历史会影响已拉取该分支的人，需团队协调。

## 建议的执行顺序

第 1、2 步是地基且风险最低（纯新增，不改现有判定），建议先做并验证。第 3 步最重，第 4 步安全敏感需仔细。第 5 步涉及团队协调，最后做。

## 待你确认

1. **闭源边界**：整个 `skill-sentry`，还是只有 `rulesets/` + `scoring.py`？后者能让开源仓库跑通完整流程，只是规则是示例的——改动更小、开源体验更好。
2. **开源版无扫描器时**：按本方案不拒绝安装（红线仍拦）？还是宁可拒绝、要求用户自行配置扫描器？
3. **历史清理**：现在就规划，还是等真正开源前再处理？
