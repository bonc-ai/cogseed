"""
path_security.py — 路径、压缩包与文档载体安全检查
==================================================

集中处理与文件系统边界相关的安全逻辑：zip 解包路径穿越防护、
Skill 边界定位（以 SKILL.md 为根）、文本文件证据收集。

2.4.0 起本模块同时负责**载体取证**：把「扫描器看不见的区域」缩小到只剩它
确实读不了的那部分，并且把读不了的部分如实记成 finding。

为什么载体取证属于这一层
------------------------
2.3.0 的覆盖缺口不是「检测不出」，而是「根本没读」：``.svg`` / ``.html`` /
``.ipynb`` 不在 ``TEXT_EXT`` 里，``.pdf`` / ``.png`` 完全不解析，``.zip`` /
``.tar.gz`` 只报一句「嵌套压缩包」。红队实测（2026-11-04，F-02/F-03）用这
几条通道把攻击样本以 ``pass / ALLOW / 100`` 装进了技能库；把同一份文本改名
成 ``.txt`` 立刻变成 ``restricted``——证明缺的是**收集**，不是**检测**。

所以这一层只做收集，不做判定：

1. 扩充 ``TEXT_EXT``，纯文本载体按文本进入同一条规则管线；
2. 对 PDF / PNG 做**有界**的文本抽取（不是解析器；抽不出就记账，绝不假装干净）；
3. 对有界归档递归读取成员，成员以 ``外层::内部`` 的合成路径进入管线——
   于是文本规则、YARA、隐藏内容、解码重扫、指令规则全部自动覆盖它们，
   不需要为「压缩包里的东西」再写一套检测。

所有上限都是硬上限。触顶之后产出 finding 而不是静默截断：一个被截断的扫描
结果不是「干净」的证据。这也是 H1-zip-bomb（1 MiB 压缩包）不会拖垮扫描器的
原因。
"""
from __future__ import annotations

import io
import re
import tarfile
import zipfile
import zlib
from pathlib import Path, PurePosixPath
from typing import Any, Iterator

from .result_models import make_finding

#: 按文本扫描的扩展名。**新增一条就多一类载体进入全部检测**，因此这张表是
#: 覆盖面最便宜的一处改动，也是最容易漏的一处。
#:
#: 2.4.0 补的是「本身就是纯文本、只是没人当它是文本」的那批：
#: ``.svg`` / ``.html`` 是可执行的标记语言，``.ipynb`` 是 JSON（markdown 与
#: code cell 都在里面），``.xml`` / ``.xaml`` 常带构建与 CI 配置，
#: ``.csv`` / ``.tsv`` 可以整列都是指令，``.ps1`` / ``.psm1`` / ``.bat`` /
#: ``.cmd`` / ``.php`` / ``.rb`` / ``.lua`` / ``.pl`` 是与 .py/.sh 同级的
#: 脚本语言——它们此前既不在文本表里，也不在质量校验的脚本白名单里。
TEXT_EXT = {
    ".md", ".markdown", ".txt", ".rst", ".adoc",
    ".yaml", ".yml", ".json", ".jsonl", ".ndjson", ".toml", ".ini", ".cfg", ".conf",
    ".py", ".pyi", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".sh", ".bash",
    ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd", ".rb", ".php", ".pl", ".lua",
    ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs",
    ".sql", ".graphql", ".proto", ".tf", ".tfvars",
    ".env", ".properties", ".lock", ".gradle",
    ".svg", ".html", ".htm", ".xhtml", ".xml", ".xaml", ".xsl", ".plist",
    ".ipynb", ".rmd", ".csv", ".tsv", ".diff", ".patch", ".service",
}
#: 没有扩展名、但确定是文本的文件名。``PurePosixPath(".gitmodules").suffix`` 是
#: 空字符串，所以只按扩展名收集会把它们整类漏掉——红队样本 ``E2-gitmodules``
#: 就是靠这一点拿到 ``pass/ALLOW/100``：一个指向攻击者仓库的子模块声明，扫描器
#: 从未打开过它。
_TEXT_FILENAMES = {
    ".gitmodules", ".gitattributes", ".gitignore", ".dockerignore", ".npmrc",
    ".pypirc", ".netrc", ".yarnrc", ".editorconfig", ".flaskenv",
    "dockerfile", "containerfile", "makefile", "gnumakefile", "procfile",
    "pipfile", "gemfile", "rakefile", "vagrantfile", "cmakelists.txt",
}
IGNORED_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache"}

