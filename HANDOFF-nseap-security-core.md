# 交接文档 — NSEAP/ECS 安全引擎接入

**分支** `wujy` ｜ **基线** `8435c93` ｜ **状态** 未提交，全部改动在工作区

---

## 1. 这一轮做了什么

把 `security-skills`（ECS Security 3.1/3.2 实现）接进 CogSeed，形态是**平台组件 + Python 子进程**，判决权留在 TS 侧。

已接通的链路：Skill 重验时会跑一次"声明 vs 实际"对账，结果写入信任回执，**仅提示，不改变判决**。

**未接通**：冻结 / FORMAL_TEST 全流程。引擎能跑但没有调用方，原因见 §6。

---

## 2. 来源文件（外部）

源目录：`/Users/wu.j.y/Desktop/安全skill/security-skills/`

| 来源 | 用途 | 是否接入 |
|---|---|---|
| `nseap-skill-security-core/` | Python 引擎 v1.3.0，约 3000 行 | ✅ 全部 |
| `skills/ecs-security-template-provider/` | 3.1 模板提供说明 | ✅ 合并进一份 SKILL.md |
| `skills/ecs-security-validator/` | 3.2 双模式校验说明 | ✅ 同上 |
| `skills/ecs-formal-test-orchestrator/` | 冻结与正式测编排说明 | ✅ 同上 |
| `skills/ecs-security-core-usage/` | Core 调用约定 | ✅ 同上 |
| `skills/ecs-skill-creator-security-guidance/` | Creator 填写指引 | ✅ 同上 |
| `skills/nseap-skill-creator/references/*.md`（5 份） | NSEAP 标准详解 | ✅ 复制进 skill-creator |
| `skills/nseap-skill-creator/templates/ontology-slice.yaml.template` | 本体切片模板 | ✅ 同上 |
| `skills/nseap-skill-creator/SKILL.md` | ECS 版创建器 | ❌ **有意不接**，见 §5 |
| `skills/nseap-skill-creator/scripts/check_skill.py` | Python 版检查器 | ❌ **有意不接**，见 §5 |

---

## 3. 本仓库改动清单

### 新增

| 路径 | 说明 |
|---|---|
| `resources/guardrail/nseap-security-core/` | 引擎，74 个文件 / 568K |
| `resources/guardrail/nseap-security-core.INTEGRITY` | 固定树哈希 `e1760010fc61…` |
| `src/main/features/security/nseap-core-adapter.ts` | TS 适配器，判决权在此 |
| `test/main/features/security/nseap-core-adapter.test.ts` | 16 个测试 |
| `resources/builtin/system/skills/skill-creator/references/nseap/` | 新增 5 份 md + `templates/` |

### 修改

| 路径 | 改了什么 |
|---|---|
| `src/main/features/skill_trust.ts` | 回执加 `nseapDeclaration` 字段 + 读回助手 `_readNseapDeclaration` |
| `src/main/features/skill_reverify.ts` | 加 `_checkNseapDeclaration()`，在 `reverifySkillDeep` 末尾调用 |
| `resources/builtin/system/skills/skill-creator/SKILL.md` | NSEAP 段指明新增参考资料 |
| `test/main/features/skill-trust.test.ts` | 新增 6 个 advisory-only 测试 |
| `test/main/util/builtin-resource-gate.test.ts` | 修过期断言，见 §7 |
| `resources/builtin/_manifest.json` | `npm run builtin:manifest` 重生成 |

**另有一批改动目前不在工作区，被压在 `git stash` 里 —— 见 §8.0，这是接手后要做的第一件事。**

---

## 4. 参考过的本仓库文件（决策依据）

这些文件没改，但结论建立在它们之上。接手前建议读前四个。

