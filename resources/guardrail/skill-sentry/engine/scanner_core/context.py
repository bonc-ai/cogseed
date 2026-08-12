"""
context.py — 文件上下文分类 + 语言分派 + 行级证据定性
========================================================

为什么需要这一层
----------------
纯正则扫描的误报几乎全部来自「同一个字符串在不同上下文里含义完全不同」：

- ``re.exec(log)``（JavaScript）不是 Python 的 ``exec()`` 动态执行；
- ``test_crawl.py`` 里的 ``169.254.169.254`` 是 SSRF 防御的**断言输入**，
  不是攻击载荷；
- ``url_safety.py`` 注释里写的 ``169.254.169.254`` 是在解释「我们拒绝它」；
- ``vendor/gsap.min.js`` 单行 100KB 压缩代码，任何宽松正则都会乱中。

这一层不做「删除 finding」，只做两件事：

1. **语言分派**：Python 专属规则不施加于 ``.js``/``.ts`` 文件（反之亦然）。
   这是纠正「规则用错对象」，属于修 bug，不是放宽检测。
2. **上下文降权**：测试文件 / 注释行 / vendor 目录里的命中，severity 降级
   并打上 ``context`` 标记，**finding 仍然保留在报告里**。审计者依旧看得到，
   只是不再让防御代码把自己判死。

设计原则：宁可降权也不丢弃。降权是可解释、可复核的；丢弃会造成静默漏报。
真正的一票否决（hard_block）不受降权影响，见 ``severity_for``。
"""
from __future__ import annotations

import re
from pathlib import PurePosixPath

# ── 语言归属 ────────────────────────────────────────────────────────────
# 规则 id 前缀/命名并不可靠，改用显式的「规则 → 适用语言集」映射。
# 未列出的规则视为语言无关（shell 命令、URL、密钥等，任何文本里都算命中）。

LANG_PY = "python"
LANG_JS = "javascript"
LANG_SHELL = "shell"
LANG_UNKNOWN = "unknown"

EXT_LANG: dict[str, str] = {
    ".py": LANG_PY,
    ".pyi": LANG_PY,
    ".js": LANG_JS,
    ".mjs": LANG_JS,
    ".cjs": LANG_JS,
    ".ts": LANG_JS,
    ".tsx": LANG_JS,
    ".jsx": LANG_JS,
    ".sh": LANG_SHELL,
    ".bash": LANG_SHELL,
    ".zsh": LANG_SHELL,
}

# 只对特定语言生效的规则。key = rule id，value = 允许的语言集合。
# 语言未知（.md/.yaml/.txt 等）时**保留**命中：文档里贴的危险代码依然值得提示，
# 只是会因为「非源码上下文」而降权（见 CONTEXT_DOC）。
RULE_LANGS: dict[str, set[str]] = {
    # Python 专属：JS 的 re.exec()/str.replace() 不是动态执行
    "python_eval_exec": {LANG_PY, LANG_UNKNOWN},
    "python_os_system": {LANG_PY, LANG_UNKNOWN},
    "pickle_loads": {LANG_PY, LANG_UNKNOWN},
    "shell_true": {LANG_PY, LANG_UNKNOWN},
    "base64_decode_exec": {LANG_PY, LANG_UNKNOWN},
    "fstring_sql": {LANG_PY, LANG_UNKNOWN},
    # Node 专属
    "node_child_process": {LANG_JS, LANG_UNKNOWN},
}

# ── 文件上下文 ──────────────────────────────────────────────────────────

CONTEXT_SOURCE = "source"    # 正常源码：不降权
CONTEXT_TEST = "test"        # 测试代码：攻击样本是断言输入
CONTEXT_VENDOR = "vendor"    # 第三方/压缩产物：不是本 skill 的作者代码
CONTEXT_DOC = "doc"          # 文档围栏代码块：可被用户照抄执行
CONTEXT_PROSE = "prose"      # 文档散文：仅是文字描述，不可执行
CONTEXT_COMMENT = "comment"  # 源码里的注释行

_TEST_DIR_PARTS = {"test", "tests", "testing", "__tests__", "spec", "specs",
                   "fixture", "fixtures", "testdata", "test_data", "e2e"}
_VENDOR_DIR_PARTS = {"vendor", "vendored", "third_party", "thirdparty",
                     "node_modules", "dist", "build", "site-packages", "external"}
_DOC_EXT = {".md", ".markdown", ".rst", ".txt", ".adoc"}
_DOC_DIR_PARTS = {"doc", "docs", "documentation", "examples", "example", "samples"}

# 压缩/打包产物：单行极长 + .min. 命名。这类文件正则误报率极高且不可人工复核。
_MINIFIED_RE = re.compile(r"\.min\.(js|css|mjs)$", re.IGNORECASE)
_LONG_LINE_THRESHOLD = 500


