# Hub Skill 客户端生命周期 —— 场景 ↔ 测试映射

**规格**：`specs/010-hub-skill-client-lifecycle/`（另一仓库 `cogseed-hub`）
**场景来源**：冻结 PRD `doc-v0.5` §12.2（`C1`–`C13`）与 §12.3（`O1`–`O4`）
**更新时机**：新增或移动本目录下的测试时同步更新；**缺口如实标注为缺口，不留白**。

> 本表是 Phase 13 / T109 的产物。它的用途是**可核对**：拿着 PRD 的场景编号，能一眼查到
> 判据落在哪个文件的哪一组用例，以及哪些部分本地根本没验证。
>
> ⚠️ **通过不等于验收**。本地测试只支持其观察范围内的结论，不构成验收、生产就绪或发布。

---

## 验收场景（`C1`–`C13`）

| # | 场景 | 判据落点 | 状态 |
|---|---|---|---|
| `C1` | 匿名打开目录页，安装一个 Skill，可开始一次真实使用 | `global-invariants.test.ts`「目录 / 版本状态 / 取字节匿名可访问」；`install.test.ts`「T027 锁定既有行为」；`pin-dispatch.test.ts`（能产生 pin 即能开始使用） | ⚠️ **部分**：「出现在 Skill 原入口」是渲染层端到端，本地未验证 → Phase 14 |
| `C2` | 安装下载过程中断网 | `source-fetch.test.ts`「下载中断时不留残片」「摘要/大小不匹配时不返回字节、不留盘」；`install.test.ts`「T028 失败保护」 | ✅ |
| `C3` | 发布物字节被篡改导致摘要不匹配 | `source-fetch.test.ts`「摘要不匹配时不返回字节、不留盘（FR-011）」；`install.test.ts`「取字节任一校验不过即不落盘」 | ✅ |
| `C4` | 更新写入过程中进程被强制结束 | `crash-recovery.test.ts`（T050 / T052 全组）；`scenarios.test.ts`「T114 崩溃注入 20 次」 | ✅ |
| `C5` | 已安装 v1，Hub 发布 v2；回退发布不覆盖本机 | `update-cadence.test.ts`「T062 Hub 回退发布不覆盖本机」；`install.test.ts`「T029 单调规则」 | ✅ |
| `C6` | 用户卸载官方副本，不被自动装回 | `uninstall.test.ts`（墓碑、10 个周期不装回、可重新安装） | ✅ |
| `C7` | Hub 返回 5xx 或不可达 | `scenarios.test.ts`「T110 `C7`」（已安装可用 + 进行中不中断 + 不擅自改停用）；`test/renderer/marketplace-card-states.test.ts`「T105」（目录页降级文案） | ✅ |
| `C8` | 某版本被停用，随后恢复 | `disable-enable.test.ts`（阻断新使用 / 不中止运行中 / 恢复回到原有选择） | ✅ |
| `C9` | 使用需要敏感权限或外部账号 | `sensitive-approval.test.ts`（确认才开始、拒绝不启动、**官方来源不能代替授权**） | ✅ |
| `C10` | 对官方副本「转为我的版本」并修改 | `test/main/features/skills/fork-to-custom.test.ts`（列表仍一条、`forked_from` 已写入、Hub 更新/停用/事件影响项 0） | ⚠️ **部分**：来源标识「我的 · 派生自 Hub v{version}」的**展示**受阻于 `CC-HUB-OPEN1-US3-US6-FORKED-FROM-READ-001` |
| `C11` | 派生后重新安装官方版 | `fork-to-custom.test.ts`「T078 / T081」（同名冲突、改名后两条并存、来源可区分） | ⚠️ **部分**：主进程侧已闭环；目录页提示与改名交互随 T103 待决 |
| `C12` | 安装与随包种子同 ID 的更高版本 | `install.test.ts`「T029 同 ID 内容按 §7.5 单调规则处理，不产生第二份」 | ✅ |
| `C13` | 已安装 v1 且使用进行中，Hub 发布 v2 | `scenarios.test.ts`「T112 `C13`」（全程读 v1、事件 `version=1.x`、结束后才换 v2） | ✅ |

## 观测场景（`O1`–`O4`）