| 路径 | 提供了什么关键约束 |
|---|---|
| `src/main/features/scanner_trust.ts` | **为何引擎不能做成可安装 Skill**。注释记着实测：扫描器当普通 Skill 装进去再扫，262ms 返回 blocked、11 条红线。pin 文件必须放在树**外面**，放里面会导致哈希覆盖自己、永不匹配 |
| `src/main/features/security/scan-orchestrator.ts` | **规则外置为 Skill、判决留平台侧**的既有先例与理由（闭源规则不随开源检出发布） |
| `src/main/features/security/sentry-adapter.ts` | 适配器的形态范本：`pythonCandidates` / `hasPyYaml` 探测 / 缓存解释器选择 / `unknown` 而非 `blocked` |
| `src/main/quality/index.ts` | **为何不能接在这里**：模块契约写明"无 LLM 调用、无 UI 副作用"且全同步，而引擎要 spawn |
| `src/main/quality/rules/nseap.ts` | CogSeed 已有的 NSEAP 检查（`check_skill.py` 的 TS 移植）。四条边界不变量与 ECS 完全一致 |
| `src/main/features/skill_reverify.ts` | 实际接入点 `reverifySkillDeep`；`isConventionRule` 是"约定性发现不算风险"的既有机制 |
| `src/main/features/skill_trust.ts` | 回执结构；`instructionRisk` 是 advisory-only 证据的成熟范本，新字段照它写 |
| `src/main/util/bundled-runtime.ts` | `bundledPythonExecutable()` 打包解释器解析 |
| `src/main/paths.ts` | `packagedGuardrailDir()` → `resources/guardrail` |
| `bin/runtime-gate.cjs` | **B 方案可行的关键**：`verifyRuntimeSourceArchive` 只校验原始 tar.gz，不校验解压后的树 |
| `bin/ensure-runtime.cjs` | `doctorDir` / `createPythonPipShims` 是 python 准备钩子（本轮最终未用到） |
| `bin/builtin-resource-gate.cjs` | `REQUIRED_BUILTIN_INVENTORY` 显式必需清单 + `exactNames` 精确比对 |
| `src/main/util/builtin-content-manifest.js` | 内置内容树哈希；改 `resources/builtin` 后必须重生成清单 |
| `resources/builtin/system/skills/skill-creator/SKILL.md` | 第 231 行起已有 `## NSEAP compliance` 整节 —— 决定了 §5 的结论 |

---

## 5. 关键决策与理由

### 引擎为何是平台组件而非 Skill
可安装 = 可替换，可替换的检查器等于由被检查者挑选检查者。放 `resources/guardrail/`，完整性靠 pin（因为引擎扫不了自己）。

### 为何接在 `reverifySkillDeep` 而非 `validateSkillDir`
`quality/` 是同步纯函数模块，契约禁止副作用；引擎要 spawn 子进程。`reverifySkillDeep` 已是异步深度检查层，sentry 也在那里。

### PyYAML 走 vendored 而非装包（B 方案）
引擎 5 个模块硬 `import yaml`、无降级；打包 CPython 3.12 只带 pip。

实测两点让方案变简单：
1. `verifyRuntimeSourceArchive` 只校验原始压缩包 → 往 site-packages 加文件**不破坏任何校验**（我原先判断错了，实测推翻）
2. PyYAML 的 `lib/yaml` 是 17 个纯 Python 文件，**不编译就能用**（`__with_libyaml__: False` 只是没 C 加速）

所以 vendored 248K 源码进 `vendor/yaml/`：无需编译器、无需按平台准备 wheel、6 平台通用，且落在内置清单哈希保护内（比不受保护的 site-packages 更安全）。

`jsonschema` 在 `pyproject.toml` 里声明但**源码零引用**，故未 vendored。

### `nseap-skill-creator` 为何不接
它和 CogSeed 的 `skill-creator` **不在同一层**：
- CogSeed 那份管产出协议（`<skill>` 容器 + `<<<skill-file>>>` 块，由 `bus.ts` 流后解析，明令禁止用 `write_file` 改 skill 目录）
- ECS 那份管 NSEAP 内容规范

且 CogSeed 的 SKILL.md 早有 `## NSEAP compliance` 整节，只是参考资料是简版（3 份）。所以正确做法是**补资料到 9 份**，不是放第二个创建器（会让模型随机选到不兼容的产出协议）。

`check_skill.py` 不接：TS 版 `quality/rules/nseap.ts` 已是它的移植且接入校验链，再放一份是两个真相源。

