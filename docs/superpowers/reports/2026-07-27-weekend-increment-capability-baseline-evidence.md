# P3394 · COGSEED · 周末增量与当前能力基线 Evidence（Sprint 2 输入）

> Delivery Delta & Capability Baseline · **doc-v0.2 增量层** · Review · 2026-07-27
> 沿用 Sprint 1 交付包（doc-v0.2, 2026-07-24）的同一产品契约、同一 Evidence 纪律、同一验收语言。
> 本文件**不重写完整 Demo 包**，只记录「周五截止 → 当前」的事实增量、可运行能力、结转关系与缺口。
> Route B · 写论文场景：P3394 / KSTAR Agent 交付治理链路 · Team 2

| 字段 | 值 |
|---|---|
| 关联交付包 | `P3394_Team2_Sprint1_写论文场景_Demo与Evidence包_20260724.docx`（附录 A） |
| 本文件角色 | Sprint 1 结果**不改动**；本文件为 Sprint 2 **当前能力基线** |
| 记录人分工 | 本人负责：状态 / Evidence / 结转关系（不代替代码与产品核验） |
| 待核验分工 | 张超 = 代码 / 可运行性 / 正式项目集成；赵丽霞(PO) = Story/AC/闭环 |
| Repo | `/Users/sudai/Documents/Mate Agent` |
| 启动 | `cd PC && ./run.sh` |

---

## 0. 时间锚定与不倒填声明

| 锚点 | Commit | 说明 |
|---|---|---|
| Sprint 1 截止（周五） | `da545d1` | 吴嘉宇「Merge 'lunwen-skill' into 'main'」2026-07-23 |
| 当前 HEAD | `06c2ebd` | == `origin/main`（已同步，无本地领先） |
| 周末增量区间 | `da545d1..06c2ebd` | 见 §2 A 层 |

**不倒填声明（客观事实支撑）：** `origin/main` 在 **2026-07-24 与 07-25 两天提交数 = 0**（`git log --since=2026-07-24 --until=2026-07-26 origin/main` 返回空）。因此周末产出**在时间上不可能**并入 Sprint 1 截止态；Sprint 1 完成状态维持周五记录，本文件所有增量一律归属 Sprint 2 基线，不回填任何 Sprint 1 勾选项。

## 1. 一页增量摘要（One-page Delta）

- **A 层（已并入 main、已推送）**：group-chat 总线与 P3394 运行时打通、IPC/渲染层新增 collaboration 与 P3394 表面（含 Review Center / PatchCandidate 界面）、commander → Orkas Core 收敛。127 文件 +31900/-2983。**本会话真实复跑 105/105 通过**。
- **B 层（本地分支、未推送 = 最大缺口）**：`codex/meta-skill-engine-single-core` @ `5e7480f`「Engine-backed KSTAR adapter and projection」，62 文件 +8654（相对 main），含 `packages/nseap-meta-skill-engine/*` 与 kstar-adapter/compat/factory/store。**未推送任何 remote，未并入 main，张超尚未核验集成**。
- **C 层（工作副本、无提交）**：35 个 untracked 文件 + 1 个 stash，均为 B 层同源副本。**不计入 Sprint 2 基线**，仅作留痕。
- **一句话结论**：Sprint 2 真实可用基线 = A 层；B 层是"已成形但未交付"，C 层是"未固化"。基线口径以能否在 main 上复跑为准。

## 2. 三层能力边界（事实分层，附录 C Claim 规则）

| 层 | 载体 | 提交/推送状态 | 规模 | 可复跑? | 计入 S2 基线? | 责任核验 |
|---|---|---|---|---|---|---|
| **A** | `origin/main` @ `06c2ebd` | 已提交 **已推送** | 127 文件 +31900/-2983 | ✅ 本会话已复跑 | ✅ 是 | 张超复核集成 |
| **B** | 分支 `codex/meta-skill-engine-single-core` @ `5e7480f` | 已提交 **未推送** | 62 文件 +8654 | ⚠️ 仅分支内 | ❌ 否（未并入） | 张超：推送+并入决策 |
| **C** | working copy + `stash@{0}` | **无提交** | 35 untracked | ❌ | ❌ 否 | 记录留痕，勿当基线 |

> 边界纪律：任何"能力已具备"的陈述，**必须标明所在层**。A 层可称"当前可运行"；B 层只能称"分支内已实现、待集成核验"；C 层只能称"草稿留痕"。

## 3. 周末代码变化 → Story/AC → Evidence（结转映射）

沿用 Sprint 1 包的 US/EN/NFR/EVD/DEL ID，仅列**周末发生变化**的条目；未变化条目维持 Sprint 1 记录。

