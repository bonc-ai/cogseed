# Skill 安全体系 第三期 — 接入 skill-sentry 做 Skill 安全审核

> 依据：`P3394_CogSeed_认知资产安全与Skill准入设计规范 doc-v0.1`（下称「规范」）
> 复用组件：`skill-sentry 2.1.0`（Scanner）
> 前置状态：一、二期已完成（见 `skill-安全体系-第二期-实施方案.md`）

---

## 0. 目标与范围（已与产品确认）

**目标**：给 Mate Agent 增加 Skill 安全审核功能，能力来源为 `skill-sentry`。

**形态**：自动扫描 + 风险分级 + 分级拦截。不是「列一个待审队列让人逐个批」，
而是系统自动判定、低风险静默、中风险提示、高风险阻断。

**覆盖入口**（三条，按用户实际使用频率排序）：

| 入口 | 时机 | 优先级 |
|---|---|---|
| 市场安装 | 安装落盘后、可用之前 | 高（用户最常走） |
| 已装技能重新审核 | 用户主动触发 / 规则包更新后 | 高（让机制平时可见） |
| 用户导入外部技能 | 首次运行前（规范 §4.3 Must） | 中 |

### 0.1 明确不做（本期）

- **ECS 3.2 / security-skills 接入** —— 产品确认暂不需要。
  因此界面上的「完整性检查」这一栏本期**不呈现**，只做「安全检查」。
  规范 §5.1 要求三层分别呈现，本期是**部分实现**，需在 UI 上诚实留白，
  不得用我方 `validateSkillDir` 冒充完整性检查（该套在真实语料上 5/5 误报）。
- 非 Skill 资产（Ontology / Rule / Template / Workspace）类型校验
- Hub 市场信誉、云端深扫、撤回运营（规范 §9.3 Out/Later）
- 企业 ECS Federation
- 二进制动态沙箱（skill-sentry 自身也未接入）

---

## 1. 一次方向修正

前两期是在**没有读过规范**的情况下自行长出来的。功能方向没错（装完防篡改、
出口扣留、用户可见），但**自建规则库的路走反了**。

### 1.1 已验证的关键事实

在**我们自己的 5 个 builtin 技能**上实跑 skill-sentry：

| 技能 | score | 分级 | 建议 | findings |
|---|---|---|---|---|
| 6743aa0797a2 | 100 | LOW | ALLOW | 0 |
| 8d2f4b7c9a10 | 100 | LOW | ALLOW | 0 |
| 9be6fda271a5 | 100 | LOW | ALLOW | 0 |
| e7f5c0e6f1be | 81 | LOW | ALLOW | 25 |
| ee99fbb42964 | 100 | LOW | ALLOW | 47 |

**5/5 ALLOW，误报 0。** 对比我方引擎在同语料上：降级 MEDIUM 之前
`{verified:0, risk:5}` —— **全部误报**。

47 条 findings 仍判 ALLOW 的原因已核实：39 条 `context=test`、7 条 `source`、
1 条 `doc`，全部 info 级。**降权层确实在工作**，不是碰巧。

结论：**放弃自建规则库，改为适配 skill-sentry。** 我方 1 条红线规则 vs 它
38 条文本规则 + 20 条密钥模式，且它有 43 个真实语料的误报标定，我方没有。

### 1.2 引擎接入方式

原计划把 YAML 规则移植进 TS。**不做**，理由三条：

1. 规范 §9.2 要求规则包能**独立签名更新**。移植进 TS 意味着规则更新必须发版。
2. `context.py` 的 6 档降权 + 语言分派是误报归零的关键，移植等于重写并重新标定。
3. 规范 §2.3 明确写「先适配存量扫描能力」，不是重造。

改为 **子进程调用 Python**。已验证：
- `/usr/bin/python3` 3.9.6 可用
- `engine.scanner_core.report` 实跑通过
- `runtime_trust/skill_guard.py` 在 3.9 下**可正常导入并运行**（原先担心的
  `dict[str, Any]` 内联泛型注解问题不存在）
