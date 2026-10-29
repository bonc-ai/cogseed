"""单元测试：依赖清单抽取。

为什么值得单独测
----------------
锁文件格式有代际差异（npm lockfileVersion 1/2/3、yarn classic/berry、
pnpm v5/v6/v9），而这些格式的解析失败**不会报错**——只会得到一份更短的清单，
于是「扫过但没有漏洞」和「根本没读到依赖」在报告里长得一样。

覆盖：
- 各生态主要清单/锁文件形态
- 清单范围（`^1.2.3`）不被当成确定版本
- 格式错误进入 `stats.unreadable`，不中断扫描
- 生成目录与符号链接不参与解析
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.scanner_core import dependency_inventory as inv  # noqa: E402


def collect(tmp_path: Path) -> dict:
    return inv.collect_dependencies(tmp_path)


def names(result: dict) -> dict[str, str | None]:
    return {f"{d.ecosystem}:{d.name}": d.version for d in result["dependencies"]}


def test_package_lock_v2_reads_transitive_packages(tmp_path):
    (tmp_path / "package-lock.json").write_text("""{
      "name": "demo", "lockfileVersion": 3,
      "packages": {
        "": {"name": "demo", "version": "1.0.0"},
        "node_modules/lodash": {"version": "4.17.20"},
        "node_modules/@scope/pkg": {"version": "2.1.0"},
        "node_modules/a/node_modules/b": {"version": "0.9.1"},
        "node_modules/link-only": {"link": true}
      }
    }""", "utf-8")

    result = collect(tmp_path)
    got = names(result)
    assert got["npm:lodash"] == "4.17.20"
    assert got["npm:@scope/pkg"] == "2.1.0"
    assert got["npm:b"] == "0.9.1"
    assert "npm:link-only" not in got
    assert result["stats"]["packages"] == 3


def test_package_lock_v1_walks_nested_dependencies(tmp_path):
    (tmp_path / "package-lock.json").write_text("""{
      "lockfileVersion": 1,
      "dependencies": {
        "minimist": {"version": "1.2.5", "dependencies": {"inner": {"version": "3.0.0"}}}
      }
    }""", "utf-8")

    got = names(collect(tmp_path))
    assert got["npm:minimist"] == "1.2.5"
    assert got["npm:inner"] == "3.0.0"


def test_package_json_distinguishes_pins_from_ranges(tmp_path):
    (tmp_path / "package.json").write_text("""{
      "dependencies": {"lodash": "4.17.20", "axios": "^1.6.0"},
      "devDependencies": {"vitest": "=1.2.0"}
    }""", "utf-8")

    result = collect(tmp_path)
    got = names(result)
    # 范围不是「已安装版本」，不能拿去和漏洞区间比较。
    assert got["npm:lodash"] == "4.17.20"
    assert got["npm:vitest"] == "1.2.0"
    assert got["npm:axios"] is None
    assert result["stats"]["constraints"] == 1


def test_requirements_handles_extras_hash_and_includes(tmp_path):
    (tmp_path / "base.txt").write_text("urllib3==1.26.4  # pinned\n", "utf-8")
    (tmp_path / "requirements.txt").write_text(
        "-r base.txt\n"
        "requests[security]==2.31.0 --hash=sha256:deadbeef\n"
        "PyYAML>=5.1\n"
        "-e git+https://example.invalid/pkg.git#egg=pkg\n",
        "utf-8",
    )

    result = collect(tmp_path)
    got = names(result)
    assert got["PyPI:urllib3"] == "1.26.4"
    assert got["PyPI:requests"] == "2.31.0"
    assert got["PyPI:pyyaml"] is None
    # include 文件里的行号必须指向它自己，而不是根 requirements.txt。
    pyyaml = next(d for d in result["dependencies"] if d.name == "pyyaml")
    urllib3 = next(d for d in result["dependencies"] if d.name == "urllib3")
    assert urllib3.file == "base.txt" and urllib3.line == 1
    assert pyyaml.file == "requirements.txt" and pyyaml.line == 3


def test_poetry_uv_and_pipfile_locks(tmp_path):
    (tmp_path / "poetry.lock").write_text(
        '[[package]]\nname = "jinja2"\nversion = "3.1.2"\n'
        'description = "x"\n\n'
        '[[package]]\nname = "markupsafe"\nversion = "2.1.3"\n', "utf-8")
    (tmp_path / "Pipfile.lock").write_text(
        '{"default": {"requests": {"version": "==2.25.0"}}, "develop": {}}', "utf-8")

    got = names(collect(tmp_path))
    assert got["PyPI:jinja2"] == "3.1.2"
    assert got["PyPI:markupsafe"] == "2.1.3"
    assert got["PyPI:requests"] == "2.25.0"


def test_yarn_classic_and_berry(tmp_path):
    (tmp_path / "yarn.lock").write_text(
        '# yarn lockfile v1\n\n'
        '"lodash@^4.17.20", lodash@^4.17.21:\n'
        '  version "4.17.21"\n'
        '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"\n'
        '\n'
        '"@scope/pkg@npm:^1.0.0":\n'
        '  version: 1.2.3\n', "utf-8")

    got = names(collect(tmp_path))
    assert got["npm:lodash"] == "4.17.21"
    assert got["npm:@scope/pkg"] == "1.2.3"


def test_pnpm_lock_formats(tmp_path):
    (tmp_path / "pnpm-lock.yaml").write_text(
        "lockfileVersion: '9.0'\n"
        "packages:\n"
        "  /lodash@4.17.20:\n"
        "    resolution: {integrity: sha512-x}\n"
        "  '@scope/pkg@2.0.0(react@18.0.0)':\n"
        "    resolution: {integrity: sha512-y}\n", "utf-8")

    got = names(collect(tmp_path))
    assert got["npm:lodash"] == "4.17.20"
    assert got["npm:@scope/pkg"] == "2.0.0"


def test_pnpm_parser_handles_v5_keys():
    parsed = inv._parse_pnpm_key("/lodash/4.17.20")
    assert parsed == ("lodash", "4.17.20")
    parsed = inv._parse_pnpm_key("/@scope/pkg/1.0.0")
    assert parsed == ("@scope/pkg", "1.0.0")


def test_lockfile_wins_over_manifest_range(tmp_path):
    (tmp_path / "package.json").write_text(
        '{"dependencies": {"lodash": "^4.17.20"}}', "utf-8")
    (tmp_path / "package-lock.json").write_text(
        '{"lockfileVersion": 3, "packages": {"node_modules/lodash": {"version": "4.17.20"}}}',
        "utf-8")

    result = collect(tmp_path)
    lodash = [d for d in result["dependencies"] if d.name == "lodash"]
    assert len(lodash) == 1
    assert lodash[0].version == "4.17.20"
    assert lodash[0].file == "package-lock.json"


def test_malformed_manifest_is_reported_not_fatal(tmp_path):
    (tmp_path / "package.json").write_text("{not json", "utf-8")
    (tmp_path / "requirements.txt").write_text("requests==2.31.0\n", "utf-8")

    result = collect(tmp_path)
    assert names(result)["PyPI:requests"] == "2.31.0"
    assert result["stats"]["unreadable"][0]["file"] == "package.json"


def test_generated_dirs_and_symlinks_are_not_followed(tmp_path, symlinks_supported):
    if not symlinks_supported:
        pytest.skip("host cannot create symlinks (Windows needs Developer Mode or an elevated token)")
    nested = tmp_path / "node_modules" / "pkg"
    nested.mkdir(parents=True)
    (nested / "package.json").write_text('{"dependencies": {"evil": "1.0.0"}}', "utf-8")
    target = tmp_path / "outside-package.json"
    target.write_text('{"dependencies": {"outside": "1.0.0"}}', "utf-8")
    (tmp_path / "link.json").symlink_to(target)

    result = collect(tmp_path)
    assert result["dependencies"] == []
