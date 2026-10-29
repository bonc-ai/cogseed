"""
yara_lite.py — 纯 Python 的 YARA 子集解释器
================================================

为什么自己实现
--------------
``malware_signature_matching`` 之前的实现是一张手写的指标表（挖矿池域名、
反向 shell 关键词、键鼠 API 名）。指标表能覆盖「已知形态」，但每加一个家族
就要改一次 Python，且无法表达「A 与 B 同时出现才算」这类结构化特征——真实的
恶意代码规则库（YARA）主要就是靠这种组合条件把误报压下去的。

引入 ``yara-python`` 需要 C 扩展 + 系统库，而引擎的约束是「随 Skill 发布、
在任意 python3 上可运行」（出厂运行时是最小 Python，没有编译工具链）。因此
这里实现一个**规则格式兼容、条件子集**的解释器：签名包仍然是标准 ``.yar``
文本，换到真正的 YARA 引擎上不需要改写规则。

支持的语法（与不支持的部分一样重要）
------------------------------------
支持:
- ``rule name : tag { meta/strings/condition }``，``import "pe"`` 会被跳过并告警
- 字符串: 文本（``ascii`` / ``wide`` / ``nocase`` / ``fullword``）、
  十六进制（``??`` 通配、``?A`` / ``A?`` 半字节、``[n-m]`` 跳转、``( a | b )``）、
  PCRE 风格正则（``/…/is``）
- 条件: ``and/or/not``、比较运算、``filesize``、``entrypoint``、
  ``uint8/16/32`` 与 ``int8/16/32``（含 ``be`` 变体）、``$a``、``#a``、``@a``、
  ``any/all/none/N of them`` 与 ``any of ($a, $b*)``、``$a at N``、``$a in (a..b)``

不支持（遇到就在 ``errors`` 里报出来，**绝不静默跳过**）:
- ``for`` 循环、``pe.*`` / ``math.*`` 模块、``xor`` 修饰符、百分比数量词
- 一个规则写错不会让整包失效：错误的规则单独记录，其余规则照常生效

覆盖边界
--------
YARA 的语义细节（偏移、宽字符边界、正则方言）这里只实现到「本项目的签名包
需要」的程度。签名包由本仓库维护，新增规则请同时补 ``tests/unit/test_yara.py``
的正反例；把第三方 YARA 规则库直接丢进来之前，先用 ``--dry-run`` 式的解析
检查确认没有落在不支持列表里。
"""
from __future__ import annotations

import re
from typing import Any, Optional

#: 单条字符串最多收集的命中偏移。``#a`` 的语义需要精确计数，超过上限时
#: 计数会被截断并在 ``capped`` 里标记——宁可承认「至少这么多」。
MAX_MATCHES_PER_STRING = 10_000

_COMPARISONS = {"==", "!=", "<", "<=", ">", ">="}
_INT_FUNCS = {
    "uint8": (1, "little", False), "uint16": (2, "little", False),
    "uint32": (4, "little", False), "int8": (1, "little", True),
    "int16": (2, "little", True), "int32": (4, "little", True),
    "uint16be": (2, "big", False), "uint32be": (4, "big", False),
    "int16be": (2, "big", True), "int32be": (4, "big", True),
}
_NUMBER_SUFFIX = {"kb": 1024, "mb": 1024 ** 2, "gb": 1024 ** 3}


class YaraError(Exception):
    """规则语法/编译错误。消息里带文件名与行号。"""


# ── 词法 ────────────────────────────────────────────────────────────────
class _Token:
    __slots__ = ("kind", "value", "line")

    def __init__(self, kind: str, value: Any, line: int) -> None:
        self.kind = kind
        self.value = value
        self.line = line

    def __repr__(self) -> str:  # pragma: no cover
        return f"<{self.kind}:{self.value!r}@{self.line}>"


