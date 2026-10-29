"""单元测试：YARA 子集解释器。

为什么值得单独测
----------------
``malware_signature_matching`` 的结论完全取决于这个解释器。它有两种失败模式，
都不会抛异常：**解析成功但条件算错**（漏报/误报），以及**规则被静默跳过**
（签名包看起来生效了，实际一条都没跑）。这里的用例主要针对这两类。

签名包本身的规则质量由 ``tests/unit/test_yara_pack.py`` 负责（每条规则的正反例
在那边），本文件只验证解释器语义。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.scanner_core import yara_lite  # noqa: E402


def pack(source: str) -> yara_lite.SignaturePack:
    result = yara_lite.SignaturePack.load({"test.yar": source})
    assert not result.errors, result.errors
    return result


def match(source: str, data: bytes) -> list[str]:
    return [rule.name for rule, _ in pack(source).match(data)]


def test_text_matching_and_modifiers():
    rules = """
rule plain {
  strings: $a = "eval("
  condition: $a
}
rule nocase_hit {
  strings: $a = "ReverseShell" nocase
  condition: $a
}
rule fullword_only {
  strings: $a = "cat" fullword
  condition: $a
}
rule wide_hit {
  strings: $a = "powershell" wide
  condition: $a
}
"""
    result = yara_lite.SignaturePack.load({"t.yar": rules})
    assert not result.errors
    assert [r.name for r, _ in result.match(b"eval(request)")] == ["plain"]
    # fullword：`cat` 不能命中 `concat`，但能命中独立的 cat。
    hit = [r.name for r, _ in result.match(b"concat(cat)")]
    assert "fullword_only" in hit
    assert [r.name for r, _ in result.match(b"reverseSHELL")] == ["nocase_hit"]
    assert [r.name for r, _ in result.match("powershell".encode("utf-16-le"))] == ["wide_hit"]


def test_hex_wildcards_jumps_and_alternation():
    source = """
rule mz_stub {
  strings: $mz = { 4D 5A }
  condition: $mz
}
rule wildcard {
  strings: $a = { 6A ?? 90 }
  condition: $a
}
rule jump {
  strings: $a = { 4D 5A [2-4] 90 }
  condition: $a
}
rule alternation {
  strings: $a = { ( 4D 5A | 7F 45 4C 46 ) }
  condition: $a
}
rule nibble {
  strings: $a = { ?D 5A }
  condition: $a
}
"""
    # `?D` 匹配任意高半字节 + D，因此 0x4D 同时命中 nibble 规则。
    assert match(source, b"\x4d\x5a\x90\x00") == ["mz_stub", "alternation", "nibble"]
    assert match(source, b"\x6a\x11\x90") == ["wildcard"]
    assert match(source, b"\x4d\x5a\xaa\xbb\x90") == ["mz_stub", "jump", "alternation", "nibble"]
    assert match(source, b"\x7f\x45\x4c\x46") == ["alternation"]
    assert match(source, b"\x3d\x5a") == ["nibble"]
    assert match(source, b"\x3e\x5a") == []


def test_regex_strings():
    source = r"""
rule credit_card {
  strings: $a = /4[0-9]{12}(?:[0-9]{3})?/
  condition: $a
}
rule case_insensitive {
  strings: $a = /secret_key/ nocase
  condition: $a
}
"""
    assert match(source, b"card=4111111111111111;") == ["credit_card"]
    assert match(source, b"SECRET_KEY") == ["case_insensitive"]


def test_conditions_combinators_and_counts():
    source = """
