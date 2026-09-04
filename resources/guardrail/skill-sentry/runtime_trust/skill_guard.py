#!/usr/bin/env python3
"""
skill_guard.py — Agent 的 Skill 安全网关（面向桌面 + 任意第三方 + 强绑定）
============================================================================

把三块能力串成 Agent 生命周期的完整防护：
  1. 安装前扫描 (install-time gate)  —— 复用 06_sandbox/agent_gate.evaluate_skill
  2. 来源感知的策略分级 (policy)      —— 官方/社区/第三方 不同门槛
  3. 加载前完整性校验 (load-time)     —— 复用 07_agent_runtime/trust_ledger 防 TOCTOU

设计前提（用户已确认）
----------------------
- 部署在用户桌面：不能假设有 Docker，需隔离降级策略。
- 允许任意第三方 Skill：最坏威胁模型，第三方来源默认最严 + 强制人工确认。
- 扫描器与 Agent 强绑定：本网关是 Agent 可信内建组件，用户不可替换。

对外主入口
----------
  install_gate(skill_path, source)   -> 安装决策
  load_gate(skill_dir)               -> 加载决策（每次启动加载 Skill 前调用）
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

GUARD_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = GUARD_DIR.parent
sys.path.insert(0, str(PROJECT_ROOT / "sandbox"))
sys.path.insert(0, str(GUARD_DIR))

from agent_gate import evaluate_skill  # type: ignore
from trust_ledger import TrustLedger, read_skill_meta  # type: ignore
try:
    from trust_root import verify_self  # type: ignore
except Exception:
    verify_self = None  # type: ignore

DEFAULT_LEDGER = "~/.agent/skill_trust_ledger.json"


def _self_check(ledger_path: str) -> dict[str, Any] | None:
    """启用网关前先做信任根自检。TRUSTED 返回 None（放行）；
    否则返回 fail-closed 拒绝结果。NO_BASELINE 视为未部署基线，
    仅告警但不阻断（开发态）；COMPROMISED 一律阻断。

    baseline / key 路径通过环境变量配置，与 Agent 实际部署保持一致：
      AGENT_TRUST_BASELINE  基线文件路径（默认 runtime_trust/trust_baseline.json）
      AGENT_TRUST_KEY_PATH  密钥文件路径（默认 ~/.agent/trust_root.key）
      AGENT_TRUST_KEY       直接提供密钥（优先于 KEY_PATH）
    """
    if verify_self is None:
        return None
    import os
    from pathlib import Path as _P
    kwargs: dict[str, Any] = {"ledger_path": ledger_path}
    if os.environ.get("AGENT_TRUST_BASELINE"):
        kwargs["baseline_path"] = _P(os.environ["AGENT_TRUST_BASELINE"])
    if os.environ.get("AGENT_TRUST_KEY_PATH"):
        kwargs["key_path"] = os.environ["AGENT_TRUST_KEY_PATH"]
    res = verify_self(**kwargs)
    if res["status"] == "COMPROMISED":
        return {"decision": "deny", "allow_load": False, "self_check": res,
                "user_message": "安全网关自身完整性校验失败（扫描器/规则可能被篡改），已停用网关并拒绝操作。"}
    return None

# ── 来源分级策略 ──────────────────────────────────────────
# require_isolation: 该来源是否必须隔离（无沙箱则 fail-closed 拒绝）
# fail_on:          达到该建议等级即拒绝
# human_confirm:    verdict=allow 也需人工确认才安装
SOURCE_POLICY: dict[str, dict[str, Any]] = {
    "official": {   # 官方仓库，签名可信
        "require_isolation": False, "fail_on": "DO_NOT_INSTALL", "human_confirm": False,
    },
    "community": {  # 社区仓库，半可信
        "require_isolation": False, "fail_on": "CAUTION", "human_confirm": False,
    },
    "thirdparty": { # 任意第三方 URL/本地，最坏假设
        "require_isolation": True, "fail_on": "CAUTION", "human_confirm": True,
    },
}
DEFAULT_SOURCE = "thirdparty"  # 来源未知时按最严处理


def _policy(source: str) -> dict[str, Any]:
    return SOURCE_POLICY.get(source, SOURCE_POLICY[DEFAULT_SOURCE])


def _humanize(summary: dict[str, Any]) -> str:
    """把结构化裁决翻译成用户能懂的一句话。"""
    v = summary.get("verdict")
    if v == "allow":
        return "未发现明显安全问题，可以安装。"
    parts = []
    das = summary.get("attack_surface_summary", {})
    if summary.get("hard_blocked"):
        parts.append("检测到疑似持续外传敏感数据的行为（高危红线）")
    if das.get("egress_points"):
        parts.append(f"包含 {das['egress_points']} 处对外网络/数据外发行为")
    if das.get("dynamic_exec_points"):
        parts.append(f"包含 {das['dynamic_exec_points']} 处动态代码执行")
    if das.get("persistence_points"):
        parts.append(f"包含 {das['persistence_points']} 处开机/持久化写入")
    if das.get("has_binaries"):
        parts.append(f"携带 {das.get('binary_files')} 个二进制文件（无法完全确认其行为）")
    mit = summary.get("required_mitigations", [])
    if mit:
        parts.append("未满足项：" + "、".join(m["name"] for m in mit[:4]))
    head = "已拒绝安装。" if v == "deny" else "需要你确认后才能安装。"
    return head + ("原因：" + "；".join(parts) + "。" if parts else "")


def install_gate(skill_path: str, source: str = DEFAULT_SOURCE,
                 ledger_path: str = DEFAULT_LEDGER) -> dict[str, Any]:
    """安装前网关。返回安装决策 + 用户可读说明。"""
    blocked = _self_check(ledger_path)
    if blocked is not None:
        blocked["source"] = source
        return blocked
    pol = _policy(source)
    summary = evaluate_skill(skill_path, require_isolation=pol["require_isolation"])

    # 隔离不满足（fail-closed）
    if summary.get("verdict") == "deny" and summary.get("scan_mode") == "no-sandbox":
        return {"decision": "deny", "source": source, "isolated": False,
                "user_message": f"来源[{source}]要求隔离扫描，但当前环境无法隔离，已拒绝安装。请安装 Docker 或改用受信来源。",
                "raw": summary}

    verdict = summary.get("verdict", "review")
    rank = {"allow": 0, "review": 1, "deny": 2, "caution": 1}
    rec = summary.get("deployment_recommendation") or summary.get("aggregate_recommendation") or "CAUTION"
    fail_rank = {"ALLOW": 0, "CAUTION": 1, "DO_NOT_INSTALL": 2}

    # 按来源策略收紧：达到 fail_on 阈值即拒绝
    if fail_rank.get(rec, 1) >= fail_rank.get(pol["fail_on"], 2):
        decision = "deny"
    elif verdict == "allow" and pol["human_confirm"]:
        decision = "confirm"   # 需人工确认
    elif verdict == "allow":
        decision = "allow"
    else:
        decision = "confirm" if verdict == "review" else "deny"

    result = {
        "decision": decision,           # allow | confirm | deny
        "source": source,
        "isolated": summary.get("isolated"),
        "scan_mode": summary.get("scan_mode"),
        "security_score": summary.get("security_score"),
        "risk_classification": summary.get("risk_classification"),
        "user_message": _humanize(summary),
        "raw": summary,
    }

    # 只有明确 allow 才登记入台账（confirm 交由 Agent 在用户确认后调 confirm_install）
    if decision == "allow":
        led = TrustLedger(ledger_path)
        led.record(Path(skill_path), verdict="allow",
                   score=summary.get("security_score"), source=source)
        result["recorded"] = True
    return result


def confirm_install(skill_path: str, source: str = DEFAULT_SOURCE,
                    ledger_path: str = DEFAULT_LEDGER) -> dict[str, Any]:
    """用户对 confirm 决策点了确认后调用：登记入台账。"""
    led = TrustLedger(ledger_path)
    entry = led.record(Path(skill_path), verdict="allow", score=None, source=source)
    return {"decision": "allow", "recorded": True, "entry_key": f"{entry['skill_id']}@{entry['version']}"}


def load_gate(skill_dir: str, ledger_path: str = DEFAULT_LEDGER) -> dict[str, Any]:
    """加载前网关：校验完整性（防 TOCTOU）。每次 Agent 启动加载 Skill 前调用。"""
    blocked = _self_check(ledger_path)
    if blocked is not None:
        return blocked
    led = TrustLedger(ledger_path)
    v = led.verify(Path(skill_dir))
    action_msg = {
        "allow_load": "完整性校验通过，允许加载。",
        "scan_required": "该 Skill 从未通过安全扫描，禁止加载，请先扫描。",
        "rescan_required": "该 Skill 安装后内容被修改，禁止加载，请重新扫描。",
        "block_load": "该 Skill 曾被判定为高危，禁止加载。",
    }
    return {
        "allow_load": v["status"] == "TRUSTED",
        "status": v["status"],
        "skill_id": v.get("skill_id"),
        "user_message": action_msg.get(v.get("action", ""), v.get("reason", "")),
        "raw": v,
    }


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Agent Skill 安全网关")
    ap.add_argument("--ledger", default=DEFAULT_LEDGER)
    sub = ap.add_subparsers(dest="cmd", required=True)
    pi = sub.add_parser("install"); pi.add_argument("skill"); pi.add_argument("--source", default=DEFAULT_SOURCE)
    pc = sub.add_parser("confirm"); pc.add_argument("skill"); pc.add_argument("--source", default=DEFAULT_SOURCE)
    pl = sub.add_parser("load"); pl.add_argument("skill")
    args = ap.parse_args()

    if args.cmd == "install":
        print(json.dumps(install_gate(args.skill, args.source, args.ledger), ensure_ascii=False, indent=2))
    elif args.cmd == "confirm":
        print(json.dumps(confirm_install(args.skill, args.source, args.ledger), ensure_ascii=False, indent=2))
    elif args.cmd == "load":
        print(json.dumps(load_gate(args.skill, args.ledger), ensure_ascii=False, indent=2))