class _Lexer:
    def __init__(self, source: str, filename: str = "<rule>") -> None:
        self.source = source
        self.filename = filename
        self.pos = 0
        self.line = 1
        self._peeked: Optional[_Token] = None

    # -- 基础 ----------------------------------------------------------
    def _advance(self, count: int = 1) -> None:
        chunk = self.source[self.pos:self.pos + count]
        self.line += chunk.count("\n")
        self.pos += count

    def skip_ws(self) -> None:
        while self.pos < len(self.source):
            char = self.source[self.pos]
            if char in " \t\r\n":
                self._advance()
                continue
            if self.source.startswith("//", self.pos):
                end = self.source.find("\n", self.pos)
                self._advance((len(self.source) if end < 0 else end) - self.pos)
                continue
            if self.source.startswith("/*", self.pos):
                end = self.source.find("*/", self.pos + 2)
                if end < 0:
                    raise YaraError(f"{self.filename}:{self.line}: unterminated block comment")
                self._advance(end + 2 - self.pos)
                continue
            break

    def peek(self) -> _Token:
        if self._peeked is None:
            self._peeked = self._read()
        return self._peeked

    def next(self) -> _Token:
        if self._peeked is not None:
            token, self._peeked = self._peeked, None
            return token
        return self._read()

    def _read(self) -> _Token:
        self.skip_ws()
        if self.pos >= len(self.source):
            return _Token("EOF", "", self.line)
        line = self.line
        char = self.source[self.pos]

        if char == "$":
            self._advance()
            name = self._read_ident_chars()
            if not name and self.pos < len(self.source) and self.source[self.pos] == "*":
                self._advance()
                return _Token("STRID", "$*", line)
            if not name:
                raise YaraError(f"{self.filename}:{line}: expected string identifier after $")
            return _Token("STRID", "$" + name, line)
        if char == "#":
            self._advance()
            return _Token("STRCOUNT", "$" + self._read_ident_chars(), line)
        if char == "@":
            self._advance()
            return _Token("STROFF", "$" + self._read_ident_chars(), line)
        if char == "!":
            self._advance()
            name = self._read_ident_chars()
            if name:
                return _Token("STRLEN", "$" + name, line)
            return _Token("PUNCT", "!", line)

        if char.isalpha() or char == "_":
            name = self._read_ident_chars()
            return _Token("IDENT", name, line)

        if char.isdigit():
            text = self._read_number()
            return _Token("NUMBER", text, line)

        if char == '"':
            return _Token("STRING", self._scan_quoted(), line)

        for operator in ("==", "!=", "<=", ">=", "..", "<<", ">>"):
            if self.source.startswith(operator, self.pos):
                self._advance(len(operator))
                return _Token("PUNCT", operator, line)
        if char in "(){}[]:,.=<>+-*\\%|&":
            self._advance()
            return _Token("PUNCT", char, line)
        raise YaraError(f"{self.filename}:{line}: unexpected character {char!r}")

    def _read_ident_chars(self) -> str:
        start = self.pos
        while self.pos < len(self.source) and re.match(r"[A-Za-z0-9_]", self.source[self.pos]):
            self._advance()
        return self.source[start:self.pos]

    def _read_number(self) -> str:
        start = self.pos
        if self.source.startswith(("0x", "0X"), self.pos):
            self._advance(2)
            while self.pos < len(self.source) and re.match(r"[0-9A-Fa-f]", self.source[self.pos]):
                self._advance()
            return self.source[start:self.pos]
        while self.pos < len(self.source) and self.source[self.pos].isdigit():
            self._advance()
        suffix_start = self.pos
        while self.pos < len(self.source) and self.source[self.pos].isalpha():
            self._advance()
        suffix = self.source[suffix_start:self.pos].lower()
        if suffix:
            if suffix not in _NUMBER_SUFFIX:
                raise YaraError(f"{self.filename}:{self.line}: unknown size suffix {suffix!r}")
            return str(int(self.source[start:suffix_start]) * _NUMBER_SUFFIX[suffix])
        return self.source[start:self.pos]

    def _scan_quoted(self) -> str:
        """读取双引号字符串的**原文**（含转义），返回解转义后的值。"""
        assert self.source[self.pos] == '"'
        self._advance()
        out = []
        while self.pos < len(self.source):
            char = self.source[self.pos]
            if char == '"':
                self._advance()
                return "".join(out)
            if char == "\\":
                if self.pos + 1 >= len(self.source):
                    break
                escape = self.source[self.pos + 1]
                mapping = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\", '"': '"'}
                if escape == "x" and self.pos + 3 < len(self.source):
                    try:
                        out.append(chr(int(self.source[self.pos + 2:self.pos + 4], 16)))
                        self._advance(4)
                        continue
                    except ValueError:
                        pass
                out.append(mapping.get(escape, escape))
                self._advance(2)
                continue
            out.append(char)
            self._advance()
        raise YaraError(f"{self.filename}:{self.line}: unterminated string")


# ── 字符串模式 ──────────────────────────────────────────────────────────
class _Pattern:
    """编译后的一条字符串。``regex`` 为 None 表示跳过（编译失败）。"""

    __slots__ = ("id", "regex", "quick", "error")

    def __init__(self, sid: str) -> None:
        self.id = sid
        self.regex: Optional[re.Pattern] = None
        self.quick: Optional[bytes] = None
        self.error: Optional[str] = None

    def find(self, data: bytes) -> tuple[list[int], bool]:
        if self.regex is None:
            return [], False
        # 文本模式（非 nocase）先做一次廉价的子串检查：签名包里绝大多数规则
        # 在绝大多数文件上不命中，逐条跑正则会把扫描时间放大到不可接受。
        if self.quick is not None and self.quick not in data:
            return [], False
        offsets: list[int] = []
        for match in self.regex.finditer(data):
            offsets.append(match.start())
            if len(offsets) >= MAX_MATCHES_PER_STRING:
                return offsets, True
        return offsets, False


