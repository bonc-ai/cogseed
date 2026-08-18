# Skill 安全体系 第二期 — 实施方案

> 承接 `docs/skill-安全体系-交接.md`（写作时 `VALIDATOR_VERSION = 0.6.0`）。
> 一期建成了机制，二期补机制的**接入面**。
> 本文所有「实测」标注都是跑过的；标「未验证」的请不要当结论。

---

## 一、二期要解决什么

一期的架构图是这样的：

```
安装 skill → 安装门（EXTREME 硬拦）→ 写回执
每次构建 system prompt → 比对回执 → blocked 则扣留
```

这张图字面正确，但把**两个唯一性**当成了前提，而两个都不成立：

| 图里写的 | 实际情况 |
|---|---|
| 「安装 skill」是唯一入盘路径 | reconcile 拉取、agent 私有 skill 解压都不经过安装门 |
| 「构建 system prompt」是唯一出口 | bridge / bus / search / 执行路径都不经过加载门 |

所以二期的主线是：**把已建成的两道门接到所有入盘点和所有出口**，而不是加新规则。

一期文档列的 4 项待办（Quarantine / deleteCustomAgent / MEDIUM 噪声 / 第 5 批规则）里，
Quarantine 和 deleteCustomAgent 保留，MEDIUM 降级保留，第 5 批规则本期不做（缺语料）。
新增的 3 项覆盖缺口优先级高于 Quarantine —— 理由见 §3。

---

## 二、实测发现的三个覆盖缺口

### 缺口 1：reconcile 路径没有安装门

`marketplace_reconcile.ts::_pullSkillLocked`（约 1208 行）从云端拉 bundle、
`extractBundleSafely` 解压、只检查 `SKILL.md` 存在，然后写 `_install.json`。
**不调 `validateSkillDir`，不写回执。**

全仓 `validateSkillDir` 调用点只有 3 处（实测 grep）：

| 位置 | 用途 |
|---|---|
| `marketplace.ts:932` | install 路径 |
| `skill_reverify.ts:82` | 重扫 |
| `skills.ts:1641/1704` | 本地导入 |

reconcile 不在其中。agent 侧同理：`_pullAgentLocked` 也不调 `validateAgentSpec`。

**严重程度：中，不是洞穿。** 加载门的 `no_receipt` → 重扫会兜住这条路
（`isReceiptStale` 对无回执返回 `stale: true`）。但兜住的是 fail-open 的加载门，
不是 fail-closed 的安装门 —— 语义上降级了，且只在 `getSystemPromptBlock` 生效（见缺口 3）。

### 缺口 2：agent 私有 skill 两道门都不过

私有 skill 在两处落盘，都是裸解压：

- `marketplace.ts:831` — install 路径
- `marketplace_reconcile.ts:1177` — reconcile 路径

`validateAgentSpec` 只校验 `agent_json`，不看 `skills/` 目录。

出口侧同样漏：`skill-registry.ts::getSystemPromptBlock` 第 850 行对
`loader.list()` 调 `_withholdUntrustedSpecs`，但私有 specs 在第 887 行才
通过 `loadAgentPrivateSkillSpecs` append 进 `rendered` —— **在扣留之后**。

**严重程度：高。** 这是唯一一条两道门全不过的路径。

### 缺口 3：加载门只挂在一个出口

`_withholdUntrustedSpecs` 的唯一调用点是 `getSystemPromptBlock:850`。
其余出口直接用 `loader.list()`：

| 出口 | 位置 | 消费方 |
|---|---|---|
| `listSkillsForBridge` | `skill-registry.ts:1091` | CLI agent（cogseed-bridge） |
| `listSkillSpecs` | `skill-registry.ts:1258` | bus 算 runtime skill list |
| `listSkillSpecsForAgentMetadata` | `skill-registry.ts:1285` | agent 元数据 / 编辑面 |
| `searchOpenTierSkills` | `skill-registry.ts:643` | 按需搜索（`trustedIds` 只用于去重，不扣留） |