rule both {
  strings: $a = "alpha" $b = "beta"
  condition: all of them
}
rule either_of_prefix {
  strings: $a1 = "alpha" $a2 = "gamma" $b = "beta"
  condition: any of ($a*)
}
rule two_of_them {
  strings: $a = "alpha" $b = "beta" $c = "gamma"
  condition: 2 of them
}
rule count_threshold {
  strings: $a = "x"
  condition: #a >= 3
}
rule offset_window {
  strings: $a = "needle"
  condition: @a < 10
}
rule at_offset {
  strings: $a = "MZ"
  condition: $a at 0
}
rule in_range {
  strings: $a = "needle"
  condition: $a in (0..8)
}
rule precedence {
  strings: $a = "alpha" $b = "beta"
  condition: not $a or $b and $b
}
"""
    compiled = pack(source)

    def hits(rule_name: str, data: bytes) -> bool:
        return rule_name in [rule.name for rule, _ in compiled.match(data)]

    # all of them：任意一条缺失即为假（把 counts 的键当全集会错判为真）。
    assert hits("both", b"alphabeta")
    assert not hits("both", b"alpha")
    # any of ($a*) 只展开 $a 前缀。
    assert hits("either_of_prefix", b"gamma")
    assert hits("either_of_prefix", b"alpha")
    assert not hits("either_of_prefix", b"beta")
    # N of them：命中数达到 N。
    assert hits("two_of_them", b"alphabeta")
    assert not hits("two_of_them", b"alpha")
    # #a 计数。
    assert hits("count_threshold", b"xxx")
    assert not hits("count_threshold", b"xx")
    # @a 未命中时比较不成立（不能用 -1 < 10 蒙混过关）。
    assert hits("offset_window", b"needle")
    assert not hits("offset_window", b"............needle")
    # 未命中的 @a 不产生命中。
    assert not hits("offset_window", b"nothing here")
    assert hits("at_offset", b"MZ\x90")
    assert not hits("at_offset", b"xMZ")
    assert hits("in_range", b"needle")
    assert not hits("in_range", b".........needle")
    # not/and/or 优先级：not a or (b and b)。
    assert not hits("precedence", b"alpha")
    assert hits("precedence", b"beta")
    assert hits("precedence", b"gamma")


def test_filesize_and_integer_functions():
    source = """
rule small {
  condition: filesize < 1KB
}
rule pe_magic {
  condition: uint16(0) == 0x5A4D
}
rule big_endian {
  condition: uint16be(0) == 0x4D5A
}
"""
    assert match(source, b"x") == ["small"]
    assert match(source, b"\x4d\x5a" + b"\x00" * 2048) == ["pe_magic", "big_endian"]
    assert match(source, b"\x00" * 2048) == []


def test_meta_and_rule_lines():
    source = """
private rule demo : tag1 tag2 {
  meta:
    severity = "critical"
    category = "reverse_shell"
    description = "测试规则"
    hard_block = false
    score = 7
  strings:
    $a = "shell"
  condition:
    $a
}
"""
    rules = yara_lite.parse_rules(source, "demo.yar").rules
    rule = rules[0]
    assert rule.name == "demo"
    assert rule.tags == ["tag1", "tag2"]
    assert rule.meta["severity"] == "critical"
    assert rule.meta["hard_block"] is False
    assert rule.meta["score"] == 7


def test_comments_and_multiline_hex_strings():
    source = """
// leading comment
rule commented {
  meta:
    note = "// not a comment" // trailing comment
  strings:
    $a = { 4D 5A /* inline
                   block */ 90 }
  condition:
    $a
}
"""
    assert match(source, b"\x4d\x5a\x90") == ["commented"]


def test_import_line_is_accepted():
    source = """
import "pe"

rule uses_no_module {
  strings: $a = "MZ"
  condition: $a
}
"""
    assert match(source, b"MZ") == ["uses_no_module"]


def test_unsupported_condition_is_reported_not_silently_skipped():
    source = """
rule loops {
  strings: $a = "x"
  condition: for any of them : ( $a )
}
rule uses_module {
  condition: pe.number_of_sections > 0
}
rule good {
  strings: $a = "ok"
  condition: $a
}
"""
    result = yara_lite.SignaturePack.load({"bad.yar": source})
    assert [rule.name for rule in result.rules] == ["good"]
    assert len(result.errors) == 2
    assert "condition" in result.errors[0]["error"]
    assert "module" in result.errors[1]["error"]


def test_unknown_string_modifier_is_reported():
    result = yara_lite.SignaturePack.load({"bad.yar": """
rule xor_rule {
  strings: $a = "x" xor
  condition: $a
}
"""})
    assert result.rules == []
    assert "xor" in result.errors[0]["error"]


def test_counts_are_exact_below_the_cap():
    source = """
rule many {
  strings: $a = "x"
  condition: #a >= 200
}
"""
    rules = yara_lite.parse_rules(source).rules
    result = rules[0].match(b"x" * 200)
    assert result is not None
    assert result["strings"]["$a"][0] == 200
    assert rules[0].match(b"x" * 199) is None