def _wide(pattern: bytes) -> bytes:
    out = bytearray()
    for byte in pattern:
        out.append(byte)
        out.append(0)
    return bytes(out)


def _compile_text(sid: str, text: str, modifiers: list[str]) -> _Pattern:
    pattern = _Pattern(sid)
    unknown = set(modifiers) - {"ascii", "wide", "nocase", "fullword", "private"}
    if unknown:
        pattern.error = f"unsupported string modifier: {', '.join(sorted(unknown))}"
        return pattern
    try:
        raw = text.encode("utf-8")
    except Exception as exc:  # pragma: no cover - utf-8 编码几乎不会失败
        pattern.error = f"cannot encode string: {exc}"
        return pattern
    variants = []
    if "wide" in modifiers and "ascii" not in modifiers:
        variants = [_wide(raw)]
    elif "wide" in modifiers and "ascii" in modifiers:
        variants = [raw, _wide(raw)]
    else:
        variants = [raw]
    parts = [re.escape(variant) for variant in variants]
    body = parts[0] if len(parts) == 1 else b"(?:" + b"|".join(parts) + b")"
    if "fullword" in modifiers:
        body = b"(?<![A-Za-z0-9_])" + body + b"(?![A-Za-z0-9_])"
    flags = re.DOTALL
    if "nocase" in modifiers:
        flags |= re.IGNORECASE
    try:
        pattern.regex = re.compile(body, flags)
    except re.error as exc:
        pattern.error = f"regex compile failed: {exc}"
        return pattern
    # quick 只对「纯 ASCII、非 nocase」的文本模式有意义：宽字符模式的字节序列
    # 与原文不同，拿原文做子串预检会把命中直接过滤掉（实测）。
    if "nocase" not in modifiers and "wide" not in modifiers:
        pattern.quick = raw
    return pattern


def _nibble_class(high: Optional[str], low: Optional[str]) -> bytes:
    values = []
    for high_value in (range(16) if high is None else [int(high, 16)]):
        for low_value in (range(16) if low is None else [int(low, 16)]):
            values.append(high_value * 16 + low_value)
    return b"[" + b"".join(b"\\x%02x" % value for value in sorted(values)) + b"]"


def _strip_hex_comments(text: str) -> str:
    text = re.sub(r"//[^\n]*", " ", text)
    return re.sub(r"/\*.*?\*/", " ", text, flags=re.DOTALL)


def _compile_hex(sid: str, inner: str) -> _Pattern:
    pattern = _Pattern(sid)
    text = _strip_hex_comments(inner)
    tokens: list[tuple[str, Any]] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char.isspace():
            index += 1
            continue
        if char in "()|":
            tokens.append((char, None))
            index += 1
            continue
        if char == "[":
            end = text.find("]", index)
            if end < 0:
                pattern.error = "unterminated jump in hex string"
                return pattern
            body = text[index + 1:end].replace(" ", "")
            match = re.fullmatch(r"(\d*)-?(\d*)", body)
            if not match or not body:
                pattern.error = f"invalid jump [{body}]"
                return pattern
            low = int(match.group(1) or 0)
            high = int(match.group(2) or match.group(1) or 0)
            if high < low:
                pattern.error = f"invalid jump range [{body}]"
                return pattern
            tokens.append(("jump", (low, high)))
            index = end + 1
            continue
        if char == "?":
            nxt = text[index + 1] if index + 1 < len(text) else ""
            if nxt == "?":
                tokens.append(("any", None))
                index += 2
                continue
            if nxt and nxt in "0123456789abcdefABCDEF":
                tokens.append(("nibble", (None, nxt)))
                index += 2
                continue
            pattern.error = "lone ? in hex string"
            return pattern
        if char in "0123456789abcdefABCDEF":
            nxt = text[index + 1] if index + 1 < len(text) else ""
            if not nxt or nxt not in "0123456789abcdefABCDEF":
                if nxt == "?":
                    tokens.append(("nibble", (char, None)))
                    index += 2
                    continue
                pattern.error = f"incomplete byte at {char!r}"
                return pattern
            tokens.append(("byte", int(char + nxt, 16)))
            index += 2
            continue
        pattern.error = f"unexpected character {char!r} in hex string"
        return pattern

    def parse_sequence(position: int) -> tuple[bytes, int]:
        parts: list[bytes] = []
        while position < len(tokens) and tokens[position][0] not in (")", "|"):
            kind, value = tokens[position]
            if kind == "byte":
                parts.append(b"\\x%02x" % value)
            elif kind == "any":
                parts.append(b".")
            elif kind == "nibble":
                parts.append(_nibble_class(*value))
            elif kind == "jump":
                low, high = value
                parts.append(b".{%d}" % low if low == high else b".{%d,%d}" % (low, high))
            elif kind == "(":
                group, position = parse_alternatives(position + 1)
                if position >= len(tokens) or tokens[position][0] != ")":
                    raise YaraError(f"{sid}: unbalanced ( in hex string")
                parts.append(b"(?:" + group + b")")
                position += 1  # 吃掉 ")"
                continue
            else:  # pragma: no cover - tokens 已在上面的循环里过滤
                raise YaraError(f"unexpected hex token {kind}")
            position += 1
        return b"".join(parts), position

    def parse_alternatives(position: int) -> tuple[bytes, int]:
        branches = []
        while True:
            branch, position = parse_sequence(position)
            branches.append(branch)
            if position < len(tokens) and tokens[position][0] == "|":
                position += 1
                continue
            break
        return b"|".join(branches), position

    body, end = parse_alternatives(0)
    if end < len(tokens) and tokens[end][0] == ")":
        pattern.error = "unbalanced ) in hex string"
        return pattern
    if not body:
        pattern.error = "empty hex string"
        return pattern
    try:
        pattern.regex = re.compile(body, re.DOTALL)
    except re.error as exc:
        pattern.error = f"regex compile failed: {exc}"
    return pattern