| 变化项 | 关键 Commit | 关联 Story/AC | 对应 DEL | Evidence | 层 | 状态 |
|---|---|---|---|---|---|---|
| group-chat 总线 × P3394 运行时打通（bus.ts +4367, collaboration.ts +2464, kstar-engine +190, kstar-notion +178, protocol +374） | `8ea94b9` | US-04/US-06、EN-01 | DEL-02/DEL-05 | EVD-02 (bus-integration 54/54)、EVD-03 (kstar-engine 3/3) | A | 真实·已复跑 |
| IPC + 渲染层 collaboration & P3394 表面（Review Center / PatchCandidate 界面、i18n） | `86a6f50` | US-07/US-08/US-09 | DEL-06/DEL-07 | EVD-04 (patch-candidates 1/1、protocol-events 1/1)、渲染层 39/39 | A | 真实·已复跑 |
| commander → Orkas Core 收敛 | `4518954` | US-01（治理归属） | DEL-01 | 见 landing-roadmap Phase 0 Done | A | 真实 |
| 渲染层 sidebar 分页 + relay activity | `c159881` | NFR-01、US-11 | DEL-08 | 渲染层测试 | A | 真实 |
| 运行时 tool-cycle Evidence（KStarToolCycle 记录/列举） | 测试 `cc6f0de`/`030acd9` | US-05（工具级留痕） | DEL-05 | EVD-01 (kstar-runtime 7/7) | A | 真实·已复跑 |
| **Engine 驱动的 KSTAR adapter + projection（单核 Meta Skill Engine）** | `5e7480f`（分支） | US-02/US-03（协议层单核） | DEL-03/DEL-04 | 分支内测试，**未在 main 复跑** | **B** | **未核验·未集成** |

## 4. 真实可运行能力证据（本会话复跑，非引用勾选项）

> 纪律：以下数字为本人在当前 HEAD `06c2ebd` **实际执行 `node scripts/run-tests.mjs run <file>`** 得到，非摘抄计划文档勾选项。命令见附录 B。

| EVD | 测试文件 | 本次结果 | 覆盖 Story |
|---|---|---|---|
| EVD-01 | `test/main/features/p3394/kstar-runtime.test.ts` | **7/7 通过** | US-05 |
| EVD-02 | `test/main/features/group_chat/bus-integration.test.ts` | **54/54 通过** | US-04/US-06 |
| EVD-03 | `test/main/features/p3394/kstar-engine.test.ts` | **3/3 通过** | US-03 |
| EVD-04 | `test/main/ipc/p3394-patch-candidates.test.ts` + `p3394-protocol-events.test.ts` | **2/2 通过** | US-08/US-09 |
| EVD-05 | 渲染层 P3394/collaboration（experience-controls 4、agent-activity-panel 1、collaboration-overview-drawer 2、conversation-info 23、ipc-shim 9） | **39/39 通过** | US-07/US-09/US-11 |
| — | **A 层合计** | **105/105 通过** | — |

**未复跑 / 待核验（明确列出，不含糊）：**
- `npm run typecheck`（全仓 `tsc --noEmit`）本会话**未运行** → 张超核验。
- `npm run test:js` 全量套件本会话**未跑全**（仅跑上述 EVD 相关文件）→ 张超全量复跑。
- **Mac 端 `cd PC && ./run.sh` 冷启动 Demo 未执行** → 张超做端到端可运行性核验。
- B 层任何测试**未在 main 复跑**（分支未并入）。

## 5. Mock 与真实集成边界

| 能力 | 真实集成 | Fixture/Mock | 边界说明 |
|---|---|---|---|
| P3394 运行时 × bus 事件流 | ✅ 真实（A 层，bus-integration 54 用例覆盖真实事件路径） | 部分外部 CLI 专家以桩替代 | 外部专家(Codex/Claude Code 等)为 participant，非 commander 后端；实际拉起未在测试内 |
| KSTAR Review Gate / PatchCandidate | ✅ IPC + 渲染界面真实（EVD-04） | PatchCandidate 数据在测试内为构造样本 | 界面与协议真实；真实补丁生成闭环待产品(赵丽霞)核验 AC |
| Meta Skill Engine 单核（`nseap-meta-skill-engine`） | ❌ **仅 B 层分支**，未并入、未推送 | MCP stdio 配置在分支内 | Sprint 2 若要计入基线，须先推送+并入+在 main 复跑 |
| Notion / KB 侧写 | kstar-notion.ts 代码真实（A 层） | 外部 Notion 调用未在测试内触达真实服务 | 属"代码就位、真实外呼待验" |

## 6. 当前缺口与阻塞（R 风险，沿用 Sprint 1 编号并新增）

