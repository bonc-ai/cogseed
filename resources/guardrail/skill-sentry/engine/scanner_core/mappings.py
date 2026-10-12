"""
mappings.py — 类别 → 标准缺陷编号 / 风险框架 / 补救指引 的单一映射表
======================================================================

为什么需要这一层
----------------
1.0/2.0 的报告只给 ``rule_id`` + 自由文本 description。这有三个后果：

- **不可比对**：安全团队无法回答「这次扫描覆盖了 OWASP LLM Top 10 的哪几项」；
- **不可导入**：SARIF / DefectDojo / GitHub code scanning 都要求标准缺陷编号，
  没有 CWE 的 finding 在聚合平台里只能算「自定义告警」，排不进任何视图；
- **不可行动**：``remediation`` 此前散落在规则文件与代码默认值两处，措辞不一致，
  用户看到的「怎么办」取决于命中了哪条代码路径。

这里把「类别」作为唯一键，集中声明四件事：CWE、OWASP LLM Top 10 (2025)、
OWASP Agentic Top 10 (2026)、可复制的补救指引。类别是规则的稳定属性
（规则会增删，类别不会），因此映射表不会随规则包版本漂移。

设计取舍
--------
- **一个类别可以有多个 CWE**，因为同一类行为在代码层的成因不同
  （``curl | sh`` 既是「下载未校验代码」(CWE-494)，也常伴随「命令注入」(CWE-78)）。
  报告里全给，不选一个「最像的」——排序即隐含判断，我们不做那个判断。
- **框架编号是提示而非认证**。OWASP LLM/Agentic 条目是风险分类，不是可验证的
  合规声明。report 里对应字段的文档注释明确写了这一点，避免被当成审计结论。
- **映射缺失时返回空列表而不是猜一个**。空列表在下游是「未分类」，
  猜错会让一个 LLM06（过度代理）显示成 LLM01（提示注入），误导修复方向。
"""
from __future__ import annotations

from typing import Any

# ── 风险框架编号 ────────────────────────────────────────────────────────
# OWASP Top 10 for LLM Applications (2025)
OWASP_LLM = {
    "LLM01": "提示注入 (Prompt Injection)",
    "LLM02": "敏感信息泄露 (Sensitive Information Disclosure)",
    "LLM03": "供应链 (Supply Chain)",
    "LLM04": "数据与模型投毒 (Data and Model Poisoning)",
    "LLM05": "不当输出处理 (Improper Output Handling)",
    "LLM06": "过度代理 (Excessive Agency)",
    "LLM07": "系统提示泄露 (System Prompt Leakage)",
    "LLM08": "向量与嵌入弱点 (Vector and Embedding Weaknesses)",
    "LLM09": "错误信息 (Misinformation)",
    "LLM10": "无界消耗 (Unbounded Consumption)",
}

# OWASP Agentic Skills Top 10 (2026) — URN 形状 owasp-agentic-skills-top-10:2026:ASTxx
#
# 这一套是**面向 Skill 的**，比通用的 Agentic Top 10 更贴近本引擎的判定对象：
# 它把「恶意 Skill」「供应链」「过度授权」「不安全元数据」「外部指令」
# 「隔离薄弱」「更新漂移」「扫描不足」分开列。因此报告同时给出两套编号：
# AST 用于与 Skill 生态的其它工具对齐，ASI 用于与通用代理安全框架对齐。
OWASP_AST = {
    "AST01": "恶意技能 (Malicious Skills)",
    "AST02": "供应链投毒 (Supply Chain Compromise)",
    "AST03": "过度授权 (Over-Privileged Skills)",
    "AST04": "不安全元数据 (Insecure Metadata)",
    "AST05": "不可信外部指令 (Untrusted External Instructions)",
    "AST06": "隔离薄弱 (Weak Isolation)",
    "AST07": "更新漂移 (Update Drift)",
    "AST08": "扫描不足 (Poor Scanning)",
    "AST09": "运行时滥用 (Runtime Abuse)",
    "AST10": "治理缺失 (Governance Gaps)",
}