**执行路径本身也不检查**：`bin/run-skill.cjs` 665 行内零个 trust/receipt 判断。

---

## 三、为什么覆盖缺口优先于 Quarantine

Quarantine 修的是一个**时间窗口**：install 先解压到最终位置
（`marketplace.ts:921-926`），validate 失败才 `rm -rf`（第 941 行）。
要利用它，攻击者需要进程恰好在 validate 与 rm 之间被杀。

三个覆盖缺口是**常态生效**的：不需要任何时序条件，正常使用就绕过。

所以顺序是：先补覆盖面（第 1–4 步），再收窄时间窗口（第 5 步）。

---

## 四、已实测确认的两件事

### tree hash 与路径无关 —— Quarantine 可以安全做

一期文档标注为「未验证」的点。实测：同一份内容放在
`quarantine-abc/`、`final/skills/my-skill/`、`other-name/` 三个位置，
`marketplaceContentTreeHash` 返回同一个值
（`fd6794c1486ed0ce4e62b1f27361cc4c0757b628375379a026a5d7cc8d61c982`）。

原因在实现里：`_hashFiles` 只 `h.update(rel)`，rel 是相对 root 的路径，
绝对路径不进摘要。所以「解压到临时目录 → 校验 → 原子移动」不会改变哈希，
跨语言契约（`Resource/sync-resource-marketplace.py`）不受影响。

**但有一个新风险，是我在读 `context.ts` 时发现的：**
降权判定靠**相对路径里的目录名**（`VENDOR_DIRS` / `TEST_DIRS`，见 `context.ts:34-43`）。
`fileContextOf` 用的是相对路径，所以临时目录名理论上不进判定 —— 但
临时目录命名仍必须避开 `test` / `tests` / `spec` / `fixtures` / `vendor` /
`vendored` / `third_party` 这些词，否则一旦将来有人把判定改成基于绝对路径，
整个 skill 会被静默降权。**命名用 `.staging-<random>`，并写一条测试锁住。**

### run-skill.cjs 不需要改 —— 主进程已有拦截点

原本担心要把 tree-hash 逻辑复制进 cjs（多一份跨语言实现）。实测发现
`local-tools.ts:1872::guardDisabledSkillBash` 已经在做同类事：
用 `extractRunSkillRefs`（第 1850 行，正则解析命令行里的 skill 引用）+
`commandMentionsSkillRoot`（第 1861 行，匹配路径提及），在 bash 工具执行**之前**
拦下被用户禁用的 skill。两个调用点：`local-tools.ts:2224`（bash）和
`:2367`（interactive_cli_start）。

所以扣留检查加在同一个 guard 里即可，`bin/run-skill.cjs` 保持不动。
Runtime worker 侧另有一条路
（`cogseed_runtime/kernel/tools/skill-tools.ts:92`），需要单独接。

---

## 五、分步实施

### 第 1 步 — `deleteCustomAgent` 加 platform 保护 ✅ 已完成

**问题**：`agents.ts:2218` 只检查 `agentId` 非空 + 目录存在，直接 `rm -rf`。

**实际危害与一期文档的描述不同，值得写清楚。** 一期说「直接 rm -rf 整个目录」，
读代码后发现 platform agent 的 spec 在 `local/marketplace/agents/<id>/`，
而 `agentDir` 指向 `cloud/agents/<id>/` —— **rm 打不中 spec**。

真正被删的是 platform agent 合法积累在 cloud 侧的**运行状态**：
`bus.ts:5048` 对每个 agent actor（含 platform）调 `recordAgentRuntimeStats`，
它写 `cloud/agents/<id>/runtime_stats.json`，而 `writeJson` 会 `mkdir -p` 父目录。
所以一个 platform agent **只要跑过一次**，`existsSync(dir)` 就为真，
这个函数随即删掉它的运行统计 + 每个用户的 agent-edit 会话目录 + session jsonl。

**两个补充理由**：

