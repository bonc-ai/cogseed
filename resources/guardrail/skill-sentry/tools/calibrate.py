#!/usr/bin/env python3
"""
calibrate.py — 规则误报率标定工具（skill-sentry 的核心用法）
=============================================================

为什么需要它
------------
skill-sentry 的定位是**规则孵化场**：新规则先在真实语料上标定误报率，达标后才
译进 CogSeed-Agent 的 `src/main/quality/`。原因很直接——在这里发现的误报只是数据，
而 `quality/` 的 EXTREME 是硬拦截写入，同样的误报在那边就是真实的装不上事故。

实测依据：2.1.0 校准前，43 个 CogSeed-Agent 官方 skill 里有 1 例误判
DO_NOT_INSTALL + 31 例误判 CAUTION，其中被判死的那个恰是**拦截** SSRF 的防御
代码。若不先标定就移植，Must 6「低风险静默通过」直接失效。

怎么用
------
    python3 tools/calibrate.py --corpus <目录>            # 标定误报
    python3 tools/calibrate.py --corpus <目录> --verbose  # 逐个 skill 明细

语料要求：目录下每个含 SKILL.md 的子目录算一个 skill，且**全部应为良性**
（官方自带内容）。因此任何 CAUTION / DO_NOT_INSTALL 都是误报。

判定标准
--------
- 误判 DO_NOT_INSTALL：必须为 0。会导致用户装不上正常内容。
- 误判 CAUTION：必须为 0。弹窗弹多了用户就无脑点继续，门等于白做。
- medium 以上 finding：应可逐条解释。这是误报的来源池。

退出码：0 = 无误报；1 = 存在误报（可用于 CI）。
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.scanner_core import scan  # noqa: E402

# 一条规则在良性语料上被降权这么多次，就说明它命中面过宽——即便当前裁决没被
# 影响，也应在移植前收窄。阈值取 5：小于它可能只是个别样本的正常提及。
NOISY_RULE_THRESHOLD = 5


def find_skills(corpus: Path) -> list[Path]:
    """递归找出语料里所有 skill 根目录（以 SKILL.md 为标志）。"""
    if (corpus / "SKILL.md").is_file():
        return [corpus]
    seen: dict[Path, None] = {}
    for skill_md in sorted(corpus.rglob("SKILL.md")):
        if {".git", "node_modules", "__pycache__"} & set(skill_md.parts):
            continue
        seen.setdefault(skill_md.parent, None)
    return list(seen)


def main() -> int:
    ap = argparse.ArgumentParser(description="标定规则在良性语料上的误报率")
    ap.add_argument("--corpus", required=True, help="良性 skill 语料目录")
    ap.add_argument("--verbose", "-v", action="store_true", help="逐个 skill 输出")
    args = ap.parse_args()

    corpus = Path(args.corpus).expanduser()
    if not corpus.is_dir():
        print(f"语料目录不存在: {corpus}", file=sys.stderr)
        return 2

    skills = find_skills(corpus)
    if not skills:
        print(f"未在 {corpus} 下找到任何含 SKILL.md 的目录", file=sys.stderr)
        return 2

    rows = [(d, scan(str(d))) for d in skills]

    false_block = [(d, r) for d, r in rows if r["deployment_recommendation"] == "DO_NOT_INSTALL"]
    false_caution = [(d, r) for d, r in rows if r["deployment_recommendation"] == "CAUTION"]

    print(f"语料: {corpus}")
    print(f"skill 数: {len(rows)}\n")

    verdicts = Counter(r["deployment_recommendation"] for _, r in rows)
    print("裁决分布：")
    for v in ("ALLOW", "CAUTION", "DO_NOT_INSTALL"):
        print(f"  {v:<16} {verdicts.get(v, 0)}")

    print(f"\n误判 DO_NOT_INSTALL : {len(false_block)}")
    print(f"误判 CAUTION        : {len(false_caution)}")

    # medium 以上命中是误报来源池：逐条应可解释。
    by_rule: Counter[tuple[str, str]] = Counter()
    for _, r in rows:
        for f in r.get("findings", []):
            if f["severity"] in ("medium", "high", "critical"):
                by_rule[(f["severity"], f["rule_id"])] += 1
    if by_rule:
        print("\nmedium 以上命中（误报来源池，逐条应可解释）：")
        for (sev, rid), n in by_rule.most_common():
            print(f"  {sev:<9} {rid:<26} {n}")
    else:
        print("\nmedium 以上命中：无")

    # 只看裁决会漏掉一类问题：某条规则在良性语料上大面积命中，但每次都被上下文
    # 降权，于是裁决始终是 ALLOW。这种规则「暂时无害」，可它已经没有信噪比，
    # 且一旦有人调整降权档位就会集体转为误报。因此按**原始严重级**单独统计。
    raw_rule: Counter[str] = Counter()
    demoted_rule: Counter[str] = Counter()
    for _, r in rows:
        for f in r.get("findings", []):
            if f.get("original_severity") in ("medium", "high", "critical"):
                raw_rule[f["rule_id"]] += 1
                if f.get("demoted"):
                    demoted_rule[f["rule_id"]] += 1
    noisy = [(rid, n, demoted_rule.get(rid, 0)) for rid, n in raw_rule.items()
             if demoted_rule.get(rid, 0) >= NOISY_RULE_THRESHOLD]
    if noisy:
        print(f"\n高噪音规则（原始 medium+ 且被降权 ≥{NOISY_RULE_THRESHOLD} 次）：")
        print("  这些规则当前靠降权兜住，信噪比已不足，移植前应收窄：")
        for rid, total, dem in sorted(noisy, key=lambda x: -x[2]):
            print(f"    {rid:<26} 命中 {total:>3}  其中降权 {dem:>3}")

    for label, items in (("误判阻断", false_block), ("误判告警", false_caution)):
        if not items:
            continue
        print(f"\n{label}明细：")
        for d, r in items:
            print(f"  {d.name}  score={r['security_score']} {r['risk_classification']}")
            for f in r.get("findings", []):
                if f["severity"] in ("medium", "high", "critical"):
                    print(f"      {f['severity']:<9} {f['rule_id']:<24} "
                          f"{f['file']}:{f['line']} (ctx={f['context']})")
            for it in r.get("sr_items", []):
                if not it["passed"] and it["required"]:
                    print(f"      SR 未通过: {it['id']} {it['detail']}")

    if args.verbose:
        print("\n逐个 skill：")
        for d, r in sorted(rows, key=lambda x: x[1]["security_score"]):
            print(f"  {r['security_score']:>4} {r['risk_classification']:<9} "
                  f"{r['deployment_recommendation']:<16} {d.name}")

    ok = not false_block and not false_caution
    print("\n结论:", "通过（无误报）" if ok else "未通过（存在误报，不得移植）")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
