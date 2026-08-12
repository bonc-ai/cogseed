# 连接链路 Spike 缺口方案：目标端加载执行侧（FR-REU-04）

> 归属：待办 #2（8/12 连接 Spike 决策 Gate）
> 上游：`docs/superpowers/specs/2026-08-10-cogseed-production-architecture.md`（§16 🔴-2、§5 缺口 ②）
> 状态：方案待确认（决策点 D-S1~D-S4）

---

## 一、缺口一句话

能力包（`capability-pack.ts`）只有**打包/存储/过期判定**，没有**"目标 Agent 真实加载 → 产出首个 Action Plan → 生成 ContextReuseReceipt"**的执行侧。8/12 Spike 要验证的就是这一段，现在没有代码可跑。

## 二、方案：`features/p3394/capability-load.ts`（目标端加载执行侧）

复用既有通道，**零新增 spawn 路径、零新增 npm 依赖**（AGENTS.md 强制）：

- 目标 Agent 调度 → `features/local_agents/runner.ts::run()`（唯一 CLI spawn 路径 ✅）
- 回执 → `features/p3394/context-reuse-receipt.ts`（prepare/complete 已就绪 ✅）
- 加载记录 → 执行事件流（lifecycle event，append-only）

### 核心入口

```ts
loadCapabilityPackToTarget(uid, {
  packId,          // 能力包 id
  targetAgentId,   // 目标 CLI Agent（映射 registry LocalCliType）
  taskPrompt,      // 目标任务描述
  cwd,             // 工作目录（过路径沙箱）
  signal,
}) → {
  ok, boundary: 'real'|'degraded'|'test-double',
  actionPlan?,     // 目标 Agent 产出的 Action Plan（ACTION_PLAN 块）
  receipt,         // ContextReuseReceipt
  evidenceRefs,    // runId / sessionId / events.jsonl 路径
}
```

### 流程（6 步）

| # | 步骤 | 实现 | 失败处理 |
|---|---|---|---|
| 1 | 读包 + 过期校验 | `readCapabilityPack` + `isCapabilityPackExpired` | 过期/不存在 → 拒绝，不启动 |
| 2 | 组装加载指令 | 任务 prompt + 能力包**引用清单**（只给 asset refs，不复制正文，守 AC-06）+ 要求先输出任务理解再输出 `ACTION_PLAN:` 块 | — |
| 3 | pre-flight 探测目标 CLI | `registry.detectOne` 真实探测 | 缺失 → `degraded`，**不冒充 real**（边界纪律） |
| 4 | 真实执行 | `runner.run()`（cwd 过路径沙箱，结果过 tool-result-cap） | 超时/失败 → `degraded` + 降级主张 |
| 5 | 输出校验 | 提取 `ACTION_PLAN:` 块，非空 + 结构化检查 | 无 Action Plan → 判失败，不出 completed 回执 |
| 6 | 回执 + 事件 | `receipt prepare(real) → complete`；执行事件流写 `capability_loaded`（含 packId、boundary、refs） | 事件写失败 → UI 状态不变（先事件后资产） |

### 事件落点决策（D-S4）

资产事件账本（`asset-events.ts`）的 13 种类型是**资产状态**事件，能力包加载是**执行行为**——**建议复用执行事件流**（task-run 同款 lifecycle event，append-only 天然不可变），不扩资产账本类型。

## 三、8/12 Spike 执行清单

1. **构造真实能力包**：`buildCapabilityPack`（真实 main_skill_ref + 引用清单，24h 有效期）
2. **选目标 Agent**（D-S1）：**hermes（Mate Agent 自己）先行跑通链路**——本机已装 `hermes` CLI，走 `runner.ts` 的 hermes backend（`hermes acp` + `HERMES_YOLO_MODE=1` 无头执行），确定可用、零外部依赖、零登录成本；**claude 作为第二阶段可选增强**（外部兼容性验证，可用则跑，不可用不阻塞）
3. **跑一次 `loadCapabilityPackToTarget`**：真实任务 prompt（如"为 X 交付物生成实现 Action Plan"）
4. **收集 Evidence**（保底 Evidence 必须真实，禁止 Mock 冒充）：
   - 目标 Agent 真实执行日志（runner `events.jsonl`）
   - 产出的 `ACTION_PLAN` 文本
   - `ContextReuseReceipt`（boundary=real, status=completed）
   - 执行事件流 `capability_loaded` 记录