1. 同文件已有三处同类守卫，写法一致：`updateCustomAgent:2518`、
   `clearAgentChat`、`sendToAgentEditChat:2741` 都是
   `if (agent.source !== 'custom')` 拒绝。delete 是漏掉的那个，不是设计如此。
2. `recycle_bin.ts:1816::createAppRecycleBatchForAgent` 只覆盖
   `cloud/agents/<id>`，**不含 marketplace 目录**，所以上面被删的东西进不了回收站。

**改法**：`deleteCustomAgent` 开头 `getAgent` + `source !== 'custom'` 返回 false。
守卫键在**解析出的 source**，不是目录是否存在 —— 后者会是个空操作。
platform agent 的移除仍走 `uninstallMarketplaceAgent`。

渲染层 `agents.js:1080` 已用 `canEditDefinition` 隐藏菜单项，这一步补的是
IPC 直接调用面（`ipc/index.ts:2302`）。

**测试**：`test/main/features/agents.test.ts` 加 3 条 —— platform agent 拒绝且
统计与 spec 均存活、platform 的 chat dir / session jsonl 不被清、custom 仍可删。
已反向验证：注掉守卫后前两条失败。

**结果**：138 tests 全绿。

---

### 第 2 步 — 加载门补到其余出口 ✅ 已完成

**改法**：`skill-registry.ts` 里把扣留下沉。两个选项：

| 方案 | 做法 | 取舍 |
|---|---|---|
| A | 在 `getLoader()` 返回处过滤一次 | 一处覆盖全部；但 loader 结果被缓存，扣留状态与 marketplace mtime 的联动要重新想 |
| B | 各出口分别调 `_withholdUntrustedSpecs` | 显式、缓存语义不变；但新增出口时会再漏 |

**选 B** 并已实施。实际接入结果与原计划有四处偏差，都是读代码后改的：

**偏差 1：`_trustFilterCache` 有 bug，必须先修。**
原实现缓存的是「某个调用方列表算出的 blocked 集合」，key 只有 `(uid, stamp)`。
一期只有一个调用点时无害；接第二个就错了 —— 各出口传的子集不同
（bridge 过滤掉 `ownerAgent`，prompt 路径可能传 allowlist），
先到的窄列表填满缓存后，后到的宽列表拿到命中，**多出来的 id 从未被验证**。
已改成缓存 per-skill 判定 `Map<string, boolean>`，只验证本代缓存没见过的 id。
配了回归测试 `verifies ids a narrower earlier call never covered`。

**偏差 2：`listSkillSpecsForAgentMetadata` 不能加扣留 —— 它守的是写路径。**
`agents.ts::updateCustomAgent` 用它解析 `skill_list`，**解析不到的 ref 会被丢弃并落盘**。
在这里扣留 = 用户的 agent 配置被永久删除，而且是被一个 fail-open 的检查删的。
把可恢复的加载期扣留变成不可恢复的数据丢失。已在源码注释里写明，
并配一条反向测试 `does NOT withhold from the agent-metadata listing` 锁住 ——
将来有人为了「消除不一致」给它加过滤，这条会失败。

**偏差 3：`searchOpenTierSkills` 不需要改。**
实测 `_computeOpenTierDirs` 只返回外部包根 + `~/.claude` / `~/.codex` 全局根，
**从不包含 marketplace 安装目录**；且 `trustedIds` 已排除受信 loader 的所有 id。
安全回执只描述 marketplace 安装物，所以这里加过滤是保证为空的操作 ——
写了会像覆盖了，实际什么都没做。已改为注释说明，不加空过滤。

**偏差 4：私有 skill 分支不能直接套用扣留 —— 会验错对象。**
`reverifySkill` 把 skill 目录解析成 `userMarketplaceSkillDir(uid, id)`，
但私有 specs 来自 `userMarketplaceAgentSkillsDir(uid, agentId)` /
`agentPrivateSkillsDir(uid, agentId)`。同名 id 会去校验**另一份文件的字节**；
不同名则解析到不存在的目录、fail open。
所以这不是「漏了一处」而是「加了会错」，留给第 3b 步连回执 key 一起改。

