# Skill Sentry

Skill 安全静态扫描 + 全生命周期信任网关。前身为个人项目 `cogseed-security-scan`，
2.0.0 起完成工程化重构，参照 `security-skills`（技能治理体系）的设计
支柱做了以下提升：

- **模块化引擎包**：`engine/scanner_core/` 从单文件脚本拆分为职责单一的
  模块（规则加载、文本规则、二进制规则、打分、报告组装、路径安全）。
- **规则版本化**：`engine/rulesets/v1.0.0/` 独立于引擎代码演进，配
  `version-policy.yaml` 声明兼容性。
- **输出契约 schema 化**：`engine/schemas/report-schema.json` 强制约束
  9 字段报告结构，`tests/conformance/` 自动校验。
- **能力边界机器可读化**：`engine/capabilities.yaml` 统一声明已实现/
  未实现能力，替代散落在多份文档里的自然语言局限声明。
- **回归测试体系**：`tests/conformance/v1.0.0/` 锁定已知样本的分数/
  分级/建议，防止未来重构悄悄改变检测行为。
- **信任链补齐单元测试**：`runtime_trust/tests/` 覆盖签名篡改检测、
  TOCTOU 内容篡改检测等核心防护场景。

详细使用说明见 [SKILL.md](./SKILL.md)。设计过程与原项目对照见
[docs/与原项目对照.md](./docs/与原项目对照.md)（历史文档，指原 cogseed-security-scan
与更早的四维治理套件的对照，本次重构未改变检测能力范围，仅提升工程严谨性）。

## 快速开始

```bash
# 扫描
python3 -m engine.scanner_core.report --artifact /path/to/skill --fail-on DO_NOT_INSTALL

# 回归验证
python3 tests/conformance/v1.0.0/run_conformance.py

# 单元测试（52 个用例）
python3 -m pytest tests/unit/ runtime_trust/tests/
```

## 目录说明

| 目录 | 内容 |
|---|---|
| `engine/` | 检测引擎：scanner_core 模块、版本化规则包、schema、能力声明 |
| `sandbox/` | Docker 隔离扫描层，供 Agent 安全扫描不可信 Skill |
| `runtime_trust/` | 信任链：trust_root（防篡改自检）、trust_ledger（TOCTOU 防护）、skill_guard（对外网关入口） |
| `tests/` | 回归向量、样例 fixtures、单元测试 |
| `docs/` | 设计文档 + 给领导评审的文档（历史遗留，未按新架构更新，仅供参考） |

## 已知局限

见 [engine/capabilities.yaml](./engine/capabilities.yaml)（机器可读）或
[SKILL.md](./SKILL.md) 底部（人类可读摘要）。核心局限：仅静态分析，
未接入动态沙箱行为分析；未接入恶意代码特征库；未做大规模误报率基线验证。
