"""
baseline.py — 风险接受（抑制）清单
=====================================

为什么必须有这一层
------------------
没有抑制机制的扫描器只有两种命运：要么团队无视它（误报太多），要么团队
关掉它。``text_rules``/``context`` 已经把「同一字符串不同上下文」的系统性
误报压到接近 0，但剩下的是**逐个的、有理由的**判定：某个 Skill 确实需要
读 ``.env`` 因为它的功能就是管理环境变量。

这类判定需要被记录下来，而不是每次重扫都重新争论一遍。

与「降权」的区别（这是本模块最容易用错的地方）
----------------------------------------------
- **降权**（``context.py``）是引擎自己的判断：这个上下文里该模式不构成证据。
  它对所有 Skill 生效，不可由用户改写。
- **抑制**（本模块）是**用户的**判断：我知道这条命中是真的，我接受它。
  它只对当前这个 Skill 生效，必须写明理由，并且**有到期日**。

因此抑制只影响打分与裁决，**绝不删除 finding**。报告里被抑制的项仍然在，
带 ``suppressed`` 与 ``suppressed_reason``——审计者始终看得见。

到期日是硬要求：``"永久接受"`` 是「临时例外」腐化的唯一路径。到期后该条
自动恢复计分，用户必须重新确认。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BASELINE_FILENAME = ".skill-sentry-baseline.json"
BASELINE_VERSION = 1


def baseline_path(skill_dir: Path) -> Path:
    return skill_dir / BASELINE_FILENAME


def load_baseline(skill_dir: Path) -> list[dict[str, Any]]:
    """读抑制清单。文件缺失/损坏一律返回空列表。

    解析失败不报错是刻意的：一个损坏的 baseline 若让扫描失败，用户会以为
    「扫描器坏了」而不是「我的抑制清单有问题」，而前者会导致他们绕过扫描。
    损坏时等价于「没有抑制」——这是安全的方向。
    """
    path = baseline_path(skill_dir)
    try:
        data = json.loads(path.read_text("utf-8"))
    except Exception:
        return []
    accepted = data.get("accepted")
    if not isinstance(accepted, list):
        return []
    return [a for a in accepted if isinstance(a, dict) and a.get("fingerprint")]


def _is_expired(entry: dict[str, Any], now: datetime) -> bool:
    raw = entry.get("expiresAt") or entry.get("expires_at")
    if not raw:
        # 没有到期日 = 立即视为过期。缺少到期日的抑制条目是配置错误，
        # 按「未抑制」处理比按「永久抑制」处理安全。
        return True
    try:
        text = str(raw).replace("Z", "+00:00")
        expires = datetime.fromisoformat(text)
    except ValueError:
        return True
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return expires <= now


#: 永不可抑制的严重级。
#:
#: 这条规则来自 SkillGuardrail 的设计（`docs/rules.md`，其表述是
#: "baselines may never suppress high or critical"），采纳它的理由很直接：
#: 抑制机制一旦能压掉高危命中，「接受风险」就变成了「把拦截关掉」。
#: 一个用户可以在不理解后果的情况下点掉一条 `rm -rf /`——而这条命中
#: 正是整个扫描器存在的理由。
#:
#: 因此 `critical` 与 `high` 不可抑制：它们始终计入分数、始终参与裁决，
#: 报告里也不会被标成 suppressed。中低危可以接受——那才是抑制机制的
#: 正当用途（「这条 raw_ip_url 是我们的内部域名，我知道」）。
UNSUPPRESSIBLE_SEVERITIES = frozenset({"critical", "high"})


def is_suppressible(finding: dict[str, Any]) -> bool:
    """该 finding 是否允许被风险接受。"""
    if finding.get("hard_block"):
        return False
    if str(finding.get("severity") or "").lower() in UNSUPPRESSIBLE_SEVERITIES:
        return False
    return True


def apply_baseline(
    findings: list[dict[str, Any]],
    accepted: list[dict[str, Any]],
    *,
    now: datetime | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """把抑制标记写到 finding 上，并返回 ``(全部 findings, 统计)``。

    返回的是**全部** findings（含被抑制的）。调用方若只要计分集合，
    用 ``[f for f in findings if not f["suppressed"]]``——把这件事显式化，
    避免抑制在某个分支上悄悄变成删除。
    """
    moment = now or datetime.now(timezone.utc)
    by_fp: dict[str, dict[str, Any]] = {}
    expired = 0
    for entry in accepted:
        if _is_expired(entry, moment):
            expired += 1
            continue
        by_fp[str(entry["fingerprint"])] = entry

    suppressed = 0
    refused = 0
    out: list[dict[str, Any]] = []
    for f in findings:
        entry = by_fp.get(str(f.get("fingerprint") or ""))
        if entry is None:
            out.append({**f, "suppressed": False})
            continue
        if not is_suppressible(f):
            # 抑制清单里有这条，但严重级不允许抑制。保留为未抑制，并在
            # 统计里计数——静默忽略会让用户以为「我明明接受了」。
            refused += 1
            out.append({**f, "suppressed": False, "suppression_refused": True})
            continue
        suppressed += 1
        out.append({
            **f,
            "suppressed": True,
            "suppressed_reason": str(entry.get("reason") or ""),
            "suppressed_by": str(entry.get("acceptedBy") or entry.get("accepted_by") or ""),
            "suppressed_until": str(entry.get("expiresAt") or entry.get("expires_at") or ""),
        })

    return out, {
        "accepted_total": len(accepted),
        "accepted_active": len(by_fp),
        "accepted_expired": expired,
        "suppressed_findings": suppressed,
        "suppression_refused": refused,
        "suppressible_levels": ["medium", "low", "info"],
    }


def add_entry(skill_dir: Path, fingerprint: str, *, rule_id: str, file: str,
              reason: str, days: int, accepted_by: str = "") -> dict[str, Any]:
    """写入一条抑制条目并返回它。

    ``days`` 是必填的正整数——API 层不接受「永久」，因为调用点会退化成
    传一个很大的数字，而「很大」与「永久」在实践中没有区别。
    """
    if days <= 0:
        raise ValueError("days must be positive")
    path = baseline_path(skill_dir)
    try:
        data = json.loads(path.read_text("utf-8"))
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    accepted = data.get("accepted")
    if not isinstance(accepted, list):
        accepted = []

    now = datetime.now(timezone.utc)
    from datetime import timedelta
    entry = {
        "fingerprint": fingerprint,
        "ruleId": rule_id,
        "file": file,
        "reason": reason,
        "acceptedBy": accepted_by,
        "acceptedAt": now.isoformat().replace("+00:00", "Z"),
        "expiresAt": (now + timedelta(days=days)).isoformat().replace("+00:00", "Z"),
    }
    accepted = [a for a in accepted if isinstance(a, dict) and a.get("fingerprint") != fingerprint]
    accepted.append(entry)
    data = {"version": BASELINE_VERSION, "accepted": accepted}
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return entry


def remove_entry(skill_dir: Path, fingerprint: str) -> bool:
    """移除一条抑制。返回是否真的删掉了东西。"""
    path = baseline_path(skill_dir)
    try:
        data = json.loads(path.read_text("utf-8"))
    except Exception:
        return False
    if not isinstance(data, dict) or not isinstance(data.get("accepted"), list):
        return False
    before = len(data["accepted"])
    data["accepted"] = [a for a in data["accepted"]
                        if not (isinstance(a, dict) and a.get("fingerprint") == fingerprint)]
    if len(data["accepted"]) == before:
        return False
    data["version"] = BASELINE_VERSION
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return True