**执行路径**：新增 `local-tools.ts::guardUntrustedSkillBash`，
复用 `extractRunSkillRefs` + `commandMentionsSkillRoot`，两个调用点同 disabled guard
（bash / interactive_cli_start）。`bin/run-skill.cjs` 保持未修改。
新增导出 `skill-registry.ts::blockedSkillIds`，给不持有 spec 对象的调用方用。

**这里踩到两个坑，都写进测试了：**

1. **按 id 拦不住。** `run-skill.cjs` 的 `readSkillDisplayName` 支持用
   frontmatter `name` 调用，所以只按目录 id 匹配可以被绕过。已加 name→id 映射，
   测试 `rejects invocation by display name`。
2. **不能拦读。** 第一版拦了任何提及 skill 路径的命令，直接**弄坏了
   `local-tools.test.ts` 两条既有测试** —— 受保护根目录的只读放行被破坏了。
   扣留的目的是阻止模型**按内容行动**，不是让文件读不出来（读恰恰是用户查看
   改了什么的方式）。已改为复用既有的 `bashProtectedRootMentionIsProvablyReadOnly`
   分类器，测试 `still allows provably read-only inspection of a withheld skill`。

**Runtime worker**：`skill-tools.ts::runRuntimeSkillTool` 在 `validateSkillToken`
之后加 `isSkillTrustedForLoad`。注意这里 import 的是 `features/skill_reverify`
而不是 `model/core-agent/skill-registry` —— 后者的模块图会拉到 `#core-agent`，
而它必须保持 dynamic-import-only（CLAUDE.md §Boundary）。该工具契约收的是
结构化 `skill_id`，没有 bash 那条路的名称解析问题。

**fail open 方向已全部保持**：只扣 `blocked`，`risk` / `unknown` 放行，
异常放行且不写入缓存（下次重试，不缓存一个 fail-open 结果）。
配测试 `serves a skill with no receipt at all`。

**验证**：`test/main` 426 files / 4928 tests 全绿；`test/renderer` 112 / 1036 全绿；
安全子集 12 / 237 全绿；`npm run typecheck` 干净。
新增测试均已反向验证（注掉守卫后确认失败）。

---

### 第 2.5 步 — 扣留状态的用户可见性 ✅ 已完成

**为什么插在这里**：第 2 步把扣留从 1 个出口扩到 6 个，等于**把「用户看不到」这个
缺陷的暴露面放大了 6 倍**。一期文档自己写过设计意图 ——

> 返回 ids 而不是直接改列表，是为了让调用方控制怎么呈现，静默丢弃会让用户看到
> skill 无故消失

—— 但呈现层从来没做（实测 `src/renderer` grep `withheld` 零命中）。
不可解释的安全控制会被当成 bug 报上来，或者让用户重装一遍碰运气。
所以在第 3 步之前先补掉。

**关键发现：`listSkills` 和加载门是两套目录，这是好事。**
`features/skills.ts::listSkills` 走 `_allSkillListingsCached`，
**不经过** `model/core-agent/skill-registry`。也就是说面板里的卡片其实一直都在，
问题只是「无法得知它被扣留了」。所以补可见性不需要改扣留逻辑，
只需要在用户可见的那份目录上加标注 —— 改动面比预想小得多。

**改法**：

1. `SkillListing` 加可选字段 `security?: { status: 'withheld'; reason }`。
   **干净时整个字段缺席**，不是 `status: 'ok'` —— 既有测试断言了干净 skill 的
   完整 payload 形状，加常驻字段会破坏它；而且「缺席」正确表达了
   「无事可报」，而不是「已验证通过」。
2. 新增 `_overlaySkillSecurity`，与 `_overlaySkillEnabled` **分开**。
   两者语义不同且不能合并：`enabled` 是用户偏好、可以自己开回来；
   扣留是验证结果、用户开不回来。合成一个 `unavailable` 标志会诱导出
   一个「点一下重新启用」的操作 —— 而那个操作恰恰必须不存在。
   只查 marketplace 来源（回执只描述 marketplace 安装物），异常时静默返回原列表。