# OWASP Top 10 for Agentic Applications (2026)
OWASP_AGENTIC = {
    "ASI01": "代理目标劫持 (Agent Goal Hijack)",
    "ASI02": "工具误用与利用 (Tool Misuse and Exploitation)",
    "ASI03": "身份与权限滥用 (Identity and Privilege Abuse)",
    "ASI04": "代理供应链漏洞 (Agentic Supply Chain Vulnerabilities)",
    "ASI05": "非预期代码执行 (Unexpected Code Execution)",
    "ASI06": "记忆与上下文投毒 (Memory and Context Poisoning)",
    "ASI07": "代理间通信不安全 (Insecure Inter-Agent Communication)",
    "ASI08": "级联失效 (Cascading Failures)",
    "ASI09": "人机信任利用 (Human-Agent Trust Exploitation)",
    "ASI10": "失控代理 (Rogue Agents)",
}


class Mapping:
    """一个类别的标准编号与修复指引。"""

    __slots__ = ("cwe", "owasp_llm", "owasp_agentic", "owasp_ast", "remediation", "references")

    def __init__(
        self,
        cwe: tuple[str, ...],
        owasp_llm: tuple[str, ...],
        owasp_agentic: tuple[str, ...],
        remediation: str,
        references: tuple[str, ...] = (),
        owasp_ast: tuple[str, ...] = (),
    ) -> None:
        self.cwe = cwe
        self.owasp_llm = owasp_llm
        self.owasp_agentic = owasp_agentic
        self.owasp_ast = owasp_ast
        self.remediation = remediation
        self.references = references


# 通用参考链接（按需拼接 CWE 页面）。
def _cwe_link(cwe_id: str) -> str:
    return f"https://cwe.mitre.org/data/definitions/{cwe_id.split('-')[1]}.html"