- 解释器解析复用 `bundled-runtime.ts::bundledPythonExecutable()`，
  回落系统 `python3`，不硬编码

### 1.3 隔离策略（产品已决策：方案三）

skill-sentry `SOURCE_POLICY` 对 `thirdparty` 要求 `require_isolation: true`，
实测在本机（Docker 已装但 `skill-security-scanner:local` 镜像未构建）会
**直接拒装所有第三方来源**：

```
source=official    → allow
source=thirdparty  → deny 「要求隔离扫描，但当前环境无法隔离，已拒绝安装」
```

**采纳方案三**：有 Docker 镜像走隔离扫描；无镜像时允许扫描但
`require_isolation=false`，报告标注 `scan_mode: degraded-local` +
`isolated: false`，UI 明示可信度较低，**且仍拦 CAUTION 以上**。

依据规范 §5.2：「检查不可用」是 `Unknown` 而非 `Blocked`，并要求
「诚实降级，不用 Mock 结果或『已安全』占位」—— 规范允许降级但要求如实标注。

已验证降级路径可用：`verdict=allow, isolated=False,
scan_mode=degraded-local, warning=未隔离运行，裁决可信度较低`。

---

## 2. 系统 Guardrail Skill 的形态

规范 §2.1 定义了第三类资产 —— **系统 Guardrail Skill**，既不是普通业务
Skill，也不是纯内置代码：

| 维度 | 规则 | 我方实现方式 |
|---|---|---|
| 资产归属 | 系统组件，非用户资产 | 放 `resources/guardrail/`，不进 `marketplace/skills/` |
| 能力市场 | **不作为普通可下载 Skill 展示** | 不进 `listSkills()` 目录 |
| 认知树 | 不成为叶片、不计入成长 | 不产生 cognition candidate |
| 用户控制 | **不可删除、关闭或绕过高风险拦截** | 无 enable/disable；EXTREME 无 force |
| KSTAR | 不进入自动改写 | 不在 evolution 候选源内 |
| 可见性 | 「设置 > 安全与信任」看版本/规则时间/回执 | 新增该页（§8.3） |
| 更新 | 签名的软件版本或独立签名规则包 | 随发布内置；规则包独立目录 |
| 失败处理 | 新增/变更的高风险可执行资产 **Fail Closed** | §6.2 表格逐项实现 |

**这解答了「之前作为 skill 装进去不好用」**：按普通 skill 装必然不好用 ——
会被停用、被 KSTAR 改写、出现在市场、长进认知树。安检门被关掉就没有意义。
正确形态是**物理上是 skill 目录（复用 Python 引擎，不移植），但走独立的
系统组件通道**。

---

## 3. 概念对齐

### 3.1 两条状态轴必须拆开

规范 §1.2 要求**安全准入状态**与**资产成熟度**正交，
「页面和接口不得把它们折叠成一个『已通过』」。

我方现状：`SkillListing.security.status` 是单一枚举
`verified | risk | withheld | unchecked` —— **把两条轴压成了一条**。

### 3.2 Receipt 字段对齐

规范 §7.3 `SecurityReceipt` vs 我方现状：

| 规范字段 | 我方 | 处理 |
|---|---|---|
| `scanner_id / version` | `validatorVersion` | 改名 + 补 scanner_id |
| `ruleset_version` | `ruleProfile` | 值改为 sentry ruleset 版本 |
| `risk_level` Low/Medium/High/Unknown | `topLevel` | **重映射**，补 Unknown |
| `findings`（位置/影响/置信度，**脱敏**） | `violationCount`+`topRule` | **需扩展** |
| `permissions_requested` | 无 | 新增 |
| `decision` Pass/Restricted/Blocked/Pending | `pass/risk/blocked` | 补 Pending |
| `expires_at` | 无 | 新增 |
| `revocation_ref` | 无 | 字段先留 |