| ID | 缺口/阻塞 | 影响 | 责任方 | 建议动作 |
|---|---|---|---|---|
| **R-07（新）** | B 层 `5e7480f` 未推送任何 remote | Meta Skill Engine 单核成果无法进入基线，存在丢失风险 | 张超 | 尽快 `git push` 到 remote 分支并发起并入决策 |
| **R-08（新）** | C 层 35 untracked + stash 无提交 | 与 B 层同源，散落易冲突/丢失 | 记录人+张超 | 确认以 B 层为准后清理 C 层，避免双源 |
| R-03（结转） | 全量 typecheck / test:js 本会话未跑全 | 无法声称"全绿" | 张超 | 全量复跑出数 |
| R-05（结转） | Mac 冷启动 Demo 未复演 | 端到端可运行性未证 | 张超 | 按十分钟脚本走查 |

## 7. Sprint 1 → Sprint 2 结转关系

- **保持不变**：Sprint 1 交付包 doc-v0.2 全部记录按周五 `da545d1` 冻结，不因周末产出改动任何勾选。
- **计入 Sprint 2 基线**：A 层全部（已在 main 且已复跑）。
- **候选待并入**：B 层单核 Engine——须先满足 R-07（推送+并入+main 复跑）后方可升为基线。
- **不计入**：C 层。

## 8. 建议的 Sprint 2 承诺范围（供三方共同确认，非单方拍板）

1. 优先消化 R-07：把 B 层单核 Engine 推送并做集成核验；核验通过后再定是否并入。
2. 全量 typecheck + test:js 出数，替换本文件"待核验"项。
3. Mac 冷启动十分钟 Demo 走查，补 EVD 端到端证据。
4. 由 PO(赵丽霞) 对 Review Gate / PatchCandidate 的真实闭环做 AC 判定。

> 承诺范围待 §9 三方核验后共同确认，本节仅为输入建议。

## 9. 真实性声明与三方核验签收

**真实性声明：** 本文件 §4 测试数字为本人在 HEAD `06c2ebd` 实际复跑所得；§2 三层状态由 git 客观状态支撑；凡未亲自执行者（typecheck 全量、Mac 冷启动、B 层集成）已在 §4/§6 明确标注"待核验"，无越界代验、无过度声称。

| 角色 | 姓名 | 核验对象 | 状态 |
|---|---|---|---|
| 记录人 | （本人/Agent） | 状态 / Evidence / 结转关系 | ✅ 已完成本文件 |
| Tech Lead | 张超 | 代码 / 可运行性 / 正式项目集成（含 R-07 推送并入、全量复跑、Mac 冷启动） | ⏳ 待核验 |
| PO | 赵丽霞 | 产品 Story / AC / 闭环 | ⏳ 待核验 |
| Scrum Master | 张浩 | 流程与 Sprint 2 承诺范围确认 | ⏳ 待确认 |

---

## 附录 A · 关联交付包
`P3394_Team2_Sprint1_写论文场景_Demo与Evidence包_20260724.docx`（Sprint 1 冻结态，doc-v0.2）。本文件为其增量层，不覆盖、不重写。

## 附录 B · 复现命令（本会话所用）
```bash
cd "/Users/sudai/Documents/Mate Agent"
# A 层 P3394 后端 + IPC
node scripts/run-tests.mjs run \
  test/main/features/p3394/kstar-runtime.test.ts \
  test/main/features/p3394/kstar-engine.test.ts \
  test/main/ipc/p3394-patch-candidates.test.ts \
  test/main/ipc/p3394-protocol-events.test.ts
# A 层 bus + 渲染层
node scripts/run-tests.mjs run \
  test/main/features/group_chat/bus-integration.test.ts \
  test/renderer/p3394-experience-controls.test.ts \
  test/renderer/agent-activity-panel.test.ts \
  test/renderer/collaboration-overview-drawer.test.ts \
  test/renderer/conversation-info.test.ts \
  test/renderer/ipc-shim.test.ts
# 三层边界核对
git rev-parse --short HEAD origin/main da545d1
git diff --shortstat da545d1..HEAD
git log --since=2026-07-24 --until=2026-07-26 --oneline origin/main   # 期望空
git branch -r --contains 5e7480f                                      # 期望空=未推送
```

## 附录 C · 状态词表（沿用交付包）
- **真实**：已在当前 HEAD 复跑/可运行，有 Evidence。
- **Fixture/Mock**：逻辑就位但依赖构造样本或桩，未触达真实外部服务。
- **未核验**：本人未亲自执行，交由责任方核验（不等于失败，也不得当作通过）。
- **未集成**：代码存在于分支/工作副本，未并入 main。

## 附录 D · 提交前自检
- [x] Sprint 1 记录未被改动（不倒填）
- [x] 每条能力标明所在层（A/B/C）
- [x] 测试数字为实跑，非摘抄勾选项
- [x] 未执行项明确标"待核验"并指派责任方
- [x] Mock/真实边界单列
- [x] 最大缺口（B 层未推送 R-07）显式提示
