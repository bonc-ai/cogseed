"""
supply_chain.py — 依赖、安装钩子与 CI 工作流的供应链风险
==========================================================

一个 Skill 的风险不只在它自己的代码里，也在它拉进来的东西里。
``text_rules.py`` 的 ``supply_chain_latest`` 只做「文本里出现过 @main 吗」，
覆盖不到下面这些形态：

- **安装钩子**：``package.json`` 的 ``postinstall`` / ``preinstall`` /
  ``prepare`` 会在 ``npm install`` 时执行任意命令，是 npm 生态最主流的
  投毒落地方式（用户以为只是「装个依赖」）。
- **依赖混淆**：``pip install --extra-index-url`` 让公开源与私有源竞争同名包，
  攻击者只需在公开源上传一个更高版本。
- **CI 提权**：``pull_request_target`` + checkout PR head 的组合
  （"pwn request"）让任意 PR 在持有 secrets 的上下文里执行代码。
- **拼写伪装**：``reqeusts`` / ``lodahs`` 一类与流行包相差 1-2 个字符的名字。

精度设计
--------
- **安装钩子**：只在钩子值**非空**时命中。``"postinstall": ""`` 是打包工具的
  常见占位，不构成风险。
- **拼写伪装**：只在「Skill 自己发起安装」的命令行里判定，不在清单声明里判定。
  理由是清单里的依赖用户可以自己复核；而 ``pip install reqeusts`` 是**运行时
  立刻发生**的事。同时给 ``low`` 置信度——离线词表无法确知某个名字是否自有其
  合法性（``request`` 与 ``requests`` 都是真实且流行的包）。
- **CI 提权**：只在两个条件同时出现时命中，单看 ``pull_request_target`` 是
  正常用法。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .context import FileContext, severity_for
from .result_models import make_finding

# ── 安装钩子 ────────────────────────────────────────────────────────────
_NPM_HOOK_KEYS = ("preinstall", "install", "postinstall", "prepare", "prepublish",
                  "prepublishOnly", "postpack")

# ── 依赖混淆 / 源覆盖 ───────────────────────────────────────────────────
_INDEX_OVERRIDE_RE = re.compile(
    r"--(?:extra-)?index-url\s+(?!https://pypi\.org)\S+|"
    r"-i\s+(?!https://pypi\.org)\S+|"
    r"npm\s+config\s+set\s+registry\s+(?!https://registry\.npmjs\.org)\S+|"
    r"--registry\s+(?!https://registry\.npmjs\.org)\S+",
    re.IGNORECASE,
)

# ── 非固定依赖 ──────────────────────────────────────────────────────────
_UNPINNED_GIT_RE = re.compile(
    r"git\+(?:https?|ssh)://[^\s'\"]+(?![^\s'\"]*@[0-9a-f]{7,40})\s*$|"
    r"git\+(?:https?|ssh)://[^\s'\"]*@(?:main|master|HEAD|develop)\b",
    re.IGNORECASE | re.MULTILINE,
)
#: 只负责定位「安装命令行」，包名由 ``_package_tokens`` 从行尾解析。
#:
#: 早期版本让正则直接捕获包名，形式是 ``pip install\s+(?!-)(\S+)``。那个
#: ``(?!-)`` 是为了跳过 ``--upgrade`` 一类开关，代价是**完全跳过带开关的命令**：
#: 实测 ``pip install --extra-index-url https://mirror/simple reqeusts`` 一个包
#: 都没解析出来——最值得看的依赖混淆样本恰好是带开关的那种写法。
_INSTALL_CMD_RE = re.compile(
    r"\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\b|"
    r"\bpip[0-9]?\s+install\b|"
    r"\buv\s+(?:pip\s+)?(?:tool\s+)?install\b|"
    r"\bnpx\b|"
    r"\bdocker\s+pull\b",
    re.IGNORECASE,
)

#: 开关类 token：``--flag`` / ``--flag=value`` / ``-x``。
_FLAG_TOKEN_RE = re.compile(r"^-{1,2}[\w-]+(?:=\S+)?$")
#: 值类 token：URL、路径、版本约束片段，都不是包名。
_VALUE_TOKEN_RE = re.compile(r"^(?:https?://|git\+|ssh://|\.|/|~|\$|\{|@\w+/\S+@|\S+@\S+$)")


def _package_tokens(tail: str) -> list[str]:
    """从安装命令的剩余部分里挑出包名 token。

    跳过开关与其取值（``--index-url https://…`` 里的 URL 不是包名），
    因此 ``pip install -U --index-url https://x reqeusts`` 能正确解出
    ``reqeusts``。
    """
    tokens = tail.replace("\\\n", " ").split()
    out: list[str] = []
    skip_next = False
    for token in tokens:
        cleaned = token.strip("'\"")
        if skip_next:
            skip_next = False
            continue
        # 命令分隔符之后的都属另一条命令。
        if cleaned in ("&&", "||", "|", ";", "then", "do"):
            break
        if _FLAG_TOKEN_RE.match(cleaned):
            # 不带 `=` 的开关，其下一个 token 是取值。
            skip_next = "=" not in cleaned
            continue
        if cleaned.endswith(":"):
            skip_next = True
            continue
        if _VALUE_TOKEN_RE.match(cleaned):
            continue
        if not cleaned:
            continue
        out.append(cleaned)
    return out

# ── CI 工作流 ───────────────────────────────────────────────────────────
_PR_TARGET_RE = re.compile(r"\bpull_request_target\b")
_PR_HEAD_CHECKOUT_RE = re.compile(
    r"github\.event\.pull_request\.head\.(?:sha|ref)|refs/pull/\$\{\{[^}]*\}\}/(?:merge|head)",
    re.IGNORECASE,
)
_UNPINNED_ACTION_RE = re.compile(r"uses:\s*([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)@(main|master|HEAD)\b")
_TAG_ACTION_RE = re.compile(r"uses:\s*([A-Za-z0-9._-]+/[A-Za-z0-9._-]+)@(v?\d+(?:\.\d+)*)\s*$")

# ── 拼写伪装词表 ────────────────────────────────────────────────────────
#: 生态里下载量最高、最常被冒充的包名。人工维护，故意保持短——长词表的
#: 边际收益低而误报上升。
_POPULAR = (
    # python
    "requests", "numpy", "pandas", "flask", "django", "urllib3", "boto3",
    "cryptography", "openai", "anthropic", "langchain", "torch", "tensorflow",
    "transformers", "scikit-learn", "pillow", "pydantic", "setuptools", "pyyaml",
    # npm
    "react", "lodash", "express", "axios", "typescript", "webpack", "eslint",
    "next", "vue", "chalk", "commander", "uuid", "zod", "dotenv", "jest", "prettier",
)

#: 与流行包相近但**自身即合法且流行**的名字。列在这里是为了让词表式的
#: 距离判定不误伤它们——``request`` 是 npm 上下载量极高的独立包，
#: 不是 ``requests`` 的伪装。
_KNOWN_LOOKALIKES = {
    "request", "moment", "mongo", "redis", "chai", "sinon", "nock", "mock",
    "tqdm", "click", "rich", "black", "isort", "flake8", "mypy", "ruff",
    "pyyaml", "yamllint", "openpyxl", "xlsxwriter", "playwright", "pytest",
    "vuex", "vite", "vitest", "rollup", "esbuild", "nodemon", "pm2", "dotenvx",
}

_SCOPED_RE = re.compile(r"^@[^/]+/")


def _raw_line(text: str, offset: int) -> str:
    """取 ``offset`` 所在的整行原文。

    逐行解析需要行内容（判断它是散文还是围栏代码块），而 ``finditer`` 只给
    偏移量。切一次比让每个调用点各算一遍便宜，也不会因为切片写错而系统性
    判错上下文。
    """
    start = text.rfind("\n", 0, offset) + 1
    end = text.find("\n", offset)
    return text[start:end if end != -1 else len(text)]


def _levenshtein(a: str, b: str, limit: int = 3) -> int:
    """带上限的编辑距离：超过 ``limit`` 直接返回 ``limit + 1``。

    早停让「对 40 个流行包 × 每个依赖」的判定在毫秒级完成，并避免为一个
    明显不相干的字符串算完整矩阵。
    """
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        best = i
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            val = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            cur.append(val)
            if val < best:
                best = val
        if best > limit:
            return limit + 1
        prev = cur
    return prev[-1]


def _looks_like_typosquat(name: str) -> str | None:
    """返回被冒充的流行包名，或 None。

    只处理「无 scope 且不在合法相似名单里」的名字。带 scope 的包
    （``@scope/name``）按 scope 判定，因为 ``@anthropic-ai/sdk`` 与
    ``@anthropic/sdk`` 的区别正是 scope 本身。
    """
    raw = name.strip().strip("'\"").split("[")[0].split("=")[0]
    if not raw or raw.startswith((".", "/", "-")):
        return None
    if raw in _KNOWN_LOOKALIKES:
        return None
    if _SCOPED_RE.match(raw):
        scope, _, base = raw.partition("/")
        if base in _KNOWN_LOOKALIKES or base in _POPULAR:
            # ``@someone/requests`` 相对 ``requests``：scope 不同但底名一致，
            # 属于「同名不同源」，交由 allowlist 策略处理，这里不判为伪装。
            return None
        target = next((p for p in _POPULAR if _levenshtein(base, p, 2) in (1, 2)), None)
        return f"{target}（作用域 {scope}）" if target else None
    if raw in _POPULAR:
        return None
    if raw.rstrip("0123456789._-") in _POPULAR:
        # ``requests2`` / ``lodash.js``：加了后缀的同名包。
        return raw.rstrip("0123456789._-")
    target = next((p for p in _POPULAR if _levenshtein(raw, p, 2) in (1, 2)), None)
    return target


def _package_json_hooks(rel: str, text: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(text)
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    scripts = data.get("scripts")
    if not isinstance(scripts, dict):
        return []
    out: list[dict[str, Any]] = []
    for key in _NPM_HOOK_KEYS:
        value = scripts.get(key)
        if isinstance(value, str) and value.strip():
            out.append({"key": key, "command": value.strip()})
    return out


def scan_supply_chain(skill_dir: Path, docs: list[tuple[str, str]],
                      contexts: dict[str, FileContext] | None = None) -> dict[str, Any]:
    """返回 ``{"findings": [...], "manifests": {...}, "packages": [...]}``。

    ``manifests`` / ``packages`` 是给报告用的**事实**（不是发现项）：
    依赖清单与运行时安装的包名，让「这份 Skill 拉了什么」变成可读信息，
    而不是只能从 finding 反推。
    """
    ctx_of = contexts or {}
    findings: list[dict[str, Any]] = []
    manifests: dict[str, Any] = {}
    runtime_packages: set[str] = set()

    for rel, text in docs:
        if not text:
            continue
        fctx = ctx_of.get(rel) or FileContext(rel, text)
        lower = rel.lower()

        # ── 安装钩子 ────────────────────────────────────────────────
        if lower.endswith("package.json"):
            hooks = _package_json_hooks(rel, text)
            if hooks:
                manifests.setdefault("npm_hooks", {})[rel] = [h["key"] for h in hooks]
            for hook in hooks:
                findings.append(make_finding(
                    "SR-SC", "install_hook", "high", "install_hook", rel, None,
                    f"package.json 定义了 {hook['key']} 钩子：依赖安装阶段会执行该命令",
                    "", source="supply-chain", context=fctx.file_ctx,
                    original_severity="high", confidence="high",
                    snippet=f"{hook['key']}={hook['command']}",
                ))
            try:
                data = json.loads(text)
                for section in ("dependencies", "devDependencies", "optionalDependencies"):
                    deps = data.get(section)
                    if isinstance(deps, dict) and deps:
                        manifests.setdefault("npm_dependencies", []).extend(
                            f"{n}@{v}" for n, v in list(deps.items())[:50]
                        )
            except Exception:
                pass
            continue

        # ── CI 工作流 ──────────────────────────────────────────────
        if ".github/workflows/" in lower and lower.endswith((".yml", ".yaml")):
            if _PR_TARGET_RE.search(text) and _PR_HEAD_CHECKOUT_RE.search(text):
                findings.append(make_finding(
                    "SR-SC", "ci_pwn_request", "critical", "supply_chain", rel, None,
                    "工作流同时使用 pull_request_target 与检出 PR head："
                    "任意 PR 可在持有 secrets 的上下文里执行代码",
                    "", source="supply-chain", context=fctx.file_ctx,
                    original_severity="critical", confidence="high",
                    snippet="pull_request_target + head checkout",
                ))
            for match in _UNPINNED_ACTION_RE.finditer(text):
                lineno = text.count("\n", 0, match.start()) + 1
                findings.append(make_finding(
                    "SR-SC", "unpinned_ci_action", "high", "supply_chain", rel, lineno,
                    f"CI 动作 {match.group(1)} 固定在 {match.group(2)} 分支而非提交哈希",
                    "", source="supply-chain", context=fctx.file_ctx,
                    original_severity="high", confidence="high", snippet=match.group(0),
                ))
            continue

        # ── 依赖源覆盖 ─────────────────────────────────────────────
        for match in _INDEX_OVERRIDE_RE.finditer(text):
            lineno = text.count("\n", 0, match.start()) + 1
            ctx = fctx.at(lineno, _raw_line(text, match.start()))
            findings.append(make_finding(
                "SR-SC", "dependency_source_override", severity_for("high", ctx), "supply_chain", rel, lineno,
                "覆盖了默认包源：公开源与私有源的同名包会发生依赖混淆",
                "", source="supply-chain", context=ctx,
                original_severity="high", confidence="high", snippet=match.group(0),
            ))

        # ── 运行时安装的包 → 非固定版本 / 拼写伪装 ─────────────────
        for cmd in _INSTALL_CMD_RE.finditer(text):
            line_start = text.rfind("\n", 0, cmd.start()) + 1
            line_end = text.find("\n", cmd.start())
            raw_line = text[line_start: line_end if line_end != -1 else len(text)]
            lineno = text.count("\n", 0, line_start) + 1
            ctx = fctx.at(lineno, raw_line)
            tail = raw_line[cmd.end() - line_start:]
            for spec in _package_tokens(tail):
                name = spec
                if spec.startswith("@") and "/" in spec:
                    name = "@" + spec[1:].split("@")[0]
                else:
                    name = re.split(r"[@=<>!\[]", spec)[0]
                if not name:
                    continue
                runtime_packages.add(spec[:60])
                # `pkg@1.2.3` / `pkg==1.2.3` / `pkg@<sha>` 视为已固定。
                pinned = bool(re.search(r"[@=]{1,2}[0-9a-fv]", spec))
                if not pinned:
                    findings.append(make_finding(
                        "SR-SC", "unpinned_runtime_install",
                        severity_for("medium", ctx), "supply_chain",
                        rel, lineno,
                        f"运行时安装未固定版本：{spec[:60]}",
                        "", source="supply-chain", context=ctx,
                        original_severity="medium", confidence="medium", snippet=spec,
                    ))
                impostor = _looks_like_typosquat(name)
                if impostor:
                    findings.append(make_finding(
                        "SR-SC", "typosquat_suspected",
                        severity_for("medium", ctx), "typosquat", rel, lineno,
                        f"依赖名 {name} 与流行包 {impostor} 高度相似：可能是拼写伪装",
                        "", source="supply-chain", context=ctx,
                        original_severity="medium",
                        # 离线词表无法确知该名字是否自有其合法性，标为低置信。
                        confidence="low", snippet=name,
                    ))

    if runtime_packages:
        manifests["runtime_packages"] = sorted(runtime_packages)
    return {"findings": findings, "manifests": manifests}
