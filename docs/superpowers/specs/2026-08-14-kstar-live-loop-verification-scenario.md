# KStar 完整闭环实机验证场景

> 日期：2026-08-14
> 实例：source Electron（Mate-Backend-Test worktree，variant=cogseed，PID 89535）
> 数据根：`~/.cogseed/runtime-variants/cogseed/data`（uid 78967691）
> 目的：验证"我们的线"（KStar Commander-Centric 沉淀线）全节点实机执行与效果
> 前置：本实例运行 2026-08-14 22:56 重启后的新代码（含检索修复/双信号/推理归因/五类来源/直接沉淀）

## 场景：一次完整的 OAuth 代码审查任务

### 会话 1（沉淀生产）：一个会留下教训的任务

**用户消息**：
> 审查一下 OAuth 登录回调的代码，看看状态校验有没有问题。重点看 state 参数是否在校验后才交换 code。

**预期链路**（对照六个节点）：

| 节点 | 预期行为 | 验证点 |
|---|---|---|
| ① 检索 | Commander 收到注入（`<confirmed-ability-assets>`）；若库中有 OAuth/审查相关资产则选中 | 日志/投影记录出现新 projection，assetIds 非空或空但带 omittedRefs 原因 |
| ② 注入 | 资产 + 本体（USER.md/MEMORY.md 条目）进入 Commander system prompt | 会话文件/日志可见注入块 |
| ③ 预测 | Commander 调 `request_projection` → `commit_forecast`（2–4 候选，aHat/rHat） | `cloud/kstar/` 出现 requirement + forecast 记录 |
| ④ 执行 | Commander 派发 Agent（dispatch_to/hand_off_to）→ 门禁通过 → Agent 执行 | 日志有派发 + guard 放行 |
| ⑤ 复盘 | 终态 → closure → 五类来源证据 → 差异测量（deltaA/deltaR）→ 模型推理归因 + lesson | `cloud/recall/records/` 出现 episode + review（inferenceMethod=model，含 lesson） |
| ⑥ 沉淀 | 阈值门通过 → 直接写入能力资产（无用户确认）→ 下次可检索 | `ability-assets/` 出现新资产 |

**验收**：
- 出现 `aa-*` 能力资产文件（type 可能是 skill_method 或 rule）
- review 记录 `inferenceMethod: 'model'` 且带 `lesson`
- 资产 `status: active, maturity: seed`

### 会话 2（沉淀消费）：同类任务再次出现

**用户消息**：
> 再审查一遍 OAuth 回调，这次看一下 token 刷新流程的状态处理。

**预期**：
- ① 检索应命中会话 1 沉淀的资产（语义匹配 + scope 通过）
- 注入块包含该资产 → 证明"沉淀 → 下次可复用"闭环成立

**验收**：
- 新 projection 的 assetIds 包含会话 1 沉淀的 `aa-*`
- usage-records 出现 `outcome: 'injected'` 且带 matchScore

## 数据核对点（验证后检查）

1. `cloud/recall/records/ability-assets/` — 新增资产文件
2. `cloud/recall/records/projections/` — 两个会话的投影（session2 含 session1 资产）
3. `cloud/recall/records/` 下的 reviews/episodes（实际在 `cloud/kstar/`）
4. `cloud/recall/jsonl/usage-records/events.jsonl` — matchScore 记录
5. `cloud/recall/jsonl/ability-asset-versions/` — 版本快照

## 风险与降级

- **检索空转**：若 session1 投影 assetIds 为空，检查 omittedRefs 原因（scope_mismatch 已修；workspace_not_referenced 若出现是 workspace 硬闸，需记录）
- **模型推理不可用**：review 的 inferenceMethod 会降级为 deterministic——记录降级原因
- **无 Agent 可派发**：若会话无可用 Agent，Commander 会自执行——观察门禁行为
- **lesson 缺失**：review 有 lesson 字段但模型可能不填——这是数据观察点，不阻塞
