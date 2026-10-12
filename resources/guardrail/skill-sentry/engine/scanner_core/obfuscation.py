"""
obfuscation.py — 混淆与「先解码再执行」的检测
===============================================

``text_rules.py`` 只匹配规则文件里写死的字面模式，因此对以下形态完全失明：

- 把载荷 base64 编码后藏进字符串常量（``exec(base64.b64decode(BLOB))``）；
- 用 ``chr()`` / ``String.fromCharCode()`` 逐字符拼出 ``eval`` 或命令；
- 用 ``\\x`` / ``\\u`` 转义串绕开关键词匹配；
- 从远端拉一段代码再执行（``eval(requests.get(...).text)``）。

判定策略：**组合而非单点**
---------------------------
单一信号都太弱，单独报会造成大量噪音：

- 一段 80 字符的 base64 可能是一张内嵌图标；
- 一个 64 位十六进制串几乎总是 sha256 摘要（lockfile 里成百上千个）；
- ``String.fromCharCode`` 在正常代码里也有（字符集处理）。

但「**解码动作 + 执行动作**」共现时的解释空间很小——正常代码不需要在运行时
把编码内容解出来再交给解释器。因此：

- 单点信号 → ``low``/``medium`` 且 ``confidence=low``（只作线索，几乎不扣分）；
- 解码+执行共现 → ``critical`` 且 ``confidence=high``（这是 ``hard_block`` 级的形态，
  但仍走加权通道，因为「共现」是行级的，不是语义级的）。

阈值卡在正常用法之上：hex 串要求 ≥ 96 字符（sha256 是 64，sha512 是 128——
因此对 128 位摘要单独放行），base64 要求 ≥ 80 字符且长度是 4 的倍数。
"""
from __future__ import annotations

import math
import re
from typing import Any

from .context import CONTEXT_DOC, FileContext, build_contexts, severity_for
from .result_models import make_finding

# ── 载荷串形态 ──────────────────────────────────────────────────────────

_B64_RUN_RE = re.compile(r"[A-Za-z0-9+/]{80,}={0,2}")
_HEX_RUN_RE = re.compile(r"\b[0-9a-fA-F]{96,}\b")
#: sha256 / sha384 / sha512 摘要是 64 / 96 / 128 位十六进制，属正常内容。
_HASH_LENGTHS = {64, 96, 128}
_XESC_RUN_RE = re.compile(r"(?:\\x[0-9a-fA-F]{2}){6,}")
_UESC_RUN_RE = re.compile(r"(?:\\u[0-9a-fA-F]{4}){6,}")
_FROMCHARCODE_RE = re.compile(r"String\.fromCharCode\s*\(([^)]{40,})\)")
_CHR_CHAIN_RE = re.compile(r"(?:chr\s*\(\s*\d{1,4}\s*\)\s*\+?\s*){5,}")
_JSFUCK_RE = re.compile(r"(?:\[\s*\]\s*\[|\(\s*!\s*\[\s*\]\s*\+|\(\s*!!\s*\[\s*\]\s*\+)")

# ── 解码动作 ────────────────────────────────────────────────────────────
_DECODE_PATTERNS: list[tuple[str, str]] = [
    ("b64decode", r"base64\.b64decode|b64decode\s*\(|atob\s*\(|FromBase64String\s*\("),
    ("hex_decode", r"bytes\.fromhex\s*\(|binascii\.unhexlify\s*\(|unhexlify\s*\(|codecs\.decode\s*\([^)]*['\"]hex['\"]"),
    ("rot13", r"codecs\.decode\s*\([^)]*rot13|rot13\s*\(|tr\s+n-za-m"),
    ("zlib_inflate", r"zlib\.decompress\s*\(|gzinflate\s*\(|gzdecode\s*\(|gzip\.decompress\s*\("),
    ("url_decode", r"urllib\.parse\.unquote\s*\(|decodeURIComponent\s*\(|unquote_plus\s*\("),
    ("reverse", r"\[\s*::\s*-1\s*\]|\.reverse\s*\(\s*\)"),
    ("string_build", r"String\.fromCharCode\s*\(|chr\s*\(\s*\d{1,4}\s*\)|bytes\s*\(\s*\["),
]