5. **判据**：

| 结果 | 判定 | 后续 |
|---|---|---|
| completed + boundary=real + ACTION_PLAN 非空 + receipt completed | ✅ Spike 通过 → 原生链路 | 8/19 保底用原生链路 |
| 其余（CLI 缺失/超时/无 Action Plan） | ⚠️ 未通过 → `degraded` 标注 + 主张降级 exported_evidence（D-2 已定） | 保底 Evidence 如实标注降级 |

## 四、决策点（需 Tech Lead/PO 拍板）

| # | 决策 | 建议 | 理由 |
|---|---|---|---|
| D-S1 | Spike 目标 Agent 用谁 | **hermes（Mate Agent 自己）先行**，claude 作第二阶段可选增强 | hermes 是受支持 LocalCliType（`hermes acp` 无头），确定可用、零外部依赖；目标端是真实执行非 Mock，Evidence 不虚；claude 仅验证外部兼容性，不可用不阻塞 |
| D-S2 | ACTION_PLAN 校验标准 | `ACTION_PLAN:` 标记块 + 非空 + ≥3 个步骤项 | 结构化校验，防"看似完成实则没干活" |
| D-S3 | 能力包引用怎么给目标 Agent | 只给 refs 清单 + 路径沙箱内可读 | 守 AC-06 引用不复制；不给正文防扩散 |
| D-S4 | 加载事件落哪 | 执行事件流（lifecycle） | 不扩资产账本；加载是执行行为非资产状态 |

## 五、Scope guard（不做）

- ❌ 不做 TaskContinuationSnapshot（D-1 未拍板）
- ❌ 不改 `runner.ts`、不新增 spawn 路径、不新增 npm 依赖
- ❌ 不做加载 UI、不做进度条（Spike 是命令行/脚本级验证）
- ❌ 不写资产账本新事件类型（D-S4 待确认后按结论执行）

## 六、验证方式

- 单测：`test/main/features/p3394/capability-load.test.ts`（13 用例）——过期拒绝、CLI 缺失降级、ACTION_PLAN 校验（含 Markdown/加粗变体）、receipt 状态机、事件落账（test-double 边界，不真 spawn）
- Spike 试跑（2026-08-10 已完成，见下）

## 七、Spike 试跑结果（2026-08-10，真实 hermes 目标端）

**结论：链路真实跑通。** `loadCapabilityPackToTarget` 在隔离临时数据目录下完成：
- 真实能力包（buildCapabilityPack）→ 真实 hermes CLI 执行（runner 通道，约 50-70s）→ `ACTION_PLAN` 校验通过 → **`ok:true, boundary:real`**，回执 completed，`capability_loaded` 事件落账，runId/sessionId/executionId 齐全
- 目标 Agent 正确理解能力包引用（"主技能 sk-handoff@1.0.0 / 规则 rule:sk-rule-1 / 模板 sk-tpl-1 / 作用域 sp_x"）——加载指令组装有效

**试跑暴露并修复的问题（Spike 的价值）：**
1. **ACTION_PLAN 格式契约**：hermes 三次输出三种格式（`ACTION_PLAN:` / `## ACTION_PLAN` / `**ACTION_PLAN:**`）——提取器从"仅精确 `ACTION_PLAN:`"放宽为兼容 Markdown 标题/加粗/冒号任意组合 + `- ` / `* ` / `1. ` 步骤行；对应补测试用例（13/13 绿）
2. **隔离环境资产不可达**：spike 临时目录无真实技能资产，目标 Agent 如实报告"sk-handoff 未注册、KB 模块版本不匹配"并降级用本地上下文——边界纪律生效（不冒充）；8/12 真实环境走真实资产解析
3. **执行耗时/成本**：单次真实加载 50-70s、消耗模型 token（架构 §9 估算的"能力包组装+目标 Action Plan 5-10K in / 1-2K out"量级吻合）

**遗留**：8/12 正式 Spike 在真实用户数据环境重跑一遍（资产可解析），即可作为保底 Evidence。