3. 前端：卡片加 `is-withheld` 类 + 琥珀色 chip「未通过安检」，
   `title` 说明「安装后文件发生变化，重新安装可恢复」，Use 按钮置灰。
   chip 排在版本/分类 chip **之前** —— 它解释了卡片为什么是灰的，得先被读到。
   视觉上与 `is-disabled` 有区分（名称保留琥珀色），因为一格灰卡片里
   用户要能看出哪个是自己关的、哪个是开不回来的。

**执行报错走 i18n**：`E_SKILL_WITHHELD` 的说明文字改走 `bash.error.skill_withheld`
（zh/en/ja/pt 四语）。
**这里我修正了自己先前的判断**：本以为 `local-tools.ts` 全部 69 处 `errText`
都是给模型看的英文、不该本地化。实际有一个既有先例 `translateFixedBashError`
用 `bash.error.*` 本地化 —— 因为渲染层会把失败工具调用的 content 当
`result_preview` 显示在对话流里，**用户是会读到的**。
模型读稳定的 `E_*` 码，人读后面那句话，两者不冲突。

Runtime worker 侧（`E_RUNTIME_SKILL_WITHHELD`）**保持英文未本地化**：
该 worker 全模块无任何 i18n 依赖，为一条错误引入 i18n 不值得，
且它的错误是协议级的、面向调用方而非终端用户。

**测试**：
- `test/main/features/skills.test.ts` +5：标注而非丢弃、与 `enabled` 相互独立、
  干净时字段缺席、custom 从不标注。
- `test/renderer/category-tabs.test.ts` +3：chip 渲染 + Use 置灰、
  正常卡片不受影响、**扣留与「仅停用」可区分**。
  （踩了个坑：该测试的 `t()` 是固定 key 映射的 stub，新 key 必须注册进去，
  否则 chip 渲染成空字符串而测试看起来「通过了」。）
- 全部反向验证：注掉 overlay / 注掉 `_isSkillWithheld` 后确认目标测试失败。

**结果**：`test/main` 426 files / 4932 tests、`test/renderer` 112 / 1039、
`typecheck` 干净。

**仍未做（第 3 步一起）**：`skills.trust.list` 这个 IPC 已存在但无界面消费，
用户目前没有途径查看「我的 skill 上次检查时间 / 结论」。

---

### 第 3 步 — reconcile + 私有 skill 接安装门


**3a. reconcile**：`_pullSkillLocked` 在 `SKILL.md` 存在性检查后、写
`_install.json` 前，补 `validateSkillDir` + `persistQualityReport` + `writeReceipt`，
与 `marketplace.ts:932-968` 对齐（含 `enforceSkillRunner: false` —— reconcile 同样是
恢复已发布字节，不重新审运行器契约）。

**这里有个需要决定的取舍**：reconcile 是后台同步。

- fail closed → 另一台设备装的 skill 在这台设备静默消失
- fail open → 违背安装门语义

**倾向 fail closed + 留痕**：写 `blocked` 回执、`log.warn`、UI 可见。
理由是 fail closed 的失败模式（少一个 skill，有提示）比 fail open 的失败模式
（装进来了，靠加载门兜）更容易发现和排查。

**顺带修一个一期遗留**：`withheld` 目前在渲染层**完全没有消费**
（实测 grep `src/renderer` 无命中，只有 `skill_reverify.ts:185` 一行 `log.warn`）。
一期文档自己写了「返回 ids 而不是直接改列表，是为了让调用方控制怎么呈现，
静默丢弃会让用户看到 skill 无故消失」—— 但呈现层没做。
第 3 步顺带补上，与 reconnect 的 blocked 提示复用同一个面。

