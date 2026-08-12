# nseap-skill-creator · Quickstart (一页)

「造 skill 的 skill」的可即用版：从一句领域描述，脚手架出符合 NSEAP 标准的 SkillPackage。
**Claude 直接用，零引擎依赖**；产出恒 `staged`（不发布、不部署）。

## 装它（三选一）
- **本项目已装**：`.claude/skills/nseap-skill-creator/` → 下次会话直接 `/nseap-skill-creator …`
- **全局用**：`cp -r nseap-skill-creator ~/.claude/skills/`（任何项目里都能 `/nseap-skill-creator`）
- **别处**：解压 `nseap-skill-creator.skill.zip` 到目标 `.claude/skills/`

## 用它（一句话）
> `/nseap-skill-creator 给我造一个处理合同条款审查的 skill`

Claude 会：① 问/抽你的领域材料（narrative + 实体 + 规则）→ ② 按标准脚手架出 SkillPackage
→ ③ 自检并如实报到哪一档。

## 看目标产出长什么样
`examples/skill-invoice-dunning/` 是一个**完整、合规的 Tier-B 参考例**（发票催收）——
含 SKILL.md（触发/反触发）、三层 schema、本体切片、input/validation 契约、non-claims、evals。
照它填自己的领域即可。

## 自检你的产出（可选，纯 stdlib）
```bash
python3 scripts/check_skill.py <你脚手架出来的 skill 目录>
```
检查：SKILL.md 触发/反触发、input 三层 owner_context、output audit_refs、runtime_contracts
护栏、staged 封顶。全绿 = 形状合规（Tier A/B 就绪待补 ★ 业务件）。

## 你只需亲手写的 5 个 ★ 件
SKILL.md 业务描述+触发 · evals/eval-cases（正反例）· skill-spec.yaml（确认默认）·
input-contract.md（字段业务含义）· validation-contract.md（边界测试+HITL）。其余模板生成。

## 边界（诚实，别越）
只脚手架到 `staged`。**不**跑真实 KSTAR 学习（那需 `metaskill` 引擎）、**不**做生产发布、
**不**碰真实资源/身份（值由 Agent 层注入）。Tier C（发布）是治理/发布的活，不在这。
