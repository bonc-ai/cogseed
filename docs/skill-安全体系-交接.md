# Skill 安全体系 — 交接文档

> 面向接手这项工作的 agent。写作时间点:`VALIDATOR_VERSION = 0.6.0`。
> 所有数字都是实测得到的,不是估算。文中标注「**未验证**」的地方请不要当成已知事实。

---

## 一、这件事要解决什么

CogSeed-Agent 会安装第三方 skill 并把它们的内容喂给模型执行。攻击面有三层:

1. **安装时** — 恶意 skill 被装进来
2. **安装后** — 装的时候干净,装完改文件(之前**完全没有覆盖**)
3. **沉淀时** — 被投毒的会话产出「经验」,之后作为参考进入系统提示词

目标不是「加一堆规则」,而是让这三层各有一个**机械的、不依赖人记得**的检查点。

### 一条贯穿全部设计的原则

> **会失灵的东西不能拥有放行权。**

模型会超时、会断网、同一输入两次结论可能不同。所以模型层只能**加码**,不能减码;
确定性代码层说了算。这条原则在 `cognition/gate.ts` 的 `mergeSemanticReview` 里
是用类型和测试锁住的,不是靠约定。

---

## 二、现在建成了什么

```
安装 skill
  │
  ├─ 安装门:validateSkillDir → EXTREME 硬拦,force 不可绕
  │   └─ 写安全回执:payloadHash + validatorVersion + ruleProfile
  │
每次构建 system prompt
  │
  ├─ 比对回执 → 内容变了 / 规则升级了 → 自动重扫
  │   └─ blocked → 从 agent 可见列表扣留(用户无法开回来)
  │
沉淀候选(经验 / 补丁 / 个人本体)
  │
  ├─ 代码底线:注入检测 + 复用 install 红线
  ├─ agent 语义审查:4 类语义风险(只能加码,失败不阻塞)
  └─ 界面:安检状态 / 成熟度 两条轴分开显示
```

### 新增文件

| 文件 | 职责 |
|---|---|
| `src/main/quality/rules/context.ts` | 三级上下文判别:文件位置 / 行位置 / 语言归属 |
| `src/main/features/skill_trust.ts` | 安全回执存取 + staleness 判定 |
| `src/main/features/skill_reverify.ts` | 验证-否则重扫 + 加载路径扣留 |
| `src/main/features/cognition/gate.ts` | 沉淀准入门(两层不对等) |
| `src/main/features/cognition/semantic-review.ts` | agent 语义审查(接真模型) |

### 测试文件

| 文件 | 数量 | 锁住什么 |
|---|---|---|
| `test/main/quality/builtin-calibration.test.ts` | 4 | **47 个内置 skill 零阻断** |
| `test/main/quality/context-and-secrets.test.ts` | 27 | 降权边界 + 密钥检出 |
| `test/main/quality/ported-rules.test.ts` | 22 | 持久化 / 动态执行 |
| `test/main/quality/ssrf-egress.test.ts` | 18 | 防御代码不被判死 |
| `test/main/quality/force-override.test.ts` | 9 | force 不可绕 EXTREME |
| `test/main/features/skill-trust.test.ts` | 23 | 篡改检测 + 扣留 |
| `test/main/features/cognition-gate.test.ts` | 26 | 单调性 / 权限边界 |
| `test/main/features/cognition-semantic-review.test.ts` | 14 | 模型输出不可信 |

**全量:5950 passed,零失败**(`test/main` + `test/renderer`)。

---

## 三、必须先理解的三个设计决定

接手时如果不理解这三条,很容易「优化」掉关键性质。

### 1. 降权是可见的,不是删除

上下文降权(vendor / test / 注释)**保留 finding**,只降等级,并记录:

```ts
{ level: 'LOW', original_level: 'EXTREME', context: 'vendor' }
```

**为什么不能直接丢:** 丢弃会把「可见的误报」换成「不可见的漏报」,后者更坏。
审计者必须能看到什么被降了、为什么。

`builtin-calibration.test.ts` 里有一条断言 `demoted > 0`,防止有人把降权
悄悄改成丢弃后测试还是绿的。

### 2. 两处 fail 方向是相反的,这是刻意的

| 位置 | 失败时 | 理由 |
|---|---|---|
| 安装门 | **fail closed**(拦住) | 准入决策,拦错只是装不上 |
| 加载门 | **fail open**(放行) | 每次建 prompt 都跑,扫描器抖一下就剥夺用户功能,这个控制会被关掉 |

