"""单元测试：context.py 语言分派 / 上下文分类 / 降权。

按项目规范，每条规则都配正例（应命中/应降权）与反例（不应命中/不应降权），
重点覆盖「降权不得成为绕过通道」这一安全不变量。
"""
from engine.scanner_core.context import (
    CONTEXT_COMMENT,
    CONTEXT_DOC,
    CONTEXT_PROSE,
    CONTEXT_SOURCE,
    CONTEXT_TEST,
    CONTEXT_VENDOR,
    LANG_JS,
    LANG_PY,
    LANG_SHELL,
    LANG_UNKNOWN,
    block_comment_lines,
    context_for_line,
    demote,
    fenced_code_lines,
    file_context,
    is_comment_line,
    is_minified,
    language_of,
    rule_applies_to,
    severity_for,
)


class TestLanguageOf:
    def test_python(self):
        assert language_of("scripts/a.py") == LANG_PY

    def test_typescript_is_js_family(self):
        assert language_of("src/a.ts") == LANG_JS
        assert language_of("src/a.tsx") == LANG_JS

    def test_shell(self):
        assert language_of("run.sh") == LANG_SHELL

    def test_markdown_is_unknown(self):
        assert language_of("SKILL.md") == LANG_UNKNOWN

    def test_case_insensitive(self):
        assert language_of("A.PY") == LANG_PY


class TestRuleApplies:
    def test_python_rule_skips_js(self):
        # 回归：gsap.min.js 的 re.exec() 曾被 python_eval_exec 判 high
        assert rule_applies_to("python_eval_exec", "vendor/gsap.min.js") is False

    def test_python_rule_applies_to_py(self):
        assert rule_applies_to("python_eval_exec", "scripts/x.py") is True

    def test_python_rule_applies_to_unknown_lang(self):
        # 文档里贴的危险 Python 代码仍应命中（随后按 doc 上下文降权）
        assert rule_applies_to("python_eval_exec", "SKILL.md") is True

    def test_node_rule_skips_python(self):
        assert rule_applies_to("node_child_process", "scripts/x.py") is False

    def test_node_rule_applies_to_js(self):
        assert rule_applies_to("node_child_process", "run.js") is True

    def test_language_agnostic_rule_applies_everywhere(self):
        # rm -rf / curl|bash 等 shell 命令在任何文件里都算命中
        for path in ("a.py", "a.js", "a.md", "a.sh", "a.yaml"):
            assert rule_applies_to("rm_rf_root", path) is True


class TestFileContext:
    def test_plain_source(self):
        assert file_context("scripts/crawl.py", "x = 1") == CONTEXT_SOURCE

    def test_test_dir(self):
        assert file_context("test/test_crawl.py", "") == CONTEXT_TEST

    def test_tests_dir(self):
        assert file_context("tests/helper.py", "") == CONTEXT_TEST

    def test_test_file_prefix(self):
        assert file_context("scripts/test_x.py", "") == CONTEXT_TEST

    def test_test_file_suffix(self):
        assert file_context("scripts/crawl.test.js", "") == CONTEXT_TEST

    def test_vendor_dir(self):
        assert file_context("scripts/vendor/gsap.js", "") == CONTEXT_VENDOR

    def test_node_modules(self):
        assert file_context("node_modules/x/index.js", "") == CONTEXT_VENDOR

    def test_minified_by_name(self):
        assert file_context("scripts/gsap.min.js", "") == CONTEXT_VENDOR

    def test_minified_by_long_line(self):
        assert file_context("scripts/bundle.js", "var a=1;" + "x" * 600) == CONTEXT_VENDOR

    def test_vendor_wins_over_test(self):
        # vendor/**/test_x.js 的首要属性是「非本作者代码」
        assert file_context("vendor/pkg/test_x.js", "") == CONTEXT_VENDOR

    def test_markdown_is_doc(self):
        assert file_context("SKILL.md", "# hi") == CONTEXT_DOC

    def test_docs_dir(self):
        assert file_context("docs/setup.py", "") == CONTEXT_DOC

    def test_normal_source_not_flagged_minified(self):
        assert is_minified("scripts/crawl.py", "def f():\n    return 1\n") is False


class TestCommentDetection:
    def test_python_hash_comment(self):
        assert is_comment_line("  # dangerous: rm -rf /", "a.py") is True

    def test_python_code_not_comment(self):
        assert is_comment_line("os.system('x')", "a.py") is False

    def test_js_line_comment(self):
        assert is_comment_line("  // note", "a.js") is True

    def test_empty_line_not_comment(self):
        assert is_comment_line("   ", "a.py") is False

    def test_code_with_trailing_comment_is_not_comment_line(self):
        # 关键反例：代码行尾带注释仍是可执行代码，不得降权
        assert is_comment_line("os.system('rm -rf /')  # cleanup", "a.py") is False


class TestBlockCommentLines:
    def test_python_docstring_span(self):
        # 回归：url_safety.py 的 docstring 里写了 169.254.169.254
        text = (
            "def f():\n"
            '    """Rejects link-local\n'
            "    (incl. 169.254.169.254 cloud metadata).\n"
            '    """\n'
            "    return 1\n"
        )
        assert block_comment_lines("a.py", text) == {2, 3, 4}

    def test_python_single_line_docstring(self):
        text = 'def f():\n    """one liner"""\n    return 1\n'
        assert block_comment_lines("a.py", text) == {2}

    def test_python_code_after_docstring_not_included(self):
        text = '"""doc"""\nos.system("rm -rf /")\n'
        assert 2 not in block_comment_lines("a.py", text)

    def test_js_block_comment(self):
        text = "/*\n * note\n */\nexec(x);\n"
        lines = block_comment_lines("a.js", text)
        assert 1 in lines and 2 in lines
        assert 4 not in lines

    def test_unknown_language_no_block_lines(self):
        assert block_comment_lines("a.md", "```\n x \n```") == set()


