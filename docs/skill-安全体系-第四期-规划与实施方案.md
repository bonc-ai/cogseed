# Skill 安全体系 第四期 — 规划与实施方案

> 承接：一期（安装门+回执+加载门扣留）、二期（接入面补齐）、三期（skill-sentry 深扫 + NSEAP advisory 对账）。
> 写作时间：2026-08-16。分支 `wujy`，工作区干净。
> 本文所有「已证实」条目都有第一手证据（代码行号 / 实测输出 / git 历史），未证实的标注「待核实」。

---

## 一、现状基线（探索结论摘要）

三期已建成的资产（保持不动）：

| 层 | 资产 |
|---|---|
| 扫描 | skill-sentry 2.1.0 引擎（`resources/guardrail/skill-sentry`，30 文件 git 跟踪）+ 共享判决脚本 `scan_gate.py`（恒 exit 0，stdout JSON；BLOCKING_CATEGORIES 三类；只读 pre-demotion critical） |
| 声明 | nseap-security-core 1.3.0 引擎（74 文件，含 vendored PyYAML）+ `check_all_skills.py` 全库机检（64/64 通过） |
| 适配 | `security/sentry-adapter.ts`（五态 verdict + 本地 25 条红线并集 + 指令审计叠加）、`nseap-core-adapter.ts`（退出码→裁决映射）、`scan-orchestrator.ts`（外部扫描器解析）、`instruction-audit.ts`（确定性召回 + 无工具模型复核，只加码） |
| 账本 | `skill_trust.ts` 回执（payloadHash+validatorVersion+ruleProfile 绑定，`<uid>/local/`）、`skill_reverify.ts` 复验、`scanner_trust.ts` pin 信任 |
| 门 | 市场安装门（最完整）、import-dir 门（质量+深扫+回执）、加载门 6 出口扣留（仅 blocked）、bash/Runtime worker 执行守卫 |
| UI | 安检四态徽章 + 安全面板（score/规则集/隔离/攻击面/指令风险/NSEAP 声明/用户覆盖） |
| 规范 | 内置 skill-creator（`## NSEAP compliance` 强制段 + 9 份参考资料）、`quality/rules/nseap.ts`（9 类 MEDIUM 检查 + 四条守卫机检）、p3394 模块（asset-events 账本、skill-validation-run、skill-invocability 语法验证） |

**本机实测基线（2026-08-16）**：系统 python3 3.9.6 + PyYAML 6.0.3 → 完整规则集；打包解释器 3.12.13 无 PyYAML（nseap 走 vendored，sentry 依赖系统 python）；Docker daemon 未运行且 `scan_gate.py` 进程内直扫——**沙箱层在判决路径上是死代码**；单次扫描 ~0.1s；扫描器自扫 = blocked/score 0（pin 信任的设计依据成立）；nseap fixture PASS；64 平台技能机检全通过。

---

## 二、差距清单（证据编号，按严重度排序）

### P0 — 真实缺陷（bug 级，端到端已断）

- **G1 覆盖（override）IPC 转发断裂**。渲染层 `marketplace.js:2062` 在用户确认后发 `acceptSecurityRisk: true`，但 `ipc/index.ts:3161` 的 `marketplace.installSkill` handler 不解构该字段，主进程 `resolveInstallDecision(scan, consented)` 恒为 `false` →「我了解风险，仍要安装」重试必再失败；回执 `userOverride` 分支不可达。**引入点：`9ae11042`（recall governance 重构）删除了该参数**。
- **G2 两个 IPC 通道被删除**。`skills.trust.reverify` / `skills.trust.list` 在 `ipc/index.ts` 零注册；渲染层 `skills.js:2845`「重新检查」按钮调死通道（结果被 try/catch 吞掉）。同一提交 `9ae11042` 删除。
- **G3 19 个 locale key 缺失**。`skills.secpanel_nseap`+6 子键、`skills.edit_nseap_precheck_*`、`skills.import_review_*` 在 zh/en/ja/pt 四语言包均无 → UI 回显裸 key（zh.json 缺失已证实）。
- **G4 agent 安装无深度扫描**。`marketplace.installAgent` 只过 quality 门，无 `scanSkillDir`——agent 包内的私有 skill 与脚本不受深扫。
- **G5 文档数字漂移**。`sentry-adapter.ts:287`、`skill_reverify.ts:233` 注释写"21 条规则"，实际 `RED_FLAGS` 25 条（22 EXTREME + 3 MEDIUM）。

### P1 — 规范/体系缺口