规范 §4.4 还要求结论绑定
`asset_id + version + payload_hash + dependency_hash + permission_hash + ruleset_version`。
我方当前只绑 `payloadHash + validatorVersion + ruleProfile`，
**缺 dependency_hash 与 permission_hash**。

### 3.3 来源分级（我方完全缺失）

| 来源 | require_isolation | fail_on | human_confirm | 我方映射 |
|---|---|---|---|---|
| official | false | DO_NOT_INSTALL | false | builtin / 官方市场 |
| community | false | CAUTION | false | 第三方市场 |
| thirdparty | true→**按 §1.3 降级** | CAUTION | true | 本地导入 / URL |

默认 `thirdparty`（来源未知按最严处理）。

---

## 4. 实施步骤

### 步骤 1 — 引擎适配层（半天～1 天）

1. 引擎放 `resources/guardrail/skill-sentry/`（只读，随发布内置）
2. 新建 `src/main/features/security/sentry-adapter.ts`：
   - 子进程调 `evaluate_skill`（走 `sandbox/agent_gate.py`，
     它内部已实现「有沙箱走沙箱、无沙箱降级并标注」）
   - 解析 9 字段契约（按 `engine/schemas/report-schema.json`）
   - 超时 / python 缺失 / 非 0 退出 / `status:ERROR` → 全部映射为
     规范 §5.2 的 `Unknown`，**不是** Blocked
3. ⚠️ **关键陷阱（已实测）**：路径不存在时引擎返回
   `status:ERROR` + `DO_NOT_INSTALL` + score 0，**但退出码为 0**。
   若只看 `deployment_recommendation` 会把所有技能判死。
   适配层**必须先判 `status`**，ERROR 一律走 Unknown 分支。
4. ⚠️ 消费 `original_severity` 而非仅 `severity` —— 降权层可被利用
   （恶意代码放 `test/` 可压低严重级），强制拦截路径需看原始级别。

### 步骤 2 — 市场安装门（1 天）

改 `marketplace.ts::_installMarketplaceSkillLocked`（现 933 行 `validateSkillDir` 处）：

1. 落盘到 `target` 后、写 Receipt 前，调 sentry 扫描
2. 按来源分级决定阈值（市场 = community / official）
3. `DO_NOT_INSTALL` → 回滚安装目录 + 持久化报告 + 抛错（沿用现有 `_assertQualityGatePassed` 形态）
4. `CAUTION` → 允许安装，Receipt 记 `Restricted`，UI 出风险卡
5. `Unknown` → **Fail Closed**：不激活，保留草稿态
6. 保留现有 `validateSkillDir` 作为结构兜底，但**风险判定以 sentry 为准**

### 步骤 3 — 已装技能重新审核（半天）

1. `skills.trust.reverify` 改为调 sentry（当前调我方引擎）
2. 二期已做的「重新检查」按钮直接复用，无需改 UI
3. 规则包版本变化 → 旧 Receipt 失效（`ruleset_version` 已在失效判据内）

### 步骤 4 — Quarantine + 导入门（1～1.5 天）

规范 §4.3 要求导入内容**先进隔离区再检查**，§10.1 禁止「先执行后补检查」。

1. `userQuarantineDir(uid)` = `<uid>/local/quarantine/<intake_id>/`
2. 导入落点改为隔离区，检查通过后才 move 到正式位置
3. 隔离区内容：**不进任何列表、不可执行、不渲染宏、不调外链、不注入 Agent**
4. 失败/取消 → 清理隔离区，正式资产零变化

⚠️ 这一步同时覆盖二期遗留的「Quarantine 时间窗」待办
（`_installMarketplaceSkillLocked` 的 validate→rm 窗口）。

### 步骤 5 — 风险分级交互（1 天）

