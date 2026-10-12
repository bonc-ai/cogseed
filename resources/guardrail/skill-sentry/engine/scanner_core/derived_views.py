"""
derived_views.py — 反规避派生视图（归一化 + 迭代解码后重扫）
==============================================================

为什么需要这一层
----------------
纯静态扫描最便宜的两个规避手法是「把关键词藏起来」和「把载荷编码起来」。
两者都不需要攻击者理解扫描器，只需要一个编辑器或一行 base64：

- ``ex<ZWSP>ec(...)``：零宽字符切断关键字，正则失配，人眼也看不出来；
- ``ｅｘｅｃ(...)``：全角 / NFKC 同形字，字面不同、语义相同；
- ``exec(base64.b64decode("<blob>"))``：载荷根本不以明文出现在文件里。

学术侧已有实测支撑（Cloak and Detonate, arXiv 2607.02357）：把载荷从
安装期可见的视图里藏起来、执行时再还原，可以在 8 个扫描器上取得 >90% 的
绕过率，其中对混合型扫描器仍有 96%。「按外观审计」被明确指出是不够的。

本模块的做法是**多视图重扫**，而不是更复杂的正则：

1. **归一化视图**：删除不可见字符、做 NFKC 折叠、把最常见的西里尔/希腊
   同形字折回拉丁字母，然后**用同一套规则再扫一遍**。行号保持不变。
2. **迭代解码视图**：对长 base64 / hex 串尝试解码，若结果可读则作为一个
   新视图再扫；最多 3 轮（一层套一层的编码是常见手法）。

判定取舍
--------
- **派生视图的命中一律降置信度**。理由：它们来自「经过变换的文本」，
  与原文的对应关系弱于直接命中；而且归一化本身会改变字符，误报面更大。
  降级而不是丢弃——审计者需要看到「解码后发现了什么」。
- **解码视图不给行号**。解码结果的第 N 行在原文里不存在；给一个假行号
  比不给更糟，因为它会把读者引到一个无关的位置。
- **可读性门槛**：解码结果必须大部分是可打印文本才作为视图。否则任何
  内嵌图片/字体/压缩资源都会解出一堆二进制，刷屏且无意义。
- **规模上限**：单文件派生视图总字节上限 + 单 blob 上限。派生视图是
  「多扫几遍」，不能让一个 1 MB 的编码资源把扫描时间翻十倍。
"""
from __future__ import annotations

import base64
import binascii
import re
import unicodedata
from typing import Any

#: 单文件所有派生视图的累计字节上限。
MAX_DERIVED_BYTES_PER_FILE = 256 * 1024
#: 单个编码串的上限（超过它的通常是资源而不是载荷）。
MAX_BLOB_CHARS = 200_000
#: 解码轮数上限。三层以上编码在真实样本里极罕见，而每多一层就多一遍扫描。
MAX_DECODE_ROUNDS = 3
#: 解码结果的可打印占比门槛。
PRINTABLE_RATIO = 0.85
#: 视图名 → 供 UI 展示的说明键。
VIEW_NOTES = {
    "normalized": "normalized",
    "b64_1": "decoded_base64",
    "b64_2": "decoded_base64_twice",
    "b64_3": "decoded_base64_thrice",
    "hex_1": "decoded_hex",
    "hex_2": "decoded_hex_twice",
    "hex_3": "decoded_hex_thrice",
}

# ── 不可见字符 ──────────────────────────────────────────────────────────
_INVISIBLE = dict.fromkeys(
    list(range(0x200B, 0x2010))     # ZWSP/ZWNJ/ZWJ/LRM/RLM…
    + [0x00AD, 0x061C, 0x180E, 0x2060, 0xFEFF, 0x115F, 0x1160]
    + list(range(0x202A, 0x202F))   # 双向控制
    + list(range(0x2066, 0x206A))
    + list(range(0xE0000, 0xE0080))  # Unicode 标签块
    + list(range(0xFE00, 0xFE10))    # 变体选择符
    + list(range(0xE0100, 0xE01F0)),
    None,
)

#: 最常见的西里尔 / 希腊同形字 → 拉丁字母。刻意保持短：这是一张
#: 「会被用来冒充英文关键词」的表，不是一份完整的 Unicode 混淆表。
_HOMOGLYPHS = str.maketrans({
    "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c",
    "\u0445": "x", "\u0443": "y", "\u0456": "i", "\u0455": "s", "\u04bb": "h",
    "\u0410": "A", "\u0415": "E", "\u041e": "O", "\u0420": "P", "\u0421": "C",
    "\u0425": "X", "\u0423": "Y", "\u0406": "I", "\u0405": "S",
    "\u03b1": "a", "\u03b2": "b", "\u03b5": "e", "\u03bf": "o", "\u03c1": "p",
    "\u03c3": "o", "\u03c4": "t", "\u03c5": "u", "\u03bd": "v", "\u03b9": "i",
    "\u03ba": "k", "\u03bc": "u", "\u0391": "A", "\u0392": "B", "\u0395": "E",
    "\u039f": "O", "\u03a1": "P", "\u03a4": "T", "\u03a5": "Y",
})