- **G6 Quarantine 隔离区未做**（二期第 5 步、三期步骤 4 均未落地）。安装仍解压到最终位置、失败再 `rm -rf`，存在"恶意内容留在正式位置"的窗口。同时卡住 SEC-AC-03/06/07 三条验收。二期文档已确认可行性：tree hash 路径无关；staging 需同文件系统、命名避开 `test/vendor` 降权词、boot_init 清理、loader 跳过。
- **G7 reconcile 路径无安装门**。`marketplace_reconcile.ts` 中 `validateSkillDir`/`scanSkillDir`/`writeReceipt` 出现次数 = 0；云端同步拉取的 skill 只查 SKILL.md 存在即安装，靠加载门 fail-open 兜底。倾向 fail-closed + 留痕（二期 §5 已论证）。
- **G8 私有（agent）skill 双门全缺**。`skill-registry.ts:964` 注释明写"NOT trust-withheld yet，传 _withholdUntrustedSpecs 会验错对象"；回执 key 需 `(agentId, skillId)` 区分（二期 step 3b）。
- **G9 自生成路径无生成门**。`createCustomSkill` 直接写 `status:'approved'` 零扫描；四条调用路径（用户自建、onboarding Claude/Codex 导入、recall 草稿落地、URL 导入占位）均无 dir 级校验、无 deep scan、无 receipt。`matrix.test.ts` 六组矩阵也不含这两条入口（测试纪律缺口）。规范 §4.2 要求"保存为正式资产的动作必须禁用，直到检查通过"。
- **G10 restricted 语义与规范冲突**。规范 §5.2：Medium「不激活+弹风险卡」；现状：`restricted` 直接放行，只落 `status:risk` 徽章，不弹卡不限制。
- **G11 覆盖语义与规范冲突**（产品决策）。`scanVerdictAllowsOverride` 对一切拒绝（含 `unknown` 扫描器故障）返回 true；规范 §4.3/SEC-AC-06 要求高风险普通用户不可覆盖。当前产品决策是"用户拥有最终决定权"，需显式拍板并落到文案与测试。
- **G12 Receipt 缺 dependency_hash / permission_hash**（卡 SEC-AC-08）。规范 §4.4 要求结论绑定 `asset_id+version+payload_hash+dependency_hash+permission_hash+ruleset_version`；现只有 payloadHash+validatorVersion+ruleProfile。技能版本快照（`skills/version-store.ts`）与回执无耦合。
- **G13 安全与信任设置页缺失**。设置页签仅 data/credentials/account/usage/general（`index.html:1003-1008` 已证实）；规范 §8.3 要求版本/规则时间/回执/导出入口。（注：状态轴已分离——`security.status` 四态与 `maturity` 五档在 renderer 独立渲染，`skills.js:1764/1823` 已证实；三期文档 §3.1 的"压成单轴"自述是历史状态。）
- **G14 Docker 沙箱死代码**。`scan_gate.py` 直接 `import engine.scanner_core.report` 进程内扫，不经过 `sandbox/agent_gate.py`；`isolated` 恒 false。威胁模型（扫描器输入是攻击者内容）与 skill-sentry 自身的 `require_isolation` 策略均未生效。
- **G15 规则包更新通道与 PyYAML 脆弱性**。规则包随 release 内置，无独立签名更新（规范 §9.2 Should）；打包解释器无 PyYAML，无系统 python 的机器 sentry 静默降级（实测凭证外传样本 ALLOW/100）。
- **G16 上游测试未随 vendored 进仓库**。skill-sentry 的 tests/（20 文件）与 runtime_trust/tests/ 未带入 → SKILL.md 声称的回归/单元测试在仓库内不可执行，是最大隐藏漂移窗口；`run-python-tests.mjs` 不扫 guardrail。
- **G17 冻结点未定**。freeze/FORMAL_TEST 链路无调用方（HANDOFF §6）；"上架 marketplace = 冻结点"是候选答案，需产品确认。
- **G18 风险五维派生停用**（上游主动关闭）。SEC-ACTION-001（不可逆操作审批）等最强规则不生效；是否复用以 L0-L5 对齐决策为前提。

---

## 三、实施方案（工作包）

### W0 修复线（P0，先做，全部有回归测试锁）

1. **G1**：`marketplace.installSkill/installAgent` handler 恢复解构并转发 `acceptSecurityRisk`；`override.test.ts` 增加"IPC 契约"级测试（对 handler 的参数形状断言，防重构再丢）。**测试先行：先写会失败的契约测试，再修 handler。**
2. **G2**：重新注册 `skills.trust.reverify`（参数校验 → `reverifySkillDeep` → 返回四态）与 `skills.trust.list`（`listReceipts` 脱敏视图）；渲染层调用处去除吞错改为上报。
3. **G3**：补 19 个 locale key（zh 为准，en/ja/pt 补齐）。
4. **G4**：agent 安装门补 `scanSkillDir`（agent 包内 skill 子目录逐目录扫，沿用 marketplace skill 门的来源分级），失败回滚同 skill 门。
5. **G5**：注释改为引用 `RED_FLAGS.length` 或写"25 条"，消除数字漂移。

### W1 生成门统一（G9 + 部分 G13）——本期核心

目标：五条生成路径（自建 / onboarding 导入 / recall 草稿 / URL 导入 / 目录导入）与外部导入同标准：**NSEAP 骨架 + deep scan + 回执，`approved` 之前完成**。