def _compile_regex(sid: str, source: str, flags: str, modifiers: list[str]) -> _Pattern:
    pattern = _Pattern(sid)
    unknown = set(modifiers) - {"ascii", "wide", "nocase", "fullword", "private"}
    if unknown:
        pattern.error = f"unsupported string modifier: {', '.join(sorted(unknown))}"
        return pattern
    flag_bits = re.DOTALL
    if "i" in flags or "nocase" in modifiers:
        flag_bits |= re.IGNORECASE
    if "s" in flags:
        flag_bits |= re.DOTALL
    try:
        pattern.regex = re.compile(source.encode("utf-8"), flag_bits)
    except re.error as exc:
        pattern.error = f"regex compile failed: {exc}"
    return pattern


# ── 规则与条件 ──────────────────────────────────────────────────────────
class Rule:
    __slots__ = ("name", "tags", "meta", "strings", "condition", "filename",
                 "line", "error")

    def __init__(self) -> None:
        self.name = ""
        self.tags: list[str] = []
        self.meta: dict[str, Any] = {}
        self.strings: dict[str, _Pattern] = {}
        self.condition: Any = None
        self.filename = ""
        self.line = 0
        self.error: Optional[str] = None

    # -- 匹配 ----------------------------------------------------------
    def match(self, data: bytes) -> Optional[dict[str, Any]]:
        """返回 ``{"strings": {id: (count, first_offset)}, "capped": bool}``。"""
        if self.error or self.condition is None:
            return None
        counts: dict[str, int] = {}
        offsets: dict[str, list[int]] = {}
        capped = False
        for sid in _referenced_strings(self.condition, set(self.strings), self.strings):
            pattern = self.strings.get(sid)
            if pattern is None:
                continue
            found, hit_cap = pattern.find(data)
            capped = capped or hit_cap
            if found:
                counts[sid] = len(found)
                offsets[sid] = found
        if not _evaluate(self.condition, data, counts, offsets, set(self.strings)):
            return None
        first = {
            sid: (counts[sid], offsets[sid][0] if offsets.get(sid) else 0)
            for sid in counts
        }
        return {"strings": first, "capped": capped}


def _referenced_strings(node: Any, all_ids: set[str],
                        patterns: dict[str, _Pattern]) -> list[str]:
    """条件实际引用了哪些字符串。未引用的不扫，避免「几十条规则 × 每个文件」。"""
    found: set[str] = set()

    def walk(item: Any) -> None:
        if not isinstance(item, tuple):
            return
        op = item[0]
        if op in ("strid", "strcount", "stroff", "strlen"):
            sid = item[1]
            if sid.endswith("*"):
                found.update(candidate for candidate in all_ids
                             if candidate.startswith(sid[:-1]))
            else:
                found.add(sid)
            return
        if op == "of":
            found.update(_expand_set(item[2], all_ids))
            return
        if op in ("at", "in"):
            walk(item[1])
            for child in item[2:]:
                walk(child)
            return
        if op == "cmp":
            walk(item[2])
            walk(item[3])
            return
        if op == "intfunc":
            walk(item[2])
            return
        if op in ("and", "or"):
            walk(item[1])
            walk(item[2])
            return
        if op == "not":
            walk(item[1])

    walk(node)
    return sorted(sid for sid in found if sid in patterns)


