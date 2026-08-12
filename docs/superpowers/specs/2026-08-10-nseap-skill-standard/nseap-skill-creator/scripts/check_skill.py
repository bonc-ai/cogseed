#!/usr/bin/env python3
"""check_skill.py — 自检一个脚手架出来的 SkillPackage 是否符合 NSEAP 标准形状。

纯 stdlib（无需 pyyaml / metaskill 引擎），零依赖，随处可跑：
    python3 check_skill.py <path-to-skill-folder>

检查：①SKILL.md frontmatter(name/description) + 触发/反触发；②input/output 双 schema 形状
(三层 owner_context / audit_refs)；③runtime_contracts 边界护栏；④non-claims(staged 封顶)。
schema 从任意 *.json（含 input_schema）读取；yaml/md 以文本查关键 token。
退出码 0 = 硬检全过。
"""
from __future__ import annotations
import json
import os
import re
import sys

OK, WARN, BAD = "✓", "⚠", "✗"


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except Exception:
        return ""


def _all_text(root: str) -> str:
    out = []
    for dp, _, fns in os.walk(root):
        for fn in fns:
            if fn.rsplit(".", 1)[-1] in ("md", "yaml", "yml", "json", "txt"):
                out.append(_read(os.path.join(dp, fn)))
    return "\n".join(out)


def _find_schemas(root: str) -> dict | None:
    for dp, _, fns in os.walk(root):
        for fn in fns:
            if fn.endswith(".json"):
                try:
                    data = json.loads(_read(os.path.join(dp, fn)))
                except Exception:
                    continue
                if isinstance(data, dict) and "input_schema" in data:
                    return data
    return None


def check(root: str) -> int:
    results: list[tuple[str, str, str]] = []          # (status, label, detail)

    def add(status, label, detail=""):
        results.append((status, label, detail))

    # ① SKILL.md
    skill_md = _read(os.path.join(root, "SKILL.md"))
    if not skill_md:
        add(BAD, "SKILL.md 存在")
    else:
        fm = re.search(r"^---\s*(.*?)\s*---", skill_md, re.S)
        has_name = bool(fm and re.search(r"^name:\s*\S", fm.group(1), re.M))
        has_desc = bool(fm and re.search(r"^description:", fm.group(1), re.M))
        add(OK if has_name and has_desc else BAD, "SKILL.md frontmatter(name+description)")
        has_trig = "use_when" in skill_md
        has_anti = "do_not_use_when" in skill_md or "negative_examples" in skill_md
        add(OK if has_trig and has_anti else BAD, "触发 + 反触发语义",
            "" if has_anti else "缺 do_not_use_when / negative_examples（反触发是硬门）")

    # ② 双 schema
    doc = _find_schemas(root)
    if not doc:
        add(WARN, "input/output schema（*.json）", "未找到含 input_schema 的 JSON；无法机检 schema 形状")
    else:
        ins = doc.get("input_schema", {})
        req = ins.get("required", [])
        oc = ins.get("properties", {}).get("owner_context", {})
        payload = [k for k in req if str(k).endswith("_payload")]
        three_layer = "task_id" in req and "owner_context" in req and len(payload) == 1
        add(OK if three_layer else BAD, "input_schema 三层(task_id+owner_context+*_payload)",
            "" if three_layer else f"顶层 required={req}")
        oc_ok = oc.get("required") == ["owner_id", "role", "authorization_scope"]
        add(OK if oc_ok else BAD, "owner_context.required = [owner_id, role, authorization_scope]")
        out_req = doc.get("output_schema", {}).get("required", [])
        add(OK if "audit_refs" in out_req else BAD, "output_schema 含 audit_refs")

        # ③ runtime_contracts 护栏
        rc = doc.get("runtime_contracts", {})
        guards = {
            "resource.direct_resource_access = false": rc.get("resource", {}).get("direct_resource_access") is False,
            "resource.access_via_gateway_only = true": rc.get("resource", {}).get("access_via_gateway_only") is True,
            "owner_binding.binding_resolved_by = agent_layer": rc.get("owner_binding", {}).get("binding_resolved_by") == "agent_layer",
            "audit.emitted_by = runtime": rc.get("audit", {}).get("emitted_by") == "runtime",
        }
        for label, ok in guards.items():
            add(OK if ok else BAD, f"runtime_contracts 护栏: {label}")

    # ④ non-claims / staged 封顶
    text = _all_text(root)
    staged = "staged" in text.lower()
    lock = re.search(r"production_release_allowed[\"'\s:]+false", text, re.I) or \
        "production_release_allowed: false" in text or '"production_release_allowed": false' in text
    add(OK if staged else BAD, "staged 封顶出现")
    add(OK if lock else BAD, "production_release_allowed = false（硬锁）")

    # 输出
    print(f"NSEAP skill self-check · {root}\n")
    hard_fail = 0
    for status, label, detail in results:
        line = f"  {status} {label}"
        if detail:
            line += f"  — {detail}"
        print(line)
        if status == BAD:
            hard_fail += 1

    print()
    if hard_fail == 0:
        print("结果：形状合规（Tier A/B 就绪待补 ★ 业务件）。发布天花板 staged，非生产就绪。")
        return 0
    print(f"结果：{hard_fail} 项硬检未过。修好后重跑。（{WARN}=提示，非硬失败）")
    return 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法: python3 check_skill.py <path-to-skill-folder>")
        raise SystemExit(2)
    raise SystemExit(check(sys.argv[1]))