1. `ensureNseapSkillSkeleton` 推广到 `createCustomSkill`（新增可选参数 `generateNseapSkeleton: boolean`，模型生成/onboarding/recall 路径传 true；纯 UI 空壳创建可不生成，但首次写入内容时补齐）。
2. 新增共享函数 `finalizeCustomSkillAdmission(uid, skillDir)`：`validateSkillDir` → `scanSkillDir(dir, 'community')` → `writeInstallReceipt`；`blocked` → 状态改 `draft`（新增状态，或复用候选态）+ 返回拒绝原因；`restricted/unknown` → 记回执并标 `pending` 徽章。
3. recall 草稿落地（`skill-draft-service.confirmRecallSkillDraft`）与 onboarding 导入（`session_import/skill-import.ts`）在写入完成后调 `finalizeCustomSkillAdmission`；失败 → 草稿保留 + UI 提示，不写 `installed`。
4. URL 导入占位草稿：进入编辑会话首次落内容时同样触发。
5. NSEAP 形状检查升级：**生成路径上 `nseap_*` 规则从 MEDIUM 升为阻断级**（`finalizeCustomSkillAdmission` 传 `escalateNseap: true`）；marketplace 安装保持 MEDIUM 不阻断（存量兼容）。
6. `matrix.test.ts` 补两行：onboarding 导入、recall 草稿。

验收：五条路径的 E2E 测试各 1 条（clean skill → approved+回执；恶意 payload → 拒绝且不 approved）；SEC-AC-02 落地。UI 侧消费现成的 `skills.security_import_*` 文案（scanning/passed/restricted/degraded/blocked_body，目前死文案无消费点）呈现"检查中→结果"。

### W2 Quarantine 隔离区（G6）

按二期 §5 已验证方案实施：`_installMarketplaceSkillLocked` 改「解压到 `<uid>/local/marketplace/skills/.staging-<random>` → 两道门 → `rename` 到最终位置（旧的先 rename 到 `.trash-<random>`）；boot_init 启动清理 staging/trash；loader 与 tree-hash skip 名单确认跳过 staging」。命名避降权词的测试锁一条。

### W3 reconcile + 私有 skill 安装门（G7/G8）

1. `marketplace_reconcile.ts::_pullSkillLocked` 在 SKILL.md 检查后补 `validateSkillDir + scanSkillDir + writeReceipt`（fail-closed：拒绝则删本地副本、写 blocked 回执、log.warn、UI 可见"云端同步的技能未通过本机安检"）。
2. 私有 skill：安装/解压后逐目录扫；回执 key 改为 `(agentId, skillId)` 前缀（`skill_trust._receiptFile` 规则扩展，旧 key 缺失即重扫天然兼容，配测试）；`skill-registry.ts:964` 私有分支接入 `partitionSkillsByTrustDeep`（先修目录解析映射）。

### W4 回执扩展（G12）

`SecurityReceipt` 增 `dependencyHash`（从 SKILL.md 声明段 + 依赖清单文件规范化哈希）与 `permissionHash`（`schemas.json.runtime_contracts` 规范化哈希，无 schema 时为常量空值）；`isReceiptStale` 增两因。KSTAR 新版本落库（version-store 写入点）时写入新回执。

### W5 交互与页面（G10/G11/G13）

1. `restricted` 语义：安装放行但**安装后卡片出现"受限"风险卡**（列出的规则级文案已具备），并把规范 §5.2 的「减少权限→重新检查」作为卡上动作（调 `skills.trust.reverify`，W0 修好后可用）。
2. 覆盖语义（G11，需产品拍板）：方案 A 维持现状（一切可覆盖，UI 措辞保持最严档）；方案 B 对齐规范（`hardBlocked` 恢复绝对阻断，`unknown` 不可覆盖只可重试/草稿）。倾向 B + 开发者模式例外留审计，落地到 `resolveInstallDecision` + override 测试。附注：UI 的 `override_final`（"这类问题无法跳过"）分支当前因 `overridable` 恒真而**不可达**，方案 B 落地后该分支自然复活，文案已就绪。
3. 新增「设置 > 安全与信任」页签：Guardrail 引擎版本、Scanner 状态（present/absent/broken + 完整性状态）、规则包版本与更新时间、最近检查/阻断记录（读 `skills.trust.list`）、Receipt 导出（脱敏）、"无法被普通用户关闭"说明。消费 W0 恢复的 IPC。
4. 状态补充：`security.status` 增加 `pending`（扫描未完成/不可用时的草稿态，与 G13 的 unknown 草稿流配套）；成熟度轴已独立存在（`maturity` 五档），不改。

### W6 运行时加固（G14/G15）

1. 沙箱路径决策（与产品确认后二选一）：
   - 方案 A：`scan_gate.py` 恢复经 `agent_gate.evaluate_skill`（有 Docker 镜像走隔离，无镜像 degraded-local）——恢复上游完整语义；
   - 方案 B：明确接受进程内直扫，理由 = 引擎只读文件不执行被测代码，残余风险（zip 炸弹/解析器漏洞）用现有 60s 超时 + 子进程级内存/输出上限兜底——需补子进程资源限制实现。
2. PyYAML 固化：把 vendored PyYAML 复制进 bundled runtime 的 site-packages 路径或 sentry 引擎侧建 `vendor/yaml`（与 nseap 同法），`sentry-adapter.resolvePython` 探测时把该目录加进 `PYTHONPATH` → 消灭"装了什么 python 才有什么规则"的机器差异。

### W7 上游同步与测试纪律（G16）