#: 单个文本文件的读取上限（与 2.3.0 一致）。
_MAX_TEXT_FILE_BYTES = 1_000_000
#: 一次扫描里所有文本文件的总预算。
_TEXT_BUDGET_BYTES = 4_000_000

# ── 载体上限 ────────────────────────────────────────────────────────────
# 这些数字不是审美选择，每一条都对着一类具体攻击：
#   * 成员数 + 单成员上限 → zip bomb（H1）与「塞 10 万个小文件」拖时间；
#   * 总解压预算 → 一个压缩包吃掉整次扫描的预算，让真正的文件失去扫描机会；
#   * 压缩比 → 「1 KiB 压缩成 1 GiB」的经典炸弹（读之前先按声明体积判断）；
#   * 嵌套深度 → 递归炸弹；超出后记账，不递归。
_MAX_MEMBERS = 200
_MAX_MEMBER_BYTES = 2 * 1024 * 1024
_ARCHIVE_BUDGET_BYTES = 8 * 1024 * 1024
_MAX_COMPRESSION_RATIO = 200
_MAX_ARCHIVE_DEPTH = 2
#: PDF 内容流 / PNG 文本块的抽取上限。抽出来是为了喂正则，不是给人读。
_MAX_EXTRACTED_TEXT = 256 * 1024
_MAX_PDF_BYTES = 8 * 1024 * 1024
_MAX_PNG_BYTES = 4 * 1024 * 1024

_TAR_SUFFIXES = (".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar.zst")
_STREAM_SUFFIXES = (".gz", ".bz2", ".xz")
#: 以 zip 容器封装的「文档 / 依赖包」格式。里面本身就是可读的 XML/文本，只是
#: 外面套了一层 zip——这是红队 A1 族的同一条通道：一份 Word 文档可以整篇都是
#: 越权指令，而它在技能目录里看起来只是一个附件。
_ZIP_FAMILY_SUFFIXES = (".zip", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".whl")
#: 标准库打不开、但确实可能藏着载荷的归档格式。不是「支持它」，而是「记账」。
_OPAQUE_ARCHIVE_SUFFIXES = (".7z", ".rar", ".zst", ".zstd", ".lz4", ".cab", ".iso")
#: 有文本层的文档载体（非纯文本）。
_DOC_CARRIER_SUFFIXES = (".pdf",)
#: 位图载体。元数据文本可以抽，像素里画的字抽不出来——后者只记账。
_IMAGE_CARRIER_SUFFIXES = (".png",)
#: 位图之外、内容还没解析的文档载体。RTF 是纯文本，由内容探测直接读；
#: OLE（`.doc` / `.xls` / `.ppt`）读不了，至少要记账，而不是让文件凭空消失。
_OLE_CARRIER_SUFFIXES = (".doc", ".xls", ".ppt", ".msi")

#: 内容探测的采样上限。判「是不是文本」不需要读完：64 KiB 足够覆盖标记语言
#: 的开头，也足够让一个 ELF/JPEG 在第一屏就暴露 NUL。
_TEXT_SNIFF_BYTES = 64 * 1024
#: 采样里可打印字符的最低占比。0.90 而不是 1.0：真实的文本文件也会带
#: 零星的 ZWSP、BOM、控制字符，而二进制里偶尔有一段合法 UTF-8 也过不了这个线。
_TEXT_PRINTABLE_RATIO = 0.90


