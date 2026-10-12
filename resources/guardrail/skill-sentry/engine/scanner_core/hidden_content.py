"""
hidden_content.py — 对人不显示、对模型可见的内容
==================================================

这一类是纯正则文本规则的**结构性盲区**：``text_rules.py`` 逐行读文本，
而下面这些载荷的特点恰恰是「人看不到」。

为什么单独立项
--------------
传统 SAST 不处理这类载荷，因为传统程序没有「读者」与「执行者」分离的问题。
Agent Skill 有：语言模型读的是**码点序列**，人读的是**渲染结果**。两者之间
可以合法地不一致：

- **Unicode 标签块**（U+E0000–U+E007F）在终端与编辑器里不显示任何字形，
  但模型能读到，是 ASCII 走私的标准手法。一段 ``SKILL.md`` 里如果藏着
  ``U+E0069 U+E0067 ...``，渲染出来是一个空白。
- **零宽字符**可以切断关键字使正则失配（``ex<ZWSP>ec(``），也可以把
  「不可见指令」拼进正文。
- **双向控制字符**把源码渲染顺序与逻辑顺序解耦（Trojan Source，CVE-2021-42574）。
- **HTML 注释**在 Markdown 渲染后不可见，但原始文本里是完整句子。
- **ANSI 转义序列**在 ``cat`` 时能重写终端画面，把危险输出伪装成正常输出。
- **隐藏样式**（``display:none`` / 白字白底）在 HTML Skill 里等价于隐形墨。

判定原则
--------
1. **不可见字符类载荷不做上下文降权**。「这段文本藏在 vendor/ 里」不改变
   它不可见这一事实；降权会让攻击者只需把载荷放进 ``tests/`` 就能绕过。
   finding 仍带 ``context`` 字段供审计。
2. **需要看语义的部分（HTML 注释里的指令）才降权**，因为正常文档确实会写
   ``<!-- TODO: 补充说明 -->``。这类只在注释里含**祈使性指令**时命中。
3. **阈值卡在「正常用法」之上**：单个 BOM、emoji 后的单个变体选择符、
   CSS 里的 ``display:none`` 都合法，规则命中需要达到「成串 / 成组」。
"""
from __future__ import annotations

import re
from typing import Any, Iterable

from .context import FileContext
from .result_models import make_finding

# ── 码点集合 ────────────────────────────────────────────────────────────

#: Unicode 标签块（U+E0000–U+E007F）。**没有任何合法用途出现在源码/文档中**：
#: 这一区块是为「语言标签」设计的兼容区，实际只被 ASCII 走私工具使用。
_TAG_CHARS = re.compile("[\U000E0000-\U000E007F]")

#: 零宽与不可见格式字符。注意 U+FEFF 在文件首部是 BOM，属正常。
_ZERO_WIDTH = "\u200b\u200c\u200d\u2060\u180e"
_ZERO_WIDTH_RE = re.compile(f"[{_ZERO_WIDTH}]")

#: 双向控制字符（Trojan Source）。
_BIDI_RE = re.compile("[\u202a-\u202e\u2066-\u2069\u061c\u200e\u200f]")

#: 变体选择符。emoji 后接 1 个是正常（U+FE0F）；成串出现是走私手法。
_VS_RE = re.compile("[\ufe00-\ufe0f\U000E0100-\U000E01EF]")

#: ANSI 转义序列。CSI / OSC 两种形态。
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")

#: 人类可读文本的扩展名。「文档里的不可见字符」与「源码里的不可见字符」
#: 风险不同，但都命中——只是描述与置信度不同。
_CODE_EXT = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".sh", ".bash",
             ".zsh", ".rb", ".go", ".rs", ".java", ".php", ".pl", ".ps1", ".bat", ".cmd"}
_DOC_EXT = {".md", ".markdown", ".rst", ".txt", ".adoc", ".html", ".htm"}