1. 把 skill-sentry 上游 `tests/`（20 文件：conformance 回归向量 + 对抗/上下文 fixtures + 145 单元用例源）与 `runtime_trust/tests/`（2 文件）带入 vendored 树，`run-python-tests.mjs` 增加 guardrail 扫描（或独立 `npm run test:guardrail`）；`docs/` 8 文件一并带入（可读性/溯源）。
2. pin 重生成入 CI：改 `resources/guardrail/*` 后 `pin-scanner-integrity.mjs --check` 失败即红。
3. 建立"上游→仓库"同步清单（skill-sentry 与 nseap 各一份 SYNC.md）：源路径、排除项（nseap 的 `.gitignore`/`__pycache__`）、**仓库自有超集**（nseap 的 `vendor/` + `SKILL.md` 必须 merge 保留、禁止 replace 覆盖——引擎硬依赖 vendor/yaml，SKILL.md 含"派生已停用/冻结无触发点"平台约定）、同步后必跑命令（conformance + pin 重生成 + `matrix.test.ts`）。
4. 双裁决语义复核：`scan_gate.py`（平台策略层：BLOCKING_CATEGORIES + original_severity==critical）与上游 `agent_gate.py`（RECOMMENDATION_TO_VERDICT）并存，上游改 recommendation 语义时需同步复核 `restricted` 分支——列入同步清单检查项。
5. 打包契约保持：`package.json` extraResources `guardrail` + `bin/packaged-resource-gate.cjs` 的 `guardrail-scanner-contract` + `matrix.test.ts`（已锁 extraResources 必须含 guardrail）不得随开源剥离脚本改动。

---

## 四、分期与优先级

| 期 | 内容 | 量级 | 解锁 |
|---|---|---|---|
| **P0（立即）** | W0 全项 | 1–2 天 | 覆盖流复活、重扫按钮复活、UI 文案正常、agent 深扫 |
| **P1（本期核心）** | W1 生成门 + W2 Quarantine + W3 双门 | 3–5 天 | 自生成/同步/私有 skill 全部纳入安检；SEC-AC-02/03/06/07 |
| **P2（本期收尾）** | W5（含产品决策 G11）+ W4 回执扩展 | 2–3 天 | SEC-AC-05/08/10、§8.3 页面、状态轴拆分 |
| **P3（下期）** | W6 沙箱/PyYAML + W7 同步纪律 | 2–3 天 | 降级面收敛、漂移窗口关闭 |

**决策项（D1 已决议；D2-D6 建议以体验优先，待确认）**：

- **D1 覆盖语义 —— ✅ 已决议：可覆盖**（2026-08-16）。维持现状：扫描层一切拒绝均可由用户显式覆盖（用户拥有机器最终决定权），`userOverride` 记入回执长期可见。W0 已修复该流程的 IPC 断裂，端到端可用。SEC-AC-10 保持"部分实现"口径；UI 的 `override_final` 分支继续不可达属预期状态。
- **D2 冻结点 —— 建议：发布侧 CI，客户端不接**。freeze/FORMAL_TEST 的仪式（只读快照、摘要一致性）为发布流水线设计；CogSeed 客户端"随时保存"没有冻结点，硬造只会加无谓摩擦。上架 marketplace = 天然冻结点，把编排器放发布侧 CI，客户端维持 advisory 对账（现状）。零用户面影响。
- **D3 L0-L5 分级 —— 建议：保持停用**。五维派生的价值在"按风险等级配审批人数"，而审批矩阵是治理设计不是代码；单用户桌面场景里 HITL 已有 preview→confirm→execute 契约承载。半设计的审批矩阵只会凭空加确认弹窗。未来若做多审批人场景，借用 Trust Graph 的 quorum 概念（N 人互异、禁止自批）即可，不必复活整机引擎。
- **D4 沙箱 —— 建议：维持进程内直扫 + 可选资源限制，不引入 Docker**。引擎只读文件、从不执行被测代码；zip 炸弹已在解压层防住。接入 Docker 会让用户面对"需要 Docker/镜像缺失"的失败面，违背零依赖体验。可选的加固是给扫描子进程加内存/输出上限（对用户完全无感），不恢复 agent_gate 热路径。
- **D5 规则包更新 —— 建议：随 release，不建独立通道**。独立签名包带来第二套更新机制与失败面；桌面应用威胁模型（第三方技能）下，规则随 release 升级 + 既有 ruleset_version 失效重扫机制已够用，用户零感知。独立签名通道与 D3 一样归入未来企业档。
- **D6 KSTAR 新版本回执 —— 建议：复用 W1 准入，后台写回执，失败不阻断保存**。加载门的 payload_changed 已在首次使用时兜底（安全不缺失）；在版本写入点复用 `admitCustomSkill` 后台跑一次，把"新版本有新回执"前移且徽章诚实，保存动作本身永不被安检失败卡住。SEC-AC-15 由此落地。

---

## 五、验收标准

### 回归基线

```bash
npm run typecheck
node scripts/run-tests.mjs run test/main/quality test/main/features/security \
  test/main/features/skill-trust.test.ts test/main/features/scanner-trust.test.ts \
  test/main/features/cognition-gate.test.ts test/main/features/cognition-semantic-review.test.ts
node scripts/run-tests.mjs run test/main test/renderer   # 改动 IPC/registry/reconcile 后必跑
python3 resources/guardrail/scan_gate.py resources/guardrail/skill-sentry <任一内置技能>  # 手工冒烟
```