def _as_number(value: Any) -> float:
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return value
    return 0


def _evaluate(node: Any, data: bytes, counts: dict[str, int],
              offsets: dict[str, list[int]], all_ids: set[str]) -> Any:
    op = node[0]
    if op == "bool":
        return node[1]
    if op == "num":
        return node[1]
    if op == "filesize":
        return len(data)
    if op == "entrypoint":
        return 0
    if op == "strid":
        return counts.get(node[1], 0) > 0
    if op == "strcount":
        return counts.get(node[1], 0)
    if op == "stroff":
        found = offsets.get(node[1]) or []
        return found[0] if found else -1
    if op == "strlen":
        return 0
    if op == "not":
        return not _as_number(_evaluate(node[1], data, counts, offsets, all_ids))
    if op == "and":
        return bool(_as_number(_evaluate(node[1], data, counts, offsets, all_ids))) and \
            bool(_as_number(_evaluate(node[2], data, counts, offsets, all_ids)))
    if op == "or":
        return bool(_as_number(_evaluate(node[1], data, counts, offsets, all_ids))) or \
            bool(_as_number(_evaluate(node[2], data, counts, offsets, all_ids)))
    if op == "cmp":
        # `@a` 只在字符串命中时有定义。YARA 里对未命中的 `@a` 做比较不会成立；
        # 若把 `-1 < 10` 直接算成 true，任何带 `@a < N` 的规则都会在干净文件上命中。
        if any(child[0] == "stroff" and not offsets.get(child[1])
               for child in (node[2], node[3]) if isinstance(child, tuple)):
            return False
        left = _as_number(_evaluate(node[2], data, counts, offsets, all_ids))
        right = _as_number(_evaluate(node[3], data, counts, offsets, all_ids))
        operator = node[1]
        return {
            "==": left == right, "!=": left != right,
            "<": left < right, "<=": left <= right,
            ">": left > right, ">=": left >= right,
        }[operator]
    if op == "intfunc":
        func = node[1]
        size, endian, signed = _INT_FUNCS[func]
        offset = int(_as_number(_evaluate(node[2], data, counts, offsets, all_ids)))
        if offset < 0 or offset + size > len(data):
            return 0
        return int.from_bytes(data[offset:offset + size], endian, signed=signed)
    if op == "of":
        quantifier, target = node[1], node[2]
        ids = _expand_set(target, all_ids)
        if target[0] == "them":
            ids = sorted(all_ids)
        matched = sum(1 for sid in ids if counts.get(sid, 0) > 0)
        if quantifier == "any":
            return matched > 0
        if quantifier == "all":
            # `all of them` 的 "them" 是规则里的全部字符串，不是「已经命中的那几条」。
            # 用 counts 的键当全集会让单条命中把 `all` 判成真。
            return bool(ids) and matched == len(set(ids))
        if quantifier == "none":
            return matched == 0
        return matched >= int(quantifier)
    if op == "at":
        sid = node[1][1] if node[1][0] == "strid" else None
        target = int(_as_number(_evaluate(node[2], data, counts, offsets, all_ids)))
        return sid is not None and target in offsets.get(sid, [])
    if op == "in":
        sid = node[1][1] if node[1][0] == "strid" else None
        low = int(_as_number(_evaluate(node[2], data, counts, offsets, all_ids)))
        high = int(_as_number(_evaluate(node[3], data, counts, offsets, all_ids)))
        return sid is not None and any(low <= offset <= high
                                       for offset in offsets.get(sid, []))
    raise YaraError(f"unsupported condition node {op}")