CATEGORY_MAP: dict[str, Mapping] = {
    # ── 凭据与密钥 ──────────────────────────────────────────────────
    "credential_access": Mapping(
        ("CWE-522", "CWE-359"),
        ("LLM02",),
        ("ASI03",),
        "不要读取用户凭据（~/.ssh、~/.aws、钥匙串、浏览器 Cookie 库）。"
        "改为要求用户在对话中显式提供所需的值，且只用于当前任务。",
    ),
    "secret": Mapping(
        ("CWE-798",),
        ("LLM02",),
        ("ASI04",),
        "移除硬编码密钥，改用环境变量或密钥托管；已泄漏的密钥必须立即轮换。",
    ),
    "secret_file": Mapping(
        ("CWE-312", "CWE-538"),
        ("LLM02",),
        ("ASI04",),
        "从包中删除该文件；凭据不应随 Skill 分发，用 .gitignore + 密钥托管替代。",
    ),
    # ── 数据外发 ────────────────────────────────────────────────────
    "data_egress": Mapping(
        ("CWE-200", "CWE-359"),
        ("LLM02",),
        ("ASI03",),
        "外发前必须显式征得用户同意，并把目标域名限定在 allowlist；"
        "日志与上报内容需脱敏。",
    ),
    "cognitive_asset_exfil": Mapping(
        ("CWE-200", "CWE-506"),
        ("LLM02", "LLM06"),
        ("ASI01", "ASI03"),
        "禁止把提示词、会话、代码等认知资产持续外传；如为遥测，必须默认关闭、"
        "可审计、只报计数与错误类型。",
    ),
    "network": Mapping(
        ("CWE-200",),
        ("LLM02",),
        ("ASI02",),
        "核对每个外部地址是否必要；把域名写入 allowlist 并在 SKILL.md 声明。",
    ),
    "ssrf": Mapping(
        ("CWE-918",),
        ("LLM06",),
        ("ASI02",),
        "对用户可控的 URL 做协议/主机 allowlist 校验，拒绝内网与云元数据地址。",
    ),
    # ── 执行 ────────────────────────────────────────────────────────
    "destructive": Mapping(
        ("CWE-77", "CWE-693"),
        ("LLM06",),
        ("ASI02", "ASI08"),
        "删除类操作限定到明确的输出目录，执行前打印目标路径并请求确认。",
    ),
    "destructive_fs": Mapping(
        ("CWE-73", "CWE-77"),
        ("LLM06",),
        ("ASI02",),
        "禁止递归删除家目录/根目录/通配符展开结果；改为先枚举再逐个确认。",
    ),
    "permission": Mapping(
        ("CWE-732",),
        ("LLM06",),
        ("ASI03",),
        "去掉 777 等全局可写权限；用最小权限（目录 755 / 文件 644）并限定属主。",
    ),
    "privilege": Mapping(
        ("CWE-250", "CWE-269"),
        ("LLM06",),
        ("ASI03",),
        "不要提权，也不要挂载 docker.sock 或使用 --privileged；"
        "把需要特权的步骤交还给用户执行。",
    ),
    "unauthorized_download": Mapping(
        ("CWE-494", "CWE-78"),
        ("LLM05", "LLM06"),
        ("ASI05",),
        "不要 curl|sh。改为固定版本 + 校验哈希后下载，再由用户确认安装。",
    ),
    "dynamic_exec": Mapping(
        ("CWE-95", "CWE-94"),
        ("LLM05",),
        ("ASI05",),
        "避免 eval/exec/动态构造代码；改用显式分支或受限的解释器接口。",
    ),
    "deserialization": Mapping(
        ("CWE-502",),
        ("LLM05",),
        ("ASI05",),
        "不要反序列化不可信数据（pickle/yaml.load/marshal）；改用 JSON 或 "
        "safe_load 并校验结构。",
    ),
    "obfuscation": Mapping(
        ("CWE-506", "CWE-656"),
        ("LLM05",),
        ("ASI05",),
        "移除混淆与「先解码再执行」的流程；源码必须可读、可复核。",
    ),
    "reverse_shell": Mapping(
        ("CWE-78",),
        ("LLM06",),
        ("ASI05",),
        "反向 shell 一律视为恶意载荷；删除并上报安全团队。",
    ),
    "command_exec": Mapping(
        ("CWE-78",),
        ("LLM05",),
        ("ASI05",),
        "拼接外部输入进命令时使用参数数组而非 shell 字符串，或做严格转义。",
    ),
    "sql_injection": Mapping(
        ("CWE-89",),
        ("LLM05",),
        ("ASI05",),
        "改用参数化查询（占位符 + 绑定参数），不要拼接字符串构造 SQL。",
    ),
    "path_traversal": Mapping(
        ("CWE-22",),
        ("LLM06",),
        ("ASI02",),
        "对拼接进路径的输入做规范化并校验其仍在允许的根目录内。",
    ),
    # ── 持久化与配置篡改 ────────────────────────────────────────────
    "persistence": Mapping(
        ("CWE-506", "CWE-284"),
        ("LLM06",),
        ("ASI10",),
        "Skill 不应安装自启动项（cron/systemd/LaunchAgents/注册表 Run）。"
        "需要定时执行时交给宿主应用的调度器。",
    ),
    "mcp_config": Mapping(
        ("CWE-506", "CWE-1357"),
        ("LLM03", "LLM06"),
        ("ASI02", "ASI04"),
        "不要改写宿主或其它 Agent 的 MCP/工具配置；"
        "连接器应由用户在应用界面里显式添加。",
    ),
    "structural": Mapping(
        ("CWE-506",),
        ("LLM03",),
        ("ASI04",),
        "移除可执行脚本/动态库/嵌套压缩包等非文本载荷；"
        "Skill 应以可读文本与受控脚本为主。",
    ),
    # ── 提示与指令类 ────────────────────────────────────────────────
    "prompt_injection": Mapping(
        ("CWE-1427",),
        ("LLM01",),
        ("ASI01", "ASI06"),
        "移除注入载荷：不要包含「忽略以上指令」「你现在是…」这类改写代理目标的文本。",
    ),
    "hidden_content": Mapping(
        ("CWE-506", "CWE-1427"),
        ("LLM01",),
        ("ASI01", "ASI06"),
        "删除不可见字符与隐藏指令（零宽字符、Unicode 标签块、HTML 注释、"
        "隐藏样式）。这类内容对用户不可见，只对模型可见。",
    ),
    "agent_instruction": Mapping(
        ("CWE-1427",),
        ("LLM01", "LLM06"),
        ("ASI01", "ASI09"),
        "把「不告知用户」「无需确认直接执行」之类的指令改写为"
        "「执行前向用户说明并获得确认」。",
    ),
    "system_prompt_extraction": Mapping(
        ("CWE-1427",),
        ("LLM07",),
        ("ASI01",),
        "不要包含索取系统提示/内部指令的内容；"
        "如需调试请引导用户使用应用的诊断入口。",
    ),
    # ── 供应链 ──────────────────────────────────────────────────────
    "supply_chain": Mapping(
        ("CWE-1357", "CWE-1104"),
        ("LLM03",),
        ("ASI04",),
        "固定依赖版本（tag/commit/digest）并提交 lockfile；"
        "不要在安装脚本或 Skill 运行时拉取 latest。",
    ),
    "dependency_vuln": Mapping(
        ("CWE-1395",),
        ("LLM03",),
        ("ASI04",),
        "升级到已修复版本；无法升级时记录到风险接受清单并注明到期日。",
    ),
    "install_hook": Mapping(
        ("CWE-506", "CWE-1357"),
        ("LLM03",),
        ("ASI04",),
        "移除 postinstall/preinstall 等安装钩子；"
        "安装阶段不应执行任意代码。",
    ),
    "typosquat": Mapping(
        ("CWE-1357",),
        ("LLM03",),
        ("ASI04",),
        "核对该依赖是否为官方包名（拼写相近的非官方包是典型投毒手法）；"
        "确需使用则固定到具体版本与哈希。",
    ),
    # ── 二进制 ──────────────────────────────────────────────────────
    "binary_indicator": Mapping(
        ("CWE-506",),
        ("LLM03",),
        ("ASI04",),
        "二进制组件无法人工复核；请附源码或提供可复现构建，否则不要随 Skill 分发。",
    ),
    "surveillance": Mapping(
        ("CWE-506",),
        ("LLM02", "LLM06"),
        ("ASI03",),
        "禁止键盘记录、屏幕截取、剪贴板监听等监控行为。",
    ),
    "crypto_miner": Mapping(
        ("CWE-506",),
        ("LLM10",),
        ("ASI10",),
        "挖矿载荷一律视为恶意；删除并上报安全团队。",
    ),
}