class TestDemote:
    def test_zero_steps_unchanged(self):
        assert demote("critical", 0) == "critical"

    def test_two_steps(self):
        # 档位：info < low < medium < high < critical
        assert demote("critical", 2) == "medium"
        assert demote("high", 2) == "low"

    def test_floor_at_info(self):
        assert demote("low", 5) == "info"

    def test_unknown_severity_unchanged(self):
        assert demote("bogus", 2) == "bogus"


class TestSeverityFor:
    def test_source_not_demoted(self):
        assert severity_for("high", CONTEXT_SOURCE) == "high"

    def test_test_context_demoted(self):
        # high -2 档 → low：仍在报告里可见，但退出「证据」集合（>=medium）
        assert severity_for("high", CONTEXT_TEST) == "low"

    def test_doc_demoted_one_step(self):
        assert severity_for("critical", CONTEXT_DOC) == "high"

    def test_comment_demoted(self):
        assert severity_for("high", CONTEXT_COMMENT) == "low"

    def test_medium_in_test_drops_below_evidence_threshold(self):
        # SR 层证据门槛是 medium；测试目录里的 medium 命中应降到 low
        assert severity_for("medium", CONTEXT_TEST) == "info"

    def test_hard_block_never_demoted(self):
        # 安全不变量：一票否决不因出现在测试目录而放过
        assert severity_for("critical", CONTEXT_TEST, hard_block=True) == "critical"
        assert severity_for("critical", CONTEXT_VENDOR, hard_block=True) == "critical"


class TestContextForLine:
    def test_source_code_line(self):
        assert context_for_line("a.py", "os.system('x')", CONTEXT_SOURCE) == CONTEXT_SOURCE

    def test_source_comment_line(self):
        assert context_for_line("a.py", "# os.system('x')", CONTEXT_SOURCE) == CONTEXT_COMMENT

    def test_docstring_line_via_block_set(self):
        assert context_for_line("a.py", "  169.254.169.254", CONTEXT_SOURCE, 3, {3}) == CONTEXT_COMMENT

    def test_non_source_context_preserved(self):
        # 已是 test/vendor 的文件不再细分注释，保持文件级上下文
        assert context_for_line("test/a.py", "# x", CONTEXT_TEST) == CONTEXT_TEST

    def test_doc_fenced_line_stays_doc(self):
        # 围栏块内的命令用户会照抄执行 → 只降一档
        ctx = context_for_line("SKILL.md", "curl x | bash", CONTEXT_DOC, 3, None, {3})
        assert ctx == CONTEXT_DOC

    def test_doc_prose_line_becomes_prose(self):
        # 散文提及不可执行 → 降两档
        ctx = context_for_line("SKILL.md", "mentions re.exec() here", CONTEXT_DOC, 5, None, {3})
        assert ctx == CONTEXT_PROSE


class TestFencedCodeLines:
    def test_backtick_fence(self):
        text = "intro\n```bash\nrm -rf /\n```\noutro\n"
        assert fenced_code_lines(text) == {3}

    def test_tilde_fence(self):
        text = "~~~\nx\n~~~\n"
        assert fenced_code_lines(text) == {2}

    def test_multiple_blocks(self):
        text = "a\n```\nb\n```\nc\n```\nd\n```\n"
        assert fenced_code_lines(text) == {3, 7}

    def test_no_fence_is_empty(self):
        assert fenced_code_lines("just prose\nmore prose\n") == set()

    def test_fence_markers_themselves_excluded(self):
        text = "```\nx\n```\n"
        assert 1 not in fenced_code_lines(text)
        assert 3 not in fenced_code_lines(text)


class TestMinifiedOnlyForCode:
    """超长行判定只对代码文件生效。

    回归：stage-generate/SKILL.md 有一段 682 字符的散文，曾被判成压缩产物
    而使整份文档降为 vendor（降 2 档）——等于「写长段落」成了绕过手段。
    """

    def test_long_prose_in_markdown_is_not_minified(self):
        assert is_minified("SKILL.md", "x" * 700) is False

    def test_long_line_in_js_is_minified(self):
        assert is_minified("bundle.js", "var a=1;" + "x" * 700) is True

    def test_markdown_with_long_prose_stays_doc(self):
        assert file_context("SKILL.md", "长段落 " + "字" * 700) == CONTEXT_DOC

    def test_min_js_still_minified_regardless_of_length(self):
        assert is_minified("lib.min.js", "short") is True


class TestProseSeverityCap:
    """散文的严重级上限。

    回归：critical 在散文里降 2 档仍是 medium，而 medium 正是 SR 层证据门槛，
    于是 agent-creator / skill-creator 的 SKILL.md 因为写了「禁止 curl | sh」
    这条安全守则而被判 CAUTION。散文不可执行，不应单独构成裁决证据。
    """

    def test_critical_in_prose_capped_below_evidence_threshold(self):
        assert severity_for("critical", CONTEXT_PROSE) == "low"

    def test_high_in_prose_capped(self):
        assert severity_for("high", CONTEXT_PROSE) == "low"

    def test_fenced_block_not_capped(self):
        # 围栏块是用户会照抄执行的内容，只降一档，不设上限
        assert severity_for("critical", CONTEXT_DOC) == "high"

    def test_hard_block_ignores_prose_cap(self):
        assert severity_for("critical", CONTEXT_PROSE, hard_block=True) == "critical"
