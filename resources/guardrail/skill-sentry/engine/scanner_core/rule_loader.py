"""
rule_loader.py — 规则包加载 + 版本管理
==========================================

从 rulesets/<version>/ 加载规则包，内置默认规则作为兜底（无 pyyaml 或
外部规则缺失时）。ruleset.yaml 声明规则包版本，供 report 里的
rules_source / ruleset_version 字段追溯。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore
except Exception:
    yaml = None  # type: ignore

ENGINE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_RULESET_VERSION = "v1.0.0"
RULESETS_DIR = ENGINE_DIR / "rulesets"

# ============================================================
# 内置默认规则（无 pyyaml 或规则包缺失时的兜底）
# ============================================================
DEFAULT_SECRET_PATTERNS = [
    ("private_key_block", r"-----BEGIN .*PRIVATE KEY-----", "critical"),
    ("aws_access_key", r"(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}", "critical"),
    ("github_token", r"gh(?:p|o|u|s|r)_[A-Za-z0-9_]{36,255}", "critical"),
    ("openai_api_key", r"sk-(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{20,}", "critical"),
    ("anthropic_api_key", r"sk-ant-(?:api03|admin01)-[A-Za-z0-9_\-]{20,}", "critical"),
    ("slack_token", r"xox(?:b|p|a|r|s)-[A-Za-z0-9\-]{20,}", "critical"),
    ("google_api_key", r"AIza[0-9A-Za-z_\-]{35}", "critical"),
    ("jwt_token", r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}", "high"),
    ("generic_env_api_key", r"(OPENAI_API_KEY|ANTHROPIC_API_KEY|API_KEY|SECRET_KEY|TOKEN)\s*=\s*['\"]?[A-Za-z0-9_\-]{16,}", "high"),
]
DEFAULT_FP_MARKERS = ["example", "sample", "placeholder", "示例", "your-key-here", "xxxxxxxx", "<your", "dummy", "redacted"]

DEFAULT_RULE_GROUPS: dict[str, list[tuple[str, str, str, str]]] = {
    "dangerous_commands": [
        ("rm_rf_root", r"rm\s+-rf\s+(/|\$HOME|~|\*)", "critical", "destructive"),
        ("find_delete", r"find\s+.+-delete\b", "high", "destructive"),
        ("git_clean_force", r"git\s+clean\s+-[a-z]*f[a-z]*d", "high", "destructive"),
        ("chmod_777", r"chmod\s+-?R?\s*777", "high", "permission"),
        ("curl_pipe_shell", r"(curl|wget)\s+[^|\n]*\|\s*(sudo\s+)?(ba)?sh", "critical", "unauthorized_download"),
        ("sudo_su", r"\bsudo\s+su\b", "high", "privilege"),
        ("docker_sock", r"/var/run/docker\.sock", "critical", "privilege"),
        ("privileged_container", r"--privileged\b", "high", "privilege"),
        ("powershell_encoded", r"powershell\s+-enc(odedcommand)?\b", "high", "obfuscation"),
    ],
    "dynamic_execution": [
        ("python_eval_exec", r"\b(eval|exec)\s*\(", "high", "dynamic_exec"),
        ("python_os_system", r"\bos\.system\s*\(", "high", "dynamic_exec"),
        ("shell_true", r"shell\s*=\s*True", "medium", "dynamic_exec"),
        ("pickle_loads", r"\bpickle\.loads?\s*\(", "high", "deserialization"),
        ("base64_decode_exec", r"exec\s*\(\s*base64\.b64decode", "critical", "obfuscation"),
        ("node_child_process", r"require\(['\"]child_process['\"]\)", "medium", "dynamic_exec"),
    ],
    "sql_injection": [
        ("fstring_sql", r"(execute|executemany|cursor\.execute)\s*\(\s*f[\"']\s*(SELECT|INSERT|UPDATE|DELETE)", "high", "sql_injection"),
        # 关键字需 \b：否则 "selector += ..." 会因内含 "select" 而误报。
        ("update_where_1eq1", r"\b(UPDATE|DELETE)\b[^;\n]*WHERE\s+1\s*=\s*1", "high", "destructive"),
        ("string_concat_sql", r"\b(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*[\"']\s*\+\s*\w+", "medium", "sql_injection"),
    ],
    "persistence": [
        ("crontab_write", r"(crontab\s+-|/etc/cron\.|/var/spool/cron)", "high", "persistence"),
        ("systemd_service", r"(/etc/systemd/system/|systemctl\s+enable)", "high", "persistence"),
        ("shell_rc_write", r">>?\s*~?/?\.?(bashrc|zshrc|profile|bash_profile)", "high", "persistence"),
        ("launchd_plist", r"(~/Library/LaunchAgents|/Library/LaunchDaemons)", "high", "persistence"),
    ],
    "prompt_injection_payloads": [
        ("ignore_previous", r"ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts)", "high", "prompt_injection"),
        ("disregard_instructions", r"disregard\s+(all\s+)?(previous|prior|the above)", "high", "prompt_injection"),
        ("reveal_system_prompt", r"(reveal|print|repeat|show)\s+(your\s+)?(system\s+prompt|instructions|initial\s+prompt)", "high", "system_prompt_extraction"),
        ("you_are_now", r"you\s+are\s+now\s+(a\s+)?(different|new)\b", "medium", "prompt_injection"),
    ],
    "network_egress": [
        ("requests_post", r"\brequests\.(post|put)\s*\(", "medium", "data_egress"),
        # 收窄：裸 "upload" 一词命中率过高（普通功能描述），见 text-rules.yaml 注释。
        ("upload_exfil", r"(\bexfil\w*|外发|外传|\bupload\w*\s*\()", "medium", "data_egress"),
        ("webhook", r"\bwebhook\b", "low", "data_egress"),
        # These two rules are release-critical and must remain in the embedded
        # fallback. Developer/system Python installations often omit PyYAML;
        # falling back must not turn credential exfiltration into ALLOW.
        ("credential_path_read",
         r"(~|\$HOME)/\.ssh/|/\.ssh/id_(rsa|dsa|ecdsa|ed25519)|\.aws/credentials|(~|\$HOME)/\.gnupg/|(~|\$HOME)/\.docker/config\.json|security\s+find-generic-password",
         "critical", "credential_access"),
        ("pipe_to_remote_sink",
         r"\|\s*(curl|wget)\b[^\n]*(-d|--data(-binary|-raw)?)\s*@?-|\|\s*nc\s+[a-zA-Z0-9\.\-]+\s+\d+",
         "critical", "data_egress"),
    ],
    "suspicious_addresses": [
        ("cloud_metadata_ip", r"169\.254\.169\.254", "high", "ssrf"),
        ("raw_ip_url", r"https?://[0-9]{1,3}(\.[0-9]{1,3}){3}", "medium", "network"),
        ("suspicious_tld", r"https?://[a-zA-Z0-9\.\-]+\.(tk|top|xyz|gq|ml|cf|ru|su)\b", "medium", "network"),
    ],
}

DEFAULT_HARD_BLOCK = [
    ("cognitive_asset_exfil",
     r"(telemetry|analytics)\.(send|track|report)\s*\([^)]*\b(prompt|context|code|conversation|history)\b",
     "critical", "cognitive_asset_exfil",
     "检测到疑似持续外传提示词/代码/会话等认知资产的行为"),
]

DEFAULT_SUPPLY_LATEST = ["@main", "@master", ":latest", "@latest", "pip install git+", "uv tool install git+", "git clone --depth 1"]
DEFAULT_LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "requirements.lock", "pipfile.lock", "uv.lock"]
DEFAULT_FORBIDDEN_FILES = [".env", "id_rsa", "id_dsa", ".pem", ".key", ".p12", ".pfx", ".npmrc", ".netrc", "credentials.json"]

# 分类到 SR 编号 / remediation 文案的映射
GROUP_SR = {
    "dangerous_commands": "SR-03", "dynamic_execution": "SR-03", "sql_injection": "SR-03",
    "persistence": "SR-03", "prompt_injection_payloads": "SR-07",
    "network_egress": "SR-04", "suspicious_addresses": "SR-04",
}
GROUP_REMEDIATION = {
    "dangerous_commands": "移除危险命令；必须使用 allowlist、容器隔离、只读挂载和人工确认",
    "dynamic_execution": "避免动态代码执行/反序列化不可信输入；如必需请沙箱隔离",
    "sql_injection": "使用参数化查询，禁止字符串拼接构造 SQL",
    "persistence": "移除持久化写入；如为合法需求需显式声明并走人工审批",
    "prompt_injection_payloads": "移除提示注入载荷；若为测试样例请隔离到测试目录并标注",
    "network_egress": "对外联行为增加 allowlist、审计日志和数据脱敏",
    "suspicious_addresses": "移除可疑地址；确认外联目标可信并纳入 allowlist",
}


def _builtin_rules() -> dict[str, Any]:
    return {
        "ruleset_version": "builtin",
        "secret_patterns": [{"id": i, "pattern": p, "severity": s} for i, p, s in DEFAULT_SECRET_PATTERNS],
        "false_positive_markers": list(DEFAULT_FP_MARKERS),
        "rule_groups": {
            g: [{"id": i, "pattern": p, "severity": s, "category": c} for i, p, s, c in rows]
            for g, rows in DEFAULT_RULE_GROUPS.items()
        },
        "hard_block": [{"id": i, "pattern": p, "severity": s, "category": c, "reason": r} for i, p, s, c, r in DEFAULT_HARD_BLOCK],
        "supply_chain_latest": list(DEFAULT_SUPPLY_LATEST),
        "lockfiles": list(DEFAULT_LOCKFILES),
        "forbidden_files": list(DEFAULT_FORBIDDEN_FILES),
        "group_sr": dict(GROUP_SR),
        "group_remediation": dict(GROUP_REMEDIATION),
    }


def load_rules(version: str = DEFAULT_RULESET_VERSION) -> dict[str, Any]:
    """加载指定版本的规则包；YAML 缺失/解析失败/pyyaml 未安装时回退到内置默认规则。

    fail-closed 审计：当请求的版本目录根本不存在时，仍回退到内置规则以
    保证「有规则可扫」（内置规则本身覆盖 8 大类红旗），但通过
    `_ruleset_resolved=False` 显式标记「请求的版本未解析」，供上层
    按需拒绝或告警，避免「用户以为扫的是 vX，实际扫的是 builtin」这类
    静默降级带来的可预测性/可审计性缺失。
    """
    rules = _builtin_rules()
    rules["_requested_version"] = version
    rules["_ruleset_resolved"] = True
    ruleset_dir = RULESETS_DIR / version

    if not ruleset_dir.is_dir():
        rules["_ruleset_resolved"] = False
        rules["_rules_source"] = f"builtin (请求的规则版本 {version} 不存在，回退内置默认规则)"
        return rules

    if yaml is None:
        rules["_rules_source"] = "builtin (pyyaml 未安装，使用内置默认规则)"
        return rules

    loaded = []
    try:
        secret_file = ruleset_dir / "secret-patterns.yaml"
        if secret_file.is_file():
            data = yaml.safe_load(secret_file.read_text("utf-8")) or {}
            if data.get("secret_patterns"):
                rules["secret_patterns"] = data["secret_patterns"]
            if data.get("false_positive_markers"):
                rules["false_positive_markers"] = data["false_positive_markers"]
            loaded.append(secret_file.name)

        text_rules_file = ruleset_dir / "text-rules.yaml"
        if text_rules_file.is_file():
            data = yaml.safe_load(text_rules_file.read_text("utf-8")) or {}
            for g in list(DEFAULT_RULE_GROUPS.keys()):
                if data.get(g):
                    rules["rule_groups"][g] = data[g]
            for key in ("hard_block", "supply_chain_latest", "lockfiles", "forbidden_files"):
                if data.get(key):
                    rules[key] = data[key]
            loaded.append(text_rules_file.name)
    except Exception as exc:
        rules["_rules_source"] = f"builtin (外部规则解析失败: {exc})"
        return rules

    rules["ruleset_version"] = version if loaded else "builtin"
    rules["_rules_source"] = f"ruleset {version}: {', '.join(loaded)}" if loaded else "builtin"
    return rules