**3b. 私有 skill**：install（`marketplace.ts:831`）和
reconcile（`marketplace_reconcile.ts:1177`）解压后，遍历私有 skill 子目录
逐个 `validateSkillDir`。私有 skill 的回执 key 需要和普通 skill 区分
（同一个 skillId 可能既是私有又是公开安装），建议 receipt 文件名带 agent 前缀 ——
**这需要动 `skill_trust.ts::_receiptFile` 的 key 规则，是本期唯一的存储格式变更**，
要考虑旧回执的兼容（缺失即重扫，天然兼容，但要写测试锁住）。

出口侧：`getSystemPromptBlock:887` 的私有 specs 分支纳入扣留（并入第 2 步）。

**代价**：一天。

---

### 第 2.6 步 — 安检状态可见面（方案 B）✅ 已完成

第 2.5 步解决了「出问题时看得懂」，但**平时看不到** —— 安全功能做好了，
用户的体验就是什么都没发生，于是它看起来像什么都没做，直到某天拦住了东西。
这一步让机制在一切正常时也可见。

**后端**：`SkillListing.security` 从「只报 withheld」扩成四态
`verified / risk / withheld / unchecked`，附带 `scannedAt` / `validatorVersion` /
`findingCount`。数据来自 `listReceipts`，**不额外重扫** ——
`partitionSkillsByTrust` 已经把过期的重扫过了，此时读到的回执就描述盘上的字节。

**契约变更**：干净的 marketplace skill 现在**会**返回 `security`（`verified`），
不再是「缺席」。第 2.5 步刚定的「缺席=无事可报」在这里被推翻,
因为徽章要回答的恰恰是「到底查过没有」—— 沉默无法与「已验证」区分。
`security` 缺席现在只表示「不是 marketplace 安装物」。对应测试已改。

**前端**：
- 卡片标题右侧一个灰色小盾牌,`title` 里写结论 + 检查时间 + 校验器版本。
  健康态刻意低调(灰度 + 低透明度),不与 skill 自身信息抢注意力。
- withheld **不显示盾牌** —— 已有文字 chip 说明了,再加一个是噪声。
- 网格上方一行汇总:「N 个技能已通过安检 · M 个待检查」,
  只有真的有 withheld 时才转琥珀色 `needs-attention`。
  健康态不能长得像警告横幅,否则用户学会忽略它。
- 汇总行带「重新检查」按钮,调既有的 `skills.trust.reverify`(逐个扇出,
  单个失败不中断整批)。理由:用户看到「3 个待检查」需要一个出口,
  否则会去随机重装。

**顺带修了一个既有 bug**：Use 按钮的点击判定挂在**卡片**上而非按钮上,
只检查 `is-disabled`。所以 withheld 卡片虽然按钮渲染成 `disabled`,
点上去仍会触发 `useSkill`。已加 `is-withheld` 判定。

**为了让徽章有意义,必须先做第 4 步** —— 见下。

**测试**：后端 +2 改 1（verified 状态 + 只有 LOW 时不报 risk）；
前端 +5（盾牌渲染与 tooltip、withheld 不双标、汇总计数、withheld 升级样式、
custom-only 不显示汇总）。反向验证均确认失败。

又踩了一次同类坑:测试 harness 的 `t()` 只替换 `{count}`,
我的新文案用 `{n}` / `{version}`,不补进去的话占位符会原样渲染,
而断言可见文本的测试**看起来是通过的**。已扩展 harness。

---

### 第 4 步 — MEDIUM 噪声 ✅ 已完成（提前，因为它变成了用户可见问题）

原计划是「1 小时的噪声清理」，优先级最低。做安检面时发现**它其实是阻塞项**。

实测：用真实 builtin 语料模拟徽章状态，结果是
`{verified: 0, risk: 5}` —— **每一个有回执的 skill 都会显示「有提示」**，
其中 4/5 的原因是 `skill_meta_category_missing`。
一个对所有东西都报警的警告等于没有警告,而且会训练用户忽略徽章。

**改法**：`skill_meta_category_missing` MEDIUM → LOW（`quality/rules/schema.ts`）。
理由:缺 `_meta.json` 是绝大多数已发布 skill 的常态默认,skill 照样能跑,
这是 marketplace 目录完整性问题而非安全信号。
`skill_meta_category_invalid` **保持 MEDIUM** —— 「设了但设错」提示可能是笔误或
过期代码,值得看;「没设」是无害默认。两者不能塌成同一级。