def safe_extract(source: Path, destination: Path) -> Path:
    """安全解压 zip 包，拒绝路径穿越（zip slip）。目录输入原样返回。"""
    if source.is_dir():
        return source.resolve()
    if not zipfile.is_zipfile(source):
        return source.resolve()
    with zipfile.ZipFile(source) as archive:
        root = destination.resolve()
        for info in archive.infolist():
            target = (destination / info.filename).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f"unsafe zip path: {info.filename}")
        archive.extractall(destination)
    children = [item for item in destination.iterdir() if item.name != "__MACOSX"]
    return children[0] if len(children) == 1 and children[0].is_dir() else destination


def locate_skill_roots(source: Path) -> list[Path]:
    """以 SKILL.md 为根定位 Skill 目录。收窄扫描边界的核心。"""
    if source.is_file():
        return [source.parent.resolve()]
    skill_files = [p for p in source.rglob("SKILL.md") if not IGNORED_DIRS.intersection(p.parts)]
    roots = sorted({p.parent.resolve() for p in skill_files}, key=str)
    return roots or [source.resolve()]


# ── 载体记账 ────────────────────────────────────────────────────────────


def _carrier_finding(
    rule_id: str,
    severity: str,
    category: str,
    file: str,
    description: str,
    remediation: str = "",
    *,
    confidence: str = "high",
) -> dict[str, Any]:
    """构造一条载体类 finding。

    载体类 finding 全部走 ``source="carrier"``、``context="source"``、不降权：
    「这个压缩包是加密的」与它在哪个目录里无关。
    """
    return make_finding(
        "SR-COV", rule_id, severity, category, file, None,
        description, remediation,
        source="carrier", context="source",
        original_severity=severity, confidence=confidence, snippet=file,
    )


def _unsafe_member(name: str) -> bool:
    """归档成员名是否越界（绝对路径 / 上跳 / 盘符）。

    只在内存里判断，**不解压**。``safe_extract`` 保护的是「把 Skill 包解开」这
    一步；这里保护的是「扫描器读成员」这一步——攻击者最希望的就是扫描器为了
    看一眼内容而把这个成员写到磁盘上。
    """
    if not name or name.startswith(("/", "\\")):
        return True
    if re.match(r"^[A-Za-z]:[\\/]", name):
        return True
    parts = PurePosixPath(name.replace("\\", "/")).parts
    return ".." in parts


def _archive_family(name: str) -> str | None:
    lower = name.lower()
    if lower.endswith(_ZIP_FAMILY_SUFFIXES):
        return "zip"
    if lower.endswith(_TAR_SUFFIXES):
        return "tar"
    if lower.endswith(_STREAM_SUFFIXES):
        return "stream"
    if lower.endswith(_OPAQUE_ARCHIVE_SUFFIXES):
        return "opaque"
    return None


def _iter_zip(members: list[zipfile.ZipInfo], handle: zipfile.ZipFile) -> Iterator[tuple[str, bytes, str]]:
    for info in members:
        if info.is_dir():
            continue
        if info.flag_bits & 0x1:
            yield info.filename, b"", "encrypted"
            continue
        mode = (info.external_attr >> 16) & 0o170000
        if mode == 0o120000:  # S_IFLNK
            yield info.filename, b"", "symlink"
            continue
        declared = info.file_size or 0
        compressed = info.compress_size or 0
        if declared > _MAX_MEMBER_BYTES:
            yield info.filename, b"", "oversized"
            continue
        if compressed and declared > compressed * _MAX_COMPRESSION_RATIO:
            yield info.filename, b"", "ratio"
            continue
        try:
            # ``read(n)`` 是硬上限：即使中央目录谎报体积，也不会解出超过 n 字节。
            data = handle.open(info).read(_MAX_MEMBER_BYTES + 1)
        except Exception:
            yield info.filename, b"", "unreadable"
            continue
        if len(data) > _MAX_MEMBER_BYTES:
            yield info.filename, b"", "oversized"
            continue
        yield info.filename, data, ""


