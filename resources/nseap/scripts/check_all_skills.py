#!/usr/bin/env python3
"""check_all_skills.py — NSEAP 全库合规校验器（机器可执行）。

遍历 resources/builtin/marketplace/skills/ 下每个技能包，机检 §13 Level B 登记准入的
可机检项：

  1. §8.1 标准目录：SKILL.md / schemas.json / references 九件 / evals 五件 / agents/*.yaml
  2. §5.4 输入/输出契约非空：schemas.json 的 input_schema/output_schema 均有 properties
  3. §5.3 触发语义：SKILL.md 含 NSEAP-GATE 区块且 use_when / do_not_use_when 非空
  4. §11.3 登记最低档：evals.json 的 cases ≥10 且反例（polarity/kind=negative/anti/counter）≥4
  5. 证据诚实标注：每条 case 必须带 evidence_source 与 business_value_claim
  6. staged 封顶：references/skill-spec.yaml 声明 promotion_ceiling=staged 且
     production_release_allowed=false

纯 stdlib，零依赖，可随处运行：
    python3 check_all_skills.py [skills-dir]

退出码 0 = 全库硬检通过；1 = 存在未达标技能。
"""
from __future__ import annotations

import json
import os
import re
import sys

OK, BAD = "✓", "✗"


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def _load_json(path: str):
    try:
        return json.loads(_read(path))
    except (ValueError, TypeError):
        return None


def _cases(evj) -> list:
    if isinstance(evj, dict):
        for key in ("cases", "evaluations"):
            if isinstance(evj.get(key), list):
                return evj[key]
    if isinstance(evj, list):
        return evj
    return []


def _is_anti(case) -> bool:
    pol = str(case.get("polarity", "")).lower()
    kind = str(case.get("kind", "")).lower()
    return pol in ("negative", "anti", "neg", "counter") or \
        kind in ("negative", "anti", "neg", "counter") or \
        case.get("is_anti") is True


def _check_skill(skill_dir: str) -> tuple[bool, list[str]]:
    errors: list[str] = []

    # 1. 标准目录
    refs = ["skill-spec.yaml", "ontology-mapping.md", "kstar-evolution.md",
            "validation-contract.md", "input-contract.md", "output-contract.md",
            "governance-boundaries.md", "eval-cases.yaml", "failure-modes.md"]
    evals = ["evals.json", "forecast_model.md", "outcome_evaluation.md",
             "replay_dataset.md", "regression_tests.md"]
    for f in ["SKILL.md", "schemas.json"]:
        if not os.path.isfile(os.path.join(skill_dir, f)):
            errors.append(f"missing {f}")
    for f in refs:
        if not os.path.isfile(os.path.join(skill_dir, "references", f)):
            errors.append(f"missing references/{f}")
    for f in evals:
        if not os.path.isfile(os.path.join(skill_dir, "evals", f)):
            errors.append(f"missing evals/{f}")
    agents_dir = os.path.join(skill_dir, "agents")
    if not (os.path.isdir(agents_dir) and any(
            f.endswith(".yaml") for f in os.listdir(agents_dir))):
        errors.append("missing agents/*.yaml")

    # 2. 输入/输出契约非空（§5.4）
    sch = _load_json(os.path.join(skill_dir, "schemas.json"))
    if sch is None:
        errors.append("schemas.json 不可解析")
    else:
        for key in ("input_schema", "output_schema"):
            props = (sch.get(key) or {}).get("properties")
            if not isinstance(props, dict) or not props:
                errors.append(f"schemas.json {key}.properties 为空")

    # 3. 触发语义（§5.3）
    skmd = _read(os.path.join(skill_dir, "SKILL.md"))
    gate = re.search(r"<!-- NSEAP-GATE:BEGIN -->([\s\S]*?)<!-- NSEAP-GATE:END -->", skmd)
    if not gate:
        errors.append("SKILL.md 缺 NSEAP-GATE 区块")
    else:
        if not re.search(r"`use_when`：?\s*\S", gate.group(1)):
            errors.append("GATE 缺 use_when")
        if not re.search(r"`do_not_use_when`：?\s*\S", gate.group(1)):
            errors.append("GATE 缺 do_not_use_when")

    # 4. 评测数量门槛（§11.3）
    evj = _load_json(os.path.join(skill_dir, "evals", "evals.json"))
    cases = _cases(evj)
    if len(cases) < 10:
        errors.append(f"evals.json cases={len(cases)} < 10")
    anti = sum(1 for c in cases if _is_anti(c))
    if anti < 4:
        errors.append(f"evals.json 反例={anti} < 4")
    # 5. 证据诚实标注（§11.2）
    for i, c in enumerate(cases):
        if "evidence_source" not in c or "business_value_claim" not in c:
            errors.append(f"case[{i}] 缺 evidence_source/business_value_claim")
            break

    # 6. staged 封顶（§9.2）
    spec = _read(os.path.join(skill_dir, "references", "skill-spec.yaml"))
    m_ceil = re.search(r"promotion_ceiling\s*[:=]\s*['\"]?([A-Za-z_]+)", spec)
    if m_ceil and m_ceil.group(1) != "staged":
        errors.append(f"promotion_ceiling={m_ceil.group(1)} 不是 staged")
    m_prod = re.search(r"production_release_allowed\s*[:=]\s*['\"]?(true|false|1|0)\b", spec)
    if m_prod and m_prod.group(1) in ("true", "1"):
        errors.append("production_release_allowed 为 true")

    return (not errors, errors)


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "..", "..", "builtin", "marketplace", "skills"))
    if not os.path.isdir(base):
        print(f"{BAD} 技能目录不存在: {base}")
        return 2

    skills = sorted(s for s in os.listdir(base)
                    if os.path.isdir(os.path.join(base, s)))
    passed, failed = [], []
    for s in skills:
        ok, errors = _check_skill(os.path.join(base, s))
        if ok:
            passed.append(s)
        else:
            failed.append((s, errors))

    print(f"NSEAP 全库机检: {len(passed)}/{len(skills)} 通过")
    for s in passed:
        print(f"  {OK} {s}")
    for s, errors in failed:
        print(f"  {BAD} {s}")
        for e in errors:
            print(f"      - {e}")

    print(f"\n结论: {'全部通过' if not failed else f'{len(failed)} 个未通过'}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