**改完复测**：`{verified: 4, risk: 1}`,剩下那 1 个是
`frontmatter_description_too_long`,是真实发现。徽章现在有意义了。

**`VALIDATOR_VERSION` 0.6.0 → 0.6.1**。这会让所有已存回执失效并触发重扫 ——
是设计好的联动,也顺便让旧回执补上新增的 `topLevel` 字段。

---

### 第 5 步 — Quarantine 隔离区（未做，记为待办）

**改法**：`_installMarketplaceSkillLocked`（`marketplace.ts:890`）从
「解压到最终位置 → 校验 → 失败 rm」改成
「解压到 `.staging-<random>` → 校验 → 通过则 `rename` 到最终位置」。

已确认（§4）：tree hash 路径无关，validator 读 `path.join(skillDir, 'SKILL.md')`
不依赖目录名。

**要处理的细节**：

1. staging 目录必须与最终位置**同一文件系统**，否则 `rename` 跨设备失败。
   放在 `userMarketplaceSkillsDir(uid)` 下的兄弟目录，不要用 `os.tmpdir()`。
2. 命名避开 `context.ts` 的 `VENDOR_DIRS` / `TEST_DIRS`（§4），配测试锁住。
3. 最终位置已存在时，`rename` 不会覆盖非空目录 —— 需要
   「rename 旧的到 `.trash-<random>` → rename 新的到位 → 删 trash」，
   或先 `rm` 旧的（回到有窗口的状态，但窗口从「恶意内容留下」缩小成「skill 暂时缺失」）。
   **倾向前者。**
4. 进程被杀留下的 staging / trash 目录需要清理 —— 挂到
   `util/boot_init.ts` 的启动清理里（不要用启动定时器，见 CLAUDE.md）。
5. loader 扫描 `userMarketplaceSkillsDir` 时必须跳过 staging / trash 目录，
   否则半成品会被当成已安装 skill。`marketplace-tree-hash.ts` 的
   `MARKETPLACE_TREE_HASH_SKIP_NAMES` 已跳过 `.` 开头的名字，
   但 skill loader 侧要单独确认。**这一点未验证，实施时先查。**

**代价**：半天，细节比想象多（尤其第 3、5 点）。

---

## 六、本期不做

| 项 | 原因 |
|---|---|
| 第 5 批规则（Go / Rust / Java） | 语料为零，加了等于未验证。需先确认是否支持这些语言 |
| 漏报率标定 | 需要真实恶意样本，是独立量级的工作。一期已如实标注 |
| 语义审查放开 `advisoryOnly` | 精度无数据，保持封顶到 MEDIUM |

---

## 七、验证

每步都跑：

```bash
npm run typecheck
```

改规则必跑校准门：

```bash
node scripts/run-tests.mjs run test/main/quality/builtin-calibration.test.ts
```

安全相关全部（基线：12 files / 237 tests，实测全绿）：

```bash
node scripts/run-tests.mjs run test/main/quality test/main/features/skill-trust.test.ts test/main/features/cognition-gate.test.ts test/main/features/cognition-semantic-review.test.ts
```

第 2、3 步动了 IPC / registry / reconcile，按一期踩过的坑必须跑到 `test/main`：

```bash
node scripts/run-tests.mjs run test/main
```

收尾全量：

```bash
node scripts/run-tests.mjs run test/main test/renderer
```

并行抖动判断沿用一期方法：失败后单独跑该文件，单独过 → 负载抖动，
单独也失败 → 真回归。已知抖动用例：`codex_t2-04_real_run`、`group_chat/bus`、
`runtime-controller`。

**规则等级变更（第 4 步）后 bump `VALIDATOR_VERSION`**（`quality/types.ts:88`），
这会让已有回执自动失效并触发重扫 —— 是设计好的联动，不是副作用。