加载门只扣 `blocked`,不扣 `risk` / `unknown`。改动这里前请先想清楚:
**一个会随机删功能的安全控制,会被它保护的人主动关掉。**

### 3. 安全扣留 ≠ 用户禁用

加载门挂在 `skill-registry.ts` 的 `loader.list()` 上,**不是**复用
`disabled` 集合。因为 `disabled` 是用户偏好,用户能再点开;
篡改过的 skill 必须是用户开不回来的。

---

## 四、当前规则:24 条

`src/main/quality/rules/red-flags.ts`。原有 9 条,本次移植 15 条。

| 批次 | 条数 | 等级 | 误报风险 |
|---|---|---|---|
| 原有(凭证/eval/下载执行/…) | 9 | 全 EXTREME | — |
| 密钥类 | 4 | 3 EXTREME + 1 MEDIUM | 低(厂商前缀固定) |
| 持久化 | 4 | 全 EXTREME | 低 |
| 动态执行 | 4 | 3 EXTREME + 1 MEDIUM | 中 |
| SSRF / 外联 | 3 | 2 EXTREME + 1 MEDIUM | **高** |

### 三个逐规则开关

```ts
neverDemote?: boolean       // 上下文永不降权 —— 只给密钥类
demoteInComments?: boolean  // 注释里降权 —— 只给「防御实现必须提到」的规则
langs?: [...]               // 语言限定 —— 修「规则用错对象」的 bug
```

**`demoteInComments` 是选择加入的,不是全局行为。** 边界:

| 规则 | 注释里降权? | 为什么 |
|---|---|---|
| SSRF 三条 | 是 | 防御实现必须能提到它拦的地址 |
| 硬编码密钥 | **否** | 注释里的真 token 仍是泄露的 token |
| `curl \| bash` | **否** | 注释里的管道通常是复制粘贴指令 |

---

## 五、加规则的正确流程

这个流程是踩过坑总结的,**请照做**。

### 步骤

1. **先探测,不要猜缺口**
   写一个临时测试,拿 15–20 个已知攻击向量打现有规则,看哪些漏。
   实测结果:持久化 21 个向量漏 10 个,动态执行 20 个漏 15 个 —— 光读规则看不出来。

2. **用真实语料定严重级,不要凭直觉**
   例:查到 `subprocess` 在 3 个内置 skill 里合法使用,而 `shell=True` 零出现
   → 所以「跑子进程」不可疑,「通过 shell 跑」才可疑。

3. **必须给作者留正确做法**
   `subprocess.run([...])` / `yaml.safe_load` / `execFile` 都不触发。
   **如果连正确写法都拦,规则会被绕过而不是被遵守。**

4. **跑校准门**
   ```bash
   node scripts/run-tests.mjs run test/main/quality/builtin-calibration.test.ts
   ```
   任何新规则若阻断内置 skill,这里会失败。**过不了就是没准备好。**

5. **双向验证** —— 攻击向量全检出 + 合法用法零 EXTREME,两边都要写进永久测试。

6. **bump `VALIDATOR_VERSION`**(`src/main/quality/types.ts`)
   这会让已有回执自动失效并触发重扫,是设计好的联动。

### 为什么校准门不可跳过

移植前量基线时发现:**现有规则已经硬拦了一个我们自己发布的 skill** ——
`stage-compose/scripts/vendor/gsap.min.js` 里压缩后的 `ut.exec(t)` 被
`no_eval_with_external_input` 判 EXTREME。

**光靠人工 review 发现不了这个。** 所以先移 context 层再加规则,
移完 context 层(未加任何新规则)EXTREME 就从 1 → 0。

---

## 六、还没做的事(按建议优先级)

### 1. Quarantine 隔离区 ⭐ 建议先做

**现状:** install 先把内容解压到**最终位置** `userMarketplaceSkillDir(uid, skillId)`,
再调 `validateSkillDir` 检查,失败才 `rm -rf`。

**问题:** 检查失败到删除之间存在窗口。而且如果进程在这中间被杀,
恶意内容就留在最终位置了。

**方向:** 解压到临时目录 → 检查 → 通过才原子移动到最终位置。
注意 `marketplaceContentTreeHash` 是跨语言契约(和 Python 侧对齐),移动后
路径变了但相对路径不变,哈希应当不受影响 —— 但这点**未验证**,请实测。