# ── 规则解析 ────────────────────────────────────────────────────────────
class _RuleParser:
    def __init__(self, source: str, filename: str) -> None:
        self.lexer = _Lexer(source, filename)
        self.filename = filename

    def _expect(self, kind: str, value: Optional[str] = None) -> _Token:
        token = self.lexer.next()
        if token.kind != kind or (value is not None and token.value != value):
            expected = value if value is not None else kind
            raise YaraError(f"{self.filename}:{token.line}: expected {expected}, "
                            f"got {token.kind} {token.value!r}")
        return token

    def _ident_is(self, value: str) -> bool:
        token = self.lexer.peek()
        return token.kind == "IDENT" and token.value == value

    def _consume_ident(self, value: str) -> bool:
        if self._ident_is(value):
            self.lexer.next()
            return True
        return False

    # -- 文件 ----------------------------------------------------------
    def parse(self) -> "ParseResult":
        """逐条解析。单条规则写错只记一条错误，继续解析后面的规则。

        为什么不能「整文件失败」：签名包是一个文件里几十条规则，一条规则用了
        不支持的语法（``for`` 循环、``pe.`` 模块）就让整包失效，等于新增一条
        规则的风险变成「静默关掉所有旧规则」。
        """
        result = ParseResult()
        while True:
            try:
                token = self.lexer.peek()
            except YaraError as exc:
                result.errors.append({"file": self.filename, "rule": "", "error": str(exc)})
                if not self._resync():
                    return result
                continue
            if token.kind == "EOF":
                return result
            if token.kind == "IDENT" and token.value == "import":
                try:
                    self.lexer.next()
                    self._expect("STRING")
                except YaraError as exc:
                    result.errors.append({"file": self.filename, "rule": "", "error": str(exc)})
                    if not self._resync():
                        return result
                continue
            if token.kind == "IDENT" and token.value in ("private", "global"):
                self.lexer.next()
                continue
            if token.kind == "IDENT" and token.value == "rule":
                try:
                    result.rules.append(self._parse_rule())
                except YaraError as exc:
                    result.errors.append({
                        "file": self.filename,
                        "rule": getattr(self, "_current_rule_name", ""),
                        "error": str(exc),
                    })
                    if not self._resync():
                        return result
                continue
            result.errors.append({
                "file": self.filename, "rule": "",
                "error": f"{self.filename}:{token.line}: expected rule, "
                         f"got {token.kind} {token.value!r}",
            })
            if not self._resync():
                return result

    def _resync(self) -> bool:
        """跳到下一条 ``rule`` 之后继续；没有下一条时返回 False。"""
        source = self.lexer.source
        match = re.search(r"(?m)^[ \t]*(?:(?:private|global)[ \t]+)?rule[ \t]+[A-Za-z_]\w*",
                          source[self.lexer.pos + 1:])
        if not match:
            self.lexer.pos = len(source)
            self.lexer.line = source.count("\n") + 1
            self.lexer._peeked = None
            return False
        offset = self.lexer.pos + 1 + match.start()
        self.lexer.pos = offset
        self.lexer.line = source.count("\n", 0, offset) + 1
        self.lexer._peeked = None
        return True

    def _parse_rule(self) -> Rule:
        rule = Rule()
        rule.filename = self.filename
        start = self._expect("IDENT", "rule")
        rule.line = start.line
        rule.name = self._expect("IDENT").value
        self._current_rule_name = rule.name
        if self.lexer.peek().kind == "PUNCT" and self.lexer.peek().value == ":":
            self.lexer.next()
            while self.lexer.peek().kind == "IDENT":
                rule.tags.append(self.lexer.next().value)
        self._expect("PUNCT", "{")
        while True:
            token = self.lexer.peek()
            if token.kind == "PUNCT" and token.value == "}":
                self.lexer.next()
                break
            if token.kind != "IDENT" or token.value not in ("meta", "strings", "condition"):
                raise YaraError(f"{self.filename}:{token.line}: expected section, "
                                f"got {token.kind} {token.value!r}")
            section = self.lexer.next().value
            self._expect("PUNCT", ":")
            if section == "meta":
                self._parse_meta(rule)
            elif section == "strings":
                self._parse_strings(rule)
            else:
                rule.condition = self._parse_expression()
                self._expect("PUNCT", "}")
                break
        if rule.condition is None:
            raise YaraError(f"{self.filename}:{rule.name}: missing condition")
        for pattern in rule.strings.values():
            if pattern.error:
                raise YaraError(f"{self.filename}:{rule.name}: string {pattern.id}: "
                                f"{pattern.error}")
        return rule

    def _parse_meta(self, rule: Rule) -> None:
        while True:
            token = self.lexer.peek()
            if token.kind != "IDENT":
                return
            if token.value in ("strings", "condition"):
                return
            key = self.lexer.next().value
            self._expect("PUNCT", "=")
            value_token = self.lexer.next()
            if value_token.kind == "STRING":
                rule.meta[key] = value_token.value
            elif value_token.kind == "NUMBER":
                rule.meta[key] = int(value_token.value)
            elif value_token.kind == "IDENT" and value_token.value in ("true", "false"):
                rule.meta[key] = value_token.value == "true"
            else:
                raise YaraError(f"{self.filename}:{value_token.line}: invalid meta value")

    def _parse_strings(self, rule: Rule) -> None:
        while True:
            token = self.lexer.peek()
            if token.kind == "IDENT" and token.value in ("meta", "condition",
                                                         "strings"):
                return
            if token.kind == "PUNCT" and token.value == "}":
                return
            if token.kind != "STRID":
                raise YaraError(f"{self.filename}:{token.line}: expected string "
                                f"identifier, got {token.kind} {token.value!r}")
            sid = self.lexer.next().value
            self._expect("PUNCT", "=")
            self.lexer.skip_ws()
            pattern = self._parse_string_value(sid)
            modifiers = self._read_modifiers()
            if isinstance(pattern, tuple) and pattern[0] == "text":
                rule.strings[sid] = _compile_text(sid, pattern[1], modifiers)
            elif isinstance(pattern, tuple) and pattern[0] == "hex":
                compiled = _compile_hex(sid, pattern[1])
                if compiled.error is None and modifiers:
                    compiled.error = "hex strings accept no modifiers"
                rule.strings[sid] = compiled
            else:
                compiled = _compile_regex(sid, pattern[1], pattern[2], modifiers)
                rule.strings[sid] = compiled
            if sid in rule.strings and rule.strings[sid].error:
                raise YaraError(f"{self.filename}:{rule.line}: {sid}: "
                                f"{rule.strings[sid].error}")

    def _parse_string_value(self, sid: str):
        source = self.lexer.source
        pos = self.lexer.pos
        if pos >= len(source):
            raise YaraError(f"{self.filename}:{self.lexer.line}: missing value for {sid}")
        char = source[pos]
        if char == '"':
            value = self.lexer._scan_quoted()
            return ("text", value)
        if char == "{":
            end = self._scan_braced(source, pos)
            inner = source[pos + 1:end]
            self.lexer._advance(end + 1 - self.lexer.pos)
            return ("hex", inner)
        if char == "/":
            end = pos + 1
            while end < len(source):
                if source[end] == "\\":
                    end += 2
                    continue
                if source[end] == "/":
                    break
                if source[end] == "\n":
                    raise YaraError(f"{self.filename}:{self.lexer.line}: "
                                    "unterminated regular expression")
                end += 1
            if end >= len(source):
                raise YaraError(f"{self.filename}:{self.lexer.line}: "
                                "unterminated regular expression")
            body = source[pos + 1:end]
            flags_start = end + 1
            cursor = flags_start
            while cursor < len(source) and source[cursor] in "is":
                cursor += 1
            flags = source[flags_start:cursor]
            self.lexer._advance(cursor - self.lexer.pos)
            return ("regex", body, flags)
        raise YaraError(f"{self.filename}:{self.lexer.line}: unsupported value for {sid}")

    def _scan_braced(self, source: str, start: int) -> int:
        depth = 0
        index = start
        while index < len(source):
            char = source[index]
            if source.startswith("/*", index):
                end = source.find("*/", index + 2)
                if end < 0:
                    raise YaraError(f"{self.filename}: unterminated comment in hex string")
                index = end + 2
                continue
            if source.startswith("//", index):
                end = source.find("\n", index)
                index = len(source) if end < 0 else end + 1
                continue
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return index
            index += 1
        raise YaraError(f"{self.filename}: unterminated hex string")

    def _read_modifiers(self) -> list[str]:
        """读取字符串修饰符。

        按 token 而不是「本行剩余文本」：YARA 允许 ``$a = "x" $b = "y"`` 写在一行，
        按行读会把后一个字符串定义当成修饰符（实测；错误信息还很像语法错误）。
        """
        modifiers = []
        while True:
            token = self.lexer.peek()
            if token.kind == "IDENT" and token.value not in ("meta", "strings",
                                                             "condition"):
                modifiers.append(self.lexer.next().value)
                continue
            break
        return modifiers

    # -- 条件 ----------------------------------------------------------
    def _parse_expression(self):
        return self._parse_or()

    def _parse_or(self):
        node = self._parse_and()
        while self._consume_ident("or"):
            node = ("or", node, self._parse_and())
        return node

    def _parse_and(self):
        node = self._parse_not()
        while self._consume_ident("and"):
            node = ("and", node, self._parse_not())
        return node

    def _parse_not(self):
        if self._consume_ident("not"):
            return ("not", self._parse_not())
        return self._parse_comparison()

    def _parse_comparison(self):
        left = self._parse_primary()
        token = self.lexer.peek()
        if token.kind == "IDENT" and token.value == "at":
            self.lexer.next()
            return ("at", left, self._parse_primary())
        if token.kind == "IDENT" and token.value == "in":
            self.lexer.next()
            self._expect("PUNCT", "(")
            low = self._parse_expression()
            self._expect("PUNCT", "..")
            high = self._parse_expression()
            self._expect("PUNCT", ")")
            return ("in", left, low, high)
        if token.kind == "PUNCT" and token.value in _COMPARISONS:
            operator = self.lexer.next().value
            return ("cmp", operator, left, self._parse_primary())
        return left

    def _parse_primary(self):
        token = self.lexer.next()
        if token.kind == "PUNCT" and token.value == "(":
            node = self._parse_expression()
            self._expect("PUNCT", ")")
            return node
        if token.kind == "NUMBER":
            value = int(token.value, 0) if str(token.value).startswith("0x") \
                else int(token.value)
            if self._consume_ident("of"):
                return ("of", value, self._parse_string_set())
            return ("num", value)
        if token.kind == "IDENT":
            if token.value in ("true", "false"):
                return ("bool", token.value == "true")
            if token.value == "filesize":
                return ("filesize",)
            if token.value == "entrypoint":
                return ("entrypoint",)
            if token.value in ("any", "all", "none"):
                self._expect("IDENT", "of")
                return ("of", token.value, self._parse_string_set())
            if token.value in _INT_FUNCS:
                self._expect("PUNCT", "(")
                argument = self._parse_expression()
                self._expect("PUNCT", ")")
                return ("intfunc", token.value, argument)
            raise YaraError(f"{self.filename}:{token.line}: unsupported identifier "
                            f"{token.value!r} in condition (modules are not supported)")
        if token.kind == "STRID":
            if self.lexer.peek().kind == "PUNCT" and self.lexer.peek().value == "*":
                self.lexer.next()
                return ("strid", token.value + "*")
            return ("strid", token.value)
        if token.kind == "STRCOUNT":
            return ("strcount", token.value)
        if token.kind == "STROFF":
            return ("stroff", token.value)
        if token.kind == "STRLEN":
            return ("strlen", token.value)
        raise YaraError(f"{self.filename}:{token.line}: unexpected token "
                        f"{token.kind} {token.value!r} in condition")

    def _parse_string_set(self):
        token = self.lexer.peek()
        if token.kind == "IDENT" and token.value == "them":
            self.lexer.next()
            return ("them", None)
        ids: list[str] = []
        if token.kind == "PUNCT" and token.value == "(":
            self.lexer.next()
            while True:
                item = self.lexer.next()
                if item.kind == "PUNCT" and item.value == ")":
                    break
                if item.kind != "STRID":
                    raise YaraError(f"{self.filename}:{item.line}: expected string "
                                    f"identifier in set")
                if self.lexer.peek().kind == "PUNCT" and self.lexer.peek().value == "*":
                    self.lexer.next()
                    ids.append(item.value + "*")
                else:
                    ids.append(item.value)
                if self.lexer.peek().kind == "PUNCT" and self.lexer.peek().value == ",":
                    self.lexer.next()
            return ("list", ids)
        if token.kind == "STRID":
            self.lexer.next()
            if self.lexer.peek().kind == "PUNCT" and self.lexer.peek().value == "*":
                self.lexer.next()
                return ("prefix", token.value)
            return ("list", [token.value])
        raise YaraError(f"{self.filename}:{token.line}: invalid string set")