# ── 执行动作 ────────────────────────────────────────────────────────────
_EXEC_PATTERNS: list[tuple[str, str]] = [
    ("eval_exec", r"\b(?:eval|exec|execfile|compile)\s*\("),
    ("js_eval", r"\b(?:eval|Function)\s*\(|new\s+Function\s*\("),
    ("shell_exec", r"\b(?:os\.system|subprocess\.(?:run|call|Popen|check_output)|child_process\.exec(?:Sync)?|execSync)\s*\("),
    ("pipe_to_shell", r"\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b|\|\s*python[0-9.]*\s"),
    ("dynamic_import", r"__import__\s*\(|importlib\.import_module\s*\(|require\s*\(\s*[A-Za-z_]"),
    ("py_run", r"runpy\.run_path\s*\(|exec\s+compile\s*\("),
]

_DECODE_RES = [(name, re.compile(rx, re.IGNORECASE)) for name, rx in _DECODE_PATTERNS]
_EXEC_RES = [(name, re.compile(rx, re.IGNORECASE)) for name, rx in _EXEC_PATTERNS]

#: 「远端拉取 + 执行」：无本地解码动作，但数据来自网络后再交给解释器。
_REMOTE_FETCH_RE = re.compile(
    r"(?:requests\.get|urlopen|urllib\.request\.urlopen|fetch\s*\(|httpx\.get|"
    r"curl\s|wget\s|Invoke-WebRequest|iwr\s)",
    re.IGNORECASE,
)

#: 单行内「解码」与「执行」的最大间隔。跨行共现噪音太大（同一文件里
#: 风马牛不相及的两行），因此只在行内与相邻行判定。
_NEIGHBOUR_WINDOW = 1


def shannon_entropy(text: str) -> float:
    """字符串的香农熵（bits/char）。用于识别「看起来像随机数据」的常量。"""
    if not text:
        return 0.0
    counts: dict[str, int] = {}
    for ch in text:
        counts[ch] = counts.get(ch, 0) + 1
    total = len(text)
    return -sum((c / total) * math.log2(c / total) for c in counts.values())


def _line_flags(text: str) -> list[dict[str, Any]]:
    """逐行标出该行具备的解码/执行能力。"""
    rows: list[dict[str, Any]] = []
    for lineno, line in enumerate(text.splitlines(), 1):
        decodes = [name for name, rx in _DECODE_RES if rx.search(line)]
        execs = [name for name, rx in _EXEC_RES if rx.search(line)]
        rows.append({
            "line": lineno,
            "text": line,
            "decodes": decodes,
            "execs": execs,
            "remote": bool(_REMOTE_FETCH_RE.search(line)),
        })
    return rows


def _blob_kind(blob: str) -> str | None:
    """判断长串是否值得报告。返回形态名或 None。"""
    if _HEX_RUN_RE.fullmatch(blob):
        # 摘要长度放行；更长的十六进制串不再有正常解释。
        return None if len(blob) in _HASH_LENGTHS else "hex_blob"
    return "base64_blob"


