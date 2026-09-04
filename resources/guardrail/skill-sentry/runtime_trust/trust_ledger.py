#!/usr/bin/env python3
"""
trust_ledger.py — Skill 信任台账 + 完整性校验（防 TOCTOU）
============================================================

解决的问题
----------
一次性扫描是无状态的：Skill 装的时候扫过一次通过了，但之后被人偷偷改内容
（TOCTOU：检查时干净、运行时变脏），或升级换了新版本，一次性扫描就失效了。

本模块把“一次性扫描”升级为“持续完整性保证”：
  1. 扫描通过后，把 skill_id/version/content_hash/verdict 记入台账。
  2. Agent 每次加载已装 Skill 前，重算 content_hash 与台账比对。
  3. 不一致 → 拒绝加载并要求重扫。

内容哈希算法
------------
对 Skill 目录下所有文件按相对路径排序，逐个哈希 (相对路径 + 文件内容)，
汇总成一个 sha256。文件增删改、改名、移动都会导致哈希变化。

台账文件
--------
默认 ~/.<agent>/skill_trust_ledger.json（可传入自定义路径）。
台账本身建议由 Agent 以受限权限持有，避免被普通 Skill 写入篡改。
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

LEDGER_VERSION = "1.0.0"
IGNORED_PARTS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", ".DS_Store"}


def compute_content_hash(skill_dir: Path) -> str:
    """对 Skill 目录内容算稳定 sha256。文件任何增删改都会变化。"""
    skill_dir = Path(skill_dir).resolve()
    h = hashlib.sha256()
    if skill_dir.is_file():
        h.update(skill_dir.name.encode("utf-8"))
        h.update(b"\0")
        h.update(skill_dir.read_bytes())
        return h.hexdigest()

    files = []
    for p in skill_dir.rglob("*"):
        if not p.is_file():
            continue
        if IGNORED_PARTS.intersection(p.parts):
            continue
        files.append(p)
    for p in sorted(files, key=lambda x: x.relative_to(skill_dir).as_posix()):
        rel = p.relative_to(skill_dir).as_posix()
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        try:
            h.update(p.read_bytes())
        except Exception:
            h.update(b"<unreadable>")
        h.update(b"\0")
    return h.hexdigest()


def read_skill_meta(skill_dir: Path) -> dict[str, str]:
    """从 SKILL.md frontmatter 粗提取 name/version（无 yaml 也能用）。"""
    skill_dir = Path(skill_dir)
    md = skill_dir / "SKILL.md" if skill_dir.is_dir() else skill_dir
    name, version = skill_dir.name if skill_dir.is_dir() else skill_dir.stem, "unknown"
    try:
        text = md.read_text("utf-8", errors="ignore")
        in_fm = False
        for line in text.splitlines():
            s = line.strip()
            if s == "---":
                if in_fm:
                    break
                in_fm = True
                continue
            if in_fm:
                if s.startswith("name:"):
                    name = s.split(":", 1)[1].strip().strip('"\'') or name
                elif s.startswith("version:"):
                    version = s.split(":", 1)[1].strip().strip('"\'') or version
    except Exception:
        pass
    return {"skill_id": name, "version": version}


class TrustLedger:
    def __init__(self, ledger_path: str | Path):
        self.path = Path(ledger_path).expanduser().resolve()
        self._data = self._load()

    def _load(self) -> dict[str, Any]:
        if self.path.is_file():
            try:
                return json.loads(self.path.read_text("utf-8"))
            except Exception:
                pass
        return {"ledger_version": LEDGER_VERSION, "entries": {}}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), "utf-8")
        tmp.replace(self.path)

    @staticmethod
    def _key(skill_id: str, version: str) -> str:
        return f"{skill_id}@{version}"

    def record(self, skill_dir: Path, verdict: str, score: Any,
               rules_version: str = "", source: str = "") -> dict[str, Any]:
        """扫描通过后登记。返回登记条目。"""
        meta = read_skill_meta(skill_dir)
        content_hash = compute_content_hash(skill_dir)
        entry = {
            "skill_id": meta["skill_id"],
            "version": meta["version"],
            "content_hash": content_hash,
            "verdict": verdict,
            "security_score": score,
            "rules_version": rules_version,
            "source": source,
            "recorded_at": int(time.time()),
        }
        self._data.setdefault("entries", {})[self._key(meta["skill_id"], meta["version"])] = entry
        self._save()
        return entry

    def verify(self, skill_dir: Path) -> dict[str, Any]:
        """加载前校验。返回 {status, reason, ...}。
        status: TRUSTED | TAMPERED | UNKNOWN | DENIED
        """
        meta = read_skill_meta(skill_dir)
        key = self._key(meta["skill_id"], meta["version"])
        entry = self._data.get("entries", {}).get(key)
        if entry is None:
            return {"status": "UNKNOWN", "skill_id": meta["skill_id"], "version": meta["version"],
                    "reason": "台账无记录，从未扫描通过，需先扫描", "action": "scan_required"}
        if entry.get("verdict") == "deny":
            return {"status": "DENIED", "skill_id": meta["skill_id"], "version": meta["version"],
                    "reason": "该 Skill 曾被扫描判定为拒绝安装", "action": "block_load"}
        current = compute_content_hash(skill_dir)
        if current != entry["content_hash"]:
            return {"status": "TAMPERED", "skill_id": meta["skill_id"], "version": meta["version"],
                    "reason": "内容哈希与登记不符（安装后被修改），拒绝加载并需重扫",
                    "action": "rescan_required",
                    "expected_hash": entry["content_hash"][:16], "actual_hash": current[:16]}
        return {"status": "TRUSTED", "skill_id": meta["skill_id"], "version": meta["version"],
                "reason": "内容哈希与登记一致", "action": "allow_load",
                "recorded_verdict": entry.get("verdict"), "security_score": entry.get("security_score")}

    def revoke(self, skill_id: str, version: str) -> bool:
        key = self._key(skill_id, version)
        if key in self._data.get("entries", {}):
            del self._data["entries"][key]
            self._save()
            return True
        return False

    def list_entries(self) -> list[dict[str, Any]]:
        return list(self._data.get("entries", {}).values())


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Skill 信任台账 / 完整性校验")
    ap.add_argument("--ledger", default="~/.agent/skill_trust_ledger.json")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_hash = sub.add_parser("hash"); p_hash.add_argument("skill")
    p_verify = sub.add_parser("verify"); p_verify.add_argument("skill")
    p_list = sub.add_parser("list")
    args = ap.parse_args()

    ledger = TrustLedger(args.ledger)
    if args.cmd == "hash":
        print(compute_content_hash(Path(args.skill)))
    elif args.cmd == "verify":
        print(json.dumps(ledger.verify(Path(args.skill)), ensure_ascii=False, indent=2))
    elif args.cmd == "list":
        print(json.dumps(ledger.list_entries(), ensure_ascii=False, indent=2))