def language_of(relpath: str) -> str:
    """按扩展名判定语言；未知返回 ``LANG_UNKNOWN``。"""
    return EXT_LANG.get(PurePosixPath(relpath.lower()).suffix, LANG_UNKNOWN)


def rule_applies_to(rule_id: str, relpath: str) -> bool:
    """该规则是否适用于该文件的语言。语言无关规则恒为 True。"""
    allowed = RULE_LANGS.get(rule_id)
    if allowed is None:
        return True
    return language_of(relpath) in allowed


def is_minified(relpath: str, text: str) -> bool:
    """压缩产物判定：命名带 ``.min.`` 或（代码文件里）存在超长单行。

    超长行启发式**只对代码文件生效**。Markdown / 纯文本里一段散文本来就可能
    是一个几百字符的长行（实测 stage-generate/SKILL.md 有 682 字符的说明段落），
    把它判成压缩产物会让整份文档被当作 vendor 降 2 档——那等于让「写了长段落」
    成为绕过检测的手段。
    """
    if _MINIFIED_RE.search(relpath):
        return True
    if language_of(relpath) == LANG_UNKNOWN:
        # 非代码文件（.md/.txt/.yaml…）不适用超长行判定。
        return False
    return any(len(line) > _LONG_LINE_THRESHOLD for line in text.splitlines()[:50])


def file_context(relpath: str, text: str | None = None) -> str:
    """判定文件级上下文。优先级：vendor > test > doc > source。

    vendor 优先于 test：``vendor/**/test_x.js`` 首要属性是「非本作者代码」。
    """
    p = PurePosixPath(relpath.lower())
    parts = set(p.parts[:-1])
    name = p.name

    if parts & _VENDOR_DIR_PARTS:
        return CONTEXT_VENDOR
    if text is not None and is_minified(relpath, text):
        return CONTEXT_VENDOR
    if parts & _TEST_DIR_PARTS:
        return CONTEXT_TEST
    if name.startswith("test_") or name.startswith("spec_"):
        return CONTEXT_TEST
    if re.search(r"[._](test|spec)\.[a-z]+$", name):
        return CONTEXT_TEST
    if p.suffix in _DOC_EXT or (parts & _DOC_DIR_PARTS):
        return CONTEXT_DOC
    return CONTEXT_SOURCE


# ── 注释行识别 ──────────────────────────────────────────────────────────

_COMMENT_PREFIX: dict[str, tuple[str, ...]] = {
    LANG_PY: ("#",),
    LANG_JS: ("//", "*", "/*"),
    LANG_SHELL: ("#",),
    LANG_UNKNOWN: ("#", "//"),
}


def is_comment_line(line: str, relpath: str) -> bool:
    """该行是否为单行注释。用于把「解释性文字」与「可执行代码」区分开。"""
    stripped = line.lstrip()
    if not stripped:
        return False
    return stripped.startswith(_COMMENT_PREFIX.get(language_of(relpath), ("#",)))


# ── 块注释 / docstring 行集合 ───────────────────────────────────────────
# 单行前缀判定不足以覆盖真实代码：Python 的 docstring 和 JS 的 /* */ 里
# 大量存在「解释我们如何防御某个攻击」的文字（实测 url_safety.py 的
# docstring 写了 169.254.169.254，正是它拒绝的目标）。这类文字不可执行，
# 却让防御代码被判高危。
#
# 这里做一次极简扫描而非完整解析：只识别成对的三引号 / /* */，且**不**处理
# 字符串内嵌引号等边缘情况。取舍是明确的——解析不确定时宁可**不**标记为
# 注释（保持原severity告警），避免把真实代码误判成注释而漏报。

_PY_TRIPLE = ('"""', "'''")


def _py_block_comment_lines(text: str) -> set[int]:
    lines = set()
    delim: str | None = None
    for no, line in enumerate(text.splitlines(), 1):
        if delim is None:
            stripped = line.lstrip()
            for d in _PY_TRIPLE:
                idx = stripped.find(d)
                if idx != 0:
                    continue
                # 同行闭合（单行 docstring）→ 该行算注释，状态不变
                if stripped.count(d) >= 2:
                    lines.add(no)
                else:
                    delim = d
                    lines.add(no)
                break
        else:
            lines.add(no)
            if delim in line:
                delim = None
    return lines


def _c_block_comment_lines(text: str) -> set[int]:
    lines = set()
    inside = False
    for no, line in enumerate(text.splitlines(), 1):
        if inside:
            lines.add(no)
            if "*/" in line:
                inside = False
            continue
        if "/*" in line and "*/" not in line:
            inside = True
            lines.add(no)
    return lines