### 2. `deleteCustomAgent` 缺系统 agent 保护

`src/main/features/agents.ts:2218`。当前只检查 `agentId` 非空和目录存在,
**没有任何「系统 agent 不可删」的判断**,直接 `rm -rf` 整个目录。

这是我在讨论 agent 权限边界时发现的,一直没修。

### 3. MEDIUM 的构成需要清理(已实测)

内置语料 50 个 MEDIUM 的构成:

| 规则 | 数量 |
|---|---|
| `skill_meta_category_missing` | **47** |
| `no_runtime_code_construction` | 1 |
| `no_cloud_metadata_access` | 1 |
| `frontmatter_description_too_long` | 1 |

**94% 的 MEDIUM 是同一条元数据规则在每个 skill 上各报一次**,不是安全发现。
这会淹没真实信号。建议要么给内置 skill 补 `_meta.json`,要么把这条降到 LOW。

（注意:写 fixture 时如果不加 `_meta.json`,skill 会是 `risk` 而不是 `pass`。
我在这上面踩过一次,误以为是代码 bug。）

### 4. 第 5 批规则?—— 需要先补语言语料

**当前语料里 Go / Rust / Java 一个都没有。** 涉及这些语言的规则等于没验证过。
加之前先确认是否真的需要支持这些语言。

---

## 七、如实说明:哪些是没验证的

这一节请务必读完,不要把下面的东西当成已解决。

### 漏报率完全未标定

能说的:**构造的 60+ 攻击向量拦住了**。
**不能说:真实攻击拦得住。** 全部攻击样本都是我自己写的,存在明显的
「出题人也是答题人」问题。真实恶意 skill 一个都没测过。

### 语义审查的精度未验证

`semantic-review.ts` 接了真模型,但:
- 默认 `advisoryOnly`,EXTREME 被封顶到 MEDIUM ——**模型单独不能硬拦**
- 这是刻意保守,等精度验证过再放开
- 4 类语义风险的实际召回/精确率**没有数据**

### 并行测试有抖动,不是本次引入的

全量跑偶尔有 1–4 个失败,**每次失败的用例都不一样**。已核实的抖动用例:
`codex_t2-04_real_run`(真 spawn CLI 走网络)、`group_chat/bus`(重 IO)、
`runtime-controller`(时序)。**单独跑都过。**

判断方法:失败后单独跑那个文件。如果单独过 → 是负载抖动;
如果单独也失败 → 是真回归。

### 一个我犯过两次的错

**只跑 `test/main/features` 是不够的。** 我因此漏掉了
`test/main/ipc/cognition.test.ts` 的一个真实回归(mock 缺 `parseSemanticReview`)。

改动 IPC 或 `cognition` 模块后,**至少跑 `test/main`**,不要只跑 features。

---

## 八、常用命令

```bash
# 类型检查(必须干净)
npm run typecheck

# 校准门 —— 改规则后必跑
node scripts/run-tests.mjs run test/main/quality/builtin-calibration.test.ts

# 安全相关全部
node scripts/run-tests.mjs run test/main/quality test/main/features/skill-trust.test.ts \
  test/main/features/cognition-gate.test.ts \
  test/main/features/cognition-semantic-review.test.ts

# 改 IPC / cognition 后
node scripts/run-tests.mjs run test/main

# 全量
node scripts/run-tests.mjs run test/main test/renderer
```

---

## 九、关键文件速查

| 想改什么 | 去哪 |
|---|---|
| 加/改规则 | `src/main/quality/rules/red-flags.ts` |
| 上下文降权逻辑 | `src/main/quality/rules/context.ts` |
| 等级语义 / `VALIDATOR_VERSION` | `src/main/quality/types.ts` |
| 安装门 | `src/main/features/marketplace.ts`(搜 `_assertQualityGatePassed`) |
| 回执 / staleness | `src/main/features/skill_trust.ts` |
| 加载门扣留 | `src/main/model/core-agent/skill-registry.ts`(搜 `_withholdUntrustedSpecs`) |
| 沉淀准入 | `src/main/features/cognition/gate.ts` |
| 前端安检展示 | `src/renderer/modules/skills.js`(搜 `_renderCognitionSecurityChip`) |

外部参考实现:`~/Desktop/安全skill/skill-sentry`(独立扫描器,58 条规则,
`engine/scanner_core/context.py` 是本次 context 层的来源)。