### 规范验收映射（SEC-AC，本期目标）

| 验收 | 本期 | 对应 |
|---|---|---|
| SEC-AC-02 沉淀候选审查前完成 3.2+3.3 | ✅ | W1 |
| SEC-AC-03 导入可执行 Skill 首运行前检查 | ✅ | W2+W1 |
| SEC-AC-05 中风险原因/影响/动作清楚 | ✅ | W5.1 |
| SEC-AC-06 高风险阻断且正式资产零变化 | ✅ | W2+W3+D1 |
| SEC-AC-07 Scanner 不可用 → 草稿 Fail Closed | ✅ | W1+W5.2 |
| SEC-AC-08 版本/依赖/权限变化 → 旧回执失效 | ✅ | W4 |
| SEC-AC-09 安全通过不显示"已验证有效" | 已实现，回归保持 | 两轴独立渲染（skills.js:1764/1823） |
| SEC-AC-10 用户确认不能覆盖 Blocked | 部分→依 D1 | 质量层 EXTREME 无 force 已成立；扫描层 `scanVerdictAllowsOverride` 现对 blocked/unknown 均返回 true（sentry-adapter.ts:122-129），是否收紧待 D1 |
| SEC-AC-13 密钥脱敏 | 已有，回归保持 | — |
| SEC-AC-14 可看版本状态不能停用 | ✅ | W5.3 |
| SEC-AC-15 KSTAR 新版本重检 | ✅ | W4+D6 |

范围外不承诺：SEC-AC-01（官方资产签名验签）、04（非 Skill 资产）、11（撤回运营）、12（企业联邦）。

---

## 六、明确不做

- 不移植 skill-sentry 规则进 TS；不改写 nseap 引擎；不新增自建规则库（语料缺失，Go/Rust/Java 规则仍不验证）。
- 不在客户端启用 freeze/FORMAL_TEST 正式门（等 D2）；不恢复风险五维派生（等 D3）。
- 不引入 Trust Graph 内核（威胁模型错位，见探索结论）。
- 不把「安全通过」渲染成「已验证有效」；不承诺检出率数字（漏报率仍无真实恶意语料标定）。

---

## 七、证据索引（节选，全文见探索报告）

- 覆盖断裂：`ipc/index.ts:3161`（handler 无 acceptSecurityRisk）vs `marketplace.js:2062`（发送）；引入点 `git show 9ae11042`。
- 死通道：`skills.js:2845` 调用 `skills.trust.reverify`；`ipc/index.ts` grep 零注册；删除于同一提交。
- reconcile 无门：`marketplace_reconcile.ts` 中三函数 grep 计数 = 0。
- 私有 skill 无门：`skill-registry.ts:964` 注释。
- 自生成无门：`skills.ts:1337-1372`（createCustomSkill 直写 approved）、`session_import/skill-import.ts`、`recall/skill-draft-service.ts:960-1027`。
- 沙箱死代码：`scan_gate.py:126-137`（直接 import engine 扫描）。
- PyYAML 实测：打包 python 3.12.13 `import yaml` → ModuleNotFoundError；系统 python 3.9.6 → 6.0.3。
- 上游对比（`diff -rq` 实测）：两引擎共享文件字节一致、无规则漂移；skill-sentry vendored 为严格子集（缺 tests/ 20 文件、runtime_trust/tests/ 2、docs/ 8）；nseap vendored 多 `vendor/`+`SKILL.md`（仓库自有加固，同步须 merge 非 replace）。
- 打包：guardrail 不进 `_manifest.json`，走 `package.json` extraResources；`bin/packaged-resource-gate.cjs` 有 `guardrail-scanner-contract`；`matrix.test.ts` 锁 extraResources。
- `run-python-tests.mjs` 覆盖 resources/builtin + resources/test，不扫 guardrail；`bundledPythonExecutable` 支持 `COGSEED_BUNDLED_PYTHON/COGSEED_PYTHON` 环境覆盖。
- `check_all_skills.py` 只做 NSEAP 结构合规（6 项机检），不检恶意代码——与 skill-sentry 两套门不可互相替代。
- 守卫 64/64：实测脚本输出（HANDOFF §8.0 的 stash 问题已随 `e56749d0` 解决，无遗留）。

---

## 执行日志（W0 完成，2026-08-16）