def scan_obfuscation(docs: list[tuple[str, str]],
                     contexts: dict[str, FileContext] | None = None) -> list[dict[str, Any]]:
    """扫描混淆载荷与「解码后执行」的形态。

    本模块的命中**全部**走上下文降权（与 hidden_content 相反）。理由是这里的
    模式在文档里被**引用**是常态：一篇讲解混淆手法的 SKILL.md 会写出
    ``eval(base64.b64decode(...))`` 作为反例。散文封顶 ``low`` 让这类引用
    退化成线索，而围栏代码块（用户会照抄执行）仍是 ``doc``，照常计分。
    """
    ctx_of = contexts or {}
    out: list[dict[str, Any]] = []

    for rel, text in docs:
        if not text:
            continue
        fctx = ctx_of.get(rel) or FileContext(rel, text)
        rows = _line_flags(text)

        # ── 1. 行内 / 相邻行的「解码 + 执行」共现 ────────────────────
        reported_lines: set[int] = set()
        for idx, row in enumerate(rows):
            ctx = fctx.at(row["line"], row["text"])
            if not row["execs"]:
                continue
            window = rows[max(0, idx - _NEIGHBOUR_WINDOW): idx + _NEIGHBOUR_WINDOW + 1]
            decode_hits = sorted({d for w in window for d in w["decodes"]})
            if not decode_hits:
                continue
            reported_lines.add(row["line"])
            out.append(make_finding(
                "SR-OB", "decode_then_execute", severity_for("critical", ctx), "obfuscation",
                rel, row["line"],
                "解码动作与执行动作共现（" + " + ".join([*decode_hits, *row["execs"]])
                + "）：运行时构造并执行代码，无法人工复核",
                "", source="obfuscation", context=ctx,
                original_severity="critical", confidence="high", snippet=row["text"],
            ))

        # ── 2. 远端拉取后交给解释器 ────────────────────────────────
        for idx, row in enumerate(rows):
            ctx = fctx.at(row["line"], row["text"])
            if not row["remote"] or not row["execs"]:
                continue
            if row["line"] in reported_lines:
                continue
            reported_lines.add(row["line"])
            out.append(make_finding(
                "SR-OB", "remote_code_execution", severity_for("critical", ctx), "unauthorized_download",
                rel, row["line"],
                "从远端获取内容后直接执行：执行内容不受版本控制，也无法审计",
                "", source="obfuscation", context=ctx,
                original_severity="critical", confidence="medium", snippet=row["text"],
            ))

        # ── 3. 长 base64 / hex 载荷串 ──────────────────────────────
        for row in rows:
            ctx = fctx.at(row["line"], row["text"])
            line = row["text"]
            if len(line) > 8000:
                line = line[:8000]
            for match in re.finditer(r"[A-Za-z0-9+/=]{80,}|[0-9a-fA-F]{96,}", line):
                blob = match.group(0)
                kind = _blob_kind(blob)
                if kind is None:
                    continue
                if len(blob) % 4 != 0 and kind == "base64_blob":
                    continue
                entropy = shannon_entropy(blob)
                # 低熵长串更可能是重复字符/占位符，不是编码载荷。
                if entropy < 3.6:
                    continue
                severity = "high" if kind == "base64_blob" and entropy > 4.5 else "medium"
                out.append(make_finding(
                    "SR-OB", kind, severity_for(severity, ctx), "obfuscation",
                    rel, row["line"],
                    f"检测到长编码串（{kind}，{len(blob)} 字符，熵 {entropy:.1f}）："
                    "可能为隐藏载荷，也可能是内嵌资源",
                    "", source="obfuscation", context=ctx,
                    original_severity=severity, confidence="low", snippet=blob[:64],
                ))

        # ── 4. 转义串 / 逐字符构造 ─────────────────────────────────
        for row in rows:
            ctx = fctx.at(row["line"], row["text"])
            line = row["text"]
            for rule_id, rx, note in (
                ("escape_hex_chain", _XESC_RUN_RE, "连续的 \\x 十六进制转义：常用于绕过关键词匹配"),
                ("escape_unicode_chain", _UESC_RUN_RE, "连续的 \\u 转义：常用于绕过关键词匹配"),
                ("fromcharcode_build", _FROMCHARCODE_RE, "用 String.fromCharCode 逐字符构造字符串"),
                ("chr_chain_build", _CHR_CHAIN_RE, "用 chr() 链逐字符构造字符串"),
                ("jsfuck_like", _JSFUCK_RE, "使用仅由符号构成的表达式（JSFuck 风格混淆）"),
            ):
                if rx.search(line):
                    out.append(make_finding(
                        "SR-OB", rule_id, severity_for("high", ctx), "obfuscation", rel, row["line"],
                        note, "", source="obfuscation", context=ctx,
                        original_severity="high",
                        confidence="medium" if rule_id.startswith("escape") else "high",
                        snippet=line,
                    ))

        # ── 5. shell 管道解码执行（单独形态，语法与 Python/JS 不同）──
        for row in rows:
            ctx = fctx.at(row["line"], row["text"])
            line = row["text"]
            if re.search(r"(?:base64\s+(?:-d|--decode)|openssl\s+enc\s+-d|xxd\s+-r)", line, re.IGNORECASE) \
                    and re.search(r"\|\s*(?:sudo\s+)?(?:ba|z)?sh\b", line, re.IGNORECASE):
                out.append(make_finding(
                    "SR-OB", "shell_pipe_decode_exec", severity_for("critical", ctx), "obfuscation",
                    rel, row["line"],
                    "shell 中「解码后管道给 shell 执行」：载荷不落盘，无法审计",
                    "", source="obfuscation", context=ctx,
                    original_severity="critical", confidence="high", snippet=line,
                ))
    return out
