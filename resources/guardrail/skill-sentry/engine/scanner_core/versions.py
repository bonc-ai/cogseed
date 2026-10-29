"""
versions.py — 版本比较，只为「已安装版本是否落在受影响区间」这一件事服务
================================================================================

为什么不用现成库
----------------
引擎的硬约束是「随 Skill 发布、在任意 python3 上可运行」：`engine/` 里除了
skill 自带的 YAML 副本没有任何第三方依赖。为了一个 `4.17.20 < 4.17.21`
引入 `packaging` / `semver` 会让出厂运行时多一条隐式前提——而 2.2.0 已经
因为同类前提（pyyaml 未接进 sys.path）静默丢过 65% 的规则集。

实现边界（重要）
----------------
这里**不是**通用版本库：

- 不解析 npm 的 `^1.2.3` / `~1.2` / `1.x` 一类**范围表达式**。清单里写范围
  意味着「最终装哪个版本」在静态阶段不可知，拿范围去匹配漏洞只会制造误报。
  漏洞库的区间是「已安装的具体版本落在哪」，不是「可能装到哪」。
- 不追求与 npm `node-semver` / PyPI `packaging` 逐位一致。目标只有两个：
  1. 常见形态排序正确（`1.2.3`、`1.2.3-beta.1`、`1.2.3.post1`、`1.2rc1`）；
  2. **无法判定时返回 `None`，由调用方当作「不匹配」**，绝不猜。

第 2 条是刻意的：一条无法验证的 CVE 结论比没有结论更糟——用户会去升级一个
本来就没问题的依赖，或者反过来忽略一条真的告警。
"""
from __future__ import annotations

import re
from typing import Optional

#: npm 可接受的具体版本形态。允许前导 `=`/`v`、多段数字、预发布与构建元数据。
_NPM_VERSION_RE = re.compile(
    r"^[=\s]*v?(\d+(?:\.\d+)*)"
    r"(?:-([0-9A-Za-z.-]+))?"
    r"(?:\+[0-9A-Za-z.-]+)?$"
)

#: PEP 440 的宽松拆解。按「pre / post / dev」分别剥离，剩余部分必须是数字段。
_PEP440_DEV_RE = re.compile(r"[-_.]?dev[-_.]?(\d*)$", re.IGNORECASE)
_PEP440_POST_RE = re.compile(r"[-_.]?(?:post|rev|r)[-_.]?(\d*)$", re.IGNORECASE)
#: 旧的隐式 post 写法：`1.0-1`。
_PEP440_IMPLICIT_POST_RE = re.compile(r"^(.+?)-(\d+)$")
_PEP440_PRE_RE = re.compile(
    r"[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*)$", re.IGNORECASE
)
_PEP440_EPOCH_RE = re.compile(r"^(\d+)!(.+)$")

_PRE_RANK = {
    "a": 1, "alpha": 1,
    "b": 2, "beta": 2,
    "c": 3, "rc": 3, "pre": 3, "preview": 3,
}

#: release 段补齐长度。PEP 440 与 semver 都把 `1.2` 与 `1.2.0` 视为同一版本，
#: 补零让元组可以直接比较，而不必写一个逐段循环。
_PAD = 8


def normalize_name(ecosystem: str, name: str) -> str:
    """依赖名的比较口径。

    PyPI 的包名按 PEP 503 规范化（大小写不敏感，`-`/`_`/`.` 等价）。
    npm 只做小写折叠：npm 本身不允许大写，但清单里偶尔出现，按原样比较会漏配。
    """
    raw = (name or "").strip()
    if ecosystem == "PyPI":
        return re.sub(r"[-_.]+", "-", raw).lower()
    return raw.lower()


def _semver_key(version: str):
    """npm 版本 → 可比较元组；无法解析返回 None。"""
    m = _NPM_VERSION_RE.match(str(version or ""))
    if not m:
        return None
    release = tuple(int(part) for part in m.group(1).split("."))
    if len(release) < _PAD:
        release = release + (0,) * (_PAD - len(release))
    pre = m.group(2)
    if pre is None:
        # semver：有预发布标识的版本小于同号正式版（1.0.0-rc1 < 1.0.0）。
        return release + ((1,),)
    ids = []
    for ident in pre.split("."):
        if ident.isdigit():
            # 数字标识小于字母标识（semver §11.4.3），用 0/1 前缀区分类型。
            ids.append((0, int(ident), ""))
        else:
            ids.append((1, 0, ident))
    return release + ((0, tuple(ids)),)


