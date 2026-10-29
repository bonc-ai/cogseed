---
name: skill-sentry
description: "针对 Skill 的强制安全扫描 + 信任网关：静态检测危险命令、注入、密钥、恶意特征（内置 YARA 子集引擎与签名包）、Prompt Injection 载荷、不可见内容（零宽/标签块/双向控制符）、混淆与编码载荷、代理运行时指令、供应链与安装钩子、持久化、数据外传、二进制行为线索、依赖漏洞（内置 OSV 快照）；归一化与解码后重扫以对抗规避；输出可解释的 Security Score / 风险分级 / 部署建议 / CWE 与 OWASP 编号 / SARIF，并通过信任根 + 信任台账 + 有到期日的风险接受提供全生命周期防篡改保护。"
version: 2.3.0
author: CogSeed
license: Apache-2.0
platforms: [linux, darwin]
prerequisites:
  commands: [python3]
  optional_commands: [gitleaks, osv-scanner, strings, docker]
metadata:
  tags: [security, skill, scanner, gate, static-analysis, trust-chain]
  requires_toolsets: [terminal]
---

# Skill Sentry

针对 **Skill** 的安全扫描 + 信任网关，定位为 Skill Factory / Agent Factory /
Companion Agent / Task Agent 的**强制安全入口**。前身为 `cogseed-security-scan`（1.0.0），
2.0.0 起完成工程化重构：模块化引擎包、规则版本化、输出契约 schema 化、
回归测试体系。2.1.0 引入上下文感知层，把裁决层从「对任何目录都告警」
校准到可用于实际拦截（见下节）。

## 何时使用

- 任何 Skill 在安装 / 发布 / 上线前的强制安全检查（一次性扫描）。
- 需要在 Skill 已安装后持续防止内容被篡改（信任台账 + TOCTOU 防护）。
- 需要对 Skill 输出 Security Score、风险分级和部署建议（ALLOW / CAUTION / DO_NOT_INSTALL）。

## 2.3.0 新增（先读这一节）

2.3.0 补的是 2.2.0 页面上两个「未完善」的检测能力。共同点是：**不再依赖用户
另装一个工具**，同时把能力边界写进报告，而不是写成一句宣传语。

**原生依赖漏洞扫描**（`engine/scanner_core/dependency_inventory.py` +
`vulnerability.py`）
从 `package.json` / `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` /
`requirements*.txt` / `poetry.lock` / `uv.lock` / `Pipfile.lock` 里抽出**实际
装上的版本**，与随规则包发布的 OSV 快照做区间匹配。没有 osv-scanner、没有网络
也能给出 `dependency_vuln` 结论；装了 osv-scanner 时它仍然会跑，结果按公告 id
去重后合并。

- 只有锁文件/精确固定的版本参与区间判定。`^1.2.3` 代表一次未来的求解，拿它
  匹配漏洞是在猜——已知恶意包是唯一例外（包名本身就是结论）。
- 快照覆盖常见 npm/PyPI 包（254 个包、1496 条公告，截至生成日期），**不是完整
  CVE 镜像**；截止日期写在 `coverage.vulnerability_db.as_of`。
- 刷新快照：`python3 tools/refresh_vulnerability_db.py`（需要网络，生成后随
  规则包一起提交）。

**原生恶意特征匹配**（`engine/scanner_core/yara_lite.py` + `signatures.py`）
签名包改为标准 `.yar` 文件（`rulesets/<version>/yara/`，49 条），由纯 Python
的 YARA **子集**解释器执行。规则能表达「WebShell 的执行入口 + 请求来源」
「挖矿协议 + 矿池」「凭据读取 + 外传」这类组合，而不是一条条孤立关键词。

- 命中同样经过 `context.py` 的上下文降权：写在「禁止使用反向 shell」文档段落
  里的示例仍是 low，不会重新变成拦截。
- 不支持的语法（`for` 循环、`pe.*` / `math.*` 模块、`xor` 修饰符）逐条报进
  `coverage.signature_pack.errors`；一条坏规则不会让整包失效，也不会被静默跳过。
- 命中不回显匹配到的字节：规则名与作者写的说明进 `description`，命中的片段
  可能是载荷或密钥本身。

## 2.2.0 新增（先读这一节）

2.2.0 的两条主线都是「让静态扫描不再容易被绕过」，以及「让一份结论能被追问」。