#: 类别 → OWASP Agentic Skills Top 10 编号。
#:
#: 单独一张表而不是写进每个 Mapping 构造：AST 编号的归类依据是「这个行为
#: 属于哪一类技能风险」，与 CWE/LLM 的归类依据不同，分开维护后调整其中
#: 一套不会牵动另一套。
AST_BY_CATEGORY: dict[str, tuple[str, ...]] = {
    # 恶意技能本体
    "credential_access": ("AST01", "AST03"),
    "data_egress": ("AST01",),
    "cognitive_asset_exfil": ("AST01",),
    "reverse_shell": ("AST01", "AST09"),
    "crypto_miner": ("AST01", "AST09"),
    "surveillance": ("AST01", "AST09"),
    "destructive": ("AST01", "AST09"),
    "destructive_fs": ("AST01",),
    "command_exec": ("AST01", "AST09"),
    "obfuscation": ("AST01",),
    "hidden_content": ("AST01", "AST05"),
    "prompt_injection": ("AST01", "AST05"),
    "agent_instruction": ("AST05", "AST09"),
    "system_prompt_extraction": ("AST01",),
    "permission": ("AST03",),
    "privilege": ("AST03", "AST09"),
    # 供应链
    "supply_chain": ("AST02",),
    "dependency_vuln": ("AST02",),
    "install_hook": ("AST02",),
    "typosquat": ("AST02",),
    "binary_indicator": ("AST02",),
    "structural": ("AST02", "AST04"),
    "unauthorized_download": ("AST02", "AST01"),
    # 授权与隔离
    "mcp_config": ("AST05", "AST09"),
    "persistence": ("AST09",),
    "network": ("AST03",),
    "ssrf": ("AST03",),
    # 其它
    "secret": ("AST04",),
    "secret_file": ("AST04",),
    "dynamic_exec": ("AST01",),
    "deserialization": ("AST04",),
    "sql_injection": ("AST01",),
    "path_traversal": ("AST01",),
    "scan_coverage": ("AST08",),
    "update_drift": ("AST07",),
}

