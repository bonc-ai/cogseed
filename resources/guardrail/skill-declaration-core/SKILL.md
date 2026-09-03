---
name: skill-declaration-core
description: "技能安全声明引擎：提供 Security Manifest 模板与字段说明（3.1）、对 Skill 目录做 PREVALIDATION 预校验与 FORMAL_TEST 正式测试（3.2）、冻结工作树并核对跨报告 subject_digest。用于查询安全声明字段、填写 references/security-manifest.yaml、预检声明与实际是否一致；Triggers: 安全声明, security manifest, 预校验, subject_digest, 冻结校验。"
license: Apache-2.0
---

# Skill Security Core

Skill Security Declaration 3.1 / 3.2 引擎（Engine 1.3.0，Ontology `cogseed.security.skill@1.1.1`）。
本文件是给模型看的**用法说明**，判决权不在这里——见下节。

## 平台约定（先读这一节）

- **本引擎是平台组件，不是可安装的 Skill。** 它位于 `resources/guardrail/`，不经
  marketplace 分发，完整性由同级的 `skill-declaration-core.INTEGRITY` 固定树哈希保护。
  原因是可安装即可替换，而可替换的检查器等于由被检查者挑选检查者。
- **判决由平台侧决定。** 引擎只返回 findings 与退出码；`pass` / `blocked` 的映射在
  `src/main/features/security/skill-declaration-adapter.ts` 的 `verdictFromExitCode`。
  任何情况下都不要按引擎输出的文字自行下结论。
- **基础设施故障一律是 `unknown`，不是 `blocked`。** 解释器缺失、超时、崩溃、
  报告无法解析都归为"没能检查"，不是"内容危险"。
- **规则唯一来源是本引擎。** Ontology、`trust-rules.yaml`、`consistency-rules.yaml`、
  `warning-policy.yaml`、`digest-profile.yaml`、`exit-code-registry.yaml` 仅存在于此，
  不要在别处按 YAML 重新实现规则。

## 何时使用

- 需要查询 Security Manifest 的字段含义、必填项、默认值或支持的 Ontology 版本。
- 需要为一个 Skill 编写 / 修补 `references/security-manifest.yaml`。
- 需要对 Skill 目录做声明与实际的一致性预检（PREVALIDATION）。

## 何时**不要**使用

- 判断一个 Skill 是否含恶意代码 —— 那是 skill-sentry 的职责，本引擎只看声明与结构。
- 计算风险等级 —— **风险派生已停用**（见下"停用项"）。
- 作为交付 / 部署授权 —— 阶段一的报告一致只证明"测的是同一份冻结内容"。

## 能力一：模板与字段（3.1）

只允许**精确版本匹配**，当前基线 `1.1.1`。先用 `list-supported-versions` 确认。

```bash
python3 scripts/template_cli.py --ontology-version 1.1.1 get-template
python3 scripts/template_cli.py --ontology-version 1.1.1 describe-field --field permissions.required
python3 scripts/template_cli.py --ontology-version 1.1.1 list-required-fields
python3 scripts/template_cli.py list-supported-versions
```

模板里未填字段写作 `REQUIRED_INPUT`，不是留空——空值容易被当作"无此需求"混过，
`REQUIRED_INPUT` 是一个明确的未完成状态。

## 能力二：校验（3.2）

| 模式 | 对象 | subject_digest | 说明 |
|---|---|---|---|
| `PREVALIDATION` | 可变工作树 | 必须为 `null` | 记录 `worktree_digest`，标注 `authority=NON_AUTHORITATIVE` |
| `FORMAL_TEST` | 仅 FROZEN 主体 | 必填且重算 | 测前/测后摘要必须一致，否则 `SUBJECT_MUTATED` |

```bash
python3 scripts/validator_cli.py --skill-root <path> --mode PREVALIDATION
```

**权威性标签是有意义的**：开发中算出的摘要恒为 NON_AUTHORITATIVE，只有冻结副本上
算出的 `subject_digest` 才是 AUTHORITATIVE。算法相同，区别只在标签——这防止
"开发阶段扫过一次"被当作"已验证"。

## 能力三：冻结与正式测试

```bash
python3 scripts/orchestrator_cli.py run-pipeline \
  --skill-root <skill> --state-root <state> --ontology-version 1.1.1
```

冻结会复制一份只读副本、算出权威摘要、写入 `provenance.checksum`，并**写入后重算
断言摘要未变**（checksum 字段本身在被哈希的文件里，因此哈希时按固定哨兵处理）。

> **本平台现状：这条链暂无触发点。** CogSeed 的 Skill 是随时保存的，没有明确的
> "发布"动作，因此"什么事件算冻结点"尚未确定。引擎能跑，但目前没有调用方。
> 不要声称某个 Skill 已通过正式测试。

## 停用项（不要调用）

- **风险五维派生已停用**：不要调用 `derive_security_fields`，不要写入
  `risk.calculated_risk_level` / `effective_risk_level` / `calculation_*` /
  `triggered_rule_ids`。模板中这些字段保持 `null`。
- 因此 `consistency-rules.yaml` 里依赖风险等级的规则（`SEC-ACTION-001`
  不可逆操作需审批、`SEC-RISK-001` 审批匹配风险、`SEC-ROLLBACK-001`）**当前不生效**。
  规则骨架在，判定逻辑不在。
- `derivation-rules.yaml` 仅作文档保留，不参与运行时校验。

## 阶段边界

退出码 `35`–`39`（EXPIRED / ATTESTATION_INVALID / SIGNATURE_INVALID /
KEY_STATUS_INVALID / GATE_DENIED）属阶段二，本引擎不会产生。Gate、Attestation、
签名与密钥均未实现——位置留了，不假装已实现。

## 依赖

引擎硬依赖 PyYAML。`vendor/yaml` 内置了 PyYAML 6.0.3 的纯 Python 实现（无需编译，
`__with_libyaml__` 为 `False` 只是没有 C 加速），由适配器通过 `PYTHONPATH` 注入。
`pyproject.toml` 声明的 `jsonschema` 在源码中从未被导入，故未内置。
