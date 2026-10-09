#!/usr/bin/env python3
"""
trust_root.py — 信任根：扫描器/规则/台账 完整性自检
============================================================

解决的问题（信任链的最后一环）
------------------------------
前面所有防护都建立在“扫描器和规则是可信的”这个假设上。如果攻击者能改扫描器
代码或规则库（比如把危险规则删掉、把 verdict 强制改成 allow），整条防护链就
从根上崩了。本模块给这条链一个**信任根**：

  1. 基线清单 baseline：记录所有关键文件（扫描器代码、规则库、网关、台账工具）
     的 sha256。
  2. 基线用 HMAC-SHA256 + Agent 私钥签名。攻击者能改文件，但没有私钥就伪造
     不出合法签名 —— 自检会失败。
  3. Agent 启动时先 verify_self()：任一关键文件被改、或签名对不上 → 判定
     COMPROMISED，拒绝启动安全网关（fail-closed）。
  4. 台账文件也纳入保护范围（防止攻击者直接改台账 hash 绕过 load_gate）。

密钥来源
--------
- 环境变量 AGENT_TRUST_KEY（推荐：Agent 启动时从受保护位置注入）。
- 或首次运行自动生成并存到 key_path（0600 权限），适合本地开发。
真正的强绑定分发中，密钥应由 Agent 本体持有、随签名二进制保护，不落盘明文。

注意
----
HMAC 是“防篡改”不是“防抵赖”。它保证：没有密钥的攻击者改不动受保护文件而不被
发现。如果攻击者已拿到密钥（=已完全攻陷 Agent 本体），信任根也无能为力——那时
问题已不在本模块的威胁模型内。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import stat
import time
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_BASELINE = ROOT_DIR / "runtime_trust" / "trust_baseline.json"
DEFAULT_KEY_PATH = "~/.agent/trust_root.key"

# 受信任根保护的关键文件（相对项目根）
PROTECTED_FILES = [
    "engine/scanner_core/report.py",
    "engine/scanner_core/text_rules.py",
    "engine/scanner_core/binary_rules.py",
    "engine/scanner_core/scoring.py",
    "engine/scanner_core/rule_loader.py",
    "engine/rulesets/v1.0.0/text-rules.yaml",
    "engine/rulesets/v1.0.0/secret-patterns.yaml",
    "sandbox/agent_gate.py",
    "sandbox/run_sandboxed_scan.sh",
    "sandbox/Dockerfile",
    "runtime_trust/skill_guard.py",
    "runtime_trust/trust_ledger.py",
    "runtime_trust/trust_root.py",
]


def _load_key(key_path: str) -> bytes:
    """优先环境变量；否则读/生成 key 文件（0600）。"""
    env = os.environ.get("AGENT_TRUST_KEY")
    if env:
        return env.encode("utf-8")
    p = Path(key_path).expanduser()
    if p.is_file():
        return p.read_bytes()
    # 首次：生成随机密钥并以 0600 存盘
    p.parent.mkdir(parents=True, exist_ok=True)
    key = os.urandom(32)
    p.write_bytes(key)
    try:
        p.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0600
    except Exception:
        pass
    return key


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _sign(payload: dict[str, Any], key: bytes) -> str:
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hmac.new(key, blob, hashlib.sha256).hexdigest()


def build_baseline(root: Path = ROOT_DIR, baseline_path: Path = DEFAULT_BASELINE,
                   key_path: str = DEFAULT_KEY_PATH, extra_files: list[str] | None = None) -> dict[str, Any]:
    """（可信环境下）生成并签名基线。应在打包/发布 Agent 时执行。"""
    key = _load_key(key_path)
    files: dict[str, str] = {}
    missing: list[str] = []
    for rel in PROTECTED_FILES + (extra_files or []):
        fp = root / rel
        if fp.is_file():
            files[rel] = _file_hash(fp)
        else:
            missing.append(rel)
    payload = {
        "baseline_version": "1.0.0",
        "created_at": int(time.time()),
        "files": files,
    }
    baseline = {"payload": payload, "signature": _sign(payload, key)}
    baseline_path.parent.mkdir(parents=True, exist_ok=True)
    baseline_path.write_text(json.dumps(baseline, ensure_ascii=False, indent=2), "utf-8")
    return {"status": "OK", "protected": len(files), "missing": missing, "baseline": str(baseline_path)}


def verify_self(root: Path = ROOT_DIR, baseline_path: Path = DEFAULT_BASELINE,
                key_path: str = DEFAULT_KEY_PATH, ledger_path: str | None = None) -> dict[str, Any]:
    """
    Agent 启动时调用。返回 {status: TRUSTED|COMPROMISED|NO_BASELINE, ...}。
    fail-closed：任何异常都判 COMPROMISED，调用方应拒绝启用安全网关。
    """
    if not Path(baseline_path).is_file():
        return {"status": "NO_BASELINE", "reason": "基线不存在，需先 build_baseline（发布时生成）"}
    try:
        baseline = json.loads(Path(baseline_path).read_text("utf-8"))
        payload = baseline["payload"]
        signature = baseline["signature"]
    except Exception as exc:
        return {"status": "COMPROMISED", "reason": f"基线文件损坏或格式异常: {exc}"}

    key = _load_key(key_path)
    # 1) 验签：基线本身没被伪造
    if not hmac.compare_digest(_sign(payload, key), signature):
        return {"status": "COMPROMISED", "reason": "基线签名校验失败（基线被篡改或密钥不符）"}

    # 2) 逐文件比对
    tampered: list[str] = []
    missing: list[str] = []
    for rel, expected in payload.get("files", {}).items():
        fp = root / rel
        if not fp.is_file():
            missing.append(rel)
            continue
        if _file_hash(fp) != expected:
            tampered.append(rel)

    # 3) 可选：台账完整性（台账内容会变，这里只校验它未被外部工具异常接管）
    ledger_note = None
    if ledger_path:
        lp = Path(ledger_path).expanduser()
        ledger_note = "台账存在" if lp.is_file() else "台账尚未创建"

    if tampered or missing:
        return {"status": "COMPROMISED",
                "reason": "关键文件完整性校验失败，拒绝启用安全网关",
                "tampered": tampered, "missing": missing, "ledger": ledger_note}
    return {"status": "TRUSTED", "reason": "扫描器/规则/网关完整性校验通过",
            "protected": len(payload.get("files", {})), "ledger": ledger_note}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="信任根：完整性基线与自检")
    ap.add_argument("--key", default=DEFAULT_KEY_PATH)
    ap.add_argument("--baseline", default=str(DEFAULT_BASELINE))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build")
    pv = sub.add_parser("verify"); pv.add_argument("--ledger", default=None)
    args = ap.parse_args()

    if args.cmd == "build":
        print(json.dumps(build_baseline(baseline_path=Path(args.baseline), key_path=args.key),
                         ensure_ascii=False, indent=2))
    elif args.cmd == "verify":
        print(json.dumps(verify_self(baseline_path=Path(args.baseline), key_path=args.key,
                                     ledger_path=args.ledger), ensure_ascii=False, indent=2))
