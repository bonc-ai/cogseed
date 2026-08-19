---
name: skill-sentry
description: "针对 Skill 的强制安全扫描 + 信任网关：静态检测危险命令、注入、密钥、恶意模式、Prompt Injection 载荷、持久化、数据外传、二进制行为线索，输出 Security Score / 风险分级 / 部署建议，并通过信任根 + 信任台账提供全生命周期防篡改保护。"
version: 2.1.0
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

## 架构

```
engine/               检测引擎（可独立安装的 Python 包）
  scanner_core/        文本规则匹配、二进制静态分析、打分、报告组装
    context.py         语言分派 + 上下文降权（2.1.0）
  rulesets/v1.0.0/      版本化规则包（text-rules / secret-patterns）
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
7. `vulnerability_findings` — 依赖漏洞（需 osv-scanner）
8. `required_mitigations` — 必须整改项
9. `deployment_recommendation` — ALLOW / CAUTION / DO_NOT_INSTALL

## 环境与降级策略

- 仅需 `python3`，不硬依赖 pyyaml / Docker。
- 装了 `gitleaks` → 增强密钥扫描；否则用内置正则兜底。
- 装了 `osv-scanner` → 依赖漏洞(CVE) 扫描；否则跳过并标注。
- 装了 `strings` → 增强二进制字符串抽取；否则用纯 Python 兜底。
- 装了 `docker` 且已构建 `skill-security-scanner:local` 镜像 → 沙箱隔离扫描；
  否则降级为本地直跑（`degraded-local`，报告中显式标注可信度较低）。

## 测试与验证

```bash
# 回归向量：锁定已知样本的分数/分级/部署建议，防止重构悄悄改变行为
python3 tests/conformance/v1.0.0/run_conformance.py

# 单元测试（145 个用例，覆盖 scoring/path_security/context 及信任链）
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
- 二进制扫描当前仅静态层（strings + 指标匹配），**未接入动态沙箱**，无法确认
  二进制真实运行时行为（写了什么 / 发到哪）。这是需单独立项的后续工作。
- 未接入恶意代码特征库（如 YARA）。
- 误报率基线目前只在 43 个 Skill 的单一语料上验证（结果：误报 0）。该语料以
  Markdown + Python + TS 为主，不含 Go/Rust/Java，也不含真实恶意样本——真阳性
  率仍只由合成样本与 8 个对抗用例覆盖，尚未在大规模真实恶意语料上标定。