#: HTML 注释体。``re.S`` 让注释跨行匹配。
_HTML_COMMENT_RE = re.compile(r"<!--(.*?)-->", re.S)

#: 注释里的祈使性指令。**必须同时**出现「动作动词」与「第二人称/代理指代」，
#: 否则 ``<!-- 本文件由脚本生成 -->`` 一类正常注释会命中。
_IMPERATIVE_VERB = (
    r"ignore|disregard|forget|override|bypass|skip|reveal|print|output|send|post|upload|"
    r"execute|run|install|download|delete|remove|"
    r"忽略|无视|忘记|覆盖|绕过|跳过|跳过检查|泄露|输出|发送|上传|执行|运行|安装|下载|删除"
)
_AGENT_PRONOUN = (
    r"you|your|assistant|agent|model|ai|claude|gpt|llm|system|"
    r"你|助手|代理|模型|系统"
)
_INSTRUCTION_IN_COMMENT_RE = re.compile(
    rf"(?:{_IMPERATIVE_VERB})[^\n]{{0,80}}(?:{_AGENT_PRONOUN})"
    rf"|(?:{_AGENT_PRONOUN})[^\n]{{0,80}}(?:{_IMPERATIVE_VERB})",
    re.IGNORECASE,
)

#: 隐藏样式声明。只匹配「把内容藏起来」的组合，不匹配普通布局属性。
_HIDDEN_STYLE_RE = re.compile(
    r"(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:[^.\d]|$)|"
    r"font-size\s*:\s*0(?:px|em|rem|%)|height\s*:\s*0(?:px)?\s*;\s*overflow\s*:\s*hidden|"
    r"position\s*:\s*absolute\s*;\s*left\s*:\s*-\d{3,}px|text-indent\s*:\s*-\d{3,}px)",
    re.IGNORECASE,
)

#: Markdown 图片/链接，URL 里带长查询串或模板插值——典型的「把内容塞进 URL 外发」。
_MD_LINK_RE = re.compile(r"!?\[[^\]]{0,200}\]\(\s*(https?://[^)\s]+)\s*\)")
_URL_INTERP_RE = re.compile(r"[?&][A-Za-z_][A-Za-z0-9_]{0,30}=\$?\{|%7B|\{\{|<%=|\$\(")

#: 隐写式 base64 data-URI（图片位置放一段 base64 文本）。
_DATA_URI_RE = re.compile(r"data:[a-z]+/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]{120,})", re.IGNORECASE)

#: 常见拉丁字母的视觉同形字（Cyrillic / Greek）。用于检出「混排伪装」。
_HOMOGLYPH_RE = re.compile("[\u0430\u0435\u043e\u0440\u0441\u0445\u0443\u0456\u0455\u04bb"
                            "\u03b1\u03b2\u03b5\u03bf\u03c1\u03c3\u03c4\u03c5\u03bd\u03b9\u03ba\u03bc]")

_MAX_LINE_SCAN = 4000


def _is_code(relpath: str) -> bool:
    dot = relpath.rfind(".")
    return dot >= 0 and relpath[dot:].lower() in _CODE_EXT


def _is_doc(relpath: str) -> bool:
    dot = relpath.rfind(".")
    return dot >= 0 and relpath[dot:].lower() in _DOC_EXT


def _iter_hits(pattern: re.Pattern[str], text: str) -> Iterable[tuple[int, str]]:
    """逐行返回 (行号, 该行) 命中。逐行而非全文，是为了给出可定位的行号。"""
    for lineno, line in enumerate(text.splitlines(), 1):
        if len(line) > _MAX_LINE_SCAN:
            # 超长行（压缩产物）一行的命中数没有审计价值，也会拖慢扫描。
            line = line[:_MAX_LINE_SCAN]
        if pattern.search(line):
            yield lineno, line