| # | 场景 | 判据落点 | 状态 |
|---|---|---|---|
| `O1` | 下载同一版本两次，分发计数 +2 | — | ⛔ **Hub 侧**，不在客户端规格范围 |
| `O2` | 登录且 Consent 生效，一次成功 + 一次失败 | `usage-event.test.ts`（白名单恰 6 字段、成功/失败各一条） | ⚠️ **部分**：`product_analytics` Consent scope 在客户端**尚不存在**，默认读数为 `unavailable`，故**实际产生的事件数恒为 0**。采集侧逻辑已闭环并可翻转（`setConsentReader`） |
| `O3` | 匿名 / 拒绝 / 撤回 Consent | `usage-event.test.ts`（三种状态下事件数 0，使用不受影响） | ✅ |
| `O4` | 派生副本与自定义 Skill | `usage-event.test.ts`；`fork-to-custom.test.ts`（派生副本事件数 0） | ✅ |

## 成功标准（SC）

| # | 判据落点 | 状态 |
|---|---|---|
| SC-001 | 两平台各跑一遍 `C1`–`C13`、`O2`–`O4` | ⛔ **未跑**：本轮仅 macOS（`darwin`）。Windows 实跑是 T119，**本轮无 Windows 环境，未跑亦不推断** |
| SC-002 | `scenarios.test.ts`「T113 复合场景」（发布 + 停用 + 不可达同时发生 → 版本恒定、中止 0） | ✅ |
| SC-003 | `scenarios.test.ts`「T114」（20 次崩溃注入，可用版本数恒为 1、从不为 0） | ✅ |
| SC-004 | `source-fetch.test.ts`（落盘字节 0 / 清单条目 0） | ✅ |
| SC-005 | `disable-enable.test.ts` | ✅ |
| SC-006 | `uninstall.test.ts` | ✅ |
| SC-007 | `fork-to-custom.test.ts`「T080」 | ✅ |
| SC-008 | `usage-event.test.ts` | ⚠️ 同 `O2`：Consent 未落地前实际事件数恒 0 |
| SC-009 | `version-gc.test.ts`（误删数 0、异常时删 0） | ✅ |
| SC-010 | `current-switch-policy.test.ts`（M1 可翻转性 + 扩散检测） | ✅ |
| SC-011 | `metadata-adapter-swap.test.ts`（Q1）、`usage-event.test.ts`（Q3） | ✅ |

## 结构性判据（Phase 13 / T115 归集）

| 判据 | 落点 | 结果 |
|---|---|---|
| M1 可翻转性（T056）+ 扩散检测（T055） | `current-switch-policy.test.ts` | ✅ 14/14 |
| Q1 可翻转性（T014） | `metadata-adapter-swap.test.ts` | ✅ 4/4 |
| Q3 可翻转性 + 扩散检测（T093） | `usage-event.test.ts` | ✅ 25/25 |
| Q4 断言（T059） | `pin-dispatch.test.ts` | ✅ 16/16 |
| 全局约束 FR-071～FR-074、FR-013 | `global-invariants.test.ts` | ✅ 19/19 |
| 平台文件语义（T118a） | `platform-fs-semantics.test.ts` | ✅ 13/13（当前平台；另一平台为代码性质断言） |
| 回滚前置条件（T118b） | `rollback-rehearsal.test.ts` | ✅ 6/6 |

## 已知缺口（不留白）

1. **Windows 实跑**（SC-001 的一半 / T119）——本轮无环境，**未跑**。
2. **`product_analytics` Consent scope 尚不存在**——`O2` / SC-008 的实际事件数恒 0，
   这是保守侧的正确行为，但不能据此声称埋点「已在真实条件下验证」。
3. **派生状态的用户可见呈现**（`C10` / `C11` 的展示半边）——受阻于
   `CC-HUB-OPEN1-US3-US6-FORKED-FROM-READ-001`，待人类裁决。
4. **端到端 / 真机 UI**——Phase 14 E2E 未进行；本地测试覆盖的是判定与渲染输出，不是视觉效果。
5. **Hub 侧联调**（`O1` 分发计数、A-03 接收端）——不在客户端规格范围，且 Q3 未收口。