def _iter_tar(handle: tarfile.TarFile) -> Iterator[tuple[str, bytes, str]]:
    try:
        members = handle.getmembers()
    except Exception:
        yield "", b"", "unreadable"
        return
    for member in members:
        if member.isdir():
            continue
        if member.issym() or member.islnk():
            yield member.name, b"", "symlink"
            continue
        # 设备节点 / FIFO：一个「技能」没有理由携带它们。
        if not member.isfile():
            yield member.name, b"", "special"
            continue
        if member.size > _MAX_MEMBER_BYTES:
            yield member.name, b"", "oversized"
            continue
        try:
            stream = handle.extractfile(member)
            if stream is None:
                yield member.name, b"", "unreadable"
                continue
            data = stream.read(_MAX_MEMBER_BYTES + 1)
        except Exception:
            yield member.name, b"", "unreadable"
            continue
        if len(data) > _MAX_MEMBER_BYTES:
            yield member.name, b"", "oversized"
            continue
        yield member.name, data, ""


def _iter_stream(outer: str, data: bytes) -> Iterator[tuple[str, bytes, str]]:
    """单流压缩（``.gz`` / ``.bz2`` / ``.xz``）：解出唯一的成员。"""
    for module_name in ("gzip", "bz2", "lzma"):
        try:
            module = __import__(module_name)
            if module_name == "gzip":
                handle = module.GzipFile(fileobj=io.BytesIO(data))
            else:
                handle = module.open(io.BytesIO(data))
            payload = handle.read(_MAX_MEMBER_BYTES + 1)
            handle.close()
        except Exception:
            continue
        inner = outer[:-3] if outer.lower().endswith((".gz", ".bz2", ".xz")) else f"{outer}.unpacked"
        if len(payload) > _MAX_MEMBER_BYTES:
            yield inner, b"", "oversized"
            return
        yield inner, payload, ""
        return
    yield "", b"", "unreadable"


def _member_entries(
    rel: str,
    family: str,
    source: Path | bytes,
) -> Iterator[tuple[str, bytes, str]]:
    """产出 ``(成员名, 字节, 跳过原因)``。``reason`` 非空表示没读到内容。"""
    try:
        if family == "zip":
            if isinstance(source, Path):
                with zipfile.ZipFile(source) as handle:
                    yield from _iter_zip(handle.infolist()[:_MAX_MEMBERS], handle)
            else:
                with zipfile.ZipFile(io.BytesIO(source)) as handle:
                    yield from _iter_zip(handle.infolist()[:_MAX_MEMBERS], handle)
        elif family == "tar":
            if isinstance(source, Path):
                with tarfile.open(source, "r:*") as handle:
                    yield from _iter_tar(handle)
            else:
                with tarfile.open(fileobj=io.BytesIO(source), mode="r:*") as handle:
                    yield from _iter_tar(handle)
        elif family == "stream":
            raw = source.read_bytes() if isinstance(source, Path) else source
            yield from _iter_stream(rel, raw[:_MAX_MEMBER_BYTES])
    except Exception:
        yield "", b"", "unreadable"


# ── 文档载体：PDF 文本层 / PNG 文本块 ───────────────────────────────────

_PDF_STREAM_RE = re.compile(rb"stream\r?\n(.*?)endstream", re.S)
_PDF_TEXT_OP_RE = re.compile(rb"\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ|')")
_PDF_HEX_OP_RE = re.compile(rb"<([0-9A-Fa-f\s]+)>\s*Tj")


def _pdf_unescape(raw: bytes) -> str:
    out = bytearray()
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch == 0x5C and i + 1 < len(raw):  # backslash
            nxt = raw[i + 1]
            mapping = {0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12,
                       0x28: 0x28, 0x29: 0x29, 0x5C: 0x5C}
            if nxt in mapping:
                out.append(mapping[nxt])
                i += 2
                continue
            if 0x30 <= nxt <= 0x37:  # octal escape, up to 3 digits
                digits = raw[i + 1:i + 4]
                m = re.match(rb"[0-7]{1,3}", digits)
                if m:
                    out.append(int(m.group(0), 8) & 0xFF)
                    i += 1 + len(m.group(0))
                    continue
            i += 2
            continue
        out.append(ch)
        i += 1
    return out.decode("latin-1")