**反规避：归一化 + 解码后重扫**（`engine/scanner_core/derived_views.py`）
每个文件会被再扫两遍：一遍是**归一化视图**（删除不可见字符 → NFKC 折叠 →
西里尔/希腊同形字折回拉丁），一遍是**迭代解码视图**（base64/hex，最多 3 层）。
两者都是「同一套规则、不同的文本」。派生视图的命中置信度降一档，并在报告里
带 `derived` 字段标明来自哪个视图。学术实测显示，只做外观审计的扫描器对
「把载荷藏起来、执行时再还原」这类手法的绕过率超过 90%。

**不可见内容检测**（`hidden_content.py`）
Unicode 标签块（U+E0000–U+E007F）、零宽字符、双向控制符、变体选择符成串、
ANSI 转义、HTML 注释内的指令、隐藏样式、Markdown 链接外带、同形字混排。
这类载荷**不做上下文降权**：藏进哪一层目录都不改变「它不可见」这一事实。

**代理指令分析**（`agentic_rules.py`）
不需要代码就能生效的越权指令——要求隐瞒行为、跳过确认、改写宿主代理配置、
索取凭据、把结果发往外部。三层精度：结构层（路径/开关/MCP 键，不降权）、
祈使层（按上下文降权）、组合层（弱信号配对）。带**否定守卫**：中文里
「要求跳过确认」与「禁止跳过确认」写法同形，靠前置与内部两级否定词区分。

（2.2.0 的默认动作是**把两者都报出来**：前者命中、后者不命中。实测这一条
曾经被违反——自家两个创作技能的「安全守则」被判成实际行为，导致它们
**无法安装**。）

**供应链 / 结构 / 评分 / 输出**
安装钩子、依赖源覆盖、拼写伪装、CI pwn request；可执行载荷、嵌套归档、符号
链接逃逸、内嵌 `.git`、setuid；按类别封顶 + 指数衰减 + severity×confidence
的可解释评分；CWE / OWASP LLM / OWASP Agentic / **OWASP Agentic Skills
Top 10 (AST01–AST10)** 映射；SARIF 2.1.0 导出；有理由与到期日的风险接受
（**高危与一票否决永不可抑制**）。

**覆盖缺口即发现项**
跳过的文件、编译失败的规则、缺失的外部工具都会作为 `info` 级发现项出现在
发现项列表里。理由：**部分扫描得到的干净结果，不是「这个包是干净的」的证据**。

## 上下文感知（2.1.0 新增，理解报告的前提）

纯正则扫描的误报几乎全部源于「同一字符串在不同上下文里含义不同」。实测在
43 个真实官方 Skill 上，旧版本有 1 例误判 `DO_NOT_INSTALL`、31 例误判
`CAUTION`——其中被判死的那个 Skill，扣分点恰是它**拦截** SSRF 的防御代码。
一个对几乎所有正常内容都告警的门是没有信息量的，只会训练用户无脑放行。

2.1.0 用两条机制校准，均属**修正规则用错对象**，不是放宽检测：

1. **语言分派**（`context.py::rule_applies_to`）：Python 专属规则不再施加于
   `.js/.ts`。JS 的 `re.exec()` 不是 Python 的动态执行 `exec()`。
2. **上下文降权**（`context.py::severity_for`）：命中所处上下文决定生效
   severity。**降权只降级、绝不删除 finding**，审计者始终可见。

| 上下文 | 降档 | 依据 |
|---|---|---|
| `source` | 0 | 正常源码，不降权 |
| `doc` | 1 | 文档围栏代码块——用户会照抄执行 |
| `comment` | 2 | 注释 / docstring——解释而非行为 |
| `test` | 2 | 测试代码——攻击串是断言输入 |
| `prose` | 2 | 文档散文——仅文字提及，不可执行 |
| `vendor` | 2 | 第三方 / 压缩产物——非本作者代码 |

**不受降权影响**：`hard_block` 一票否决项恒为 critical（测试目录同样能藏真实
外传代码）。

每条 finding 因此新增三个审计字段：`context`、`original_severity`、`demoted`。

配套的裁决层修正：

- **SR 证据门槛**：`SR-01/03/04` 需生效 severity ≥ medium 才算证据。原实现下
  info 级的 `http_url` 规则会让「文档里写了一个网址」==「有数据外发风险」。