- **G1** ✅ 恢复 `marketplace.installSkill/installAgent` 的 `acceptSecurityRisk` 转发；并修复同一断裂链的下一环：`securityBlocked/securityUnavailable/securityOverridable/securityScan/securityRuleIds` 五个字段此前在 `_wrapMarketplaceInstallError` → `getMarketplaceInstallErrorInfo` → IPC 响应三层全部被丢弃，渲染层风险卡永远无法触发——三层全部补齐。
- **G2** ✅ 重新注册 `skills.trust.reverify`（→`reverifySkillDeep`，isValidSkillId 校验）与 `skills.trust.list`（→`listReceipts`）。
- **G3** ✅ 补齐 18 个缺失 key（secpanel_nseap×7、edit_nseap_precheck×4、import_review×7）到 zh/en/ja/pt 四语言包（比子任务报告的 19 少 1，以实测 diff 为准）。
- **G4** ✅ agent 安装门：私有 skill bundle 解压后逐个 `scanSkillDir`（来源分级 create_uid==='0'→official），blocked/unknown → 回滚整个 agent 安装 + 抛带 security 字段的错误；私有 skill 回执刻意不写（key 需 (agentId,skillId)，属 W3）。
- **G5** ✅ 修正 sentry-adapter "21 条"注释 → 25 条。
- **契约测试**：新增 `test/main/ipc/security-trust-ipc.test.ts`（9 用例：转发/死通道/错误字段传播/无效 id 拒绝），修复前 8 失败、修复后 9/9。
- **回归**：typecheck 干净；security 子集 221/221；ipc+quality 355/356（唯一失败 `hub-account.logout` 为 HEAD 提交 `214c60ca` 引入的预存在测试漂移，与本轮无关，单跑同样失败）。

### 执行日志（W1 完成，2026-08-16）

- **新模块** `src/main/features/security/custom-skill-admission.ts`：生成路径共享准入（本地红线 → deep scan 只判作者内容 → NSEAP skeleton 补缺 → 升级的 NSEAP 形状复检 → 最终树回执）。关键取舍：
  - skeleton 在扫描**之后**生成（防模板稀释裁决，沿用导入路径实测结论）；
  - NSEAP 升级白名单 8 条可行动规则；`staged_ceiling`/`production_lock`/`compliance_tier` 排除（声明在 skill-spec.yaml，TS 形状检查不读该文件——升级会全库误伤）；
  - blocked/unknown 不写回执，加载门在首次使用时重试。
- **三条路径接入**：commander `<skill>` 容器创建（blocked → 删半成品 + 结构化拒绝；unknown → 保留 + securityUnavailable 标记）、onboarding Claude/Codex 导入（blocked/unknown → 回滚 + reason）、recall 草稿落地（blocked/unknown → 抛错走既有回滚；新增 admit 测试缝，单测注入 stub 不 spawn Python）。
- **URL 导入**：占位草稿为空壳，内容经编辑会话逐文件落盘，无显式收尾点——由加载门（已验证覆盖 custom）在首次使用时 deep 复验兜底；显式准入待后续定收尾点。
- **测试**：新增 custom-skill-admission.test.ts（7 用例）+ matrix Row 7（生成准入 2 用例，与共享 gate 对齐）；回归：typecheck 干净、security 子集 392/392、bus+recall 546/546、matrix 23/23。

### 执行日志（W1 修订 + W2 完成，2026-08-16）

- **W1 修订（回答"会不会限制生成能力"）**：NSEAP 形状升级改为 **opt-in**（`admitCustomSkill(uid, skillId, { escalateNseap })`）。只有 commander 路径（skill-creator 契约承诺 trigger 语义）开启；Claude/Codex onboarding、recall 蒸馏方法等源保真导入默认 advisory——否则每个外来技能都会被打 risk 徽章（徽章通胀 = 无徽章）。新增测试锁"默认不升级"。能力守恒原则：回执从不剥夺能力，加载门只扣 blocked，最坏情况是多一个徽章而非生成不出来。
- **W2 Quarantine 完成**：`_installMarketplaceSkillLocked` 改为 staging→gate→promote：
  - 解压/复制到 `.staging-<hex>`（同文件系统、点前缀全枚举路径不可见、命名避开降权词——`quarantineStagingName` 导出 + 测试锁 hex 域）；
  - 两道门全过 → 旧安装先 rename 到 `.trash-<hex>` → staging rename 到最终位置 → 删 trash；
  - 拒绝/异常 → 只删 staging，**最终位置从未被触碰**——新属性：毒更新不再摧毁旧安装（旧流程是先 rm target 再扫，被拒后用户一无所有）；
  - 启动清理 `cleanupOrphanedStagingDirs` 挂 `registerDeferred('marketplace:cleanup-staging')`。
  - 测试：`marketplace-quarantine.test.ts` 3 用例（clean 无残留 / 毒更新保旧装 / 命名域）。
- 回归：typecheck 干净；W0+W1+W2 相关 18 文件 410/410。

### 执行日志（W3 完成，2026-08-16）

- **W3a reconcile 安装门（UX-first）**：`_pullSkillLocked` 在解压后跑 `validateSkillDir + scanSkillDir`，但**拒绝绝不删除内容**——用户是在另一台设备通过同一安检流装的，同步路径静默删库是惩罚用户。拒绝 → 写 `blocked` 回执（加载门据此扣留，卡片可见可解释可重查）；`unknown` → 不写回执（加载门首次使用重试）；通过 → 与安装路径同形态回执。新增 2 个 reconcile gate 测试（clean 回执 / 毒包保留+blocked 回执+加载门扣留）。
- **W3b 私有 agent skill 回执与加载门**：
  - `skill_trust` 回执 key 扩展 `(agentId, skillId)`（文件名 `agentId__skillId.json`），read/write/stale/delete 加可选 agentId，`listReceipts` 排除私有回执；
  - `skill_reverify` 抽出 `_reverifyDeep` 共享体，新增 `reverifyAgentPrivateSkillDeep` / `partitionAgentPrivateSkillsByTrustDeep`（私有目录解析 + 私有 key，fail-open 同公开路径）；
  - registry 私有分支接入扣留（只扣 blocked）；
  - agent 安装（G4）同步写 `(agentId, skillId)` 回执。
  - 新增 `skill-trust-private.test.ts` 4 用例：命名空间隔离、私有回执不入公共列表、篡改扣留、**同名影子测试**（公开树 clean pass + 私有树独立 blocked，证明不再验错字节）。
