# Skill Sentry

Skill 安全静态扫描 + 全生命周期信任网关 + 路径级组合风险。前身为个人项目
`cogseed-security-scan`，2.0.0 起按 CogSeed 技能治理体系设计。

## 2.2.0 新增了什么（以及为什么）

| 能力 | 解决的具体问题 | 入口 |
|---|---|---|
| **反规避派生视图** | 把关键词用零宽字符切断、或把载荷 base64 编码后藏起来，可以让纯正则扫描完全失明。学术实测（Cloak and Detonate, arXiv 2607.02357）显示这类手法对 8 个扫描器的绕过率 >90%。 | `engine/scanner_core/derived_views.py` |
| **不可见内容检测** | Unicode 标签块、双向控制符、隐藏样式、HTML 注释指令、Markdown 链接外带——对人不显示、对模型可见。 | `engine/scanner_core/hidden_content.py` |
| **混淆载荷检测** | 「解码动作 × 执行动作」共现、长编码串熵、转义串、shell 管道解码执行。 | `engine/scanner_core/obfuscation.py` |
| **代理指令分析** | 不需要代码就能生效的越权指令（隐瞒、跳过确认、改写宿主配置、索取凭据）。带前置与内部两级否定守卫，能区分「要求跳过确认」与「禁止跳过确认」。 | `engine/scanner_core/agentic_rules.py` |
| **供应链分析** | 安装钩子、依赖源覆盖、运行时未固定安装、拼写伪装、CI pwn request。 | `engine/scanner_core/supply_chain.py` |
| **文件结构检查** | 可执行载荷、嵌套归档、符号链接逃逸、内嵌 `.git`、setuid/setgid。 | `engine/scanner_core/structural.py` |
| **可解释评分** | 按类别封顶 + 指数衰减 + severity×confidence；输出逐类别扣分与触发的分数下限。 | `engine/scanner_core/scoring.py` |
| **标准编号映射** | CWE / OWASP LLM Top 10 (2025) / OWASP Agentic Top 10 / **OWASP Agentic Skills Top 10 (AST01–AST10)**。 | `engine/scanner_core/mappings.py` |
| **SARIF 2.1.0 导出** | 让结果进入 GitHub code scanning / DefectDojo 一类既有告警流程，按 CWE 与其它扫描器归并。 | `engine/scanner_core/sarif.py`、`--format sarif` |
| **风险接受（抑制）** | 逐条记录「我知道这条，我接受」，必须写理由 + 到期日；**高危与一票否决永不可抑制**。 | `engine/scanner_core/baseline.py` |
| **覆盖缺口即发现项** | 「部分扫描得到的干净结果不是干净的证据」——跳过的文件、编译失败的规则、缺失的外部工具都作为 `info` 级发现项出现在列表里。 | `report.py::coverage_findings` |

## 2.2.0 的实测校准（不是宣传口径）

- **内置语料 66 个 Skill：误报 0**。校准前有 2 例误拒装——恰好是自家的
  `agent-creator` / `skill-creator`，它们的「安全守则」章节写的是**禁止**
  `curl | sh`、**禁止**读 `~/.ssh`，而闸门把禁止读成了行为。
- **对抗用例 21 组**（`tests/unit/test_detectors.py`）：正例全部命中，反例全部干净。
- **规则条数 181**（v1.0.0 为 58），12 个规则组 + 70 条密钥模式 + 2 条一票否决。
- **反规避有效性**：`tests/fixtures/v2-samples/sample-evasion-skill` 里没有任何
  明文的危险串（一处零宽切断、一处 base64），全部在派生视图里被检出。

## 已知局限

见 [engine/capabilities.yaml](./engine/capabilities.yaml)（机器可读，含每条能力的
`report_fields` 与局限）或 [SKILL.md](./SKILL.md) 底部。核心局限：仅静态分析，
不执行被扫描代码；未接入 YARA 与动态沙箱；未做大规模误报率基线验证。

## 快速开始

```bash
# 扫描
python3 -m engine.scanner_core.report --artifact /path/to/skill --fail-on DO_NOT_INSTALL

# SARIF 导出（接 GitHub code scanning / DefectDojo）
python3 -m engine.scanner_core.report --artifact /path/to/skill --format sarif --output out.sarif

# 人类可读摘要
python3 -m engine.scanner_core.report --artifact /path/to/skill --format summary

# 回归验证（锁定分数/分级/建议 + 正反例契约）
python3 tests/conformance/v1.1.0/run_conformance.py

# 单元测试
python3 -m pytest tests/unit runtime_trust/tests
```

## 目录说明

| 目录 | 内容 |
|---|---|
| `engine/` | 检测引擎：scanner_core 模块、版本化规则包（`rulesets/v1.1.0`）、schema、能力声明 |
| `sandbox/` | Docker 隔离扫描层，供 Agent 安全扫描不可信 Skill |
| `runtime_trust/` | 信任链：trust_root（防篡改自检）、trust_ledger（TOCTOU 防护）、skill_guard（对外网关入口） |
| `tests/conformance/` | 回归向量：锁定已知输入的打分/分级/建议，含正例与反例 |
| `tests/fixtures/` | 样本 Skill（安全 / 恶意 / 防御 / 反规避 / 纯散文守则） |
| `tests/unit/` | 单元测试，含每条新规则的正反例配对 |

## 规则包版本

当前版本由 `engine/rulesets/CURRENT` 声明（不是硬编码在代码里），
因此升级规则包只需要改一处。`engine/rulesets/v1.0.0` 仍可显式加载用于
比对历史判定，但它不含 2.2.0 新增的 5 个规则组，`coverage.rule_groups`
会如实反映这一点。