- **`required` 语义边界**：`required=True` 只用于**有证据的安全缺陷**
  （SR-01/03/04）。`SR-02/05/08` 是**声明缺失**（没写 allowed_tools / HITL /
  审计），属成熟度问题，改为 advisory——仍出现在 `required_mitigations`
  供作者改进，但不再左右部署建议。
- **未降权 critical 单条即拒装**：源码里明写 `rm -rf /` 原先只到 CAUTION
  （扣 40 分 → 60 分 → HIGH）。降权层落地后「仍是 critical」已具备足够置信度，
  故收紧为 `DO_NOT_INSTALL`。实测官方语料生效 critical 数为 0，不引入误阻断。

校准结果：43 个官方 Skill 全部 `ALLOW`（误报 0），恶意样本仍 `DO_NOT_INSTALL`，
且 8 个「把恶意代码藏进 test/vendor/注释/文档以求降权放行」的对抗用例全部未逃脱。
**但这不等于没有绕过通道**：更宽的对抗门禁见 `tests/conformance/adversarial/`
（图像承载指令、嵌套归档、反例标记洗 severity、`X = """…"""` 之后的代码被判成
注释、变量中介 + 自研解码器），其中 6 条当前仍在逃脱。

## 架构

```
engine/               检测引擎（可独立安装的 Python 包）
  scanner_core/        文本规则匹配、二进制静态分析、打分、报告组装
    context.py         语言分派 + 上下文降权（2.1.0）
  rulesets/v1.0.0/      历史规则包（仅文本规则，保留用于比对）
  rulesets/v1.1.0/      上一版规则包（文本规则 + 密钥模式）
  rulesets/v1.2.0/      当前规则包（+ vulnerabilities.jsonl + yara/ 签名包）
  schemas/              report-schema.json（9 字段输出契约）
  capabilities.yaml    机器可读的能力边界声明
  exit-code-registry.yaml  CLI 退出码语义表
sandbox/              Docker 隔离扫描层（agent_gate 编排，只暴露裁决面）
runtime_trust/        信任链：trust_root（防篡改自检）→ trust_ledger（TOCTOU 防护）→ skill_guard（install_gate/load_gate）
tests/
  conformance/v1.0.0/  回归向量 + 自动化断言（run_conformance.py）
  fixtures/            正例/反例样本
    legacy-samples/     安全样本 / 恶意样本
    context-samples/    上下文降权样本（防御代码不得被判成攻击代码）
  unit/                scoring / path_security / context 单元测试
docs/                 设计文档 + 评审文档
```

## 如何运行

```bash
# 扫描单个 Skill 目录
python3 -m engine.scanner_core.report \
  --artifact /path/to/skill-dir \
  --output report.json \
  --fail-on DO_NOT_INSTALL
```

`--artifact` 接受：Skill 目录、含 SKILL.md 的目录、或 Skill zip 包。
`--fail-on` 达到该部署建议等级时以非 0 退出码返回，用于 CI / 发布流程强制拦截。

## 可编程调用（供工厂系统集成）

```python
from engine.scanner_core import scan

report = scan("/path/to/skill-dir")
if report["deployment_recommendation"] == "DO_NOT_INSTALL":
    raise SystemExit("Skill 被安全扫描拦截")
```

## 全生命周期信任网关（新增于 2.0.0，原 07_agent_runtime 设计）

**两层取更严**：`evaluate_skill` 计算隔离层与本地层的结论并采用更严的那个
（隔离层已判拒装时直接返回），把两层的结论、隔离状态与各自 `scanner_version`
放进 `tier_evidence`。
理由是可测量的：镜像内的引擎可能落后于当前引擎（实测镜像停在 1.0.0，对
`os.system('rm -rf /')` 只给 CAUTION，而当前引擎给 DO_NOT_INSTALL）。
「沙箱优先」在那种情况下等于让更旧的引擎覆盖更新的引擎——装了 Docker 的机器
门禁反而更弱。隔离层可以加强结论，不能削弱结论。

```python
from runtime_trust.skill_guard import install_gate, load_gate

# 安装前：按来源分级策略（official/community/thirdparty）决定 allow/confirm/deny
decision = install_gate("/path/to/skill", source="thirdparty")

# 每次加载前：重算内容哈希，防止“装完再改”的 TOCTOU 攻击
gate = load_gate("/path/to/installed-skill")
if not gate["allow_load"]:
    raise SystemExit(gate["user_message"])
```