---

## 6. 已知限制（不要误读为已完成）

### 冻结 / FORMAL_TEST 没有触发点
CogSeed 的 Skill 随时保存，没有"发布"动作，**"什么事件算冻结点"仍未定**。引擎能跑（打包 Python 上跑通完整流水线，`subject_digest` 与系统 Python 一致），但目前无调用方。已在引擎 SKILL.md 里写明，**不要声称某个 Skill 已通过正式测试**。

待定：上架 marketplace 算冻结点？首次被 Agent 调用算？另外冻结会 `shutil.copytree` 出只读副本，与既有 `src/main/features/skills/version-store.ts` 的版本快照如何不重复存储，也需设计。

### 风险分级在上游被主动停用
不是未实现，是**主动关掉的**：模板里 `risk.*` 全为 `null` 并注明"暂不填写"；`security_core/freeze.py:19` 有 `_RISK_FREEZE_IGNORE_RULE_PREFIXES` 忽略风险类发现；`warning-policy.yaml` 对应条目 `freeze_blocking: false` 且覆盖 production；冒烟测试自己打印 `risk derivation tests skipped — disabled`。

后果：`consistency-rules.yaml` 里最有力的几条**当前不生效** —— `SEC-ACTION-001`（不可逆/资金操作需审批）、`SEC-RISK-001`（审批匹配风险等级）、`SEC-ROLLBACK-001`（高风险需回滚）。**规则骨架在，判定逻辑不在。**

### 用户看不见任何变化
数据写进回执的 `nseapDeclaration` 了，渲染层还没读它。要用户可感需改 UI。

### 所有已发布技能都没有安全声明
故对账目前对全部技能返回 `absent`。这是设计如此（`absent` 刻意区别于 `pass`），不是 bug。

---

## 7. 接手时必须知道的四条不变量

`_checkNseapDeclaration()`（`skill_reverify.ts`）有四条属性，改动时不要破坏，均有测试锁住：

1. **永不改变 `decision`** —— 调用点在 decision 定稿之后。破坏它会把"未填完声明"升级成安全徽章，且因为所有技能都无声明，会一次点亮整个技能库
2. **无 manifest → `absent`，不 spawn** —— 记 `pass` 等于为不存在的文件宣称检查过
3. **引擎不可用 → `unavailable`，永不 `blocked`** —— 基础设施故障不是内容危险的证据
4. **绝不抛异常** —— 整个函数包在 try/catch。重验决定 Skill 能否加载，advisory 附加项不该有能力打断它

措辞上还有一条：引擎的 `blocked` 记作 `mismatch`。声明不符是编写缺陷，在安全记录里写 `blocked` 会被读成威胁判决。测试里有断言锁住这个状态永不落进回执判决词汇。

---

## 8. 过程中发现的问题（8.0 未解决，其余已修）

### 8.0 ⚠️ 未解决：23 个技能的守卫修复被压在 stash 里

**接手后要做的第一件事。** 我在写交接文档时核对命令输出，发现守卫通过数是 `41/64` 而非预期的 `64/64` —— 那批改动不在工作区。

原因：我在调查测试失败是否先于改动存在时，多次用 `git stash` / `stash pop` 在纯 HEAD 上做对照实验。其中一次 pop 没有恢复回来，改动留在了 stash 里。

已核实的事实：

```
$ git stash list
stash@{0}: On wujy: runtime-generated schemas

$ git stash show --stat stash@{0}
24 files changed, 346 insertions(+), 47 deletions(-)
  ├─ 23 × resources/builtin/marketplace/skills/*/schemas.json   （+13 行/个，纯新增）
  └─ resources/builtin/_manifest.json                           （94 行，重生成）
```

当前状态：
- 工作区那 23 个 `schemas.json` 是 **HEAD 版本**（仍缺 `owner_binding` / `audit`）
- 守卫通过 **41/64**，两条边界检查在 1/3 平台技能上仍然空转
- 工作区的 `_manifest.json` 是 1421 行、**不含**引擎路径（引擎在 `resources/guardrail/`，不属 `resources/builtin` 树，这点正常）

