"""
structural.py — 文件级结构风险
================================

文本规则看不见「这个文件是什么」，而文件本身可以携带风险：

- **可执行载荷**：``.exe`` / ``.dll`` / ``.so`` / ``.scr`` / ``.vbs`` 随 Skill
  分发，无论内容如何都无法人工复核。
- **符号链接逃逸**：``ln -s /etc/passwd data.txt`` 让「读取技能目录内的文件」
  在解析后落到目录之外。``path_security.py`` 只对 zip 解包做了穿越防护，
  已解开的目录没有做这一层。
- **``.git`` 目录**：``.git/hooks/pre-commit`` 会在用户下一次提交时执行。
  一个 Skill 带着 ``.git`` 就等于带了一个待触发的钩子。
- **嵌套压缩包**：扫描器看不到里面，用户也看不到。
- **可执行位**：一个「只读文档型 Skill」里出现 0755 的 shell 脚本，
  说明它的实际用途与声明不符。

判定原则与 ``hidden_content`` 一致：**结构事实不做上下文降权**。
把 ``payload.exe`` 放进 ``vendor/`` 不改变它是一个无法审计的可执行文件。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .result_models import make_finding
from .path_security import IGNORED_DIRS

#: 扩展名 → (严重级, 说明)。这些类型在 Skill 里没有正常用途。
_EXECUTABLE_EXT: dict[str, tuple[str, str]] = {
    ".exe": ("critical", "Windows 可执行文件"),
    ".dll": ("high", "Windows 动态库"),
    ".scr": ("critical", "Windows 屏保可执行文件（常见载荷伪装）"),
    ".com": ("critical", "DOS 可执行文件"),
    ".msi": ("high", "Windows 安装包"),
    ".vbs": ("critical", "VBScript 脚本（常被用于无文件落地）"),
    ".vbe": ("critical", "编码的 VBScript"),
    ".js.jse": ("high", "JScript 编码脚本"),
    ".jse": ("high", "JScript 编码脚本"),
    ".wsf": ("high", "Windows 脚本文件（可混合多种脚本引擎）"),
    ".hta": ("critical", "HTML 应用程序（以可信进程执行脚本）"),
    ".lnk": ("critical", "Windows 快捷方式（可携带命令行参数）"),
    ".so": ("high", "Linux 动态库"),
    ".dylib": ("high", "macOS 动态库"),
    ".pyd": ("high", "Python 扩展模块（原生代码）"),
    ".node": ("high", "Node 原生扩展"),
    ".jar": ("medium", "Java 归档（可含可执行字节码）"),
    ".class": ("medium", "Java 字节码"),
    ".apk": ("medium", "Android 安装包"),
    ".dmg": ("high", "macOS 磁盘映像"),
    ".pkg": ("high", "macOS 安装包"),
    ".deb": ("medium", "Debian 安装包"),
    ".rpm": ("medium", "RPM 安装包"),
    ".wasm": ("medium", "WebAssembly 模块（可执行，不可读）"),
}

#: 嵌套归档：扫描器不递归解包，因此它们是「内容不可见」区域。
_ARCHIVE_EXT = {".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".zst"}

#: 体积上限。超过它说明该文件不是给人读的。
_LARGE_FILE_BYTES = 8 * 1024 * 1024


def _real_escapes(skill_dir: Path, path: Path) -> bool:
    """符号链接的真实目标是否落在 Skill 目录之外。"""
    try:
        target = Path(os.path.realpath(path))
    except OSError:
        return False
    try:
        root = Path(os.path.realpath(skill_dir))
    except OSError:
        return False
    return root != target and root not in target.parents


#: 结构扫描的忽略集 = 通用忽略集 **减去 .git**。
#:
#: ``path_security.IGNORED_DIRS`` 里有 ``.git``，因为扫描版本库内部对象没有
#: 意义。但「这个 Skill 里带了一个 .git 目录」本身是一条高价值发现：
#: ``.git/hooks/pre-commit`` 会在用户下一次提交时执行。沿用通用忽略集
#: 会让这条发现永远不可能出现——实测第一版就是这样，规则写了、测试也写了，
#: 但被上游的忽略集整体挡掉。
_STRUCTURAL_IGNORED = IGNORED_DIRS - {".git"}


def _iter_files(skill_dir: Path):
    """遍历文件；遇到 ``.git`` 目录时只产出该目录本身，不下钻。

    ``.git/objects`` 里是成百上千个二进制对象，逐个走一遍既慢又会刷屏
    （每个都会命中 ``oversized_file`` 或 ``executable_payload``）。
    一个 ``.git`` 目录报一次，信息量完全一样。
    """
    for path in sorted(skill_dir.rglob("*")):
        rel = path.relative_to(skill_dir).as_posix()
        parts = rel.split("/")[:-1]
        if ".git" in parts:
            # 属于某个 .git 子树：只有「.git 目录本身」值得产出，其余跳过。
            continue
        if _STRUCTURAL_IGNORED.intersection(parts):
            continue
        yield path, rel


def scan_structure(skill_dir: Path) -> dict[str, Any]:
    """返回 ``{"findings": [...], "summary": {...}}``。

    ``summary`` 是文件构成的事实统计（文件数、总字节、可执行文件数、
    归档数、符号链接数），供报告与 UI 展示「这个 Skill 里到底有什么」。
    """
    findings: list[dict[str, Any]] = []
    file_count = 0
    total_bytes = 0
    executables = 0
    archives = 0
    symlinks = 0
    extensions: dict[str, int] = {}

    for path, rel in _iter_files(skill_dir):
        try:
            if path.is_symlink():
                symlinks += 1
                if _real_escapes(skill_dir, path):
                    findings.append(make_finding(
                        "SR-ST", "symlink_escape", "critical", "structural", rel, None,
                        "符号链接指向 Skill 目录之外：读取该文件会实际落到目录外",
                        "", source="structural", context="source",
                        original_severity="critical", confidence="high", snippet=rel,
                    ))
                continue
            # ``.git`` 目录：钩子会在用户下一次 git 操作时执行。目录判定必须
            # 在 ``is_file()`` **之前**——否则它会被这一行直接跳过，规则写了
            # 却永远不会触发（第一版就是这样）。
            if path.is_dir():
                if path.name == ".git":
                    findings.append(make_finding(
                        "SR-ST", "embedded_git_dir", "high", "structural", rel, None,
                        "包含 .git 目录：其中的 hooks 会在用户执行 git 操作时运行",
                        "", source="structural", context="source",
                        original_severity="high", confidence="high", snippet=rel,
                    ))
                continue
            if not path.is_file():
                continue
            stat = path.stat()
        except OSError:
            continue

        file_count += 1
        total_bytes += stat.st_size
        suffix = path.suffix.lower()
        extensions[suffix or "(none)"] = extensions.get(suffix or "(none)", 0) + 1


        entry = _EXECUTABLE_EXT.get(suffix)
        if entry:
            executables += 1
            severity, note = entry
            findings.append(make_finding(
                "SR-ST", "executable_payload", severity, "structural", rel, None,
                f"随包分发可执行载荷（{note}）：内容无法人工复核",
                "", source="structural", context="source",
                original_severity=severity, confidence="high", snippet=rel,
            ))
            continue

        if suffix in _ARCHIVE_EXT:
            archives += 1
            findings.append(make_finding(
                "SR-ST", "nested_archive", "medium", "structural", rel, None,
                "嵌套压缩包：扫描器与用户都无法看到其内容",
                "", source="structural", context="source",
                original_severity="medium", confidence="medium", snippet=rel,
            ))
            continue

        # 可执行位：文档型文件带执行权限说明实际用途与声明不符。
        if os.name != "nt" and stat.st_mode & 0o111:
            if suffix in (".sh", ".bash", ".zsh", ".command", ".ps1", ".bat", ".cmd"):
                findings.append(make_finding(
                    "SR-ST", "executable_script", "low", "structural", rel, None,
                    "带可执行权限的脚本：确认其用途与 SKILL.md 的声明一致",
                    "", source="structural", context="source",
                    original_severity="low", confidence="medium", snippet=rel,
                ))

        # setuid/setgid：执行时以文件属主身份运行。Skill 里的可执行文件
        # 带这两个位，说明它以提权为设计目标。
        if os.name != "nt" and stat.st_mode & 0o6000:
            findings.append(make_finding(
                "SR-ST", "setuid_bit", "critical", "privilege", rel, None,
                "文件设置了 setuid/setgid 位：执行时以文件属主权限运行",
                "", source="structural", context="source",
                original_severity="critical", confidence="high", snippet=rel,
            ))

        if stat.st_size > _LARGE_FILE_BYTES:
            findings.append(make_finding(
                "SR-ST", "oversized_file", "low", "structural", rel, None,
                f"文件体积 {stat.st_size // (1024 * 1024)} MiB：超出可人工复核的范围",
                "", source="structural", context="source",
                original_severity="low", confidence="high", snippet=rel,
            ))

    top_ext = sorted(extensions.items(), key=lambda kv: (-kv[1], kv[0]))[:12]
    return {
        "findings": findings,
        "summary": {
            "file_count": file_count,
            "total_bytes": total_bytes,
            "executable_count": executables,
            "archive_count": archives,
            "symlink_count": symlinks,
            "top_extensions": [{"ext": ext, "count": n} for ext, n in top_ext],
        },
    }