def _inflate(block: bytes) -> bytes:
    try:
        return zlib.decompress(block)
    except Exception:
        return block


def extract_pdf_text(path: Path) -> str:
    """从 PDF 里抽出可见文本层（有界、尽力而为）。

    只做规范里最常见的两条路径：内容流 Flate 解压 + ``(...) Tj`` /
    ``[ ... ] TJ`` 字面量。这不是 PDF 解析器——加密 PDF、CID 字体、对象流里
    的间接引用都会得到空字符串或残缺文本。调用方据此记一条「文本层未解析」的
    finding，而不是把「没抽到」当成「没内容」。

    之所以不做完整解析：PDF 解析器是一类 CVE 高发组件，一个安全扫描器引入它
    等于给自己加一块攻击面。这里只读字节、只解压、只取字面量，全程有上限。
    """
    try:
        data = path.read_bytes()[:_MAX_PDF_BYTES]
    except OSError:
        return ""
    chunks: list[str] = []
    total = 0
    for block in _PDF_STREAM_RE.findall(data):
        raw = _inflate(block)
        for match in _PDF_TEXT_OP_RE.finditer(raw):
            text = _pdf_unescape(match.group(1))
            chunks.append(text)
            total += len(text)
            if total >= _MAX_EXTRACTED_TEXT:
                break
        for match in _PDF_HEX_OP_RE.finditer(raw):
            try:
                decoded = bytes.fromhex(re.sub(rb"\s+", b"", match.group(1)).decode("ascii"))
            except ValueError:
                continue
            # UTF-16BE 是 PDF 里中文文本的常见编码；解不成就按 latin-1 取原文。
            text = decoded.decode("utf-16-be", errors="ignore") or decoded.decode("latin-1")
            chunks.append(text)
            total += len(text)
        if total >= _MAX_EXTRACTED_TEXT:
            break
    return "\n".join(c for c in chunks if c)[:_MAX_EXTRACTED_TEXT]


_PNG_SIG = b"\x89PNG\r\n\x1a\n"


def extract_png_text(path: Path) -> str:
    """抽出 PNG 的 ``tEXt`` / ``zTXt`` / ``iTXt`` 文本块。

    为什么值得单独做：一个 1×1 的 PNG 可以携带任意长度的文本，而图片在技能里
    几乎不会被怀疑。红队 A1-png-instruction 就是这样把整段越权指令塞进去的，
    并且拿到了 ``pass / 100``。像素里画的字仍然抽不出来，但那需要一个多模态
    通道，不是这一层能解决的诚实边界。
    """
    try:
        data = path.read_bytes()[:_MAX_PNG_BYTES]
    except OSError:
        return ""
    if not data.startswith(_PNG_SIG):
        return ""
    offset = len(_PNG_SIG)
    chunks: list[str] = []
    total = 0
    while offset + 8 <= len(data):
        try:
            length = int.from_bytes(data[offset:offset + 4], "big")
            tag = data[offset + 4:offset + 8]
        except ValueError:
            break
        offset += 8
        if length < 0 or offset + length > len(data):
            break
        payload = data[offset:offset + length]
        offset += length + 4  # skip CRC
        if tag == b"tEXt":
            _, sep, text = payload.partition(b"\x00")
            if sep:
                chunks.append(text.decode("latin-1", errors="ignore"))
        elif tag == b"zTXt":
            _, sep, rest = payload.partition(b"\x00")
            if sep and len(rest) > 1:
                try:
                    chunks.append(zlib.decompress(rest[1:]).decode("latin-1", errors="ignore"))
                except Exception:
                    pass
        elif tag == b"iTXt":
            parts = payload.split(b"\x00", 5)
            if len(parts) >= 6:
                body = parts[5]
                if parts[1] == b"\x01":
                    try:
                        body = zlib.decompress(body)
                    except Exception:
                        body = b""
                chunks.append(body.decode("utf-8", errors="ignore"))
        if tag == b"IEND":
            break
        total = sum(len(c) for c in chunks)
        if total >= _MAX_EXTRACTED_TEXT:
            break
    return "\n".join(c for c in chunks if c)[:_MAX_EXTRACTED_TEXT]