def _pep440_key(version: str):
    """PEP 440 版本 → 可比较元组；无法解析返回 None。

    阶段排序：dev < pre(a<b<rc) < final < post。每个阶段都带一个
    ``dev_flag``，使 ``1.0rc1.dev1 < 1.0rc1 < 1.0`` 成立。
    """
    raw = str(version or "").strip()
    if not raw:
        return None
    # 本地版本（+...）不参与公共版本排序。
    raw = raw.split("+", 1)[0].strip()
    if raw[:1] in ("v", "V"):
        raw = raw[1:].strip()
    epoch = 0
    m = _PEP440_EPOCH_RE.match(raw)
    if m:
        epoch = int(m.group(1))
        raw = m.group(2)

    dev = None
    m = _PEP440_DEV_RE.search(raw)
    if m:
        dev = int(m.group(1) or 0)
        raw = raw[:m.start()]

    post = None
    m = _PEP440_POST_RE.search(raw)
    if m:
        post = int(m.group(1) or 0)
        raw = raw[:m.start()]
    else:
        m = _PEP440_IMPLICIT_POST_RE.match(raw)
        if m:
            post = int(m.group(2))
            raw = m.group(1)

    pre = None
    m = _PEP440_PRE_RE.search(raw)
    if m:
        rank = _PRE_RANK.get(m.group(1).lower())
        if rank is None:
            return None
        pre = (rank, int(m.group(2) or 0))
        raw = raw[:m.start()]

    if not raw:
        return None
    if not re.fullmatch(r"\d+(?:\.\d+)*", raw):
        return None
    release = tuple(int(part) for part in raw.split("."))
    if len(release) < _PAD:
        release = release + (0,) * (_PAD - len(release))

    dev_flag = 0 if dev is None else -1
    if post is not None:
        return (epoch,) + release + (5, post, dev_flag)
    if pre is not None:
        return (epoch,) + release + (pre[0], pre[1], dev_flag)
    if dev is not None:
        return (epoch,) + release + (0, dev, dev_flag)
    return (epoch,) + release + (4, 0, 0)


def version_key(ecosystem: str, version: str):
    """版本 → 可比较键；无法解析返回 None。"""
    if ecosystem == "PyPI":
        return _pep440_key(version)
    return _semver_key(version)


def compare(ecosystem: str, left: str, right: str) -> Optional[int]:
    """比较两个版本：-1 / 0 / 1；任一侧不可解析时返回 None。"""
    lk = version_key(ecosystem, left)
    rk = version_key(ecosystem, right)
    if lk is None or rk is None:
        # 不用「宽松比较」兜底：`not-a-version` 那种字符串也能排出一个顺序，
        # 于是「无法判定」会被伪装成一个确定结论。OSV 的版本字段是干净的，
        # 解析失败就说明这条数据不该参与判定。
        return None
    if lk == rk:
        return 0
    return -1 if lk < rk else 1


def is_concrete(ecosystem: str, version: str) -> bool:
    """该字符串是否能当作一个确定的已安装版本。"""
    return version_key(ecosystem, version) is not None


def in_range(
    ecosystem: str,
    version: str,
    introduced: Optional[str] = None,
    fixed: Optional[str] = None,
    last_affected: Optional[str] = None,
) -> Optional[bool]:
    """判断 ``version`` 是否落在 ``[introduced, fixed)`` / ``... last_affected]``。

    返回 ``None`` 表示**无法判定**（版本或边界不可解析）。调用方必须把
    ``None`` 当作「不匹配」，不要当作 True 也不要当作 False 参与统计——
    见模块文档。
    """
    if not version:
        return None
    # OSV 用 "0" 作为「从第一个版本开始」的哨兵值，它不是版本号。
    if introduced and introduced != "0":
        cmp_intro = compare(ecosystem, version, introduced)
        if cmp_intro is None:
            return None
        if cmp_intro < 0:
            return False
    if fixed:
        cmp_fixed = compare(ecosystem, version, fixed)
        if cmp_fixed is None:
            return None
        if cmp_fixed >= 0:
            return False
    if last_affected:
        cmp_last = compare(ecosystem, version, last_affected)
        if cmp_last is None:
            return None
        if cmp_last > 0:
            return False
    return True