def block_comment_lines(relpath: str, text: str) -> set[int]:
    """返回位于块注释 / docstring 内的行号集合（1-based）。"""
    lang = language_of(relpath)
    if lang == LANG_PY:
        return _py_block_comment_lines(text)
    if lang == LANG_JS:
        return _c_block_comment_lines(text)
    return set()


# ── Markdown 围栏代码块 ─────────────────────────────────────────────────
# 文档里「散文提到某个函数名」与「围栏块里给出可复制执行的命令」风险完全不同。
# 前者（"含 JS 的 re.exec()"）不可执行；后者（```curl x | bash```）用户会照抄运行。
# 这与 Mate-Agent 自带校验器的取舍一致：它只扫 SKILL.md 的围栏可执行块，
# 不扫散文。这里不做「散文完全不扫」，而是散文多降一档——保留线索，降低噪音。

_FENCE_RE = re.compile(r"^\s{0,3}(```|~~~)")


def fenced_code_lines(text: str) -> set[int]:
    """返回 Markdown 围栏代码块**内部**的行号集合（1-based，不含围栏行本身）。"""
    lines: set[int] = set()
    inside = False
    for no, line in enumerate(text.splitlines(), 1):
        if _FENCE_RE.match(line):
            inside = not inside
            continue
        if inside:
            lines.add(no)
    return lines


# ── 降权 ────────────────────────────────────────────────────────────────

_ORDER = ["info", "low", "medium", "high", "critical"]

# 每种上下文的降级档数。source=0 表示不降权。
_DEMOTE_STEPS: dict[str, int] = {
    CONTEXT_SOURCE: 0,
    CONTEXT_COMMENT: 2,
    CONTEXT_TEST: 2,
    CONTEXT_DOC: 1,
    CONTEXT_PROSE: 2,
    CONTEXT_VENDOR: 2,
}

# 某些上下文另设**严重级上限**，因为固定降档数不足以表达「结论性」差异：
# 散文里的 critical 降 2 档仍是 medium，而 medium 正好是 SR 层的证据门槛，
# 于是「文档里写了一句禁止 curl | sh」会被当成「发现危险命令」。实测
# agent-creator / skill-creator 的 SKILL.md 就因为写了安全守则而被判 CAUTION——
# 和 SSRF 防御代码被判死是同一类错误：把「禁止某行为的说明」当成「该行为」。
#
# 散文不可执行，因此它可以提供线索，但不足以单独构成裁决证据（证据门槛 medium）。
# 注意围栏代码块**不**设上限：那是用户会照抄执行的内容。
_SEVERITY_CAP: dict[str, str] = {
    CONTEXT_PROSE: "low",
}


def demote(severity: str, steps: int) -> str:
    """按档下调 severity，下界为 info。"""
    if steps <= 0:
        return severity
    try:
        idx = _ORDER.index(severity)
    except ValueError:
        return severity
    return _ORDER[max(0, idx - steps)]


def severity_for(severity: str, context: str, *, hard_block: bool = False) -> str:
    """给定原始 severity 与上下文，返回生效 severity。

    ``hard_block`` 规则不降权：一票否决项的语义是「命中即需人工专项评估」，
    不因为出现在测试目录就可以放过（测试目录同样可以藏真实外传代码）。
    """
    if hard_block:
        return severity
    out = demote(severity, _DEMOTE_STEPS.get(context, 0))
    cap = _SEVERITY_CAP.get(context)
    if cap is not None and _ORDER.index(out) > _ORDER.index(cap):
        out = cap
    return out


def context_for_line(
    relpath: str,
    line: str,
    file_ctx: str,
    lineno: int | None = None,
    block_lines: set[int] | None = None,
    fenced_lines: set[int] | None = None,
) -> str:
    """行级上下文。

    - 文档（``CONTEXT_DOC``）内部再分两级：围栏代码块内仍是 doc（用户会照抄
      执行），围栏外的散文降为 ``CONTEXT_PROSE``（不可执行，仅作线索）。
    - 源码文件里的单行注释与 docstring/块注释归为 ``CONTEXT_COMMENT``。
    - test/vendor 文件不再细分，沿用文件级上下文。
    """
    if file_ctx == CONTEXT_DOC:
        if lineno is not None and fenced_lines is not None and lineno not in fenced_lines:
            return CONTEXT_PROSE
        return CONTEXT_DOC
    if file_ctx != CONTEXT_SOURCE:
        return file_ctx
    if is_comment_line(line, relpath):
        return CONTEXT_COMMENT
    if block_lines and lineno is not None and lineno in block_lines:
        return CONTEXT_COMMENT
    return file_ctx