# ── 归档：成员进入同一条文本管线 ─────────────────────────────────────────


def _collect_archive_docs(
    rel: str,
    path: Path | bytes,
    *,
    depth: int,
    budget: dict[str, int],
    findings: list[dict[str, Any]],
) -> list[tuple[str, str]]:
    """把一个归档（可嵌套）的文本成员摊平成 ``(合成路径, 文本)``。

    ``depth`` 从 0 开始；``MAX_ARCHIVE_DEPTH`` 是「还能再打开几层」，到顶后
    只记一条 finding，不递归——递归炸弹的第一道防线是深度而不是超时。
    """
    docs: list[tuple[str, str]] = []
    binary_members = 0
    family = _archive_family(rel)
    if family is None:
        return docs
    if family == "opaque":
        findings.append(_carrier_finding(
            "archive_format_unscannable", "medium", "scan_coverage", rel,
            f"归档格式 {PurePosixPath(rel).suffix} 无法在本地解包：其内容本次未被检查",
            "提供解包后的源码，或改用 zip/tar.gz。",
        ))
        return docs

    for member, data, skip in _member_entries(rel, family, path):
        member_rel = f"{rel}::{member}" if member else rel
        if skip:
            rule, severity = {
                "encrypted": ("archive_encrypted", "high"),
                "symlink": ("archive_symlink_member", "high"),
                "special": ("archive_special_member", "high"),
                "oversized": ("archive_member_oversized", "low"),
                "ratio": ("archive_member_bomb", "high"),
                "unreadable": ("archive_member_unreadable", "medium"),
            }.get(skip, ("archive_member_unreadable", "medium"))
            findings.append(_carrier_finding(
                rule, severity, "structural", member_rel,
                {
                    "encrypted": "归档成员加密：扫描器无法读取其内容",
                    "symlink": "归档成员是符号链接：解包后可能落到技能目录之外",
                    "special": "归档成员是设备节点/特殊文件：技能不应携带",
                    "oversized": "归档成员超出单成员上限：内容未检查",
                    "ratio": "归档成员压缩比异常：典型压缩炸弹形态",
                    "unreadable": "归档成员解压失败：内容未检查",
                }[skip],
                "移除该成员或提供可读版本。",
            ))
            continue
        if _unsafe_member(member):
            findings.append(_carrier_finding(
                "archive_path_traversal", "critical", "structural", member_rel,
                "归档成员路径越界（绝对路径或 ..）：解包会写到技能目录之外",
                "移除该成员；这类归档通常用于覆盖任意文件。",
            ))
            continue

        nested = _archive_family(member) if member else None
        if nested is not None:
            if depth + 1 >= _MAX_ARCHIVE_DEPTH:
                findings.append(_carrier_finding(
                    "archive_nesting_truncated", "medium", "scan_coverage", member_rel,
                    f"嵌套归档超过 {_MAX_ARCHIVE_DEPTH} 层：内层内容未检查",
                    "摊平归档层级，或提供解包后的源码。",
                ))
                continue
            docs.extend(_collect_archive_docs(
                member_rel, data, depth=depth + 1, budget=budget, findings=findings,
            ))
            continue

        suffix = PurePosixPath(member).suffix.lower() if member else ""
        if suffix not in TEXT_EXT:
            # 归档里的二进制成员：不扫描，但要**说出来**。H1-zip-bomb 的成员是
            # 一个 1 MiB 的 `zeros.bin`，此前它从证据里完全消失，用户只看到
            # 一条「有 1 个文件未做文本分析」，指的是 zip 本身。
            binary_members += 1
            continue
        if budget["bytes"] + len(data) > _ARCHIVE_BUDGET_BYTES:
            findings.append(_carrier_finding(
                "archive_scan_truncated", "medium", "scan_coverage", rel,
                f"归档成员总解压体积超过 {_ARCHIVE_BUDGET_BYTES // (1024 * 1024)} MiB：部分成员未检查",
                "拆分归档，或只分发扫描得到的源码。",
            ))
            break
        docs.append((member_rel, data.decode("utf-8", errors="ignore")))
        budget["bytes"] += len(data)
    if binary_members:
        findings.append(_carrier_finding(
            "archive_binary_members", "low", "scan_coverage", rel,
            f"归档内有 {binary_members} 个二进制成员：未做文本分析，只按二进制签名扫描外层",
            "如这些成员来自第三方，请人工确认其用途。",
        ))
    return docs