- 回归：typecheck 干净；W3 相关 24 文件 590/590 全绿。

### 执行日志（W4 完成，2026-08-16）

- **W4 回执扩展（UX-first 版本）**：`SecurityReceipt` 增 `dependencyHash` / `permissionHash` 两个**纯证据字段**：
  - `currentDependencyHash`：SKILL.md "External dependencies" 声明段 + 依赖清单文件（requirements.txt/package.json/pyproject.toml 等 15 类，有界读取）的稳定哈希；
  - `currentPermissionHash`：`schemas.json.runtime_contracts` 深度键排序稳定序列化哈希，无 schema 时为常量 `'none'`（区别值，永不假匹配）。
  - **刻意不加 staleness 分支**：payload 树哈希已覆盖同一批字节（`payload_changed` 先触发），加第二道门是伪复杂度和无谓重扫。字段只用于规范 §4.4 绑定与回执导出审计——**零新增提醒、零新增重扫、零生成影响**。
  - `writeInstallReceipt` 增 `skillDir` 尾参自动计算，5 个调用点（安装/导入/准入/reconcile/私有技能）全部带上。
- 测试：`skill-trust-hashes.test.ts` 3 用例（键序稳定性与 none 常量 / 依赖维度敏感而散文不敏感 / 新字段往返）。
- 回归：typecheck 干净；W4 相关 17 文件 388/388 全绿。

### 执行日志（W5 完成，2026-08-16）

- **W5① restricted 轻提示**：安装成功但 restricted 时，`installMarketplaceSkill` 在成功响应中附带 `securityScan`，渲染层弹**一条** 8 秒自动消失的非阻塞 toast（`uiToast` warning，复用现成文案）。无新对话框——完整风险卡仍在技能安全面板，避免"每次安装都点掉一个弹窗"的打扰面。
- **W5② 导入复核安检行**：自定义导入的复核对话框现在消费 `skills.security_import_restricted/degraded`（此前是死文案），restricted/degraded 各加一行静默说明。
- **W5③ 安全与信任设置页**：新页签（index.html + settings_tabs 兼容），懒加载模块 `settings-security.js`：
  - 扫描器可用性（present/absent_by_build/broken）+ 树哈希完整性（verified/tampered/unpinned/unreadable，含"未通过时怎么办"的说明）；
  - sentry 引擎/规则包版本、NSEAP 引擎版本与完整性；
  - 最近 20 条检查回执（结论/评分/时间）+ **脱敏回执导出**（只导 id/结论/时间/分数/攻击面计数/哈希——回执本就不含匹配原文）；
  - "系统保护不可关闭"说明 + 刷新按钮。
  - 新 IPC `skills.security.status`（组合 scanner_trust/nseap-core-adapter/sentry-adapter 的现有完整性源，`guardrail-status.ts` 无自有逻辑）。
- 四语言 locale 新增 37 key（settings.security.*）。
- 测试：security-trust-ipc 契约 +1（status 快照形状）。回归：typecheck 干净，W5 相关 19 文件 434/434。

### 执行日志（W6/W7 完成，2026-08-16）

- **W6 PyYAML 固化**：`resources/guardrail/skill-sentry/vendor/yaml/`（从 nseap 同源复制 PyYAML 6.0.3 纯 Python 版 + LICENSE，252K）。sentry-adapter 探测与运行均注入 `PYTHONPATH=vendor`。实测：打包 CPython 3.12.13（原本无 yaml）现在直接加载完整规则集（`rules_source: ruleset v1.0.0: ...`）——**机器间规则覆盖差异清零**。pin 已用 `node --import tsx scripts/pin-scanner-integrity.mjs` 重生成（gitignored，发布时打包流程再生成）。沙箱路径（D4）维持现状并在方案文档记录为决策项，不投机加固。
- **W7 上游测试进仓**：上游 skill-sentry `tests/`（20 文件）+ `runtime_trust/tests/`（2 文件）复制到 `resources/test/skill-sentry/`（不进发布树），三处 repo shim（conftest sys.path + collect_ignore fixtures + RUNTIME_TRUST_DIR 路径），**153/153 全绿**（`python3 -m pytest` 与 `run-python-tests.mjs` 双路径）。`npm run test:resources` 默认覆盖 resources/test，自动纳入。
- **SYNC.md**：`resources/guardrail/SYNC.md` 同步清单——merge 不 replace、两引擎的仓库自有加固件清单、repo shim 说明、同步后必跑命令、打包契约与有意不接清单。
- 回归：typecheck 干净；W6/W7 相关 16 文件 244/244；全量 test/main 后台跑通（结果见会话记录，预存在 11 失败与 HEAD 一致）。