# 未登记类别：给出可用的兜底文案，但**不猜** CWE/OWASP 编号。
FALLBACK = Mapping(
    (),
    (),
    (),
    "复核该模式是否必要；无法说明用途时请移除。",
)


def mapping_for(category: str) -> Mapping:
    """按类别取映射；未登记返回不含编号的兜底项。"""
    base = CATEGORY_MAP.get(category, FALLBACK)
    ast = AST_BY_CATEGORY.get(category, ())
    if not ast or base.owasp_ast == ast:
        return base
    return Mapping(
        base.cwe, base.owasp_llm, base.owasp_agentic,
        base.remediation, base.references, ast,
    )


def references_for(category: str) -> list[str]:
    """该类别可点击的参考资料。CWE 链接由编号派生，不手工维护。"""
    m = mapping_for(category)
    return [_cwe_link(c) for c in m.cwe]


def framework_summary(findings: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """把 findings 汇总成「框架条目 → 相关规则」的形状，供报告与 UI 使用。

    只统计**生效 severity >= low** 的 finding：info 级是线索（例如「文档里出现了
    HTTP 地址」），把它们计入框架覆盖会让每份报告都「命中全部十条」，
    框架视图随即失去信息量。
    """
    llm: dict[str, dict[str, Any]] = {}
    agentic: dict[str, dict[str, Any]] = {}
    ast: dict[str, dict[str, Any]] = {}
    for f in findings:
        if f.get("severity") not in ("low", "medium", "high", "critical"):
            continue
        m = mapping_for(str(f.get("category") or ""))
        for key, bucket in ((k, llm) for k in m.owasp_llm):
            row = bucket.setdefault(key, {"id": key, "count": 0, "rules": []})
            row["count"] += 1
            if f.get("rule_id") not in row["rules"]:
                row["rules"].append(f.get("rule_id"))
        for key, bucket in ((k, agentic) for k in m.owasp_agentic):
            row = bucket.setdefault(key, {"id": key, "count": 0, "rules": []})
            row["count"] += 1
            if f.get("rule_id") not in row["rules"]:
                row["rules"].append(f.get("rule_id"))
        for key, bucket in ((k, ast) for k in m.owasp_ast):
            row = bucket.setdefault(key, {"id": key, "count": 0, "rules": []})
            row["count"] += 1
            if f.get("rule_id") not in row["rules"]:
                row["rules"].append(f.get("rule_id"))
    for bucket, titles in ((llm, OWASP_LLM), (agentic, OWASP_AGENTIC), (ast, OWASP_AST)):
        for key, row in bucket.items():
            row["title"] = titles.get(key, key)
            row["rules"] = sorted(row["rules"])
    return {
        "owasp_llm": [llm[k] for k in sorted(llm)],
        "owasp_agentic": [agentic[k] for k in sorted(agentic)],
        "owasp_ast": [ast[k] for k in sorted(ast)],
    }