def _carrier_text_docs(
    rel: str,
    path: Path,
    findings: list[dict[str, Any]],
) -> list[tuple[str, str]]:
    """PDF / PNG 的文本抽取。抽不到时记一条 coverage finding，不记为干净。"""
    suffix = path.suffix.lower()
    if suffix in _DOC_CARRIER_SUFFIXES:
        text = extract_pdf_text(path)
        if text.strip():
            return [(rel, text)]
        findings.append(_carrier_finding(
            "carrier_text_unparsed", "low", "scan_coverage", rel,
            "PDF 文本层未能抽取（加密/自定义编码/扫描件）：其文字内容本次未被检查",
            "提供可复制文本的 PDF，或附上同内容的纯文本。",
        ))
        return []
    if suffix in _IMAGE_CARRIER_SUFFIXES:
        text = extract_png_text(path)
        if text.strip():
            return [(rel, text)]
        findings.append(_carrier_finding(
            "carrier_pixels_unparsed", "low", "scan_coverage", rel,
            "图片内容未做 OCR：像素内的文字本次未被检查（元数据文本已抽取）",
            "如图片来自第三方，请人工确认其文字内容。",
        ))
    return []


def _sniff_text(path: Path) -> str | None:
    """按**内容**判断这份文件是不是文本；是则返回解码后的样本。

    为什么不能只信扩展名：``TEXT_EXT`` 是一张白名单，攻击者唯一要做的事就是
    换一个「看起来像文档」的后缀。红队 2026-11-05 的 V1 就是 A1-svg 的同一段
    凭据外发指令，只把 ``.svg`` 改成 ``.rtf``——引擎 ``pass/100``，应用安装并
    落干净回执，唯一的痕迹是一条「有 1 个文件未做文本分析」的 info。

    判据刻意保守，因为误判的代价是把二进制当文本喂给正则（噪声）：
    NUL 直接否掉；整段必须是合法 UTF-8；可打印占比要过 0.90。RTF、VBS、JSP、
    无扩展名脚本、``.doc`` 之外的标记语言都能过，ELF/JPEG/OLE 过不了。
    """
    try:
        with path.open("rb") as handle:
            head = handle.read(_TEXT_SNIFF_BYTES)
    except OSError:
        return None
    if not head or b"\x00" in head:
        return None
    try:
        decoded = head.decode("utf-8")
    except UnicodeDecodeError as exc:
        # 采样截断可能把一个多字节字符切成两半：只容忍末尾这一个字符。
        if exc.start < len(head) - 3:
            return None
        try:
            decoded = head[:exc.start].decode("utf-8")
        except UnicodeDecodeError:
            return None
    if not decoded:
        return None
    printable = sum(1 for ch in decoded if ch.isprintable() or ch in "\n\r\t")
    if printable / len(decoded) < _TEXT_PRINTABLE_RATIO:
        return None
    return decoded