def normalize(text: str) -> str:
    """归一化视图：删不可见字符 → NFKC 折叠 → 同形字折回拉丁。

    行数保持不变（三类变换都不触碰换行），因此派生视图的 finding 可以
    带原始行号。
    """
    stripped = text.translate(_INVISIBLE)
    folded = unicodedata.normalize("NFKC", stripped)
    return folded.translate(_HOMOGLYPHS)


# ── 编码串识别 ──────────────────────────────────────────────────────────
_B64_RUN_RE = re.compile(r"[A-Za-z0-9+/]{40,}={0,2}")
_HEX_RUN_RE = re.compile(r"\b[0-9a-fA-F]{40,}\b")


def _printable_ratio(text: str) -> float:
    if not text:
        return 0.0
    printable = sum(1 for ch in text if ch.isprintable() or ch in "\n\r\t")
    return printable / len(text)


def _decode_base64(blob: str) -> str | None:
    padded = blob + "=" * (-len(blob) % 4)
    try:
        raw = base64.b64decode(padded, validate=False)
    except (binascii.Error, ValueError):
        return None
    return decode_bytes(raw)


def _decode_hex(blob: str) -> str | None:
    if len(blob) % 2:
        return None
    try:
        raw = binascii.unhexlify(blob)
    except (binascii.Error, ValueError):
        return None
    return decode_bytes(raw)


def decode_bytes(raw: bytes) -> str | None:
    """字节 → 文本，附可读性门槛。不可读返回 None。"""
    if not raw or len(raw) > MAX_BLOB_CHARS:
        return None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        # latin-1 兜底：一段被当成文本的二进制会立刻被可读性门槛挡掉。
        text = raw.decode("latin-1", errors="replace")
    return text if _printable_ratio(text) >= PRINTABLE_RATIO else None


def extract_decoded_views(text: str) -> list[tuple[str, str]]:
    """从一段文本里提取「迭代解码」视图。

    返回 ``[(视图名, 解码文本)]``，最多 ``MAX_DECODE_ROUNDS`` 层。
    每层里所有可解码的串**合并**成一个视图，而不是每个串一个视图——
    视图数量决定扫描遍数，而一个文件里出现 20 个 base64 常量是正常的
    （图标、测试夹具、证书链）。
    """
    views: list[tuple[str, str]] = []
    frontier = text
    for depth in range(1, MAX_DECODE_ROUNDS + 1):
        chunks: list[str] = []
        budget = MAX_DERIVED_BYTES_PER_FILE
        for blob, decoder, label in _candidate_blobs(frontier):
            decoded = decoder(blob)
            if not decoded:
                continue
            chunks.append(f"# source: {label}\n{decoded}")
            budget -= len(decoded)
            if budget <= 0:
                break
        if not chunks:
            break
        merged = "\n\n".join(chunks)
        names = {label for _, _, label in _candidate_blobs(frontier)}
        name = _view_name(names, depth)
        views.append((name, merged))
        # 下一轮：在解码结果里继续找编码串（嵌套编码）。
        frontier = merged
    return views


def _view_name(labels: set[str], depth: int) -> str:
    suffix = {1: "_1", 2: "_2", 3: "_3"}.get(depth, f"_{depth}")
    if labels == {"hex"}:
        return f"hex{suffix}"
    if labels == {"base64"}:
        return f"b64{suffix}"
    # 混合：取 base64 命名（更常见），并在说明里体现是混合视图。
    return f"b64{suffix}"


def _candidate_blobs(text: str):
    """产出 ``(blob, decoder, label)``；去重并按长度降序。

    长串优先：一个 500 字符的 base64 载荷通常**包含**若干短的可解码片段，
    先去重的短串会把同一个载荷解出多份噪音。
    """
    seen: set[str] = set()
    rows: list[tuple[str, Any, str, int]] = []
    for match in _B64_RUN_RE.finditer(text):
        blob = match.group(0)
        if blob in seen or len(blob) > MAX_BLOB_CHARS:
            continue
        seen.add(blob)
        rows.append((blob, _decode_base64, "base64", len(blob)))
    for match in _HEX_RUN_RE.finditer(text):
        blob = match.group(0)
        if blob in seen or len(blob) > MAX_BLOB_CHARS:
            continue
        # 纯十六进制且长度是常见摘要长度时不当作载荷候选：sha256/384/512
        # 到处都是，把摘要当载荷解会产出 32 字节的二进制噪音。
        if len(blob) in (32, 40, 64, 96, 128):
            continue
        seen.add(blob)
        rows.append((blob, _decode_hex, "hex", len(blob)))
    rows.sort(key=lambda r: -r[3])
    return [(blob, decoder, label) for blob, decoder, label, _ in rows]


def derived_views(rel: str, text: str) -> list[tuple[str, str]]:
    """一个文件的所有派生视图：``[(视图名, 文本)]``。

    归一化视图只在**确实发生了变化**时产出——否则每个文件都要多扫一遍
    完全相同的文本，白白翻倍扫描时间。
    """
    out: list[tuple[str, str]] = []
    if not text:
        return out
    normalized = normalize(text)
    if normalized != text:
        out.append(("normalized", normalized))
    # 解码视图基于归一化文本：先移除不可见字符，避免把
    # `aGVs<ZWSP>bG8=` 这类被切断的编码串漏掉。
    out.extend(extract_decoded_views(normalized))
    return out