## 输出字段（9 项核心契约，见 engine/schemas/report-schema.json）

1. `security_score` — 0-100 加权评分
2. `risk_classification` — CRITICAL / HIGH / MEDIUM / LOW
3. `attack_surface` — 外联点、动态执行点、持久化点、二进制文件
4. `permission_summary` — 权限声明、HITL、副作用
5. `data_access_summary` — 网络使用、外发 findings、二进制网络指标
6. `dangerous_action_list` — 危险动作清单
7. `vulnerability_findings` — 依赖漏洞（内置 OSV 快照；osv-scanner 为可选增强）
8. `required_mitigations` — 必须整改项
9. `deployment_recommendation` — ALLOW / CAUTION / DO_NOT_INSTALL

## 环境与降级策略

- 仅需 `python3`，不硬依赖 pyyaml / Docker。环境没有 pyyaml 时使用 skill 自带的
  `vendor/yaml` 副本，规则集强度不随运行环境变化；两者都不可用时
  `ruleset_resolved=False` 并回退内置规则（规则数由 181 条降到 64 条，报告里写明）。
- 装了 `gitleaks` → 增强密钥扫描；否则用内置正则兜底。
- 依赖漏洞扫描与 YARA 匹配是**原生能力**，不需要额外工具；规则包缺失
  `vulnerabilities.jsonl` / `yara/` 时报告会明确标注「未加载」。
- 装了 `osv-scanner` → 依赖漏洞查询扩展到完整 CVE 镜像；否则使用内置快照。
- 装了 `strings` → 增强二进制字符串抽取；否则用纯 Python 兜底。
- 装了 `docker` 且已构建 `skill-security-scanner:local` 镜像 → 沙箱隔离扫描；
  否则降级为本地直跑（`degraded-local`，报告中显式标注可信度较低）。

## 测试与验证

```bash
# 回归向量：锁定已知样本的分数/分级/部署建议，防止重构悄悄改变行为
python3 tests/conformance/v1.1.0/run_conformance.py

# 对抗门禁：已证实的绕过通道 + 必须守住的对照，随 npm test 一起跑。
# 基线当前记录 6 条攻击向量仍在逃脱（图像与归档两条载体通道完全不可见，
# 其中图像那条在三个来源上都可装）；修好之后用 --update-baseline 收紧缺口。
python3 tests/conformance/adversarial/run_adversarial.py
python3 -m pytest tests/conformance/adversarial -q

# 单元测试（scoring/path_security/context、依赖清单解析、版本区间、YARA 子集、信任链）
python3 -m pytest tests/unit/ runtime_trust/tests/
```

## 已知局限（机器可读版见 engine/capabilities.yaml）

- 文本检测以正则 / 关键词为主，存在误报与漏报；Score 为启发式度量而非绝对结论。
- 上下文降权基于**静态启发式**：文件路径命名（`test/`、`vendor/`）与轻量注释
  解析。它降低了噪音，但攻击者可把恶意代码放进 `test/` 目录以求降权——实测该
  路径**不能**逃脱裁决（降权后仍报 CAUTION，hard_block 与未降权 critical 不受
  影响），但严重级会被压低。若用于强制拦截，建议同时消费 `original_severity`。
- 块注释解析不处理字符串内嵌引号等边缘情况；不确定时**不**标记为注释（保持
  原级别告警），取舍偏向避免漏报。
- 二进制扫描当前仅静态层（strings + 指标 + YARA 签名），**未接入动态沙箱**，
  无法确认二进制真实运行时行为（写了什么 / 发到哪）。这是需单独立项的后续工作。
- 依赖漏洞快照有截止日期，且只覆盖常见 npm/PyPI 包；未安装 osv-scanner 时，
  快照之外的公告不会被发现。清单里的版本范围不参与判定。
- YARA 引擎是子集实现：不支持 `for` 循环、`pe/math` 模块与 `xor` 修饰符；
  第三方 YARA 规则库直接放进签名包前，需先确认没有落在不支持列表里。
- 误报率基线目前只在 43 个 Skill 的单一语料上验证（结果：误报 0）。该语料以
  Markdown + Python + TS 为主，不含 Go/Rust/Java，也不含真实恶意样本——真阳性
  率仍只由合成样本与 8 个对抗用例覆盖，尚未在大规模真实恶意语料上标定。