def _expand_set(target: tuple[str, Any], all_ids: set[str]) -> list[str]:
    kind, value = target
    if kind == "them":
        return sorted(all_ids)
    if kind == "prefix":
        return [sid for sid in all_ids if sid.startswith(value)]
    ids: list[str] = []
    for item in value:
        if item.endswith("*"):
            ids.extend(sid for sid in all_ids if sid.startswith(item[:-1]))
        else:
            ids.append(item)
    return ids


class ParseResult:
    """一个文件的解析结果：可用的规则 + 每条失败规则的原因。"""

    __slots__ = ("rules", "errors")

    def __init__(self) -> None:
        self.rules: list[Rule] = []
        self.errors: list[dict[str, str]] = []


def parse_rules(source: str, filename: str = "<rule>") -> ParseResult:
    """解析一个 ``.yar`` 文件；单条规则失败不影响其余规则。"""
    return _RuleParser(source, filename).parse()


class SignaturePack:
    """一组已编译规则 + 解析错误清单。"""

    __slots__ = ("rules", "errors")

    def __init__(self, rules: list[Rule], errors: list[dict[str, str]]) -> None:
        self.rules = rules
        self.errors = errors

    @classmethod
    def load(cls, files: dict[str, str]) -> "SignaturePack":
        rules: list[Rule] = []
        errors: list[dict[str, str]] = []
        for filename, source in sorted(files.items()):
            try:
                parsed = parse_rules(source, filename)
            except Exception as exc:  # 解析器的任何意外都不能让扫描整体失败
                errors.append({"file": filename, "rule": "",
                               "error": f"{type(exc).__name__}: {exc}"})
                continue
            errors.extend(parsed.errors)
            for rule in parsed.rules:
                if rule.error:
                    errors.append({"file": filename, "rule": rule.name,
                                   "error": rule.error})
                    continue
                rules.append(rule)
        return cls(rules, errors)

    def match(self, data: bytes) -> list[tuple[Rule, dict[str, Any]]]:
        matched = []
        for rule in self.rules:
            result = rule.match(data)
            if result is not None:
                matched.append((rule, result))
        return matched