规范 §5.2：

| 结果 | 系统行为 | 用户反馈 | 可选动作 |
|---|---|---|---|
| Low / Pass | 静默放行 + 记 Receipt | 不弹窗 | 查看详情 |
| Medium / Restricted | 不激活，建议限权/修复/隔离 | 弹风险卡 | 减权、移除敏感内容、取消 |
| High / Blocked | 阻断 | 说明风险类型与影响，**不暴露敏感原文** | 删除、导出脱敏报告 |
| Unknown | 可执行资产 **Fail Closed** | 「安全检查暂不可用，已保留为草稿」 | 重试、稍后 |
| Stale | 规则集过期 | 显示过期，未知可执行资产受限 | 更新规则、重扫 |

UI 要点：
- 高风险**无「仍要安装」**（§4.3：普通用户不能覆盖）
- 中风险首版**不提供「永久信任并跳过」**（§4.3）
- 第一页不展示完整扫描日志 / CVE / 内部 Skill 术语，专家详情放抽屉（§8.2）
- `degraded-local` 必须标注，不得表达为「已隔离验证」

### 步骤 6 — 设置 > 安全与信任页（半天）

规范 §8.3：引擎版本、Scanner 状态、规则包版本与更新时间、最近检查/阻断记录、
离线或过期状态、Receipt 导出入口、**无法被普通用户关闭的系统保护说明**。

`skills.trust.list` IPC 已存在但无界面消费，本步一并接上（二期遗留）。

---

## 5. 必须保留的既有决定

二期已验证，重构中**不要丢**：

- `listSkillSpecsForAgentMetadata` **不得**加扣留（它守写路径，
  扣留会导致用户 agent 配置被永久删除）—— 已有反向测试锁定
- 扣留**不拦读**（用户要能看文件改了什么）
- 按 id + frontmatter name 双路径匹配（只按 id 拦不住）
- EXTREME 无 force 覆盖

---

## 6. 验收对照（规范 §11 本期覆盖项）

| ID | 要求 | 步骤 |
|---|---|---|
| SEC-AC-03 | 导入可执行 Skill 首次运行前完成检查 | 4 + 5 |
| SEC-AC-05 | 中风险清楚显示原因/影响/动作 | 5 |
| SEC-AC-06 | 高风险阻断且正式资产零变化 | 2 + 4 |
| SEC-AC-07 | Scanner 不可用 → 草稿 + Fail Closed | 1 + 5 |
| SEC-AC-08 | 版本/依赖/权限变化 → 旧 Receipt 失效 | 3 |
| SEC-AC-09 | 安全通过**不**自动显示「已验证有效」 | 3 |
| SEC-AC-10 | 用户确认**不能**覆盖 Blocked | 5 |
| SEC-AC-13 | 发现密钥 → 日志与 Receipt **脱敏** | 1 |
| SEC-AC-14 | 可看版本状态但**不能停用**保护 | 6 |

不覆盖：SEC-AC-01/02/04/11/12/15。

---

## 7. 遗留风险与诚实边界

1. **漏报率未标定** —— skill-sentry 自己的文档写明：43 个语料以
   Markdown + Python + TS 为主，不含 Go/Rust/Java，**不含真实恶意样本**；
   真阳性率只由合成样本和 8 个对抗用例覆盖。接入它**大幅改善了误报**
   （5/5 ALLOW），**不等于检出能力已被证明**。
2. **完整性检查缺失** —— 本期不接 ECS 3.2，规范 §5.1 的三层表达只实现
   「安全检查」一层。UI 需诚实留白。
3. **降权层可被利用压低严重级** —— 见步骤 1 第 4 点。
4. **`degraded-local` 可信度较低** —— 无 Docker 镜像时非隔离扫描。
5. **Python 依赖** —— 优先用打包解释器，回落系统 `python3`；
   两者都无时按 `Unknown` Fail Closed，不静默放行。