**恢复时的冲突风险**：stash 里的 `_manifest.json` 和工作区的 `_manifest.json` 都被改过（同一文件、不同代次）。不要直接 `git stash pop`，建议：

```bash
# 只取 23 个 schemas.json，跳过 stash 里的 _manifest.json
git checkout stash@{0} -- $(git stash show --name-only stash@{0} | grep 'schemas.json')

# 然后重新生成清单（以工作区当前内容为准，避免用 stash 里的旧代次）
npm run builtin:manifest

# 核对：应输出 64/64
（用 §9 的守卫核对脚本）

# 确认无误后再丢弃 stash
git stash drop stash@{0}
```

改动本身是验证过的（当时实测 64/64、diff 为 23 文件 299 行纯新增、零删除），只是没留在工作区。下面 §8.1 记录的是它的内容与依据。

### 8.1 23 个平台技能的守卫在空转（数据缺口）
64 个有 `runtime_contracts` 的技能里 23 个缺 `owner_binding` / `audit`，导致 `validateNseapRuntimeGuards` 两条守卫在 1/3 平台技能上**永不通过**。因为等级 MEDIUM（不阻塞），一直没被发现。

补的字段照抄 41 个合规技能的形状（统计确认只有 1 种变体）。补前核实过这不是造假：这 23 个技能的 `input_schema.owner_context` 和 `output_schema.audit_refs **全部已存在**，只是 `runtime_contracts` 没声明指向它们。

结果：**64/64 通过**（此前 41/64）。⚠️ 但该改动当前在 stash 里，见 §8.0。

根因不在 skeleton —— `nseap_skill_skeleton.ts` 不生成 `schemas.json`，而真正的模板源 `skill-creator/references/nseap/contracts.md` 四条守卫写得完整正确。是那 23 个没照它写。

### 8.2 `__pycache__` 会破坏固定哈希（接入引入的缺陷）
引擎跑一次就在 `security_core/` 下写 15 个 `.pyc`，树哈希改变，pin 从第二次运行起报 `tampered`。

修法：两处 `spawnSync` 都设 `PYTHONDONTWRITEBYTECODE=1`。加了回归测试"跑完引擎后 pin 必须仍匹配"。

**若没修，会在正式使用时表现为"安全组件被篡改"的假警报** —— 而假警报会训练用户忽略真警报。

### 8.3 路径二次拼接
适配器设了 `cwd: dir`，相对 skill 路径就相对引擎目录解析，导致找不到 manifest、静默返回 `unknown`。改为 `path.resolve(skillRoot)`。

### 8.4 `builtin-resource-gate` 过期断言
`expect(manifest.files).toHaveLength(1275)` 而实际 1421。历史漂移：129 → 138 → … → 1275，被漏改两次（`47cdc63` 一次、本轮一次），期间它是在**失败**而非守卫。

**没有简单改成动态** —— `createBuiltinManifest` 是从磁盘遍历的，拿它自己的长度断言自己等于 `x === x` 恒真。

先做了对照实验（副本上删文件 + 重新生成清单，此时所有哈希自洽）：

| 删除内容 | 其他各层是否拦住 |
|---|---|
| 必需 system SKILL.md | ✅ |
| 整个 agent 目录 | ✅ |
| 1 个 `references/*.md` | ❌ 全部漏过 |
| 20 个 `schemas.json` | ❌ 全部漏过 |

所以这条断言**不能删**，是唯一能发现"批量文件消失但清单已刷新"的防线。

最终做法：
- 三个 inventory 计数（6/34/64）改为引用 `REQUIRED_BUILTIN_INVENTORY.*.length` —— 它们与显式清单完全一致，而 `exactNames` 已按名精确比对，字面量是把强检查换成弱形式重述
- `files` 拆成独立测试，对照**已提交的 `_manifest.json`**（真正的第二来源，由 `npm run builtin:manifest` 写入并在 diff 中审阅）
- 加 `> 900` 下限防"两边同时缩水"。这个数字不需跟随内容变更 —— 只增不减时永不触发

已验证新断言覆盖旧断言的全部能力，含原先漏网的两类。

---

## 9. 验证方式

```bash
# 全量（约 80s）
npm test

# 本轮相关
npm test -- test/main/features/security/nseap-core-adapter.test.ts   # 16 个
npm test -- test/main/features/skill-trust.test.ts                   # 43 个（含新增 6）
npm test -- test/main/util/builtin-resource-gate.test.ts             # 11 个

# 引擎直跑（诊断用）
G=resources/guardrail/nseap-security-core
P=resources/runtime/python/darwin-arm64/python/bin/python3
PYTHONPATH="$PWD/$G/vendor:$PWD/$G" PYTHONDONTWRITEBYTECODE=1 \
  "$P" "$G/scripts/validator_cli.py" --skill-root "$G/fixtures/sample-skill" --mode PREVALIDATION

# 平台技能守卫核对
python3 - <<'EOF'
import json,glob
tot=ok=0
for f in sorted(glob.glob('resources/builtin/marketplace/skills/*/schemas.json')):
    rc=(json.load(open(f)).get('runtime_contracts') or {})
    if not rc: continue
    tot+=1
    r,o,a=rc.get('resource') or {},rc.get('owner_binding') or {},rc.get('audit') or {}
    if (r.get('direct_resource_access') is False and r.get('access_via_gateway_only') is True
        and o.get('binding_resolved_by')=='agent_layer' and a.get('emitted_by')=='runtime'): ok+=1
