"""
dependency_inventory.py — 从清单与锁文件里抽出「实际装了哪些版本」
====================================================================

为什么需要这一层
----------------
``supply_chain.py`` 看的是「依赖声明得像不像投毒」（安装钩子、源覆盖、拼写
伪装、未固定的 git 引用），它**不回答**「这个已经装上的版本有没有已知漏洞」。
后者需要一份「包名 + 具体版本」的清单，而清单有两种形态：

- **锁文件**：``package-lock.json`` / ``yarn.lock`` / ``pnpm-lock.yaml`` /
  ``poetry.lock`` / ``uv.lock`` / ``Pipfile.lock`` —— 含传递依赖，版本是确定的。
- **清单**：``package.json`` / ``pyproject.toml`` / ``requirements.txt`` ——
  只有作者写的约束。范围（``^4.17.20``）在静态阶段**无法**确定最终版本，
  因此只能用于「包名本身已被标记为恶意」的匹配，不能用于版本区间判定。

设计取舍
--------
- **解析失败不静默**：清单存在却读不出来时记入 ``stats.unreadable``，由报告
  变成一条 ``info`` 级覆盖项。「没有发现漏洞」与「没有读到依赖」必须是两句话。
- **不做版本求解**：不解析 ``^`` / ``~`` / ``>=`` / ``1.x``。没有网络与注册表
  的情况下求解出来的版本是猜的，而猜出来的 CVE 结论会误导用户。
- **递归有界**：锁文件可能上万行，清单可以互相包含（``-r base.txt``）。深度、
  文件数、条目数都有上限，超限记录 ``truncated``，不静默截断。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterable, Optional

from .path_security import IGNORED_DIRS

#: 单个清单文件的读取上限。正常锁文件远小于此；超过它多半是误把别的东西
#: 命名成了清单。
MAX_MANIFEST_BYTES = 4_000_000
#: 一次扫描最多解析的清单文件数与依赖条目数。
MAX_MANIFESTS = 200
MAX_DEPENDENCIES = 20_000
#: ``-r other.txt`` 的递归深度。
MAX_INCLUDE_DEPTH = 3

_LOCKFILE_NAMES = {
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
    "poetry.lock", "uv.lock", "Pipfile.lock",
}

#: 要求文件允许的命名：requirements.txt / requirements-dev.txt / requirements/dev.txt。
_REQUIREMENTS_RE = re.compile(r"(^|/)requirements[\w.-]*\.txt$", re.IGNORECASE)
#: `name[extras]==1.2.3` / `name===1.2.3`（PEP 508 的两个精确等价写法）。
_PINNED_REQ_RE = re.compile(
    r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*===?\s*"
    r"v?(\d+(?:\.\d+)*(?:[._-]?(?:a|b|c|rc|alpha|beta|pre|preview|post|dev)[._-]?\d*)?"
    r"(?:\+[0-9A-Za-z.]+)?)\s*(?:;.*)?$",
    re.IGNORECASE,
)
#: pyproject.toml / setup.cfg 里的精确固定（`"requests==2.31.0"`）。
_PINNED_IN_QUOTES_RE = re.compile(
    r"[\"']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*===?\s*"
    r"v?(\d+(?:\.\d+)*(?:[._-]?(?:a|b|c|rc|alpha|beta|pre|preview|post|dev)[._-]?\d*)?"
    r"(?:\+[0-9A-Za-z.]+)?)[\"']",
    re.IGNORECASE,
)
#: package.json 里可当作「确定版本」的写法；其余（^、~、*、git、file）只留名字。
_CONCRETE_JSON_VERSION_RE = re.compile(
    r"^[=\s]*v?(\d+(?:\.\d+)*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
)

_POETRY_PACKAGE_HEADER_RE = re.compile(r"^\[\[package\]\]\s*$", re.MULTILINE)
_TOML_KV_RE = re.compile(r"^\s*(name|version)\s*=\s*[\"']([^\"']+)[\"']\s*$", re.MULTILINE)


class Dependency:
    """一条「包名 + 版本」记录。``version`` 为 None 表示清单只给了范围。"""

    __slots__ = ("ecosystem", "name", "version", "constraint", "file", "line", "source")

    def __init__(self, ecosystem: str, name: str, version: Optional[str],
                 file: str, line: Optional[int] = None, source: str = "lockfile",
                 constraint: Optional[str] = None) -> None:
        self.ecosystem = ecosystem
        self.name = name
        self.version = version
        self.constraint = constraint
        self.file = file
        self.line = line
        self.source = source

    def as_dict(self) -> dict[str, Any]:
        return {
            "ecosystem": self.ecosystem,
            "name": self.name,
            "version": self.version,
            "file": self.file,
            "line": self.line,
            "source": self.source,
        }

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"<Dependency {self.ecosystem}:{self.name}@{self.version or self.constraint}>"


def _relative(skill_dir: Path, path: Path) -> str:
    try:
        return path.relative_to(skill_dir).as_posix()
    except ValueError:
        return path.name


def _iter_manifest_candidates(skill_dir: Path) -> list[Path]:
    """遍历可能承载依赖信息的文件，按相对路径排序返回。

    只沿目录树走一遍，并在进入生成目录前剪枝——``node_modules`` 里可能有上万个
    ``package.json``，而它们不是这个 Skill 的依赖声明，是依赖自己。

    排序是契约的一部分：同一份 Skill 目录两次扫描必须得到同一份清单，否则
    「哪条重复记录被保留」会随文件系统遍历顺序漂移。
    """
    found: list[Path] = []
    stack = [skill_dir]
    while stack:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    # 符号链接可能指向 Skill 之外；结构扫描会单独报告它。
                    continue
                if entry.is_dir():
                    if entry.name in IGNORED_DIRS:
                        continue
                    stack.append(entry)
                    continue
            except OSError:
                continue
            if not entry.is_file():
                continue
            name = entry.name
            if (name in _LOCKFILE_NAMES or name in ("package.json", "pyproject.toml")
                    or _REQUIREMENTS_RE.search(_relative(skill_dir, entry).lower())):
                found.append(entry)
    found.sort(key=lambda item: _relative(skill_dir, item))
    return found[:MAX_MANIFESTS]


def _read_text(path: Path) -> Optional[str]:
    try:
        if path.stat().st_size > MAX_MANIFEST_BYTES:
            return None
        return path.read_text("utf-8", errors="replace")
    except OSError:
        return None


def _pinned(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    match = _CONCRETE_JSON_VERSION_RE.match(value.strip())
    return match.group(1) if match else None


def _add(deps: list[Dependency],
         skill_dir: Path, path: Path, items: Iterable[tuple]) -> None:
    """把解析结果收进清单。条目可选第 6 项为「实际所在的文件」（`-r` 递归）。

    包名在这里按生态规范化（PyPI 用 PEP 503），这样 ``PyYAML`` 与 ``pyyaml``
    不会在漏洞库里被当成两个包。
    """
    from .versions import normalize_name  # 局部导入：避免模块级循环依赖

    for item in items:
        name, version, line, source, constraint = item[:5]
        item_path = item[5] if len(item) > 5 else path
        if not name:
            continue
        ecosystem = "npm" if _is_npm(item_path) else "PyPI"
        deps.append(Dependency(
            ecosystem, normalize_name(ecosystem, name)[:214], version,
            _relative(skill_dir, item_path), line, source, constraint,
        ))
        if len(deps) >= MAX_DEPENDENCIES:
            return


def _is_npm(path: Path) -> bool:
    return path.name in ("package.json", "package-lock.json", "npm-shrinkwrap.json",
                         "yarn.lock", "pnpm-lock.yaml")


# ── npm ────────────────────────────────────────────────────────────────
def _parse_package_json(text: str) -> list[tuple[str, Optional[str], Optional[int], str, Optional[str]]]:
    data = json.loads(text)
    if not isinstance(data, dict):
        return []
    out = []
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        group = data.get(section)
        if not isinstance(group, dict):
            continue
        for name, spec in group.items():
            if not isinstance(name, str) or not name:
                continue
            version = _pinned(spec)
            out.append((name, version, None, "manifest" if version else "constraint",
                        None if version else (spec if isinstance(spec, str) else None)))
    return out


def _parse_package_lock_v1(dependencies: Any, depth: int = 0):
    if not isinstance(dependencies, dict) or depth > 20:
        return
    for name, info in dependencies.items():
        if not isinstance(name, str) or not isinstance(info, dict):
            continue
        version = info.get("version")
        if isinstance(version, str) and version:
            yield name, version, None, "lockfile", None
        yield from _parse_package_lock_v1(info.get("dependencies"), depth + 1)


def _parse_package_lock(text: str) -> list[tuple[str, Optional[str], Optional[int], str, Optional[str]]]:
    data = json.loads(text)
    if not isinstance(data, dict):
        return []
    out = []
    packages = data.get("packages")
    if isinstance(packages, dict):
        for key, info in packages.items():
            if not isinstance(info, dict) or info.get("link") is True:
                continue
            version = info.get("version")
            if not isinstance(version, str) or not version:
                continue
            if not key:
                continue  # 根条目是项目自身，不是依赖
            name = key.rsplit("node_modules/", 1)[-1]
            if name:
                out.append((name, version, None, "lockfile", None))
        return out
    # lockfileVersion 1：嵌套 dependencies。
    for item in _parse_package_lock_v1(data.get("dependencies")):
        out.append(item)
    return out


_YARN_V1_HEADER_RE = re.compile(r"^(\S.*):\s*$")
_YARN_VERSION_RE = re.compile(r"^\s+version\s+\"?([^\"\s]+)\"?\s*$")
_YARN_BERRY_VERSION_RE = re.compile(r"^\s+version:\s*\"?([^\"\s]+)\"?\s*$")


def _descriptor_name(header: str) -> Optional[str]:
    """yarn 描述符 → 包名。支持 classic 与 berry 的 ``pkg@npm:^1.0.0`` 写法。"""
    descriptor = header.split(",")[0].strip().strip('"').strip()
    if not descriptor:
        return None
    if descriptor.startswith("@"):
        # 作用域包名本身以 @ 开头，分隔符是**第二个** @。
        sep = descriptor.find("@", 1)
        if sep <= 1:
            return None
        name, rest = descriptor[:sep], descriptor[sep + 1:]
    else:
        if "@" not in descriptor:
            return None
        name, rest = descriptor.split("@", 1)
    if not name:
        return None
    if rest.startswith(("git+", "http://", "https://", "file:", "link:", "portal:",
                        "workspace:", "patch:", "exec:")):
        return None
    # berry 别名：`alias@npm:real-package@^1.0.0` 实际安装的是 real-package。
    alias = re.match(r"^npm:([^@]+)@", rest)
    if alias:
        return alias.group(1)
    return name


def _parse_yarn_lock(text: str) -> list[tuple[str, Optional[str], Optional[int], str, Optional[str]]]:
    out = []
    current: Optional[str] = None
    for lineno, line in enumerate(text.splitlines(), 1):
        header = _YARN_V1_HEADER_RE.match(line)
        if header and not line.startswith((" ", "\t", "#")):
            current = _descriptor_name(header.group(1))
            continue
        if current is None:
            continue
        match = _YARN_VERSION_RE.match(line) or _YARN_BERRY_VERSION_RE.match(line)
        if match:
            out.append((current, match.group(1), lineno, "lockfile", None))
            current = None
    return out


def _parse_pnpm_key(key: str) -> Optional[tuple[str, str]]:
    """pnpm 锁文件键 → (包名, 版本)。

    兼容三代格式：``/name/1.2.3``（v5）、``/name@1.2.3``（v6）、
    ``name@1.2.3``（v9），以及 peer 后缀 ``name@1.2.3(react@18.0.0)``。
    """
    raw = str(key or "").strip().strip("'\"")
    raw = raw.split("(", 1)[0]
    if not raw or raw.startswith("file:"):
        return None
    if raw.startswith("/"):
        raw = raw[1:]
    if "@" in raw[1:]:
        idx = raw.rfind("@")
        name, version = raw[:idx], raw[idx + 1:]
        if name and version:
            return name, version
    parts = raw.split("/")
    if len(parts) >= 2:
        name, version = "/".join(parts[:-1]), parts[-1]
        if name and version:
            return name, version
    return None


def _parse_pnpm_lock(text: str) -> list[tuple[str, Optional[str], Optional[int], str, Optional[str]]]:
    keys: list[str] = []
    try:
        data = _yaml_load(text)
    except Exception:
        data = None
    if isinstance(data, dict) and isinstance(data.get("packages"), dict):
        keys = list(data["packages"].keys())
    else:
        # 没有 YAML 解析器时的兜底：只认 packages: 下缩进两格的键行。
        in_packages = False
        for line in text.splitlines():
            if re.match(r"^packages:\s*$", line):
                in_packages = True
                continue
            if in_packages and re.match(r"^\S", line):
                in_packages = False
            if in_packages:
                match = re.match(r"^\s{2,}(['\"]?)([^'\":]+)\1:\s*$", line)
                if match:
                    keys.append(match.group(2).strip())
    out = []
    for key in keys:
        parsed = _parse_pnpm_key(key)
        if parsed:
            out.append((parsed[0], parsed[1], None, "lockfile", None))
    return out


# ── PyPI ──────────────────────────────────────────────────────────────
def _parse_requirements(text: str, current_file: Path, skill_dir: Path, depth: int,
                        visited: set[Path]) -> list[tuple]:
    out: list[tuple] = []
    base = current_file.parent
    for lineno, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        include = re.match(r"^(?:-r|--requirement)\s+(\S+)", stripped)
        if include:
            if depth >= MAX_INCLUDE_DEPTH:
                continue
            target = (base / include.group(1)).resolve()
            try:
                target.relative_to(skill_dir.resolve())
            except ValueError:
                continue
            if target in visited or not target.is_file():
                continue
            visited.add(target)
            child = _read_text(target)
            if child is not None:
                out.extend(_parse_requirements(child, target, skill_dir,
                                               depth + 1, visited))
            continue
        if stripped.startswith(("-", "git+", "http://", "https://", "file:")):
            continue
        # 去掉行尾哈希与内联注释（`requests==2.31 # comment`）。
        stripped = re.sub(r"\s+--hash=\S+", "", stripped)
        stripped = re.sub(r"\s+#.*$", "", stripped)
        match = _PINNED_REQ_RE.match(stripped)
        if match:
            out.append((match.group(1), match.group(2), lineno, "manifest", None,
                        current_file))
            continue
        name_match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)", stripped)
        if name_match:
            out.append((name_match.group(1), None, lineno, "constraint",
                        stripped[:120], current_file))
    return out


def _parse_poetry_like_lock(text: str) -> list[tuple[str, Optional[str], Optional[int], str, Optional[str]]]:
    out = []
    blocks = _POETRY_PACKAGE_HEADER_RE.split(text)
    for block in blocks[1:]:
        name = None
        version = None
        for match in _TOML_KV_RE.finditer(block):
            if match.group(1) == "name":
                name = match.group(2)
            else:
                version = match.group(2)
        if name and version:
            out.append((name, version, None, "lockfile", None))
    return out


def _parse_pipfile_lock(text: str) -> list[tuple[str, Optional[str], Optional[int], str, Optional[str]]]:
    data = json.loads(text)
    if not isinstance(data, dict):
        return []
    out = []
    for section in ("default", "develop"):
        group = data.get(section)
        if not isinstance(group, dict):
            continue
        for name, info in group.items():
            if not isinstance(info, dict):
                continue
            raw = info.get("version")
            if isinstance(raw, str):
                match = re.match(r"^==\s*v?(.+)$", raw.strip())
                if match:
                    out.append((name, match.group(1), None, "lockfile", None))
                    continue
            out.append((name, None, None, "constraint", raw if isinstance(raw, str) else None))
    return out


def _yaml_load(text: str) -> Any:
    try:
        import yaml  # noqa: PLC0415
        return yaml.safe_load(text)
    except Exception:
        return None


# ── 汇总 ──────────────────────────────────────────────────────────────
def collect_dependencies(skill_dir: Path) -> dict[str, Any]:
    """返回 ``{"dependencies": [...], "stats": {...}}``。

    条目按 (ecosystem, 规范化包名, 版本) 去重；同一包名同时出现在清单与锁文件
    时保留锁文件里的确定版本——那是「实际装上的那个」。
    """
    deps: list[Dependency] = []
    manifests: list[dict[str, Any]] = []
    unreadable: list[dict[str, str]] = []
    seen_names: set[tuple[str, str]] = set()
    truncated = False

    for path in _iter_manifest_candidates(skill_dir):
        rel = _relative(skill_dir, path)
        text = _read_text(path)
        try:
            if text is None:
                unreadable.append({"file": rel, "reason": "unreadable_or_too_large"})
                continue
            before = len(deps)
            if path.name == "package.json":
                items = _parse_package_json(text)
            elif path.name in ("package-lock.json", "npm-shrinkwrap.json"):
                items = _parse_package_lock(text)
            elif path.name == "yarn.lock":
                items = _parse_yarn_lock(text)
            elif path.name == "pnpm-lock.yaml":
                items = _parse_pnpm_lock(text)
            elif path.name == "poetry.lock":
                items = _parse_poetry_like_lock(text)
            elif path.name == "uv.lock":
                items = _parse_poetry_like_lock(text)
            elif path.name == "Pipfile.lock":
                items = _parse_pipfile_lock(text)
            elif path.name == "pyproject.toml":
                items = [(name, version, None, "manifest", None)
                         for name, version in _PINNED_IN_QUOTES_RE.findall(text)]
            else:  # requirements*.txt
                items = _parse_requirements(text, path, skill_dir, 0, {path})
        except Exception as exc:  # 清单格式错误不是扫描崩溃的理由
            unreadable.append({"file": rel, "reason": f"parse_error:{type(exc).__name__}"})
            continue

        _add(deps, skill_dir, path, items)
        if len(deps) >= MAX_DEPENDENCIES:
            truncated = True
            break
        manifests.append({
            "file": rel,
            "kind": "lockfile" if path.name in _LOCKFILE_NAMES else "manifest",
            "packages": len(deps) - before,
        })

    # 去重：确定版本优先于范围；同一组合只保留第一条。
    deduped: list[Dependency] = []
    concrete_names: set[tuple[str, str]] = set()
    for dep in deps:
        key = (dep.ecosystem, dep.name.lower(), dep.version or "")
        if dep.version:
            concrete_names.add((dep.ecosystem, dep.name.lower()))
        if key in seen_names:
            continue
        seen_names.add(key)
        deduped.append(dep)
    deduped = [d for d in deduped
               if d.version or (d.ecosystem, d.name.lower()) not in concrete_names]

    ecosystems: dict[str, int] = {}
    for dep in deduped:
        ecosystems[dep.ecosystem] = ecosystems.get(dep.ecosystem, 0) + 1

    return {
        "dependencies": deduped,
        "stats": {
            "packages": sum(1 for d in deduped if d.version),
            "constraints": sum(1 for d in deduped if not d.version),
            "ecosystems": ecosystems,
            "manifests": manifests,
            "unreadable": unreadable,
            "truncated": truncated or len(deduped) >= MAX_DEPENDENCIES,
        },
    }