def scan_hidden_content(
    docs: list[tuple[str, str]],
    contexts: dict[str, FileContext] | None = None,
) -> list[dict[str, Any]]:
    """扫描不可见/隐藏内容载荷。

    ``contexts`` 只用于在 finding 上**标注**命中所处的上下文，
    **不参与是否命中或严重级的判定**——见模块文档的判定原则 1。
    """
    ctx_of = contexts or {}
    out: list[dict[str, Any]] = []

    for rel, text in docs:
        if not text:
            continue
        fctx = ctx_of.get(rel) or FileContext(rel, text)
        code = _is_code(rel)
        doc = _is_doc(rel)

        def ctx_at(lineno: int, line: str, _f=fctx) -> str:
            return _f.at(lineno, line)

        # ── 1. Unicode 标签块 ───────────────────────────────────────
        for lineno, line in _iter_hits(_TAG_CHARS, text):
            out.append(make_finding(
                "SR-HC", "unicode_tag_smuggling", "critical", "hidden_content",
                rel, lineno,
                "检测到 Unicode 标签块字符（U+E0000–U+E007F）：渲染后不可见，"
                "但会被模型当作正文读取",
                "", hard_block=False, source="hidden-content",
                context=ctx_at(lineno, line), original_severity="critical", confidence="high",
                snippet=line,
            ))

        # ── 2. 双向控制字符（Trojan Source）─────────────────────────
        for lineno, line in _iter_hits(_BIDI_RE, text):
            out.append(make_finding(
                "SR-HC", "bidi_control_chars", "high", "hidden_content",
                rel, lineno,
                "检测到双向文本控制字符：源码的显示顺序与逻辑顺序不一致，"
                "可用于隐藏真实代码（Trojan Source）",
                "", source="hidden-content", context=ctx_at(lineno, line),
                original_severity="high", confidence="high", snippet=line,
            ))

        # ── 3. 零宽字符 ────────────────────────────────────────────
        # 单个零宽字符在文档里仍可能是排版残留；成串（>=3）或出现在代码
        # 标识符位置才是「切断关键字」的形态。分别给不同严重级。
        for lineno, line in _iter_hits(_ZERO_WIDTH_RE, text):
            count = len(_ZERO_WIDTH_RE.findall(line))
            # 行首单个 BOM 是合法文件头。
            if lineno == 1 and count == 1 and line.startswith("\ufeff"):
                continue
            if code and count >= 1:
                severity, note = "high", "代码文件中出现零宽字符，可切断关键字或隐藏指令"
            elif count >= 3:
                severity, note = "medium", "成串零宽字符，常见于不可见指令载荷"
            else:
                severity, note = "low", "存在零宽字符（可能是排版残留，也可能是隐藏内容）"
            out.append(make_finding(
                "SR-HC", "zero_width_chars", severity, "hidden_content",
                rel, lineno, note, "", source="hidden-content", context=ctx_at(lineno, line),
                original_severity=severity,
                # 单个零宽字符在文档里确实常是残留 → 降置信度，不降严重级。
                confidence="high" if (code or count >= 3) else "low",
                snippet=line,
            ))

        # ── 4. 变体选择符成串（emoji 隐写）──────────────────────────
        for lineno, line in _iter_hits(_VS_RE, text):
            if len(_VS_RE.findall(line)) >= 4:
                out.append(make_finding(
                    "SR-HC", "variation_selector_run", "high", "hidden_content",
                    rel, lineno,
                    "检测到连续变体选择符：可在不改变显示的前提下按位编码隐藏数据",
                    "", source="hidden-content", context=ctx_at(lineno, line),
                    original_severity="high", confidence="medium", snippet=line,
                ))

        # ── 5. ANSI 转义序列 ───────────────────────────────────────
        for lineno, line in _iter_hits(_ANSI_RE, text):
            # 文档里的转义序列会在用户 cat/查看时重写终端画面；
            # 源码里的转义序列大多是彩色输出，风险低一档。
            severity = "medium" if doc else "low"
            out.append(make_finding(
                "SR-HC", "ansi_escape_sequence", severity, "hidden_content",
                rel, lineno,
                "包含 ANSI 转义序列：可重写终端输出，把危险结果显示成正常结果"
                if doc else "包含 ANSI 转义序列（源码中通常为彩色输出）",
                "", source="hidden-content", context=ctx_at(lineno, line),
                original_severity=severity, confidence="medium", snippet=line,
            ))

        # ── 6. HTML 注释里的指令 ───────────────────────────────────
        if "<!--" in text:
            for match in _HTML_COMMENT_RE.finditer(text):
                body = match.group(1)
                if not _INSTRUCTION_IN_COMMENT_RE.search(body):
                    continue
                lineno = text.count("\n", 0, match.start()) + 1
                _match_line = body.splitlines()[0] if body.splitlines() else body
                out.append(make_finding(
                    "SR-HC", "hidden_instruction_html_comment", "high", "hidden_content",
                    rel, lineno,
                    "HTML 注释中包含针对模型的祈使性指令：渲染后不可见，但原始文本可被读取",
                    "", source="hidden-content", context=ctx_at(lineno, _match_line),
                    original_severity="high", confidence="medium",
                    snippet=_match_line,
                ))

        # ── 7. 隐藏样式 ────────────────────────────────────────────
        if _is_doc(rel) or rel.lower().endswith((".html", ".htm", ".svg")):
            for lineno, line in _iter_hits(_HIDDEN_STYLE_RE, text):
                out.append(make_finding(
                    "SR-HC", "hidden_style_block", "medium", "hidden_content",
                    rel, lineno,
                    "使用隐藏样式（display:none / 透明 / 零字号）隐藏内容："
                    "对用户不可见，但仍会被解析",
                    "", source="hidden-content", context=ctx_at(lineno, line),
                    original_severity="medium", confidence="medium", snippet=line,
                ))

        # ── 8. 链接外带（把内容编码进 URL）──────────────────────────
        for match in _MD_LINK_RE.finditer(text):
            url = match.group(1)
            if not _URL_INTERP_RE.search(url):
                continue
            lineno = text.count("\n", 0, match.start()) + 1
            _match_line = url
            out.append(make_finding(
                "SR-HC", "markdown_link_exfil", "medium", "data_egress",
                rel, lineno,
                "Markdown 链接把变量插值进远程 URL：渲染时会自动发起请求，"
                "可用于静默外带上下文",
                "", source="hidden-content", context=ctx_at(lineno, _match_line),
                original_severity="medium", confidence="medium", snippet=url,
            ))

        # ── 9. base64 data-URI 隐写 ────────────────────────────────
        for match in _DATA_URI_RE.finditer(text):
            lineno = text.count("\n", 0, match.start()) + 1
            _match_line = match.group(0)
            out.append(make_finding(
                "SR-HC", "embedded_data_uri_blob", "medium", "obfuscation",
                rel, lineno,
                "内嵌长 base64 data-URI：可能是伪装成图片的编码载荷",
                "", source="hidden-content", context=ctx_at(lineno, _match_line),
                original_severity="medium", confidence="low",
                snippet=match.group(0)[:80],
            ))

        # ── 10. 同形字混排 ─────────────────────────────────────────
        if code:
            for lineno, line in _iter_hits(_HOMOGLYPH_RE, text):
                # 只在同一行同时出现 ASCII 字母与同形字时才算伪装；
                # 纯西里尔字母的注释是正常的多语言文本。
                if re.search(r"[A-Za-z]", line):
                    out.append(make_finding(
                        "SR-HC", "homoglyph_mixed_script", "medium", "hidden_content",
                        rel, lineno,
                        "同一行混用拉丁字母与视觉同形的西里尔/希腊字母："
                        "可用于让标识符看起来像可信名称",
                        "", source="hidden-content", context=ctx_at(lineno, line),
                        original_severity="medium", confidence="low", snippet=line,
                    ))
    return out