print(f'四条守卫全通过: {ok}/{tot}')
EOF
# 恢复 stash 前输出 41/64，恢复后应为 64/64。见 §8.0
```

### 改动 `resources/builtin` 或引擎后必做

```bash
npm run builtin:manifest          # 改 resources/builtin 后
npm run builtin:manifest:check    # 校验
```

改引擎目录后须重生成 pin（临时脚本，用完删除）：

```ts
import * as fs from 'node:fs';
import { marketplaceContentTreeHash } from './src/main/util/marketplace-tree-hash';
const h = marketplaceContentTreeHash('resources/guardrail/nseap-security-core');
fs.writeFileSync('resources/guardrail/nseap-security-core.INTEGRITY', `${h}\n`);
```

生成前先清字节码：`find resources/guardrail/nseap-security-core -name __pycache__ -type d -prune -exec rm -rf {} +`

---

## 10. 当前测试状态

**7934 passed / 7 failed / 15 skipped**

7 个失败全部是 `test/main/features/expert_team_orchestration.test.ts`：`Cannot find module 'src/main/features/expert_teams'` —— 模块不存在，**先于本轮所有改动**（已用 `git stash` 在纯 HEAD 上复跑确认）。不是本轮引入，也不在本轮范围内。

另：`test/main/features/messaging-owner-bind-integration.test.ts` 在全量并跑时偶发失败，单独跑通过。与本轮无关。

---

## 11. 建议的下一步

按性价比排序：

0. **先恢复 stash 里的 23 个 `schemas.json`** —— 见 §8.0。当前守卫仍是 41/64，这是一个已完成但未落地的修复，成本最低、风险最小

1. **把 `nseapDeclaration` 显示到 UI** —— 数据已在回执里，改渲染层即可。这是本轮成果变成用户可感的最短路径
2. **定冻结点** —— 产品决策，非技术选择。定了才能启用 FORMAL_TEST 那条链
3. **补风险分级判定逻辑** —— 工作量最大，但那是 ECS 那套里最有价值的部分（L0–L5 + 不可逆操作审批）
4. **提交拆分** —— 当前工作区混了三块内容，建议分三个提交：① 23 个技能守卫修复 ② 引擎接入 ③ gate 测试修复

### 未做的事情，明确记录
- 出站 LLM 脱敏：`src/main/model/client.ts` / `core-agent/runner.ts` 对出站载荷**无任何匿名化**，代码库无真名↔代号映射表。这是独立于本轮的真实缺口，我曾提议但未获采纳，此处仅作记录
- `expert_team_orchestration` 的 7 个失败未修（超出范围）
