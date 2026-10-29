"""对抗门禁 runner —— 判据是「安装门禁会不会拒绝」，不是「有没有 finding」。

判据为什么必须逐来源判定
------------------------
`runtime_trust/skill_guard.py::SOURCE_POLICY` 的 `fail_on` 逐来源不同：
official=DO_NOT_INSTALL，community/thirdparty=CAUTION。所以「本次裁决是否达到
该来源的 fail_on 阈值」才是安装门禁真正用的判据。

`tools/evasion_check.py` 只把 ALLOW 记为逃脱。那个口径偏松：一份 CAUTION 的
恶意样本在 community/thirdparty 上**已经被拒**，记成「没拦住」；反过来它也
掩盖了真正的缺口——只要裁决不到 ALLOW，它就认为拦住了，而门禁是否拦截取决于
来源。这里按来源逐个判定，并且要求一条向量**在所有来源上都被拒**才算没有逃脱。

为什么不直接调 install_gate
---------------------------
`install_gate` 会先尝试 Docker 沙箱（`sandbox/agent_gate.py::evaluate_skill`），
而沙箱裁决来自镜像内的另一份引擎——实测该镜像仍是 1.0.0 引擎
（见 `test_sandbox_tier.py`）。若把 `install_gate` 当判据，同一份向量在有 Docker
的机器上会掺进 1.0.0 的结论、没 Docker 的机器上只有当前引擎，门禁结论随环境
漂移，而这恰好是最不该漂移的东西。因此本套件只测**当前引擎**
（`engine.scanner_core.scan`，确定性、无 Docker 依赖），沙箱层单独作为一个
「必须与当前引擎同版本」的一致性用例；门禁自身的严格性不变量另见
`test_gate_strictness.py`。

不变量（比用例耐用）
--------------------
1. 除 `hard_block` 外，任何降权不得把一份恶意样本从「被拒」推到「可装」。
2. `scoring.py::is_confirmed_critical` 不得因文本变换而翻转。
3. 每个载体类型（文本 / 二进制 / 归档 / 图像 / 编码）至少有一条能被检出的对抗用例。
基线是棘轮：新逃脱即失败；缺口收窄也要显式收紧基线，免得修复无人记账。

用法::

    python3 tests/conformance/adversarial/run_adversarial.py
    python3 tests/conformance/adversarial/run_adversarial.py --update-baseline

退出码：0 = 与基线一致；1 = 存在漂移（回归或缺口收窄）；2 = 用法错误。
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

SKILL_ROOT = Path(__file__).resolve().parents[3]
if str(SKILL_ROOT) not in sys.path:
    sys.path.insert(0, str(SKILL_ROOT))

import vectors  # noqa: E402  （与测试同目录，pytest 与直接执行都能导入）

from engine.scanner_core import scan  # noqa: E402
from engine.scanner_core.result_models import SEVERITY_ORDER  # noqa: E402
from engine.scanner_core.scoring import is_confirmed_critical  # noqa: E402

BASELINE_PATH = Path(__file__).resolve().parent / "baseline.json"

#: 冻结进基线的字段。分数也锁：本仓库既有的 conformance 向量就是这么做的，
#: 分数漂移往往是规则改动的副作用，需要人看一眼。
LOCKED_FIELDS: tuple[str, ...] = (
    "recommendation",
    "security_score",
    "risk_classification",
    "confirmed_critical",
    "example_info",
    "max_severity",
    "escape_sources",
)

_RANK = {"ALLOW": 0, "CAUTION": 1, "DO_NOT_INSTALL": 2}


def source_policies() -> dict[str, dict[str, Any]]:
    """从安装门禁取来源策略，避免在测试里复制一份阈值。"""
    from runtime_trust.skill_guard import SOURCE_POLICY  # noqa: PLC0415

    return SOURCE_POLICY


def engine_version() -> str:
    return (SKILL_ROOT / "engine" / "VERSION").read_text("utf-8").strip()


#: 用一份干净的样本读引擎自报的规则集健康度（不是被测向量，避免互相影响）。
RULESET_PROBE_SKILL = SKILL_ROOT / "tests" / "fixtures" / "legacy-samples" / "sample-safe-skill"

#: 完整规则集的 `rules_source` 前缀。内置兜底是 "builtin (…)"。
FULL_RULESET_PREFIX = "ruleset "


def engine_rules_health() -> dict[str, Any]:
    """本次测量实际用的规则集——对抗结论的前提，不是可选信息。

    为什么必须摆在结论旁边
    ----------------------
    规则集读不到时引擎会**静默退回内置规则**，而两条路的差距不是毫厘：内置兜底
    64 条规则、12 个组里的扩展规则全部失效，完整规则集 181 条（见
    `tests/unit/test_rule_loader.py` 与 `rule_loader.py::_import_yaml`）。
    在那种状态下得出的「逃脱率」测的不是这个扫描器，而是 64 条内置规则——
    一个看起来更漂亮、但属于另一个产品的数字。
    """
    report = scan(str(RULESET_PROBE_SKILL))
    coverage = report.get("coverage", {})
    return {
        "rules_source": coverage.get("rules_source"),
        "ruleset_version": coverage.get("ruleset_version"),
        "ruleset_resolved": coverage.get("ruleset_resolved"),
        "rule_count": coverage.get("rule_count"),
        "rule_groups": len(coverage.get("rule_groups") or []),
    }


def full_ruleset_problem(health: dict[str, Any]) -> str | None:
    """完整规则集返回 None；否则返回「为什么这份测量不算数」。"""
    source = str(health.get("rules_source") or "")
    if not source.startswith(FULL_RULESET_PREFIX) or not health.get("ruleset_resolved"):
        return (
            f"规则集不完整：{source or '(空)'}（{health.get('rule_count')} 条规则）。"
            "本次对抗测量无效——它测的是内置兜底规则，不是这个扫描器。"
            "先修规则集加载：环境没有 pyyaml 时必须能落到 skill 自带的 vendor/yaml"
            "（见 engine/scanner_core/rule_loader.py::_import_yaml）"
        )
    return None


def build_skill(vector: vectors.Vector, parent: Path) -> Path:
    skill = parent / vector.name
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        vectors.SKILL_MD.format(name=vector.name), encoding="utf-8"
    )
    for rel, body in vector.files.items():
        target = skill / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(body, bytes):
            target.write_bytes(body)
        else:
            target.write_text(body, encoding="utf-8")
    return skill


def summarize(report: dict[str, Any]) -> dict[str, Any]:
    """把报告压成基线里冻结的那几个字段。"""
    findings = report.get("findings", [])
    recommendation = report["deployment_recommendation"]
    policies = source_policies()
    escape_sources = [
        source
        for source in ("official", "community", "thirdparty")
        if _RANK[recommendation] < _RANK[policies[source]["fail_on"]]
    ]
    content = [f for f in findings if f.get("category") != "scan_coverage"]
    severities = [str(f.get("severity") or "info") for f in content]
    return {
        "recommendation": recommendation,
        "security_score": report["security_score"],
        "risk_classification": report["risk_classification"],
        "confirmed_critical": is_confirmed_critical(findings),
        "example_info": sum(
            1 for f in findings if f.get("example") and f.get("severity") == "info"
        ),
        "max_severity": max(severities, key=lambda s: SEVERITY_ORDER.get(s, 0), default="none"),
        "escape_sources": escape_sources,
    }


def evaluate(vector: vectors.Vector) -> dict[str, Any]:
    """跑一条向量，返回冻结字段。整个过程在临时目录里，不写仓库。"""
    with tempfile.TemporaryDirectory(prefix=f"adv-{vector.name}-") as tmp:
        skill = build_skill(vector, Path(tmp))
        report = scan(str(skill))
    return summarize(report)


def load_baseline() -> dict[str, Any] | None:
    if not BASELINE_PATH.is_file():
        return None
    return json.loads(BASELINE_PATH.read_text("utf-8"))


SANDBOX_IMAGE = "skill-security-scanner:local"
SANDBOX_SCRIPT = SKILL_ROOT / "sandbox" / "run_sandboxed_scan.sh"


def sandbox_tier_probe() -> dict[str, Any] | None:
    """在隔离沙箱里跑对照向量，回报沙箱内那份引擎的版本与裁决。

    返回 None 表示本机无法测这一层（没有 docker，或镜像不存在）——不是失败，
    是「这一层没被测」。这个区分很重要：沙箱可用与不可用会用**两份不同的
    引擎**给出裁决，把「没测」当成「通过」，正是这条通道能长期隐藏的原因。
    """
    import shutil  # noqa: PLC0415
    import subprocess  # noqa: PLC0415

    if shutil.which("docker") is None:
        return None
    inspect = subprocess.run(
        ["docker", "image", "inspect", SANDBOX_IMAGE],
        capture_output=True, text=True, check=False,
    )
    if inspect.returncode != 0:
        return None

    vector = vectors.BY_NAME["control-source-plain"]
    with tempfile.TemporaryDirectory(prefix="sandbox-tier-") as tmp:
        skill = build_skill(vector, Path(tmp))
        report_dir = Path(tmp) / "out"
        report_dir.mkdir()
        subprocess.run(
            ["bash", str(SANDBOX_SCRIPT), str(skill), str(report_dir)],
            capture_output=True, text=True, timeout=300, check=False,
        )
        report_file = report_dir / "report.json"
        if not report_file.is_file():
            return {"image": SANDBOX_IMAGE, "error": "沙箱未产出报告"}
        report = json.loads(report_file.read_text("utf-8"))
    return {
        "image": SANDBOX_IMAGE,
        "observed_scanner_version": report.get("scanner_version"),
        "observed_recommendation_for_control": report.get("deployment_recommendation"),
        "observed_score_for_control": report.get("security_score"),
        "expected_scanner_version": engine_version(),
    }


SANDBOX_TIER_NOTE = (
    "沙箱镜像内的引擎仍是 1.0.0（旧布局 01_scanner/02_rules），对 "
    "`os.system('rm -rf /')` 只给 CAUTION/HIGH —— 正是 2.2.0 收紧前的行为；"
    "sandbox/build.sh 指向的 06_sandbox/Dockerfile 与 Dockerfile 里 COPY 的 "
    "01_scanner/02_rules 在当前树里都不存在，所以这个镜像也重建不了。"
    "已止损：sandbox/agent_gate.py::evaluate_skill 改为两层取更严（隔离层可以"
    "加强结论、不能削弱结论），落后镜像因此不再拉低安装门禁，两层结论与各自"
    "引擎版本都进 tier_evidence。但重建镜像前，隔离层作为「更强的证据」的价值"
    "仍然没有——它只会重复本地层的结论。镜像版本一致性由本记录与 "
    "test_sandbox_tier.py 继续钉住。"
)


def compare(actual: dict[str, Any], frozen: dict[str, Any]) -> tuple[bool, str]:
    """与冻结值逐字段比对，并区分「回归」与「缺口收窄」。"""
    changed = [k for k in LOCKED_FIELDS if actual[k] != frozen.get(k)]
    if not changed:
        return True, "一致"
    if "escape_sources" in changed:
        grew = len(actual["escape_sources"]) > len(frozen.get("escape_sources") or [])
        verb = "回归：逃脱来源变多" if grew else "改善：逃脱来源变少（请收紧基线）"
    else:
        verb = "漂移"
    detail = ", ".join(
        f"{k}: {frozen.get(k)!r} -> {actual[k]!r}" for k in changed
    )
    return False, f"{verb}（{detail}）"


def run(update: bool, record_sandbox_tier: bool = False) -> int:
    baseline = load_baseline()
    frozen_vectors = (baseline or {}).get("vectors", {})

    # 先验证测量前提，再谈结论：规则集残缺时后面的数字没有解释力，
    # 而且此时**不允许**写基线（否则会把残缺规则集下的结果冻结成标准）。
    health = engine_rules_health()
    rules_problem = full_ruleset_problem(health)
    print(f"规则集  {health['rules_source']} · {health['rule_count']} 条规则"
          f" · {health['rule_groups']} 个组 · resolved={health['ruleset_resolved']}")
    if rules_problem is not None:
        print(f"规则集  ✗ {rules_problem}")
        return 1

    print(f"{'向量':<34}{'类型':<9}{'裁决':<16}{'分':>4}{'单条crit':<10}{'逃脱来源':<28}")
    print("-" * 104)

    records: dict[str, Any] = {}
    failures: list[str] = []
    attack_escapes = 0
    control_escapes = 0
    for vector in vectors.VECTORS:
        actual = evaluate(vector)
        records[vector.name] = actual
        if actual["escape_sources"]:
            if vector.kind == "control":
                control_escapes += 1
            else:
                attack_escapes += 1
        print(
            f"{vector.name:<34}{vector.kind:<9}{actual['recommendation']:<16}"
            f"{actual['security_score']:>4}{str(actual['confirmed_critical']):<10}"
            f"{','.join(actual['escape_sources']) or '-':<28}"
            + ("" if update or baseline is None else "  " + compare(actual, frozen_vectors.get(vector.name, {}))[1])
        )
        if update or baseline is None:
            continue
        if vector.name not in frozen_vectors:
            failures.append(f"{vector.name}: 基线里没有这条向量（新增向量需 --update-baseline）")
            continue
        ok, note = compare(actual, frozen_vectors[vector.name])
        if not ok:
            failures.append(f"{vector.name}: {note}")

    print("-" * 104)
    print(f"引擎版本 {engine_version()} · 向量 {len(vectors.VECTORS)} 条"
          f"（对照 {len(vectors.CONTROLS)} / 攻击 {len(vectors.ATTACKS)}）"
          f" · 逃脱：攻击 {attack_escapes}/{len(vectors.ATTACKS)}"
          f"，对照 {control_escapes}/{len(vectors.CONTROLS)}")

    if control_escapes:
        # 对照逃脱说明判据本身失效（或引擎把最露骨的载荷放行了），
        # 此时基线里的攻击缺口不再有解释力，必须先修判据。
        failures.append(
            f"{control_escapes} 条对照向量逃脱：判据零点失效，先修判据再谈攻击缺口"
        )

    if update:
        payload = dict(baseline or {})
        payload.update(
            {
                "schema_version": 1,
                "criterion": "escape = 裁决未达到该来源策略的 fail_on 阈值（逐来源判定）",
                "engine_version": engine_version(),
                # 这些数是在哪份规则集上量出来的（可追溯性，不是断言：
                # 规则集一变，分数也会变，届时本来就要重新冻结）。
                "ruleset": health,
                "vectors": {
                    name: {
                        "kind": vectors.BY_NAME[name].kind,
                        "axis": vectors.BY_NAME[name].axis,
                        "channel": vectors.BY_NAME[name].channel,
                        "root_cause": vectors.BY_NAME[name].root_cause,
                        **records[name],
                    }
                    for name in (v.name for v in vectors.VECTORS)
                },
            }
        )
        BASELINE_PATH.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"\n基线已写入 {BASELINE_PATH.relative_to(SKILL_ROOT)}")
        if control_escapes:
            print("但对照向量仍在逃脱：先把判据修好，再让这份基线生效。")
            return 1
        return 0

    if record_sandbox_tier:
        probe = sandbox_tier_probe()
        if probe is None:
            print("\n本机没有 docker 或没有镜像，沙箱层未测（不写成基线）。")
            return 1
        probe["status"] = (
            "fixed"
            if probe["observed_scanner_version"] == probe["expected_scanner_version"]
            else "known_gap"
        )
        probe["known_gap"] = SANDBOX_TIER_NOTE
        payload = dict(baseline or {})
        payload["sandbox_tier"] = probe
        BASELINE_PATH.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"\n沙箱层记录已写入（status={probe['status']}）")
        return 0

    if baseline is None:
        print("\n没有基线：先跑 --update-baseline 并人工确认每条缺口。")
        return 1

    if failures:
        print("\n与冻结基线不一致：")
        for line in failures:
            print(f"  - {line}")
        print("\n说明：逃脱来源变多 = 真实回归；变少 = 修复，请 --update-baseline 收紧缺口。")
        return 1

    print("\n结论：与冻结基线一致（尚无新逃脱通道，已知缺口未被掩盖）。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="对抗向量门禁")
    parser.add_argument("--update-baseline", action="store_true", help="重写 baseline.json 的 vectors 段")
    parser.add_argument(
        "--record-sandbox-tier",
        action="store_true",
        help="在 Docker 沙箱里跑对照向量并记录沙箱层引擎版本（需要 docker 与镜像）",
    )
    args = parser.parse_args()
    return run(update=args.update_baseline, record_sandbox_tier=args.record_sandbox_tier)


if __name__ == "__main__":
    raise SystemExit(main())