def collect_evidence(skill_dir: Path) -> tuple[set[str], list[tuple[str, str]], list[dict[str, Any]]]:
    """返回 ``(相对路径集合, [(相对路径, 文本内容)], 载体 findings)``。

    只有文本进入 ``docs``；二进制仍交给 ``binary_rules``。``docs`` 里还会出现
    三类**合成路径**：

    * ``bundle.zip::scripts/run.py`` —— 归档成员
    * ``docs/brief.pdf``           —— PDF 文本层
    * ``assets/logo.png``          —— PNG 文本块

    合成路径的扩展名保持成员自己的后缀，因此语言分派与上下文降权照常生效；
    这是「不为载体写第二套检测」的关键。

    扩展名白名单只决定**先读哪些**，不再是「读不读」的最终裁决：白名单之外
    的文件过一遍内容探测，是文本就读（V1 的 ``.rtf``、``.vbs``、无扩展名脚本
    都在这里进入同一条管线）。探测为文本却因为体积/预算没读完的，记一条点名
    的 finding——「没检查」必须是可见的结论，不能只是计数。
    """
    files: set[str] = set()
    docs: list[tuple[str, str]] = []
    findings: list[dict[str, Any]] = []
    total = 0
    archive_budget = {"bytes": 0}

    for path in sorted(skill_dir.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(skill_dir).as_posix()
        # 生成目录（__pycache__/.venv/node_modules 等）不收集证据，
        # 与 locate_skill_roots 的排除口径保持一致。
        if IGNORED_DIRS.intersection(rel.split("/")[:-1]):
            continue
        files.add(rel.lower())
        suffix = path.suffix.lower()
        try:
            size = path.stat().st_size
        except OSError:
            continue

        is_text = suffix in TEXT_EXT or path.name.lower() in _TEXT_FILENAMES
        if is_text:
            if size > _MAX_TEXT_FILE_BYTES:
                findings.append(_carrier_finding(
                    "text_carrier_oversized", "medium", "scan_coverage", rel,
                    f"文本文件 {size} 字节，超过单文件 {_MAX_TEXT_FILE_BYTES} 字节上限："
                    "其内容本次未被检查",
                    "拆分文件，或提供体积在限制内的版本。",
                ))
                continue
            try:
                docs.append((rel, path.read_text("utf-8", errors="ignore")))
                total += size
            except Exception:
                findings.append(_carrier_finding(
                    "text_carrier_unreadable", "medium", "scan_coverage", rel,
                    "文本文件读取失败：其内容本次未被检查",
                    "检查文件权限或编码后重新打包。",
                ))
        elif _archive_family(rel) is not None:
            docs.extend(_collect_archive_docs(
                rel, path, depth=0, budget=archive_budget, findings=findings,
            ))
        elif suffix in _DOC_CARRIER_SUFFIXES or suffix in _IMAGE_CARRIER_SUFFIXES:
            docs.extend(_carrier_text_docs(rel, path, findings))
        elif suffix in _OLE_CARRIER_SUFFIXES:
            # 旧二进制 Office 容器：读不出文字层，但「里面可能是整篇指令」这个
            # 事实必须让它留下痕迹，而不是像以前那样直接从这个函数里消失。
            findings.append(_carrier_finding(
                "carrier_binary_document_unparsed", "medium", "scan_coverage", rel,
                f"二进制文档载体 {suffix} 的文字内容本次未被检查",
                "提供可读文本的版本（.docx/.pdf），或附上同内容的纯文本。",
            ))
        else:
            sample = _sniff_text(path)
            if sample is None:
                continue  # 二进制：交给 binary_rules，并由覆盖计数披露
            if size > _MAX_TEXT_FILE_BYTES:
                findings.append(_carrier_finding(
                    "text_carrier_oversized", "medium", "scan_coverage", rel,
                    f"内容为文本但体积 {size} 字节超过上限：其内容本次未被检查",
                    "拆分文件，或提供体积在限制内的版本。",
                ))
                continue
            docs.append((rel, path.read_text("utf-8", errors="ignore")))
            total += size
        if total >= _TEXT_BUDGET_BYTES:
            findings.append(_carrier_finding(
                "text_budget_exhausted", "medium", "scan_coverage", rel,
                f"文本总量超过 {_TEXT_BUDGET_BYTES // (1024 * 1024)} MiB：此后的文件未检查",
                "拆分技能，或减少随包分发的大文本。",
            ))
            break
    return files, docs, findings