---

## 总体状态（四期全部工作包完成）

W0-W7 全部落地，决策项 D1-D6 留待产品/安全拍板（文档 §四）。四期执行原则沉淀：**安全是兜底的网不是筛子——拒绝绝不删用户内容（W3 reconcile 保内容写 blocked 回执、W2 毒更新不毁旧装）、基础设施故障不惩罚用户（unknown 保留+重试）、提醒只加必要信息（W5 restricted 单条 toast、W4 零新增提醒）、生成能力不受限（W1 NSEAP 升级 opt-in 仅 commander、回执从不剥夺能力）。**

### 执行日志（D6 + D4 落地，2026-08-16）

- **D6 KSTAR/编辑版本回执**：`_applySkillContainerEdit`（commander 批量编辑提交点）在编辑成功后后台跑 `admitCustomSkill(..., { recordBlockedReceipt: true })`。UX-first 契约与 reconcile 同款：拒绝**永不删改用户内容**——写 blocked 回执让加载门首次使用时扣留，响应携带 `securityBlocked` 供 commander 一句提示；形状升级对编辑保持关闭（源保真）。`admitCustomSkill` 新增 `recordBlockedReceipt` 选项（内联无状态，无并发风险）。测试用 `tests/` 降权载荷验证全链路（逐文件校验放行 → 整树准入拦截 → blocked 回执 → 内容保留），并确认根目录恶意文件在**逐文件写入校验层就被拒绝**（比预期更早的防线）。
- **D4 扫描资源限制（不引入 Docker）**：`scan_gate.py` 顶部 POSIX `RLIMIT_AS` 512MiB 守卫（Windows 跳过，60s 超时兜底）；sentry-adapter 输出积累上限（stdout 8MiB / stderr 1MiB，溢出=unknown 杀进程）。均对用户无感。
- **真实验证**：`npm run smoke` OK（主进程模块图完整加载）；restart 脚本启动的应用在**本会话沙箱内**被 Electron 自身 sandbox 初始化拒绝（`sandbox initialization failed: Operation not permitted` + 日志 EPERM）——环境限制而非代码回归，需用户侧 `./run.sh` 正常启动确认。
- 回归：typecheck 干净；D6/D4 相关 19 文件 445/445；vendored python 套件 153/153。

### 执行日志（安全与信任页 v2 UI，2026-08-16）

- **设计稿**：`docs/design/security-settings-ui-draft.html`（自包含，可浏览器打开，右上角三态预览）。四层结构：Hero 总览卡（一眼绿勾 + 关键版本数字）→ 组件三卡片（扫描器/深扫引擎/完整性引擎，异常态附"怎么办"）→ 记录表（徽章 + 评分条 + 最近 10 条可展开）→ 操作区 + 弱化保护说明。
- **新增"单独检查一个 skill"**：记录表每行"重新检查"按钮（行内"检查中…"状态 → `skills.trust.reverify` → 就地刷新）；"检查指定技能…"按钮展开可搜索选择器（输入过滤已安装技能 → 点击检查）。
- **实现**：`settings-security.js` 重写为 v2（约 400 行，vanilla，无 emoji 图标），CSS 追加 `.sec-*` 系列（复用应用设计 token），四语言新增 29 key。脚本按应用惯例移入 `lazy-features.js` 的 settings 懒加载 bundle（并从 index.html 移除静态标签）；同步修正 lazy-features 测试期望（含预存在缺失的 hub-account.js）。
- 回归：typecheck 干净；相关 12 文件 175/176——唯一失败 `lazy-features` 的 spaces 用例为预存在（manifest 缺 spaces key，与本次无关）；其余 renderer 预存在失败经 stash 归因确认。

### 执行日志（导入检查结果统一弹窗，2026-08-16）

- **设计稿**：`docs/design/import-check-modal-draft.html`（五态切换预览 + 按 U 键切换文件夹/URL 来源徽章）。经用户确认后实现。
- **实现**：新模块 `renderer/modules/import-check-modal.js`（`window.showImportCheckResult`，五态：检查中/通过/有提示/已拦截/不可用；发现列表白话+位置、不展示原文；已拦截无"强制安装"仅导出脱敏报告；底部"安全通过 ≠ 已验证有效"）。CSS `.imp-*` 系列、四语言 28 key（import_check.*）、模块挂入 skills 懒加载 bundle（先于 skills.js）。
- **接线**：
  - 文件夹导入成功 → 弹窗（pass/risk/unavailable 三态，[完成/查看技能][保留/重新检查/删除][保留为草稿/重试]；删除则不进详情页）；拒绝 → 原 showValidationReport 换成统一弹窗 blocked/unavailable 态（发现来自质量报告）。
  - URL 导入 → 首次内容落盘（onFinal 首次 written/created）触发 `skills.admit`（新增 IPC，跑准入 gate、source-preserving 不写拒绝回执）→ 弹同一弹窗，仅一次。
  - `skills.createFromDir` IPC 成功分支补转发 securityPass/securityScan 证据（此前被丢弃）。
- 回归：typecheck 干净；相关 14 文件 224/227——3 个失败均为已归因预存在（spaces、skills-frontmatter×2），零新增。
